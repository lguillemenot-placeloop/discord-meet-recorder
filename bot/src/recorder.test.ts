// Fait passer de l'Opus réel (encodé comme Discord : 48 kHz stéréo, trames de 20 ms)
// dans MeetingRecorder avec un faux salon vocal, et vérifie les WAV et segments.jsonl.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import OpusScript from 'opusscript';
import type { VoiceConnection } from '@discordjs/voice';
import { MeetingRecorder, SAMPLE_RATE } from './recorder.js';
import { MeetingStore, type Meeting, type Segment } from './store.js';

const FRAME = 960; // 20 ms à 48 kHz

function opusTone(ms: number, freq: number): Buffer[] {
  const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  const packets: Buffer[] = [];
  for (let f = 0; f < ms / 20; f++) {
    const pcm = Buffer.alloc(FRAME * 2 * 2);
    for (let i = 0; i < FRAME; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * freq * (f * FRAME + i)) / 48_000) * 12_000);
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }
    packets.push(Buffer.from(encoder.encode(pcm, FRAME)));
  }
  encoder.delete();
  return packets;
}

function fakeConnection() {
  const speaking = new EventEmitter();
  const streams = new Map<string, Readable>();
  const receiver = {
    speaking,
    subscribe(userId: string) {
      const stream = new Readable({ read() {} });
      streams.set(userId, stream);
      return stream;
    },
  };
  return { connection: { receiver } as unknown as VoiceConnection, speaking, streams };
}

function newMeeting(): Meeting {
  return {
    id: 'test-meet',
    title: 'Test',
    guildId: 'g',
    guildName: 'G',
    channelId: 'c',
    channelName: 'vocal',
    textChannelId: null,
    startedBy: { id: 'u1', name: 'Alice' },
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'recording',
    participants: {},
  };
}

test('une prise de parole par personne, en 16 kHz mono, avec le bon minutage', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'meet-'));
  try {
    const store = new MeetingStore(dataDir);
    const meeting = newMeeting();
    await store.create(meeting);
    const { connection, speaking, streams } = fakeConnection();
    const names: Record<string, string | null> = { alice: 'Alice', bob: 'Bob', otherbot: null };
    const recorder = new MeetingRecorder(connection, meeting, store, async (id) => (id in names ? names[id] : id));
    recorder.start();

    speaking.emit('start', 'alice');
    for (const p of opusTone(1_000, 440)) streams.get('alice')!.push(p);
    streams.get('alice')!.push(null);

    await new Promise((r) => setTimeout(r, 150));
    speaking.emit('start', 'bob');
    speaking.emit('start', 'otherbot');
    for (const p of opusTone(600, 220)) streams.get('bob')!.push(p);
    for (const p of opusTone(600, 300)) streams.get('otherbot')!.push(p);
    // Bob parle encore quand on arrête : sa prise de parole doit quand même être écrite.
    await recorder.stop();

    // Un bruit de 100 ms après l'arrêt n'est pas enregistré.
    speaking.emit('start', 'carol');
    assert.equal(streams.has('carol'), false);

    const segments = (await readFile(join(store.dir(meeting.id), 'segments.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Segment);
    assert.deepEqual(segments.map((s) => s.speaker), ['Alice', 'Bob']);
    assert.equal(recorder.segments, 2);
    assert.deepEqual(meeting.participants, { alice: 'Alice', bob: 'Bob' });

    const [alice, bob] = segments;
    assert.ok(Math.abs(alice.durationMs - 1_000) <= 40, `durée Alice ${alice.durationMs}`);
    assert.ok(Math.abs(bob.durationMs - 600) <= 40, `durée Bob ${bob.durationMs}`);
    assert.ok(bob.offsetMs >= 150, `décalage Bob ${bob.offsetMs}`);

    const wav = await readFile(join(store.dir(meeting.id), alice.file));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);

    // Le son décodé est bien un 440 Hz : on compte les passages par zéro sur le milieu du fichier.
    const samples = (wav.length - 44) / 2;
    let crossings = 0;
    for (let i = samples / 4; i < (samples * 3) / 4 - 1; i++) {
      const a = wav.readInt16LE(44 + i * 2);
      const b = wav.readInt16LE(44 + (i + 1) * 2);
      if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) crossings++;
    }
    const freq = crossings / 2 / (samples / 2 / SAMPLE_RATE);
    assert.ok(Math.abs(freq - 440) < 15, `fréquence ${freq}`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('un paquet Opus illisible ne coupe ni la prise de parole, ni les suivantes, ni l’arrêt', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'meet-'));
  try {
    const store = new MeetingStore(dataDir);
    const meeting = newMeeting();
    await store.create(meeting);
    const { connection, speaking, streams } = fakeConnection();
    const recorder = new MeetingRecorder(connection, meeting, store, async () => 'Alice');
    recorder.start();

    // Comme juste après une connexion au salon : un paquet invalide au milieu de la parole.
    speaking.emit('start', 'alice');
    const first = streams.get('alice')!;
    const tone = opusTone(1_000, 440);
    for (const p of tone.slice(0, 25)) first.push(p);
    first.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));
    for (const p of tone.slice(25)) first.push(p);
    first.push(null);
    await new Promise((r) => setTimeout(r, 150));

    // La même personne reparle : un nouveau flux doit être ouvert et enregistré.
    speaking.emit('start', 'alice');
    const second = streams.get('alice')!;
    assert.notEqual(second, first, 'la deuxième prise de parole doit avoir son propre flux');
    for (const p of opusTone(600, 440)) second.push(p);

    const started = Date.now();
    await recorder.stop();
    assert.ok(Date.now() - started < 2_000, 'l’arrêt ne doit pas rester bloqué');

    const segments = (await readFile(join(store.dir(meeting.id), 'segments.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Segment);
    assert.equal(segments.length, 2);
    assert.ok(segments[0].durationMs >= 900, `durée 1re prise ${segments[0].durationMs}`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
