// Stockage des meets sur disque, partagé avec le transcripteur et le serveur MCP.
//
// <DATA_DIR>/meetings/<meetingId>/
//   meeting.json      métadonnées et statut (voir Meeting)
//   segments.jsonl    une ligne par prise de parole (voir Segment)
//   segments/*.wav    audio de chaque prise de parole (supprimé après transcription)
//   transcript.json   écrit par le transcripteur
//   stop-request.json écrit par le transcripteur quand quelqu'un dit la phrase d'arrêt
//   .notified         marqueur : le bot a annoncé la fin de la transcription
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type MeetingStatus = 'recording' | 'recorded' | 'transcribing' | 'transcribed' | 'failed';

export interface Meeting {
  id: string;
  title: string;
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  textChannelId: string | null;
  startedBy: { id: string; name: string };
  startedAt: string;
  endedAt: string | null;
  status: MeetingStatus;
  /** userId -> nom affiché dans le serveur Discord */
  participants: Record<string, string>;
  error?: string;
}

export interface Segment {
  file: string;
  userId: string;
  speaker: string;
  startedAt: string;
  /** Début de la prise de parole, en ms depuis le début du meet */
  offsetMs: number;
  durationMs: number;
}

export interface StopRequest {
  userId: string;
  speaker: string;
  text: string;
  requestedAt: string;
}

export class MeetingStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'meetings');
  }

  dir(id: string): string {
    return join(this.root, id);
  }

  async create(meeting: Meeting): Promise<void> {
    await mkdir(join(this.dir(meeting.id), 'segments'), { recursive: true });
    await this.save(meeting);
  }

  async save(meeting: Meeting): Promise<void> {
    const path = join(this.dir(meeting.id), 'meeting.json');
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(meeting, null, 2));
    await rename(tmp, path);
  }

  async load(id: string): Promise<Meeting | null> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), 'meeting.json'), 'utf8')) as Meeting;
    } catch {
      return null;
    }
  }

  async list(): Promise<Meeting[]> {
    await mkdir(this.root, { recursive: true });
    const ids = await readdir(this.root);
    const meetings = await Promise.all(ids.map((id) => this.load(id)));
    return meetings.filter((m): m is Meeting => m !== null);
  }

  async appendSegment(id: string, segment: Segment): Promise<void> {
    await appendFile(join(this.dir(id), 'segments.jsonl'), `${JSON.stringify(segment)}\n`);
  }

  /** Demande d'arrêt déposée par le transcripteur quand quelqu'un a dit STOP_PHRASE. */
  async stopRequest(id: string): Promise<StopRequest | null> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), 'stop-request.json'), 'utf8')) as StopRequest;
    } catch {
      return null;
    }
  }

  async isNotified(id: string): Promise<boolean> {
    try {
      await readFile(join(this.dir(id), '.notified'));
      return true;
    } catch {
      return false;
    }
  }

  async markNotified(id: string): Promise<void> {
    await writeFile(join(this.dir(id), '.notified'), new Date().toISOString());
  }
}

export function meetingId(startedAt: Date, channelName: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`;
  const time = `${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}`;
  const slug =
    channelName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'vocal';
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${date}_${time}_${slug}_${suffix}`;
}
