import type { RunState } from '../../extension/src/run/types.ts';
import { JOB_STATUSES, type JobStatus, type QueueJob } from './queue.ts';
import { DEFAULT_SETTINGS, type FleetSettings } from './settings.ts';

/**
 * What the Fleet Office page shows (#35): the queue, each applier and its job, the owner's
 * inbox and the recent activity, built from the queue file and the Runs the extension
 * reported. Pure, so it is tested without a server. Field labels and counts only, never a
 * field's value (the bridge never has them).
 */

/** A field as the extension reports it (bridgeFields): label, status and where its value came from. */
export interface ReportedField {
  id?: string;
  label?: string;
  status?: string;
  source?: string;
}

export interface OfficeJob {
  id: string;
  company: string;
  title: string;
  ats: string;
  location: string;
  tier: 'A' | 'B';
  fit: number | null;
  doc: string;
  status: JobStatus;
  statusNote: string;
  worker: string | null;
  /** One entry per page the Run has been on, the current one last. */
  pages: { filled: number; total: number }[];
  /** Who filled the fields on the current page. */
  src: { rules: number; answers: number; classifier: number; agent: number };
  /** Labels of fields an agent answered (check them before Submit), and of fields that need the owner. */
  agentAnswered: string[];
  needs: string[];
  /** When the bridge got the latest screenshot of the job's tab (#37), if it has one. */
  screenAt: string | null;
  updatedAt: string;
}

export interface OfficeEvent {
  at: string;
  who: string;
  text: string;
  tone?: 'ok' | 'warn';
}

export interface OfficeSnapshot {
  at: string;
  stopped: boolean;
  maxReadyOpen: number;
  counts: Record<JobStatus, number>;
  submittedToday: number;
  incidentsToday: number;
  /** Up to four applier desks, by when each worker was first seen. */
  workers: { name: string; job: OfficeJob | null }[];
  queue: OfficeJob[];
  ready: OfficeJob[];
  needs: OfficeJob[];
  stuck: OfficeJob[];
  events: OfficeEvent[];
  /** The fleet switches (#54), for the Office's Switches panel (#55). */
  settings: FleetSettings;
}

/** Ticker lines for a change of switches: "Switched off: LinkedIn Easy Apply". */
export function switchEvents(before: FleetSettings, after: FleetSettings, at: string): OfficeEvent[] {
  const out: OfficeEvent[] = [];
  for (const [group, values] of Object.entries(after) as [keyof FleetSettings, Record<string, boolean>][]) {
    for (const [key, on] of Object.entries(values)) {
      if ((before[group] as Record<string, boolean>)[key] === on) continue;
      out.push({ at, who: 'You', text: `Switched ${on ? 'on' : 'off'}: ${SWITCH_NAMES[`${group}.${key}`] ?? `${group}.${key}`}`, ...(!on && { tone: 'warn' as const }) });
    }
  }
  return out;
}

export const SWITCH_NAMES: Record<string, string> = {
  'parts.scout': 'Scout',
  'parts.appliers': 'Appliers',
  'parts.answerer': 'Answerer',
  'parts.fixer': 'Fixer',
  'parts.outreach': 'Outreach',
  'sources.linkedin': 'LinkedIn search',
  'sources.simplify': 'SimplifyJobs New-Grad list',
  'sources.recommendations': 'AI recommendations',
  'sources.jobbank': 'Job Bank',
  'sources.indeed': 'Indeed',
  'apply.external': 'Company sites',
  'apply.linkedinEasy': 'LinkedIn Easy Apply',
  'apply.indeedApply': 'Indeed Apply',
  'apply.tailored': 'Tailored CVs',
  'site.createAccounts': 'Creating site accounts',
  'site.gmailCodes': 'Reading codes from Gmail',
};

export const DESKS = 4;
const HELD: JobStatus[] = ['claimed', 'running'];
const DONE_STATUSES = new Set(['filled', 'review', 'prefilled']);

const atsName = (ats: string | null | undefined, url: string): string => {
  const a = (ats ?? '').toLowerCase();
  const known: Record<string, string> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday', smartrecruiters: 'SmartRecruiters', icims: 'iCIMS', linkedin: 'LinkedIn' };
  if (known[a]) return known[a];
  if (a) return ats!;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Job site';
  }
};

const docName = (j: QueueJob): string => {
  const r = j.documents?.resume;
  if (!r) return 'Default resume';
  const base = r.split(/[\\/]/).pop() ?? r;
  return j.tier === 'A' ? `Tailored CV (${base})` : base;
};

export function officeJob(j: QueueJob, report?: { run: RunState; fields: unknown[] }, screenAt: string | null = null): OfficeJob {
  const fields = (report?.fields ?? []) as ReportedField[];
  const agentIds = new Set((j.agentAnswers ?? []).map((a) => a.fieldId));
  const src = { rules: 0, answers: 0, classifier: 0, agent: 0 };
  for (const f of fields) {
    if (!DONE_STATUSES.has(f.status ?? '')) continue;
    if (f.id && agentIds.has(f.id)) src.agent++;
    else if (f.source === 'rule' || f.source === 'adapter') src.rules++;
    else if (f.source === 'answerBank') src.answers++;
    else if (f.source === 'classifier') src.classifier++;
  }
  const pages = (report?.run.history ?? []).map((s) => ({ filled: s.filled + s.review, total: s.filled + s.review + s.needs }));
  const page = report?.run.page ?? 0;
  if (fields.length && pages.length < page) {
    // The page it is on now, from the fields as last reported.
    const counted = fields.filter((f) => f.status !== 'skipped');
    pages.push({ filled: counted.filter((f) => DONE_STATUSES.has(f.status ?? '')).length, total: counted.length });
  }
  if (!pages.length) pages.push({ filled: 0, total: 0 });
  const byId = (id: string) => fields.find((f) => f.id === id)?.label ?? id;
  return {
    id: j.id,
    company: j.company ?? 'Unknown company',
    title: j.title ?? 'Untitled job',
    ats: atsName(j.ats, j.applyUrl),
    location: j.location ?? '',
    tier: j.tier ?? 'B',
    fit: typeof j.fit?.score === 'number' ? j.fit.score : null,
    doc: docName(j),
    status: j.status,
    statusNote: j.statusNote ?? '',
    worker: j.worker ?? null,
    pages,
    src,
    agentAnswered: [...agentIds].map(byId),
    needs: fields.filter((f) => f.status === 'needs').map((f) => f.label ?? f.id ?? '').filter(Boolean).slice(0, 6),
    screenAt,
    updatedAt: j.updatedAt,
  };
}

/** One line per history entry, in plain words, with the worker that held the job then. */
export function jobEvents(j: QueueJob): OfficeEvent[] {
  const name = j.company ?? 'a job';
  const out: OfficeEvent[] = [];
  let who = 'Queue';
  for (const h of j.history) {
    const claimed = /^claimed by (.+)$/.exec(h.note ?? '');
    if (claimed) who = claimed[1];
    const note = h.note ? `: ${h.note}` : '';
    const line: Record<JobStatus, [string, OfficeEvent['tone']?]> = {
      queued: [h.note ? `${name} went back to the queue (${h.note})` : `Queued ${name}: ${j.title ?? ''}`.trim()],
      claimed: [`Claimed ${name}: ${j.title ?? ''}`.trim()],
      running: [h.page ? `Run is on page ${h.page} at ${name}` : `Pressed Run at ${name}`],
      ready: [`Stopped at Submit on ${name}. It's in your inbox.`, 'ok'],
      submitted: [`${name}: application sent`, 'ok'],
      needsYou: [`${name} needs you${note}`, 'warn'],
      stuck: [`Stuck at ${name}${note}`, 'warn'],
      skipped: [`Skipped ${name}${note}`],
      expired: [`${name} expired`],
    };
    const [text, tone] = line[h.status] ?? [`${name}: ${h.status}`];
    out.push({ at: h.at, who: h.status === 'queued' && !h.note ? 'Queue' : who, text, ...(tone && { tone }) });
    if (h.status === 'queued') who = 'Queue';
  }
  return out;
}

export function officeSnapshot(o: {
  jobs: QueueJob[];
  runs: Map<string, { run: RunState; fields: unknown[] }>;
  /** Worker name → when it first asked for a job (ms). */
  workersSeen: Map<string, number>;
  stopped: boolean;
  maxReadyOpen: number;
  incidentsToday: number;
  /** Job id → when its latest screenshot came in. */
  screens?: Map<string, string>;
  settings?: FleetSettings;
  /** Lines that come from the bridge rather than a job (switch changes). */
  extraEvents?: OfficeEvent[];
  now: number;
}): OfficeSnapshot {
  const today = new Date(o.now).toISOString().slice(0, 10);
  const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  for (const j of o.jobs) counts[j.status] = (counts[j.status] ?? 0) + 1;
  const view = (j: QueueJob) => officeJob(j, o.runs.get(j.id), o.screens?.get(j.id) ?? null);
  const held = o.jobs.filter((j) => HELD.includes(j.status) && j.worker);
  const names = [...o.workersSeen.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);
  for (const j of held) if (!names.includes(j.worker!)) names.push(j.worker!);
  const workers = names.slice(0, DESKS).map((name) => {
    const j = held.find((x) => x.worker === name);
    return { name, job: j ? view(j) : null };
  });
  const newest = (a: QueueJob, b: QueueJob) => b.updatedAt.localeCompare(a.updatedAt);
  return {
    at: new Date(o.now).toISOString(),
    stopped: o.stopped,
    maxReadyOpen: o.maxReadyOpen,
    counts,
    submittedToday: o.jobs.filter((j) => j.status === 'submitted' && j.updatedAt.startsWith(today)).length,
    incidentsToday: o.incidentsToday,
    workers,
    // In claim order: Tier A first, then oldest (queue.ts › claim).
    queue: o.jobs
      .filter((j) => j.status === 'queued')
      .sort((a, b) => (a.tier === 'A' ? 0 : 1) - (b.tier === 'A' ? 0 : 1) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, 12)
      .map(view),
    ready: o.jobs.filter((j) => j.status === 'ready').sort(newest).map(view),
    needs: o.jobs.filter((j) => j.status === 'needsYou').sort(newest).map(view),
    stuck: o.jobs.filter((j) => j.status === 'stuck').sort(newest).slice(0, 12).map(view),
    events: [...o.jobs.flatMap(jobEvents), ...(o.extraEvents ?? [])].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
    settings: o.settings ?? DEFAULT_SETTINGS,
  };
}
