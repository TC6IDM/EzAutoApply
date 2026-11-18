import type { FieldInfo, FillStatus, Resolution } from '../fill/types';
import type { Incident } from './incident';

/**
 * `npm run replay` (#19): every stored incident becomes a regression case. Its redacted page
 * snippet is scanned again and run through `resolveFields`, and the outcome is compared with
 * the baseline, which holds the outcomes accepted so far. A Fixer's change must not make a case
 * worse; a case that gets better is the fix showing. Pure: the runner
 * (tests/replay/replay.test.ts) supplies the DOM, the profile and the files.
 */

export interface Outcome {
  key?: string;
  status: FillStatus | string;
  source?: string;
}

export interface ReplayCase {
  id: string;
  ats: string;
  label: string;
  /** What the extension did when the incident was filed. */
  then: Outcome;
  /** What it does now, or null when the field can't be found in the snippet again. */
  now: Outcome | null;
}

/** Incidents about what to fill (not how a widget took it, or a page that wouldn't move). */
export function replayable(i: Partial<Incident>): boolean {
  return !!i.field && !!i.domSnippet && (i.kind === 'unmatched' || i.kind === 'rejected' || i.kind === 'wrongValue');
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The incident's field among the rescanned ones: same label, then a label containing it, then the only one of its kind. */
export function pickField<T extends FieldInfo>(fields: T[], label: string, kind?: string): T | null {
  const want = norm(label);
  const exact = fields.find((f) => norm(f.label) === want);
  if (exact) return exact;
  const near = want ? fields.filter((f) => norm(f.label).includes(want) || (norm(f.label) && want.includes(norm(f.label)))) : [];
  if (near.length === 1) return near[0];
  const same = fields.filter((f) => f.kind === kind);
  return same.length === 1 ? same[0] : null;
}

export const outcomeOf = (r: Resolution): Outcome => ({ ...(r.key && { key: r.key }), status: r.status, source: r.source });

/** How good a status is: anything filled beats a value to check, which beats nothing. */
const RANK: Record<string, number> = { needs: 0, skipped: 0, review: 1, prefilled: 2, filled: 2 };
const rank = (o: Outcome | null) => (o ? (RANK[o.status] ?? 0) : -1);

export interface ReplayReport {
  /** Worse than the accepted outcome: a lower status, or a different key than one accepted. */
  regressed: { case: ReplayCase; was: Outcome | null }[];
  /** Better than accepted: a status up, or a key where there was none. */
  improved: { case: ReplayCase; was: Outcome | null }[];
  unchanged: ReplayCase[];
  /** Not in the baseline yet. */
  fresh: ReplayCase[];
}

export function compareReplay(baseline: Record<string, Outcome | null>, cases: ReplayCase[]): ReplayReport {
  const out: ReplayReport = { regressed: [], improved: [], unchanged: [], fresh: [] };
  for (const c of cases) {
    if (!(c.id in baseline)) {
      out.fresh.push(c);
      continue;
    }
    const was = baseline[c.id];
    const keyLost = !!was?.key && c.now?.key !== was.key;
    if (rank(c.now) < rank(was) || keyLost) out.regressed.push({ case: c, was });
    else if (rank(c.now) > rank(was) || (!was?.key && !!c.now?.key)) out.improved.push({ case: c, was });
    else out.unchanged.push(c);
  }
  return out;
}

/** The baseline after accepting this run. */
export const acceptReplay = (cases: ReplayCase[]): Record<string, Outcome | null> => Object.fromEntries(cases.map((c) => [c.id, c.now]));

const show = (o: Outcome | null) => (o ? `${o.status}${o.key ? ` (${o.key})` : ''}` : 'not found');

/** The report as plain lines for the terminal. */
export function replayLines(r: ReplayReport): string[] {
  const line = (x: { case: ReplayCase; was: Outcome | null }) => `  ${x.case.ats} · "${x.case.label}": ${show(x.was)} → ${show(x.case.now)}`;
  return [
    `replay: ${r.regressed.length} worse, ${r.improved.length} better, ${r.unchanged.length} unchanged, ${r.fresh.length} new`,
    ...(r.regressed.length ? ['Worse than accepted:', ...r.regressed.map(line)] : []),
    ...(r.improved.length ? ['Better than accepted:', ...r.improved.map(line)] : []),
    ...(r.fresh.length ? ['New (not in the baseline yet):', ...r.fresh.map((c) => line({ case: c, was: c.then }))] : []),
  ];
}
