import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A running /ezaa-sprint in the Fleet Office (#50): the issue it is on, what it finished and
 * passed over, its PR, the 5-hour and weekly usage and the verdict. Read-only from the
 * sprint's own files (`<temp>/ezaa-sprint`, written by .claude/skills/ezaa-sprint/sprint.mjs);
 * the only thing the Office can do to a sprint is ask it to wind down, through that script.
 */

// verdict.mjs › STALE_HOURS / KEEP_GOING_STALE_HOURS: a sprint stops counting this long after its last step.
const STALE_HOURS = 14;
const KEEP_GOING_STALE_HOURS = 8 * 24;

export type Verdict = 'GO' | 'SMALL' | 'WRAP' | 'STOP' | 'UNKNOWN';

export interface SprintUsage {
  session: number | null;
  weekly: number | null;
  sessionResets?: string;
  weeklyResets?: string;
  at: number;
}

interface SprintState {
  startedAt: string;
  branch: string;
  smallAt?: number;
  newAt?: number;
  stopAt?: number;
  keepGoing?: boolean;
  done?: { n: number; title?: string; cost?: number; repo?: string }[];
  skipped?: { n: number; why?: string }[];
  current?: { n: number; title?: string; repo?: string } | null;
  readings?: { at: string }[];
  windDown?: { at: string };
  pr?: number;
  /** Linked repos (#57), by name: that repo's PR number once it has one. */
  linked?: Record<string, { repo: string; pr?: number | null }>;
}

export interface SprintView {
  branch: string;
  startedAt: string;
  keepGoing: boolean;
  current: { n: number; title: string } | null;
  done: { n: number; title: string; cost: number | null }[];
  /** Passed over and never finished later. */
  skipped: { n: number; why: string }[];
  pr: number | null;
  linkedPrs: { repo: string; number: number; url: string }[];
  usage: { session: number | null; weekly: number | null; sessionResets: string | null; weeklyResets: string | null } | null;
  verdict: Verdict;
  lines: { smallAt: number; newAt: number; stopAt: number };
  windingDown: boolean;
}

/** The same rule as verdict.mjs › judge. */
export function verdictOf(u: SprintUsage | null, lines: { smallAt: number; newAt: number; stopAt: number }): Verdict {
  if (!u) return 'UNKNOWN';
  const used = Math.max(u.session ?? 0, u.weekly ?? 0);
  return used >= lines.stopAt ? 'STOP' : used >= lines.newAt ? 'WRAP' : used >= Math.min(lines.smallAt, lines.newAt) ? 'SMALL' : 'GO';
}

export function sprintView(s: SprintState | null, u: SprintUsage | null, now: number): SprintView | null {
  if (!s || typeof s.branch !== 'string') return null;
  const last = Date.parse(s.readings?.at(-1)?.at || s.startedAt);
  if (!(now - last <= (s.keepGoing ? KEEP_GOING_STALE_HOURS : STALE_HOURS) * 3600e3)) return null;
  const lines = { smallAt: s.smallAt ?? 80, newAt: s.newAt ?? 94, stopAt: s.stopAt ?? 96 };
  const done = (s.done ?? []).map((d) => ({ n: d.n, title: d.title ?? `#${d.n}`, cost: d.cost ?? null }));
  const finished = new Set(done.map((d) => d.n));
  const skipped = (s.skipped ?? []).filter((d) => !finished.has(d.n)).map((d) => ({ n: d.n, why: d.why ?? '' }));
  const pr = typeof s.pr === 'number' ? s.pr : null;
  return {
    branch: s.branch,
    startedAt: s.startedAt,
    keepGoing: Boolean(s.keepGoing),
    current: s.current ? { n: s.current.n, title: s.current.title ?? `#${s.current.n}` } : null,
    done,
    skipped,
    pr,
    linkedPrs: Object.values(s.linked ?? {}).flatMap((l) => (typeof l.pr === 'number' && /^[\w.-]+\/[\w.-]+$/.test(l.repo) ? [{ repo: l.repo, number: l.pr, url: `https://github.com/${l.repo}/pull/${l.pr}` }] : [])),
    usage: u ? { session: u.session, weekly: u.weekly, sessionResets: u.sessionResets ?? null, weeklyResets: u.weeklyResets ?? null } : null,
    verdict: verdictOf(u, lines),
    lines,
    windingDown: Boolean(s.windDown),
  };
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

/**
 * The sprint as its own files say, or null when none is running. Usage: the status line's
 * copy while under 5 minutes old, else the endpoint's cache while under 20 (sprint.mjs › usage).
 */
export function readSprint(dir: string, now: number): SprintView | null {
  const state = readJson<SprintState>(join(dir, 'state.json'));
  if (!state) return null;
  const line = readJson<SprintUsage>(join(dir, 'statusline-usage.json'));
  const cache = readJson<SprintUsage>(join(dir, 'usage.json'));
  const usage = line && now - line.at < 5 * 60e3 ? line : cache && now - cache.at < 20 * 60e3 ? cache : null;
  return sprintView(state, usage, now);
}
