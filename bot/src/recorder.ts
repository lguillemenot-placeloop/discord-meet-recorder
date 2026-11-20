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
    await Promise.allSettled(pending.map((c) => c.done));
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
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: SAMPLE_RATE / 50 });
    const chunks: Buffer[] = [];

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.active.set(userId, { stop: () => opusStream.push(null), done });

    const finished = new Promise<void>((resolve) => {
      decoder.on('data', (chunk: Buffer) => chunks.push(chunk));
      decoder.once('end', resolve);
      decoder.once('error', (err) => {
        console.warn(`[recorder] paquet Opus illisible pour ${userId} :`, err.message);
      });
      opusStream.once('error', () => resolve());
    });
    opusStream.pipe(decoder);

    try {
      await finished;
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
