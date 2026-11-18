import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The Fixer's tickets (#32, plan §8): incidents grouped by site, kind and question, so the same
 * field missed on ten Greenhouse forms is one thing to fix. The Fixer writes a resolution on a
 * ticket; an incident filed after it opens the ticket again (the fix didn't hold). Incidents
 * stay as the bridge wrote them (redacted, outside git); resolutions sit beside them in
 * tickets.json.
 */

/** An incident as the extension filed it (extension/src/incidents/incident.ts › Incident). */
export interface IncidentFile {
  id: string;
  at?: string;
  receivedAt?: string;
  host?: string;
  ats?: string;
  kind?: string;
  jobId?: string;
  field?: { label?: string; kind?: string };
  stop?: { reason?: string };
  note?: string;
  siteMessage?: string;
}

export const OUTCOMES = ['fixed', 'answered', 'cantFix', 'needsYou'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface Resolution {
  outcome: Outcome;
  note?: string;
  at: string;
}

export interface Ticket {
  key: string;
  ats: string;
  kind: string;
  /** The question (a field's label) or, for a page that wouldn't move, the stop reason. */
  label: string;
  count: number;
  first: string;
  last: string;
  incidents: string[];
  jobIds: string[];
  resolution: Resolution | null;
  /** No resolution yet, or an incident came in after it. */
  open: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const whenOf = (i: IncidentFile) => i.at ?? i.receivedAt ?? '';

export function ticketOf(i: IncidentFile): { key: string; ats: string; kind: string; label: string } {
  const ats = i.ats || i.host || 'site';
  const kind = i.kind || 'unknown';
  const label = i.field?.label || i.stop?.reason || i.note || '(no label)';
  const key = `t-${createHash('sha1').update(`${ats}|${kind}|${norm(label)}`).digest('hex').slice(0, 10)}`;
  return { key, ats, kind, label };
}

export function groupTickets(incidents: IncidentFile[], resolutions: Record<string, Resolution>): Ticket[] {
  const byKey = new Map<string, Ticket>();
  for (const i of [...incidents].sort((a, b) => whenOf(a).localeCompare(whenOf(b)))) {
    const t = ticketOf(i);
    const at = whenOf(i);
    const got = byKey.get(t.key) ?? { ...t, count: 0, first: at, last: at, incidents: [], jobIds: [], resolution: resolutions[t.key] ?? null, open: true };
    got.count++;
    got.last = at;
    got.incidents.push(i.id);
    if (i.jobId && !got.jobIds.includes(i.jobId)) got.jobIds.push(i.jobId);
    byKey.set(t.key, got);
  }
  for (const t of byKey.values()) t.open = !t.resolution || t.last > t.resolution.at;
  return [...byKey.values()].sort((a, b) => b.last.localeCompare(a.last));
}

/** Every incident file under `dir` (`<date>/<id>.json`), skipping the bridge's and replay's own files. */
export function readIncidentFiles(dir: string): IncidentFile[] {
  if (!existsSync(dir)) return [];
  const out: IncidentFile[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...readIncidentFiles(p));
    else if (name.endsWith('.json') && name !== 'tickets.json' && !name.startsWith('replay-')) {
      try {
        const v = JSON.parse(readFileSync(p, 'utf8')) as IncidentFile;
        if (v && typeof v.id === 'string') out.push(v);
      } catch {
        /* half-written: the next read gets it */
      }
    }
  }
  return out;
}

export function readResolutions(file: string): Record<string, Resolution> {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Resolution>) : {};
  } catch {
    return {};
  }
}

export function writeResolutions(file: string, r: Record<string, Resolution>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(r, null, 2));
  renameSync(`${file}.tmp`, file);
}
