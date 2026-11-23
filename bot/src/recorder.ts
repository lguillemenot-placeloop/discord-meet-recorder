import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice';
import prism from 'prism-media';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Meeting, MeetingStore } from './store.js';
import { pcmToWav } from './wav.js';

/** Whisper travaille en 16 kHz mono : on décode l'Opus directement à ce format. */
export const SAMPLE_RATE = 16_000;
export const CHANNELS = 1;
/** Silence après lequel une prise de parole est considérée finie. */
const SILENCE_MS = 1_000;
/** En dessous, c'est un bruit (clic, souffle) : on ne garde pas. */
const MIN_SEGMENT_MS = 400;
/** À l'arrêt, temps maximal laissé aux prises de parole en cours pour être écrites. */
const STOP_TIMEOUT_MS = 5_000;

/**
 * Décodeur qui saute les paquets Opus illisibles au lieu de s'arrêter. Le décodeur de prism-media
 * passe en erreur au premier paquet invalide (fréquent juste après une connexion au salon) : le flux
 * est alors détruit sans « end », la capture ne se termine jamais, la personne n'est plus
 * enregistrée et l'arrêt du meet reste bloqué.
 */
class TolerantDecoder extends prism.opus.Decoder {
  invalidPackets = 0;

  override _transform(chunk: Buffer, encoding: BufferEncoding, done: (err?: Error | null) => void): void {
    super._transform(chunk, encoding, (err?: Error | null) => {
      if (err) this.invalidPackets++;
      done();
    });
  }
}

interface ActiveCapture {
  stop: () => void;
  done: Promise<void>;
}

/**
 * Enregistre un salon vocal : un fichier WAV par prise de parole et par personne.
 * Discord envoie un flux séparé par utilisateur, donc on sait toujours qui parle.
 */
export class MeetingRecorder {
  private readonly active = new Map<string, ActiveCapture>();
  private readonly startedAtMs: number;
  private stopped = false;
  private segmentCount = 0;

  constructor(
    private readonly connection: VoiceConnection,
    private readonly meeting: Meeting,
    private readonly store: MeetingStore,
    /** Nom affiché de la personne, ou null pour ne pas l'enregistrer. */
    private readonly resolveSpeaker: (userId: string) => Promise<string | null>,
  ) {
    this.startedAtMs = Date.parse(meeting.startedAt);
  }

  start(): void {
    this.connection.receiver.speaking.on('start', this.onSpeakingStart);
  }

  get segments(): number {
    return this.segmentCount;
  }

  /** Arrête l'écoute et attend que les prises de parole en cours soient écrites. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.connection.receiver.speaking.off('start', this.onSpeakingStart);
    const pending = [...this.active.values()];
    for (const capture of pending) capture.stop();
    // Garde-fou : une capture bloquée ne doit jamais empêcher le meet de se clore.
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(pending.map((c) => c.done)).then(() => false),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(true), STOP_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
    if (timedOut) console.warn(`[recorder] ${this.active.size} prise(s) de parole non terminée(s) à l’arrêt, abandonnée(s)`);
  }

  private readonly onSpeakingStart = (userId: string): void => {
    if (this.stopped || this.active.has(userId)) return;
    this.capture(userId).catch((err) => console.error(`[recorder] capture ${userId} :`, err));
  };

  private async capture(userId: string): Promise<void> {
    const startedAtMs = Date.now();
    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const decoder = new TolerantDecoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: SAMPLE_RATE / 50 });
    const chunks: Buffer[] = [];

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.active.set(userId, { stop: () => opusStream.push(null), done });

    const finished = new Promise<void>((resolve) => {
      decoder.on('data', (chunk: Buffer) => chunks.push(chunk));
      decoder.once('end', resolve);
      // Filets : quoi qu'il arrive au décodeur ou au flux, la prise de parole se termine avec ce
      // qui a été reçu, et l'abonnement est libéré pour que la suivante reparte sur un flux neuf.
      decoder.once('close', resolve);
      decoder.once('error', (err) => {
        console.warn(`[recorder] décodeur Opus en erreur pour ${userId} :`, err.message);
        opusStream.destroy();
        resolve();
      });
      opusStream.once('error', () => resolve());
    });
    opusStream.pipe(decoder);

    try {
      await finished;
      if (decoder.invalidPackets > 0) {
        console.warn(`[recorder] ${decoder.invalidPackets} paquet(s) Opus illisible(s) ignoré(s) pour ${userId}`);
      }
      await this.writeSegment(userId, startedAtMs, Buffer.concat(chunks));
    } finally {
      this.active.delete(userId);
      resolveDone();
    }
  }

  private async writeSegment(userId: string, startedAtMs: number, pcm: Buffer): Promise<void> {
    const durationMs = Math.round((pcm.length / (SAMPLE_RATE * CHANNELS * 2)) * 1000);
    if (durationMs < MIN_SEGMENT_MS) return;

    // null : à ignorer (un autre bot du salon, par exemple)
    const speaker = await this.resolveSpeaker(userId);
    if (speaker === null) return;
    this.meeting.participants[userId] = speaker;

    const offsetMs = Math.max(0, startedAtMs - this.startedAtMs);
    const file = `segments/${String(offsetMs).padStart(9, '0')}_${userId}.wav`;
    await writeFile(join(this.store.dir(this.meeting.id), file), pcmToWav(pcm, SAMPLE_RATE, CHANNELS));
    await this.store.appendSegment(this.meeting.id, {
      file,
      userId,
      speaker,
      startedAt: new Date(startedAtMs).toISOString(),
      offsetMs,
      durationMs,
    });
    this.segmentCount++;
  }
}
