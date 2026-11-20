// Lecture seule des meets écrits par le bot et le transcripteur (voir bot/src/store.ts).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Meeting {
  id: string;
  title: string;
  guildName: string;
  channelName: string;
  startedBy: { id: string; name: string };
  startedAt: string;
  endedAt: string | null;
  status: 'recording' | 'recorded' | 'transcribing' | 'transcribed' | 'failed';
  participants: Record<string, string>;
  error?: string;
}

export interface TranscriptEntry {
  speaker: string;
  userId: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  engine: string;
  language: string | null;
  entries: TranscriptEntry[];
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class MeetingReader {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'meetings');
  }

  async list(): Promise<Meeting[]> {
    let ids: string[];
    try {
      ids = await readdir(this.root);
    } catch {
      return [];
    }
    const meetings = await Promise.all(ids.filter((id) => ID_PATTERN.test(id)).map((id) => this.load(id)));
    return meetings
      .filter((m): m is Meeting => m !== null)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  /** Accepte un identifiant exact, un début d'identifiant non ambigu, ou « latest ». */
  async resolve(idOrPrefix: string): Promise<Meeting> {
    const meetings = await this.list();
    if (idOrPrefix === 'latest') {
      if (!meetings[0]) throw new Error('Aucun meet enregistré.');
      return meetings[0];
    }
    const exact = meetings.find((m) => m.id === idOrPrefix);
    if (exact) return exact;
    const matches = meetings.filter((m) => m.id.startsWith(idOrPrefix));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Plusieurs meets commencent par « ${idOrPrefix} » : ${matches.map((m) => m.id).join(', ')}`);
    throw new Error(`Meet introuvable : ${idOrPrefix}. Utilise list_meetings pour voir les identifiants.`);
  }

  async transcript(id: string): Promise<Transcript | null> {
    try {
      return JSON.parse(await readFile(join(this.root, id, 'transcript.json'), 'utf8')) as Transcript;
    } catch {
      return null;
    }
  }

  private async load(id: string): Promise<Meeting | null> {
    try {
      return JSON.parse(await readFile(join(this.root, id, 'meeting.json'), 'utf8')) as Meeting;
    } catch {
      return null;
    }
  }
}

export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function durationMinutes(m: Meeting): number | null {
  if (!m.endedAt) return null;
  return Math.max(1, Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 60_000));
}

const STATUS_LABEL: Record<Meeting['status'], string> = {
  recording: 'enregistrement en cours',
  recorded: 'en attente de transcription',
  transcribing: 'transcription en cours',
  transcribed: 'transcrit',
  failed: 'échec',
};

export function formatMeetingLine(m: Meeting): string {
  const duration = durationMinutes(m);
  const people = Object.values(m.participants).join(', ') || '—';
  return [
    `- ${m.id}`,
    `  « ${m.title} » · ${m.guildName} / ${m.channelName}`,
    `  ${m.startedAt}${duration ? ` · ${duration} min` : ''} · ${STATUS_LABEL[m.status]}`,
    `  Participants : ${people}`,
  ].join('\n');
}

/** Temps de parole par personne, du plus grand au plus petit. */
export function speakingTime(entries: TranscriptEntry[]): Array<{ speaker: string; seconds: number }> {
  const totals = new Map<string, number>();
  for (const e of entries) totals.set(e.speaker, (totals.get(e.speaker) ?? 0) + (e.endMs - e.startMs));
  return [...totals.entries()]
    .map(([speaker, ms]) => ({ speaker, seconds: Math.round(ms / 1000) }))
    .sort((a, b) => b.seconds - a.seconds);
}

export function formatMeeting(m: Meeting, transcript: Transcript | null): string {
  const lines = [
    `# ${m.title}`,
    `Identifiant : ${m.id}`,
    `Serveur Discord : ${m.guildName} · salon vocal : ${m.channelName}`,
    `Début : ${m.startedAt}${m.endedAt ? ` · fin : ${m.endedAt}` : ''}${durationMinutes(m) ? ` (${durationMinutes(m)} min)` : ''}`,
    `Démarré par : ${m.startedBy.name}`,
    `Statut : ${STATUS_LABEL[m.status]}${m.error ? ` (${m.error})` : ''}`,
    `Participants : ${Object.values(m.participants).join(', ') || '—'}`,
  ];
  if (transcript) {
    lines.push('', `Transcription : ${transcript.entries.length} phrases (${transcript.engine}).`, 'Temps de parole :');
    for (const { speaker, seconds } of speakingTime(transcript.entries)) lines.push(`- ${speaker} : ${clock(seconds * 1000)}`);
    lines.push('', 'Utilise get_meeting_transcript pour le texte complet.');
  }
  return lines.join('\n');
}

/**
 * Regroupe les phrases consécutives d'une même personne (moins de GAP_MS d'écart)
 * pour obtenir des tours de parole lisibles.
 */
const GAP_MS = 3_000;

export function formatTranscript(entries: TranscriptEntry[], format: 'markdown' | 'lines'): string {
  if (format === 'lines') {
    return entries.map((e) => `[${clock(e.startMs)}] ${e.speaker}: ${e.text}`).join('\n');
  }
  const turns: Array<{ speaker: string; startMs: number; endMs: number; texts: string[] }> = [];
  for (const e of entries) {
    const last = turns.at(-1);
    if (last && last.speaker === e.speaker && e.startMs - last.endMs <= GAP_MS) {
      last.texts.push(e.text);
      last.endMs = Math.max(last.endMs, e.endMs);
    } else {
      turns.push({ speaker: e.speaker, startMs: e.startMs, endMs: e.endMs, texts: [e.text] });
    }
  }
  return turns.map((t) => `**[${clock(t.startMs)}] ${t.speaker}** : ${t.texts.join(' ')}`).join('\n\n');
}
