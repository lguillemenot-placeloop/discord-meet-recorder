import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clock, formatTranscript, MeetingReader, speakingTime, type TranscriptEntry } from './meetings.js';

const entries: TranscriptEntry[] = [
  { speaker: 'Alice', userId: 'a', startMs: 0, endMs: 2_000, text: 'Bonjour.' },
  { speaker: 'Alice', userId: 'a', startMs: 3_000, endMs: 5_000, text: 'On commence ?' },
  { speaker: 'Bob', userId: 'b', startMs: 5_500, endMs: 7_000, text: 'Oui.' },
  { speaker: 'Alice', userId: 'a', startMs: 20_000, endMs: 21_000, text: 'Autre sujet.' },
];

test('regroupe les phrases proches d’une même personne en un tour de parole', () => {
  assert.equal(
    formatTranscript(entries, 'markdown'),
    '**[00:00] Alice** : Bonjour. On commence ?\n\n**[00:05] Bob** : Oui.\n\n**[00:20] Alice** : Autre sujet.',
  );
  assert.equal(formatTranscript(entries, 'lines').split('\n').length, 4);
});

test('temps de parole et horloge', () => {
  assert.deepEqual(speakingTime(entries), [
    { speaker: 'Alice', seconds: 5 },
    { speaker: 'Bob', seconds: 2 },
  ]);
  assert.equal(clock(3_725_000), '1:02:05');
});

test('retrouve un meet par identifiant, début d’identifiant ou « latest »', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-'));
  try {
    for (const [id, startedAt] of [
      ['2026-11-19_1000_dev_aaaa', '2026-11-19T10:00:00Z'],
      ['2026-11-20_1400_dev_bbbb', '2026-11-20T14:00:00Z'],
      ['2026-11-20_1500_produit_cccc', '2026-11-20T15:00:00Z'],
    ]) {
      await mkdir(join(dir, 'meetings', id), { recursive: true });
      await writeFile(join(dir, 'meetings', id, 'meeting.json'), JSON.stringify({ id, startedAt, participants: {} }));
    }
    // Un dossier au nom suspect est ignoré.
    await mkdir(join(dir, 'meetings', '..evil'), { recursive: true });
    const reader = new MeetingReader(dir);
    assert.equal((await reader.resolve('latest')).id, '2026-11-20_1500_produit_cccc');
    assert.equal((await reader.resolve('2026-11-19')).id, '2026-11-19_1000_dev_aaaa');
    await assert.rejects(reader.resolve('2026-11-20'), /Plusieurs meets/);
    await assert.rejects(reader.resolve('nope'), /introuvable/);
    assert.equal((await reader.list()).length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
