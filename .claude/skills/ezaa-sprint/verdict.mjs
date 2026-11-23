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

// Why the issue in hand is no longer this sprint's, or null. `begin` checks once, but a
// sprint paused at a checkpoint resumes hours later, and meanwhile someone may have taken
// the issue, built it and merged it: carrying on builds it twice and `finish` reopens it.
// So `finish`, `next` and `budget` ask again: closed, or assigned only to other people.
export function takenAway({ state, assignees = [], me, also = [] }) {
  if (state && state !== 'OPEN') return 'closed';
  const ours = new Set([me, ...also]);
  if (assignees.length && !assignees.some(a => ours.has(a))) return `assigned to ${assignees.join(', ')}`;
  return null;
}

// ---------- usage per issue (#49) ----------
// The board keeps what each finished issue took ("Usage %": the 5-hour window it
// used), so the sizes' costs are measured across sprints instead of guessed.
export const USAGE_FIELD = 'Usage %';
export const MEASURED_AFTER = 5;               // a size's own average is used once this many are measured
export const SIZE_FACTOR = { XS: 0.5, S: 1, M: 2, L: 4, XL: 8 }; // the guess, relative to an S

/**
 * What an issue used, from the reading at `begin` to now: { session, weekly } in
 * points of each limit. A figure that went down (its limit reset meanwhile) or
 * wasn't read is null.
 */
export function issueUsage(start, u) {
  if (!start || !u || u.error) return { session: null, weekly: null };
  const delta = (now, then) => (typeof now === 'number' && typeof then === 'number' && now >= then ? now - then : null);
  return { session: delta(u.session, start.sessionAtStart), weekly: delta(u.weekly, start.weeklyAtStart) };
}

/** "used about 4% of the 5-hour window, 1% of the week", or null when neither was measured. */
export function usageNote({ session, weekly }) {
  const parts = [session !== null && `${session}% of the 5-hour window`, weekly !== null && `${weekly}% of the week`].filter(Boolean);
  return parts.length ? `used about ${parts.join(', ')}` : null;
}

const sizeOf = s => String(s ?? '').replace(/^size:/, '').toUpperCase() || null;

/** Per size, from board rows [{ size, usage }]: { S: { n, avg }, … } (only measured rows count). */
export function sizeAverages(rows) {
  const by = {};
  for (const r of rows || []) {
    const size = sizeOf(r.size);
    if (!size || typeof r.usage !== 'number' || !Number.isFinite(r.usage)) continue;
    (by[size] ||= []).push(r.usage);
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.length, avg: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 }]));
}

/**
 * The expected cost of an issue of `size`: its measured average once MEASURED_AFTER
 * are on the board, else a guess (this sprint's average, else DEFAULT_ISSUE_COST, for an S,
 * scaled by SIZE_FACTOR). { cost, measured, n }.
 */
export function expectedCost(size, averages, sprintAverage = null) {
  const key = sizeOf(size) || 'S';
  const m = averages?.[key];
  if (m && m.n >= MEASURED_AFTER) return { cost: m.avg, measured: true, n: m.n };
  const base = sprintAverage ?? DEFAULT_ISSUE_COST;
  return { cost: Math.round(base * (SIZE_FACTOR[key] ?? 1)), measured: false, n: m?.n ?? 0 };
}

/**
 * Issues whose measured usage sits nearer another size's average than their own
 * label's (only sizes with at least `min` measured count). [{ n, size, usage, looks }].
 */
export function misSized(rows, averages, min = 3) {
  const known = Object.entries(averages || {}).filter(([, v]) => v.n >= min);
  if (known.length < 2) return [];
  const out = [];
  for (const r of rows || []) {
    const size = sizeOf(r.size);
    if (!size || typeof r.usage !== 'number') continue;
    const nearest = known.reduce((best, [k, v]) => (Math.abs(v.avg - r.usage) < Math.abs(best[1].avg - r.usage) ? [k, v] : best));
    if (nearest[0] !== size && known.some(([k]) => k === size)) out.push({ n: r.n, size, usage: r.usage, looks: nearest[0] });
  }
  return out;
}

// ---------- the checkpoint's decision questions ----------

/** When a limit resets, short: "8:00 PM" on the same day, "Sun 9:00 AM" on another; null without a time. */
export function resetLabel(iso, now = new Date(), timeZone) {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const day = d => d.toLocaleDateString('en-US', { timeZone });
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  return day(at) === day(now) ? time : `${at.toLocaleDateString('en-US', { weekday: 'short', timeZone })} ${time}`;
}

/** "5-hour 77% (resets 8:00 PM), weekly 39% (resets Sun 9:00 AM)" for one reading. */
export function readingLine(r, now = new Date(), timeZone) {
  const pct = v => (v ?? '?') + '%';
  const when = iso => { const l = resetLabel(iso, now, timeZone); return l ? ` (resets ${l})` : ''; };
  return `5-hour ${pct(r.session)}${when(r.sessionResets)}, weekly ${pct(r.weekly)}${when(r.weeklyResets)}`;
}

/**
 * The PR's Usage section: the reading at the start, each checkpoint's, then the
 * latest one (left out when it is that last checkpoint's). [] with no readings.
 */
export function usageLines(readings = [], resets = 0, timeZone) {
  const first = readings[0], last = readings.at(-1);
  if (!first || !last) return [];
  const at = r => new Date(r.at).toLocaleString(undefined, timeZone ? { timeZone } : undefined);
  const line = (label, r) => `- ${label} (${at(r)}): ${readingLine(r, new Date(r.at), timeZone)}`;
  const checkpoints = readings.filter(r => r !== first && r.step === 'checkpoint');
  const lines = ['## Usage', line('At the start', first), ...checkpoints.map((r, i) => line(`Checkpoint ${i + 1}`, r))];
  if (last !== first && last !== checkpoints.at(-1)) lines.push(line('Latest reading', last));
  if (resets) lines.push(`- The 5-hour window reset ${resets}× during the sprint`);
  return lines;
}

/** The hidden mark on the checkpoint's questions comment, so a resumed sprint finds it. */
export const DECISIONS_MARK = '<!-- sprint-decisions -->';

// ---------- open decisions (claude-workflow#7) ----------
// The owner, 2026-11-23: every "Decisions waiting" post carries ALL the open
// decisions, not only the newest; one asked once and left unanswered must not
// get buried. A question stays open until someone with write access answers it
// under any post that listed it, or the sprint settles it (`settle N`, or its
// issue closed). Numbers are the question's own and stay the same in every post.

/** Who may answer: the PR's comment author association. */
export const ANSWERERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Gives every question a stable number (1, 2, 3… in the order asked), keeping ones it has. */
export function numberQuestions(questions = []) {
  let next = Math.max(0, ...questions.map(q => q.n || 0)) + 1;
  for (const q of questions) if (!q.n) q.n = next++;
  return questions;
}

const POST_ITEM = /^(\d{1,3})\. (?:\*\*#\d+:\*\* )?(.+)$/;
/** A decisions post's questions: Map(number as printed in that post → question text). */
export function postedQuestions(body) {
  const map = new Map();
  for (const line of String(body || '').split('\n')) {
    const m = line.match(POST_ITEM);
    if (m) map.set(Number(m[1]), m[2].trim());
  }
  return map;
}

/** The numbers a reply answers, among those its post listed ("1 B", "1.B", "2. A 3. C", "2 keep main"). */
export function answeredNumbers(body, listed) {
  const found = new Set();
  for (const m of String(body || '').matchAll(/(?:^|[\s,;(])(\d{1,3})\s*[.):-]?\s*[A-Za-z]/gm)) if (listed.has(Number(m[1]))) found.add(Number(m[1]));
  // A post with one question: any reply from someone who may answer is its answer.
  if (!found.size && listed.size === 1 && String(body || '').trim()) found.add([...listed.keys()][0]);
  return found;
}

/**
 * The texts of the questions answered anywhere in the PR's comments: each reply
 * from someone who may answer counts for the post above it (numbers as that post
 * printed them, so posts from before stable numbers still count).
 */
export function answeredTexts(comments = [], answerers = ANSWERERS) {
  const done = new Set();
  let listed = null;
  for (const c of comments) {
    const body = String(c.body || '');
    if (body.includes(DECISIONS_MARK)) { listed = postedQuestions(body); continue; }
    if (!listed || !answerers.has(c.association)) continue;
    for (const n of answeredNumbers(body, listed)) done.add(listed.get(n));
  }
  return done;
}

/** The questions still open: not settled, and not answered in the thread. */
export function openQuestions(questions = [], answered = new Set()) {
  return questions.filter(q => !q.settled && !q.answered && !answered.has(String(q.text).trim()));
}

const shortDate = iso => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The one PR comment a checkpoint posts: EVERY open question (new ones and ones
 * asked before and not yet answered) with its own number, its options, the
 * recommended one and any artifact link. null when nothing is open.
 */
export function decisionsComment(questions, attribution = '', answered = new Set()) {
  const open = openQuestions(numberQuestions(questions || []), answered);
  if (!open.length) return null;
  const again = open.filter(q => q.posted).length;
  const lines = [DECISIONS_MARK, '## Decisions waiting',
    `Every open decision is here${again ? `, including ${again} asked before and not answered yet` : ''}. Answer under this comment (a number and a letter is enough, e.g. "${open[0].n} B"); the sprint reads the answers when it resumes.`, ''];
  open.forEach(q => {
    lines.push(`${q.n}. ${q.issue ? `**#${q.issue}:** ` : ''}${q.text}`);
    if (q.posted) lines.push(`   - _Asked before${q.firstPosted || q.at ? ` (first ${shortDate(q.firstPosted || q.at)})` : ''}, still open._`);
    (q.options || []).forEach((o, k) => {
      const letter = String.fromCharCode(65 + k);
      const recommended = q.recommend && (q.recommend === o || q.recommend.toUpperCase() === letter);
      lines.push(`   - ${letter}. ${o}${recommended ? ' **(recommended)**' : ''}`);
    });
    if (q.recommend && !(q.options || []).some((o, k) => q.recommend === o || q.recommend.toUpperCase() === String.fromCharCode(65 + k))) lines.push(`   - Recommended: ${q.recommend}`);
    if (q.link) lines.push(`   - Mock-ups: ${q.link}`);
  });
  if (attribution) lines.push('', attribution);
  return lines.join('\n');
}

/**
 * The comments after the last questions post: [{ author, at, body, url }]. Empty
 * when no post was made, or nobody has answered since. `seen` skips ones shown already.
 */
export function answersSince(comments, seen = null) {
  const list = comments || [];
  let last = -1;
  list.forEach((c, i) => { if (String(c.body || '').includes(DECISIONS_MARK)) last = i; });
  if (last < 0) return [];
  return list.slice(last + 1).filter(c => !String(c.body || '').includes(DECISIONS_MARK) && (!seen || c.at > seen));
}

// ---------- the PR's "Now working on" line (claude-workflow#1) ----------
const clock = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const span = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`; };

// Why a sprint stopped, for the PR's top line (claude-workflow#9; the owner, 2026-11-23: "the top of
// a PR will always show status"). Set by checkpoint (inferred, or --reason) and end.
export const STOP_REASONS = {
  limit: '⏸ Usage limit reached, checkpointed',
  'wind-down': '⏹ Wound down on request, checkpointed',
  'nothing-left': '✅ Work done: nothing left this sprint can take, checkpointed',
  ended: '⏹ Sprint ended',
  checkpoint: '⏸ Checkpointed',
};

/** Why a checkpoint stopped: the person's --reason, else the budget, a wind-down, or nothing left. */
export function stopReason({ given, verdict, windDown, nothingLeftAt }) {
  if (given && STOP_REASONS[given]) return given;
  if (verdict === 'WRAP' || verdict === 'STOP') return 'limit';
  if (windDown) return 'wind-down';
  if (nothingLeftAt) return 'nothing-left';
  return 'checkpoint';
}

/**
 * The line at the top of the sprint's PR, always there: while it runs, the issue
 * being built and since when (or that it waits on a permission answer on the PR,
 * or is between issues); once stopped, why and when, and what is left to look at.
 */
export function nowLine(s, running, now = Date.now()) {
  if (!s) return null;
  if (running) {
    const c = s.current;
    if (c?.waitingOn) return `**Now:** ⏳ waiting on a permission answer on this PR (${c.waitingOn.id}, asked ${clock(c.waitingOn.at)}) for #${c.n}${c.title ? ` ${c.title}` : ''}. Reply \`allow\` or \`deny\` under it.`;
    if (c) return `**Now working on:** #${c.n}${c.title ? ` ${c.title}` : ''}${c.repo ? ` (in ${c.repo})` : ''} · since ${clock(c.at)} (${span(now - Date.parse(c.at))} at the last update)`;
    const last = s.done?.at(-1)?.at;
    return `**Now:** between issues${last ? ` (last one finished ${clock(last)})` : ''}`;
  }
  const reason = s.ended ? 'ended' : s.status?.reason || 'checkpoint';
  const at = s.status?.at;
  // Which limit stopped it and when that one resets: the higher figure of the last reading.
  let resets = '';
  const r = s.readings?.at(-1);
  if (reason === 'limit' && r) {
    const weekly = (r.weekly ?? -1) > (r.session ?? -1);
    const when = resetLabel(weekly ? r.weeklyResets : r.sessionResets, new Date(now));
    if (when) resets = `${weekly ? 'weekly limit' : '5-hour limit'} resets ${when}`;
  }
  // When the paused sprint's next loop is sent (checkpoint --wake-in / --next-wake).
  const next = s.ended ? '' : s.nextWake ? `next loop about ${resetLabel(s.nextWake, new Date(now))}` : 'no next loop scheduled';
  const done = (s.done || []).filter(d => !d.repo).length;
  const waiting = (s.handedOff || []).length;
  const decisions = (s.questions || []).filter(q => !q.settled && !q.answered).length;
  const tail = [resets, next, `${done} done`, waiting ? `${waiting} waiting on a person` : '', decisions ? `${decisions} decision${decisions === 1 ? '' : 's'} open (see the latest "Decisions waiting" comment)` : ''].filter(Boolean).join(' · ');
  return `**Status:** ${STOP_REASONS[reason]}${at ? ` ${clock(at)}` : ''} · ${tail}`;
}

// ---------- when a paused sprint wakes (claude-workflow#4) ----------
/**
 * The time of the next wake from checkpoint's --wake-in <seconds> or
 * --next-wake <time>, as an ISO string, or null when neither is given or it
 * cannot be read (the PR then says nothing about a wake rather than a wrong one).
 */
export function wakeAt({ wakeIn, nextWake } = {}, now = Date.now()) {
  if (wakeIn != null && wakeIn !== '') {
    const seconds = Number(wakeIn);
    return Number.isFinite(seconds) && seconds > 0 ? new Date(now + seconds * 1000).toISOString() : null;
  }
  if (nextWake) {
    const at = Date.parse(nextWake);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  return null;
}

/** The last line of a sprint PR that is not running: ended, paused until a known wake, or checkpointed. */
export function pauseLine(s) {
  if (s?.ended) return '_The sprint has ended: no wake follows. Whatever is left is listed above; a new sprint picks it up._';
  if (s?.nextWake) return `_The sprint is paused: next wake about ${clock(s.nextWake)} (${new Date(s.nextWake).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}). Then it reads the answers under its questions and the Inbox, and carries on._`;
  return '_The sprint has checkpointed: CI runs once on this state. Nothing more arrives unless it resumes after a usage reset._';
}

// ---------- finish, run again after it died half way ----------
/**
 * The done list with `entry` in it once. A `finish` that hung or died after it
 * wrote the state (on a stalled gh call, say) and is run again replaces its own
 * line instead of adding a second one, and keeps the cost the first run measured
 * (the rerun no longer knows when the issue began) and what it had already done.
 */
export function withDone(done, entry) {
  const list = done || [];
  const i = list.findIndex(d => d.n === entry.n && (d.repo || null) === (entry.repo || null));
  if (i < 0) return [...list, entry];
  const before = list[i];
  const merged = { ...before, ...entry };
  for (const k of ['cost', 'weeklyCost', 'title', 'pr', 'reviewed']) if (entry[k] == null && before[k] != null) merged[k] = before[k];
  return list.map((d, k) => (k === i ? merged : d));
}

// ---------- stalls: where a session's wall-clock time went ----------
// Reads Claude Code's own transcript lines (the JSONL under ~/.claude/projects)
// and finds every gap of `minMinutes` or more between one step and the next,
// with what it was waiting on. It reports tool names, the first words of a
// command and times: never a file's contents, a message or a tool's output.
const head = (text, n = 70) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
const blocks = e => (Array.isArray(e.message?.content) ? e.message.content : []);
const textOf = e => (typeof e.message?.content === 'string' ? e.message.content : blocks(e).filter(b => b.type === 'text').map(b => b.text).join(' '));

/** One tool call as a short label: `Bash: node sprint.mjs finish 723 --note "…` */
export function toolLabel(b) {
  const i = b.input || {};
  const bg = i.run_in_background ? ' (in the background)' : '';
  if (b.name === 'Bash' || b.name === 'PowerShell') return `${b.name}: ${head(i.command)}${bg}`;
  if (b.name === 'ScheduleWakeup') return `ScheduleWakeup ${i.stop ? 'stop' : `${i.delaySeconds} s`}`;
  if (b.name === 'Agent' || b.name === 'Task') return `${b.name}: ${head(i.description, 50)}${bg}`;
  if (b.name === 'Monitor') return `Monitor${i.timeout ? ` (${i.timeout} ms)` : ''}`;
  if (i.file_path) return `${b.name}: ${String(i.file_path).split(/[\/]/).pop()}`;
  return b.name;
}

/** What one transcript line is, for the gap finder. */
export function stepKind(e) {
  if (e.type === 'assistant') {
    const tools = blocks(e).filter(b => b.type === 'tool_use');
    return tools.length ? { kind: 'tool', tools } : { kind: 'reply' };
  }
  if (e.type !== 'user') return { kind: 'other' };
  if (blocks(e).some(b => b.type === 'tool_result')) return { kind: 'result' };
  const text = textOf(e);
  if (/<task-notification>/.test(text)) return { kind: 'prompt', from: 'a background task finishing' };
  if (/<command-name>|<<autonomous-loop/.test(text)) return { kind: 'prompt', from: 'the loop prompt (a ScheduleWakeup firing, or a typed /command)' };
  if (e.isMeta) return { kind: 'prompt', from: 'Claude Code itself' };
  return { kind: 'prompt', from: 'a message from the person' };
}

/**
 * [{ at, minutes, cause, what }] for each gap of at least `minMinutes`.
 * cause: 'tool' (a tool call took that long), 'model' (Claude's reply did:
 * a slow or retried stream), 'idle' (the turn had ended: nothing ran until a
 * wake, a notification or the person), 'other'.
 */
export function findStalls(entries, { minMinutes = 5 } = {}) {
  const steps = (entries || []).filter(e => e && e.timestamp && !e.isSidechain && (e.type === 'user' || e.type === 'assistant'))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const out = [];
  let turn = [];   // the tool calls since the last prompt, to say what an idle turn left running
  for (let i = 0; i < steps.length; i++) {
    const k = stepKind(steps[i]);
    const gap = i > 0 ? describeGap(steps[i - 1], steps[i], k, turn, minMinutes) : null;
    if (gap) out.push(gap);
    // After the gap: a wake prompt closes the turn it is about.
    if (k.kind === 'prompt') turn = [];
    if (k.kind === 'tool') turn.push(...k.tools);
  }
  return out;
}

function describeGap(prev, step, k, turn, minMinutes) {
  const minutes = (Date.parse(step.timestamp) - Date.parse(prev.timestamp)) / 60000;
  if (minutes < minMinutes) return null;
  const p = stepKind(prev);
  let cause = 'other', what;
  if (p.kind === 'tool' && k.kind === 'result') { cause = 'tool'; what = p.tools.map(toolLabel).join(' + '); }
  else if ((p.kind === 'result' || p.kind === 'prompt') && (k.kind === 'tool' || k.kind === 'reply')) { cause = 'model'; what = "Claude's reply (a slow or retried response, or long thinking)"; }
  else if ((p.kind === 'reply' || p.kind === 'tool') && k.kind === 'prompt') {
    cause = 'idle';
    const wake = [...turn].reverse().find(b => b.name === 'ScheduleWakeup');
    const left = turn.filter(b => b.input?.run_in_background).map(toolLabel);
    what = `the turn ended${wake ? ` with ${toolLabel(wake)}` : ' with no wake scheduled'}${left.length ? `, leaving ${left.join(' + ')}` : ''}; woken by ${k.from}`;
  } else what = `${p.kind} → ${k.kind}`;
  return { at: prev.timestamp, minutes: Math.round(minutes), cause, what };
}

/** Minutes per cause, and the five longest gaps, as printable lines. */
export function stallSummary(stalls, sessionMinutes = null) {
  const by = {};
  for (const g of stalls) by[g.cause] = (by[g.cause] || 0) + g.minutes;
  const names = { idle: 'idle, the turn had ended', tool: 'waiting on a tool', model: "waiting on Claude's reply", other: 'other' };
  const lines = [];
  if (sessionMinutes != null) lines.push(`session span: ${span(sessionMinutes * 60000)}`);
  for (const [cause, m] of Object.entries(by).sort((a, b) => b[1] - a[1])) lines.push(`${names[cause] || cause}: ${span(m * 60000)}`);
  const top = [...stalls].sort((a, b) => b.minutes - a.minutes).slice(0, 5);
  if (top.length) lines.push('longest:', ...top.map(g => `  ${g.minutes} min at ${clock(g.at)}: ${g.what}`));
  return lines;
}

// ---------- what a sprint may take (claude-workflow#3) ----------
// The owner, 2026-11-22: a keep-going sprint keeps going, and is done only when
// nothing on the board can be worked on: everything Claude can build is built,
// and what is left waits on a decision or a real-world step only a person can
// take. So past its own and the unassigned issues it takes other developers'
// who:claude issues, then Claude's part of the shared ones (mock-ups, drafts,
// research, code that doesn't wait on the decision), then the preparation for
// the owner's own (a checklist, a filled-in draft). It hands those back with
// `handoff`, which puts HANDED_OFF on them so no later sprint does them again.
// Never an issue someone else has In Progress: they are on it now.
export const HANDED_OFF = 'status:claude-part-done';

// An issue skipped because a permission question went unanswered (claude-workflow#8).
// The owner, 2026-11-23: a sprint stalled for hours on a "may Claude edit .claude/…?"
// prompt. The permission hook (.claude/hooks/permission.mjs) now asks it on the PR
// and waits; with no answer the sprint skips the issue (`skip N --watched`), which
// labels it and lists it on the PR as skipped on purpose. The label does not keep
// later sprints off it: each asks again, and a late "allow P<n>" puts it back.
export const WATCHED = 'needs:watched-session';
export const WATCHED_LABEL = ['5319e7', 'A sprint asked permission for it on the PR and got no answer; skipped on purpose'];

/** The PR section for issues skipped on purpose for want of a permission answer; [] when there are none. */
export function watchedLines(list = []) {
  if (!list.length) return [];
  return ['', '## Left for a watched session (on purpose)',
    `These needed permission for something Claude Code always asks about (a change to \`.claude/\` or \`CLAUDE.md\`, for example). The sprint asked on this PR and nobody answered in time, or the answer was no, so it skipped them deliberately (label \`${WATCHED}\`) instead of waiting. Nothing is wrong with them: reply \`allow P<n>\` under the question and the sprint's next pass puts the issue back, or do it while someone is at the computer.`,
    ...list.map(w => `- #${w.n}${w.title ? ` ${w.title}` : ''}${w.why ? `: ${w.why}` : ''}`)];
}

export const TIERS = [
  'yours',
  'unassigned',
  "another developer's (keep going: nothing of yours or unassigned was left)",
  "Claude's part of a shared issue or a decision: build what needs no person, then handoff",
  "the owner's: prepare what Claude can (a checklist, a draft, the research), then handoff",
];

/**
 * { tier } when this sprint may take the issue (lower tiers first), or
 * { tier: null, why }. issue: { labels: [names], assignees: [logins] };
 * status: its board column. greedy: a keep-going sprint not started --no-greedy.
 */
export function takeable({ labels = [], assignees = [] }, status, { me, also = [], mine = false, keepGoing = false, greedy = false } = {}) {
  const has = l => labels.includes(l);
  if (has('type:epic') || has('inbox')) return { tier: null, why: 'a parent or the Inbox' };
  const waiting = labels.find(l => l.startsWith('status:'));
  if (waiting) return { tier: null, why: `waiting on a person (${waiting})` };
  if (status === 'In Review') return { tier: null, why: 'in review' };
  if (status === 'Done') return { tier: null, why: 'done' };
  const ours = new Set([me, ...also]);
  const own = assignees.some(a => ours.has(a));
  const others = assignees.length > 0 && !own;
  if (status === 'In Progress' && !own) return { tier: null, why: `in progress${assignees.length ? ` under ${assignees.join(', ')}` : ''}` };
  const wide = Boolean(keepGoing && greedy);
  const who = labels.find(l => l.startsWith('who:'))?.slice(4) || null;
  const decision = has('type:decision');
  // A who:claude decision is Claude's to prepare in any sprint: the options, the mock-ups and the
  // question; the person's pick is the only part that waits, so it is handed back, never skipped.
  if (who === 'claude' && decision && (own || !others)) return !mine || keepGoing || own ? { tier: 3 } : { tier: null, why: 'unassigned (--mine)' };
  if (who === 'claude' && !decision) {
    if (own) return { tier: 0 };
    if (!others) return !mine || keepGoing ? { tier: 1 } : { tier: null, why: 'unassigned (--mine)' };
    return wide ? { tier: 2 } : { tier: null, why: `assigned to ${assignees.join(', ')}` };
  }
  if (!wide) return { tier: null, why: decision ? 'a decision' : `who:${who || 'nobody'}` };
  if (who === 'you' || who === 'lawyer') return { tier: 4 };
  return { tier: 3 };
}

/** "NOTHING LEFT: …" with why each open issue was left, counted: the sprint's done line. */
export function nothingLeft(reasons) {
  const counts = {};
  for (const why of reasons) { const k = why.replace(/ under .*/, '').replace(/^assigned to .*/, 'assigned to someone else'); counts[k] = (counts[k] || 0) + 1; }
  const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`);
  return `NOTHING LEFT on the board that this sprint can work on${parts.length ? `: ${parts.join(' · ')}` : ''}.`;
}
