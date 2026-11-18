import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The job queue (docs/agent-fleet-plan.md §11.1): one JSON object per line in
 * `ai-job-search/apply_queue/queue.jsonl`, written by `/queue` there and read and updated
 * here. The file is read again on every call, so jobs `/queue` appends show up at once.
 */

export type JobStatus = 'queued' | 'claimed' | 'running' | 'ready' | 'submitted' | 'needsYou' | 'stuck' | 'skipped' | 'expired';
export const JOB_STATUSES: JobStatus[] = ['queued', 'claimed', 'running', 'ready', 'submitted', 'needsYou', 'stuck', 'skipped', 'expired'];

export interface QueueJob {
  id: string;
  source?: string;
  listingUrl?: string;
  applyUrl: string;
  applyKind?: string;
  ats?: string | null;
  company?: string;
  title?: string;
  location?: string;
  fit?: { score?: number; band?: string; notes?: string };
  tier?: 'A' | 'B';
  documents?: { resume?: string; coverLetter?: string };
  postingText?: string;
  status: JobStatus;
  statusNote?: string;
  worker?: string;
  /** ISO time the claim runs out; a job held past it goes back to `queued`. */
  leaseUntil?: string;
  tabUrl?: string;
  /** Fields an agent answered through POST /answers (#29), so the ready list says what to check. */
  agentAnswers?: { fieldId: string; at: string }[];
  createdAt: string;
  updatedAt: string;
  history: { at: string; status: JobStatus; note?: string; page?: number }[];
}

/** Query parameters that only say where a click came from (ai-job-search's apply_queue.py, extension ownJob.ts). */
const TRACKING = /^(utm_.*|gh_src|source|src|ref|refid|referrer|trk|trkinfo|trackingid|lever-source|lever-origin|iis|iisn|ccuid|mode|_ga|gclid|fbclid|mc_[a-z]+|sid|ebp|lipi)$/i;

/** One key per posting, however it was linked: LinkedIn's job id, else the address without trackers, fragment or trailing slash. */
export function postingKey(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim();
  }
  const host = url.hostname.toLowerCase();
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    const id = url.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/)?.[1] ?? url.searchParams.get('currentJobId');
    if (id) return `linkedin:${id}`;
  }
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return `${host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

/** A claim lasts this long unless the applier reports again. */
export const LEASE_MS = 20 * 60_000;
const HELD: JobStatus[] = ['claimed', 'running'];
/** A worker keeps these too, without a lease: it may not take another job until this one is ready (#67). */
const KEPT: JobStatus[] = ['needsYou', 'stuck'];

export class QueueStore {
  readonly file: string;
  private readonly now: () => number;
  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  private read(): { jobs: QueueJob[]; bad: string[] } {
    if (!existsSync(this.file)) return { jobs: [], bad: [] };
    const jobs: QueueJob[] = [];
    const bad: string[] = [];
    for (const line of readFileSync(this.file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const job = JSON.parse(line) as QueueJob;
        if (job && typeof job.id === 'string') jobs.push({ ...job, history: Array.isArray(job.history) ? job.history : [] });
        else bad.push(line);
      } catch {
        bad.push(line); // kept as it was, so nothing someone wrote by hand is lost
      }
    }
    return { jobs, bad };
  }

  private write(jobs: QueueJob[], bad: string[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, [...jobs.map((j) => JSON.stringify(j)), ...bad].map((l) => `${l}\n`).join(''));
    renameSync(tmp, this.file);
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  /** Read, change, write: `fn` returns what the caller gets back. */
  private change<T>(fn: (jobs: QueueJob[]) => T): T {
    const { jobs, bad } = this.read();
    const out = fn(jobs);
    this.write(jobs, bad);
    return out;
  }

  private mark(job: QueueJob, status: JobStatus, note?: string, page?: number): void {
    job.status = status;
    job.updatedAt = this.iso();
    if (note !== undefined) job.statusNote = note;
    job.history.push({ at: job.updatedAt, status, ...(note && { note }), ...(page !== undefined && { page }) });
  }

  /** Held jobs whose lease ran out go back to the queue. */
  private expireLeases(jobs: QueueJob[]): void {
    for (const j of jobs) {
      if (HELD.includes(j.status) && j.leaseUntil && Date.parse(j.leaseUntil) < this.now()) {
        delete j.worker;
        delete j.leaseUntil;
        this.mark(j, 'queued', 'lease ran out');
      }
    }
  }

  all(): QueueJob[] {
    return this.read().jobs;
  }

  get(id: string): QueueJob | null {
    return this.all().find((j) => j.id === id) ?? null;
  }

  /** Add jobs not already queued (by id). Returns the ids added. */
  add(jobs: Partial<QueueJob>[]): string[] {
    return this.addAll(jobs).added;
  }

  /**
   * Add jobs not already queued, by id or by the posting's address (#79: the owner may send a
   * posting the Scout queued already). `already` names the jobs that were there, with their status.
   */
  addAll(jobs: Partial<QueueJob>[]): { added: string[]; already: Pick<QueueJob, 'id' | 'status' | 'company' | 'title'>[] } {
    return this.change((all) => {
      const byId = new Map(all.map((j) => [j.id, j]));
      const byAddress = new Map<string, QueueJob>();
      for (const j of all) for (const u of [j.applyUrl, j.listingUrl]) if (u) byAddress.set(postingKey(u), j);
      const added: string[] = [];
      const already: Pick<QueueJob, 'id' | 'status' | 'company' | 'title'>[] = [];
      for (const j of jobs) {
        if (!j.id || !j.applyUrl) continue;
        const had = byId.get(j.id) ?? [j.applyUrl, j.listingUrl].map((u) => u && byAddress.get(postingKey(u))).find(Boolean);
        if (had) {
          already.push({ id: had.id, status: had.status, ...(had.company && { company: had.company }), ...(had.title && { title: had.title }) });
          continue;
        }
        const at = this.iso();
        const job: QueueJob = { ...j, id: j.id, applyUrl: j.applyUrl, status: 'queued', createdAt: j.createdAt ?? at, updatedAt: at, history: [{ at, status: 'queued' }] };
        all.push(job);
        byId.set(job.id, job);
        for (const u of [job.applyUrl, job.listingUrl]) if (u) byAddress.set(postingKey(u), job);
        added.push(job.id);
      }
      return { added, already };
    });
  }

  /**
   * The next queued job for `worker` (Tier A first, then oldest), leased for LEASE_MS. Jobs
   * `allow` refuses (the fleet switches, #54) stay queued for when they are turned back on.
   */
  claim(worker: string, allow: (j: QueueJob) => boolean = () => true): QueueJob | null {
    return this.change((all) => {
      this.expireLeases(all);
      const next = all
        .filter((j) => j.status === 'queued' && allow(j))
        .sort((a, b) => (a.tier === 'A' ? 0 : 1) - (b.tier === 'A' ? 0 : 1) || a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) return null;
      next.worker = worker;
      next.leaseUntil = this.iso(this.now() + LEASE_MS);
      this.mark(next, 'claimed', `claimed by ${worker}`);
      return structuredClone(next);
    });
  }

  /** The job `worker` hasn't finished yet (#67): held, or waiting on a field or a blocker. */
  unfinished(worker: string): QueueJob | null {
    const job = this.all().find((j) => j.worker === worker && (HELD.includes(j.status) || KEPT.includes(j.status)));
    return job ? structuredClone(job) : null;
  }

  /** Note that an agent answered one of the job's fields (#29). */
  noteAgentAnswer(id: string, fieldId: string): void {
    this.change((all) => {
      const job = all.find((j) => j.id === id);
      if (!job) return;
      const rest = (job.agentAnswers ?? []).filter((a) => a.fieldId !== fieldId);
      job.agentAnswers = [...rest, { fieldId, at: this.iso() }];
    });
  }

  /** A new status for a job. A held status renews the lease; needsYou and stuck keep the worker; any other one ends the claim. */
  setStatus(id: string, status: JobStatus, o: { note?: string; page?: number; tabUrl?: string } = {}): QueueJob | null {
    return this.change((all) => {
      const job = all.find((j) => j.id === id);
      if (!job) return null;
      if (HELD.includes(status)) job.leaseUntil = this.iso(this.now() + LEASE_MS);
      else if (KEPT.includes(status)) delete job.leaseUntil;
      else {
        delete job.leaseUntil;
        delete job.worker;
      }
      if (o.tabUrl) job.tabUrl = o.tabUrl;
      this.mark(job, status, o.note, o.page);
      return structuredClone(job);
    });
  }

  /**
   * Jobs held by a worker that isn't running any more (it ended mid-job) go back to `queued`, so
   * Start gives them to the appliers it starts (#77). Returns their ids.
   */
  releaseOrphans(isRunning: (worker: string) => boolean, note = 'back to the queue: its applier had ended'): string[] {
    return this.change((all) => {
      const ids: string[] = [];
      for (const j of all) {
        if (!j.worker || isRunning(j.worker) || !(HELD.includes(j.status) || KEPT.includes(j.status))) continue;
        delete j.worker;
        delete j.leaseUntil;
        this.mark(j, 'queued', note);
        ids.push(j.id);
      }
      return ids;
    });
  }

  /** The kill switch: every held job goes back to `queued`. Returns how many. */
  releaseAll(note = 'stopped by Stop all'): number {
    return this.change((all) => {
      let n = 0;
      for (const j of all) {
        if (!HELD.includes(j.status)) continue;
        delete j.worker;
        delete j.leaseUntil;
        this.mark(j, 'queued', note);
        n++;
      }
      return n;
    });
  }
}
