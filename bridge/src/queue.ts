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
  createdAt: string;
  updatedAt: string;
  history: { at: string; status: JobStatus; note?: string; page?: number }[];
}

/** A claim lasts this long unless the applier reports again. */
export const LEASE_MS = 20 * 60_000;
const HELD: JobStatus[] = ['claimed', 'running'];

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
    return this.change((all) => {
      const have = new Set(all.map((j) => j.id));
      const added: string[] = [];
      for (const j of jobs) {
        if (!j.id || !j.applyUrl || have.has(j.id)) continue;
        const at = this.iso();
        all.push({ ...j, id: j.id, applyUrl: j.applyUrl, status: 'queued', createdAt: j.createdAt ?? at, updatedAt: at, history: [{ at, status: 'queued' }] });
        have.add(j.id);
        added.push(j.id);
      }
      return added;
    });
  }

  /** The next queued job for `worker` (Tier A first, then oldest), leased for LEASE_MS. */
  claim(worker: string): QueueJob | null {
    return this.change((all) => {
      this.expireLeases(all);
      const next = all
        .filter((j) => j.status === 'queued')
        .sort((a, b) => (a.tier === 'A' ? 0 : 1) - (b.tier === 'A' ? 0 : 1) || a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) return null;
      next.worker = worker;
      next.leaseUntil = this.iso(this.now() + LEASE_MS);
      this.mark(next, 'claimed', `claimed by ${worker}`);
      return structuredClone(next);
    });
  }

  /** A new status for a job. A held status renews the lease; any other one ends it. */
  setStatus(id: string, status: JobStatus, o: { note?: string; page?: number; tabUrl?: string } = {}): QueueJob | null {
    return this.change((all) => {
      const job = all.find((j) => j.id === id);
      if (!job) return null;
      if (HELD.includes(status)) job.leaseUntil = this.iso(this.now() + LEASE_MS);
      else {
        delete job.leaseUntil;
        delete job.worker;
      }
      if (o.tabUrl) job.tabUrl = o.tabUrl;
      this.mark(job, status, o.note, o.page);
      return structuredClone(job);
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
