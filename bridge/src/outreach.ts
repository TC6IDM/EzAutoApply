import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The owner's recruiter page (#41, #58): the people ai-job-search's /prospects found and the
 * messages it drafted for them (its tools/prospects.py writes them), shown in the Office with
 * copy buttons. The owner sends every message by hand and marks it here, so nobody is written
 * to twice. The file holds real people's names: it lives outside both repos
 * (~/.ezautoapply/outreach/prospects.jsonl) and is never committed, published or put in an
 * incident. Nothing here sends anything.
 */

export const PROSPECT_STATUSES = ['found', 'sent', 'replied', 'skip'] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export const CHANNELS = ['linkedin', 'email'] as const;

export interface Prospect {
  id: string;
  status: ProspectStatus;
  found_at: string;
  company: string;
  name: string;
  title: string;
  source_url: string;
  profile_url?: string;
  email?: string;
  email_source?: string;
  role?: string;
  role_url?: string;
  why?: string;
  messages?: { note: string; follow_up: string; reason: string; reason_source: string; email_subject?: string; email_body?: string };
  drafted_at?: string;
  /** /outreach (#119): the id of the draft it put in the owner's Gmail; the owner sends it there. */
  gmail_draft?: string;
  gmail_drafted_at?: string;
  sent_at?: string;
  replied_at?: string;
  skip_at?: string;
  channel?: string;
}

export function readProspects(file: string): Prospect[] {
  if (!existsSync(file)) return [];
  const out: Prospect[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as Prospect;
      if (p && typeof p.id === 'string' && typeof p.name === 'string') out.push(p);
    } catch {
      /* a half-written line; the rest still counts */
    }
  }
  return out;
}

function writeProspects(file: string, rows: Prospect[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, rows.map((r) => JSON.stringify(r) + '\n').join(''));
  renameSync(`${file}.tmp`, file);
}

/** Records what the owner did (the same fields tools/prospects.py › mark writes). Null for an unknown id. */
export function markProspect(file: string, id: string, status: ProspectStatus, channel: string | undefined, at: string): Prospect | null {
  const rows = readProspects(file);
  const p = rows.find((r) => r.id === id);
  if (!p) return null;
  p.status = status;
  p[`${status}_at`] = at;
  if (channel) p.channel = channel;
  writeProspects(file, rows);
  return p;
}

/**
 * What the Office shows: people with messages ready to send (oldest first), then those
 * written to (newest first). People still waiting for a draft, and skipped ones, stay out.
 */
export function recruiterView(rows: Prospect[], max = 30): Prospect[] {
  const ready = rows.filter((r) => r.status === 'found' && r.messages).sort((a, b) => a.found_at.localeCompare(b.found_at));
  const done = rows
    .filter((r) => r.status === 'sent' || r.status === 'replied')
    .sort((a, b) => (b.replied_at ?? b.sent_at ?? '').localeCompare(a.replied_at ?? a.sent_at ?? ''));
  return [...ready, ...done].slice(0, max);
}
