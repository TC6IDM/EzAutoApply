// The sprint's verdicts without GitHub or the usage endpoint: the lines, GO/SMALL/WRAP/STOP/UNKNOWN,
// when a size:L issue may start, the average cost, and what `finish` refuses. sprint.mjs imports
// these; .claude/tests/sprint.test.mjs tests them.

export const STALE_HOURS = 14;              // a sprint left behind by a crash stops counting this long after its last step
export const KEEP_GOING_STALE_HOURS = 8 * 24; // a keep-going sprint may wait out a weekly reset (maintainer, 2026-11-13)
export const DEFAULT_SMALL_AT = 80;         // only size:S issues start at or above this % (maintainer, 2026-11-13)
export const DEFAULT_NEW_AT = 94;           // no new issue at or above this % (either limit)
export const DEFAULT_STOP_AT = 96;          // checkpoint now at or above this % (every finished issue is already pushed, so it costs under 1%)
// On Fable a keep-going sprint's 55-minute wakes alone cost about 2% of the
// 5-hour window an hour (the owner, 2026-11-16, #82), so the lines sit lower
// there. Any other model keeps the three above.
export const FABLE_LINES = { smallAt: 70, newAt: 82, stopAt: 88 };
// A size:L issue rarely fits one 5-hour window, so it starts only in a keep-going
// sprint (which waits out a reset and carries on) and only with a fresh window:
// the 5-hour figure at most this (maintainer, 2026-11-13), the weekly under
// LARGE_WEEKLY_UNDER (maintainer, 2026-11-14: was at most 70%).
export const LARGE_SESSION_AT = 20;
export const LARGE_WEEKLY_UNDER = 92;
export const DEFAULT_ISSUE_COST = 12;       // % of the 5-hour window an issue is guessed to take until one is measured

export function defaultLines(model) {
  const name = model ? [model.id, model.name].filter(Boolean).join(' / ') : null;
  if (model && /fable/i.test(`${model.id} ${model.name}`)) return { ...FABLE_LINES, why: `the session's model is ${name}, where the waiting wakes cost more, so the lines sit lower` };
  return { smallAt: DEFAULT_SMALL_AT, newAt: DEFAULT_NEW_AT, stopAt: DEFAULT_STOP_AT, why: name ? `the session's model is ${name}` : 'the model of the session is not known (the status line has not reported it in the last 30 minutes), so the usual lines' };
}

export const until = iso => {
  if (!iso) return '?';
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  const at = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${at}, in ${m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`}`;
};

export function judge(u, s) {
  const newAt = s?.newAt ?? DEFAULT_NEW_AT, stopAt = s?.stopAt ?? DEFAULT_STOP_AT;
  const smallAt = Math.min(s?.smallAt ?? DEFAULT_SMALL_AT, newAt);
  if (u.error) return { verdict: 'UNKNOWN', smallAt, newAt, stopAt, used: null, line: `UNKNOWN: ${u.error}. Finish the current issue, then checkpoint.` };
  const used = Math.max(u.session ?? 0, u.weekly ?? 0);
  const binding = (u.weekly ?? 0) > (u.session ?? 0) ? 'weekly' : '5-hour';
  const verdict = used >= stopAt ? 'STOP' : used >= newAt ? 'WRAP' : used >= smallAt ? 'SMALL' : 'GO';
  const resets = binding === 'weekly' ? u.weeklyResets : u.sessionResets;
  const line = `${verdict}: 5-hour ${u.session ?? '?'}% (resets ${until(u.sessionResets)}) · weekly ${u.weekly ?? '?'}% (resets ${until(u.weeklyResets)}) · ${smallAt < newAt ? `small issues only from ${smallAt}%, ` : ''}no new issue from ${newAt}%, checkpoint at ${stopAt}%${u.stale ? ` (stale: ${u.stale})` : ''}`;
  const resumeInSeconds = resets ? Math.max(0, Math.round((Date.parse(resets) - Date.now()) / 1000) + 120) : null;
  return { verdict, smallAt, newAt, stopAt, used, binding, resumeInSeconds, line };
}

export const isLarge = labels => labels.some(l => (l.name ?? l) === 'size:L' || (l.name ?? l) === 'size:XL');
export function largeAllowed(u, s, asked = false) {
  if (!s?.keepGoing) return { ok: false, why: 'size:L only in a keep-going sprint (it waits out a reset and carries on)' };
  if (u.error || typeof u.session !== 'number' || typeof u.weekly !== 'number') return { ok: false, why: 'size:L needs a usage reading' };
  if (u.session > LARGE_SESSION_AT && !asked) return { ok: false, why: `size:L starts only in a fresh window (5-hour at most ${LARGE_SESSION_AT}%, now ${u.session}%)` };
  if (u.weekly >= LARGE_WEEKLY_UNDER) return { ok: false, why: `size:L needs weekly room (under ${LARGE_WEEKLY_UNDER}%, now ${u.weekly}%)` };
  return { ok: true, why: `size:L may start: a fresh window (5-hour ${u.session}%) in a keep-going sprint` };
}

export function averageCost(s) {
  const costs = (s?.done || []).map(d => d.cost).filter(c => typeof c === 'number' && c > 0);
  return costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) / costs.length) : null;
}

// Why `finish N` refuses, or null: the tree must be clean and the last (non-merge)
// commit must name #N, so the PR gains exactly that issue's commit; and a note is needed.
export function finishRefusal({ n, dirty, subject, note }) {
  if (dirty) return { code: 2, why: `Commit #${n} first (one commit per issue); the tree still has changes:\n${dirty}` };
  if (!new RegExp(`#${n}\\b`).test(subject)) return { code: 2, why: `The last commit ("${subject}") does not name #${n}. Commit the issue as "<title> (#${n})" first.` };
  if (!note) return { code: 1, why: 'finish needs --note "<what changed, where>" for the issue\'s In Review comment' };
  return null;
}
