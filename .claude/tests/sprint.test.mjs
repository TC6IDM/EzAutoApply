// The sprint's verdicts and finish's refusals.
// Run: node --test .claude/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  judge, defaultLines, largeAllowed, averageCost, finishRefusal, isLarge,
  DEFAULT_SMALL_AT, DEFAULT_NEW_AT, DEFAULT_STOP_AT, FABLE_LINES, LARGE_SESSION_AT, LARGE_WEEKLY_UNDER,
} from '../skills/ezaa-sprint/verdict.mjs';

const soon = new Date(Date.now() + 3600e3).toISOString();
const u = (session, weekly) => ({ session, weekly, sessionResets: soon, weeklyResets: soon });
const v = (session, weekly, lines) => judge(u(session, weekly), lines).verdict;

test('default lines: GO / SMALL / WRAP / STOP on either limit', () => {
  assert.deepEqual([DEFAULT_SMALL_AT, DEFAULT_NEW_AT, DEFAULT_STOP_AT], [80, 94, 96]);
  assert.equal(v(10, 10), 'GO');
  assert.equal(v(79, 0), 'GO');
  assert.equal(v(80, 0), 'SMALL');
  assert.equal(v(0, 93), 'SMALL', 'the weekly figure counts too');
  assert.equal(v(94, 0), 'WRAP');
  assert.equal(v(95, 50), 'WRAP');
  assert.equal(v(96, 0), 'STOP');
  assert.equal(v(10, 99), 'STOP');
});

test('a missing figure counts as 0, an error is UNKNOWN', () => {
  assert.equal(v(null, 50), 'GO');
  const j = judge({ error: 'no Claude login found on this machine' });
  assert.equal(j.verdict, 'UNKNOWN');
  assert.equal(j.used, null);
  assert.match(j.line, /^UNKNOWN: no Claude login/);
});

test('Fable gets the lower lines; other models and unknown keep the usual ones', () => {
  assert.deepEqual(FABLE_LINES, { smallAt: 70, newAt: 82, stopAt: 88 });
  const fable = defaultLines({ id: 'claude-fable-5-2', name: 'Fable 5.2' });
  assert.deepEqual([fable.smallAt, fable.newAt, fable.stopAt], [70, 82, 88]);
  assert.equal(v(71, 0, fable), 'SMALL');
  assert.equal(v(83, 0, fable), 'WRAP');
  assert.equal(v(88, 0, fable), 'STOP');
  for (const m of [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }, null]) {
    const l = defaultLines(m);
    assert.deepEqual([l.smallAt, l.newAt, l.stopAt], [80, 94, 96]);
  }
});

test('named lines win, and small never sits above new', () => {
  const lines = { smallAt: 99, newAt: 12, stopAt: 15 };
  assert.equal(v(11, 0, lines), 'GO');
  assert.equal(v(12, 0, lines), 'WRAP');
  assert.equal(v(15, 0, lines), 'STOP');
  assert.equal(judge(u(0, 0), lines).smallAt, 12);
});

test('the line names the binding limit and when to resume', () => {
  const j = judge(u(20, 60));
  assert.equal(j.binding, 'weekly');
  assert.ok(j.resumeInSeconds > 3600 && j.resumeInSeconds < 3600 + 200, String(j.resumeInSeconds));
  assert.match(j.line, /5-hour 20% .* weekly 60%/);
  assert.match(judge({ ...u(20, 10), stale: 'endpoint 429' }).line, /stale: endpoint 429/);
});

test('size:L only in a keep-going sprint with a fresh window and weekly room', () => {
  assert.equal(isLarge([{ name: 'size:L' }]), true);
  assert.equal(isLarge(['size:M']), false);
  assert.equal(largeAllowed(u(5, 10), { keepGoing: false }).ok, false);
  assert.equal(largeAllowed(u(LARGE_SESSION_AT, 10), { keepGoing: true }).ok, true);
  assert.equal(largeAllowed(u(LARGE_SESSION_AT + 1, 10), { keepGoing: true }).ok, false);
  assert.equal(largeAllowed(u(LARGE_SESSION_AT + 1, 10), { keepGoing: true }, true).ok, true, '--asked skips the fresh-window rule');
  assert.equal(largeAllowed(u(5, LARGE_WEEKLY_UNDER), { keepGoing: true }, true).ok, false, 'but never the weekly one');
  assert.equal(largeAllowed({ error: 'x' }, { keepGoing: true }).ok, false);
});

test('average cost counts only measured issues', () => {
  assert.equal(averageCost({ done: [] }), null);
  assert.equal(averageCost({ done: [{ cost: 10 }, { cost: null }, { cost: 0 }, { cost: 15 }] }), 13);
  assert.equal(averageCost(null), null);
});

test('finish refuses a dirty tree, a commit that does not name #N, and no note', () => {
  assert.equal(finishRefusal({ n: 48, dirty: ' M a.mjs', subject: '', note: 'x' }).code, 2);
  assert.equal(finishRefusal({ n: 48, dirty: '', subject: 'Tests for the guard (#4)', note: 'x' }).code, 2);
  assert.equal(finishRefusal({ n: 4, dirty: '', subject: 'Tests for the guard (#48)', note: 'x' }).code, 2, '#4 is not #48');
  assert.equal(finishRefusal({ n: 48, dirty: '', subject: 'Tests for the guard (#48)', note: '' }).code, 1);
  assert.equal(finishRefusal({ n: 48, dirty: '', subject: 'Tests for the guard (#48)', note: 'x' }), null);
});

import { takenAway } from '../skills/ezaa-sprint/verdict.mjs';

test('an issue taken or closed while the sprint was paused is no longer its own', () => {
  assert.equal(takenAway({ state: 'OPEN', assignees: ['me'], me: 'me' }), null);
  assert.equal(takenAway({ state: 'OPEN', assignees: [], me: 'me' }), null, 'unassigned: still free to finish');
  assert.equal(takenAway({ state: 'OPEN', assignees: ['me', 'other'], me: 'me' }), null);
  assert.equal(takenAway({ state: 'OPEN', assignees: ['other'], me: 'me', also: ['other'] }), null, 'take-from');
  assert.equal(takenAway({ state: 'OPEN', assignees: ['other'], me: 'me' }), 'assigned to other');
  assert.equal(takenAway({ state: 'CLOSED', assignees: ['me'], me: 'me' }), 'closed', 'someone else built and merged it');
});

// ---------- usage per issue (#49) ----------
import { issueUsage, usageNote, sizeAverages, expectedCost, misSized, MEASURED_AFTER, DEFAULT_ISSUE_COST } from '../skills/ezaa-sprint/verdict.mjs';

test('issue usage is the rise since begin; a reset or a missing reading is null', () => {
  const start = { sessionAtStart: 48, weeklyAtStart: 53 };
  assert.deepEqual(issueUsage(start, { session: 52, weekly: 54 }), { session: 4, weekly: 1 });
  assert.deepEqual(issueUsage(start, { session: 3, weekly: 54 }), { session: null, weekly: 1 }, 'the 5-hour window reset meanwhile');
  assert.deepEqual(issueUsage(start, { error: 'x' }), { session: null, weekly: null });
  assert.deepEqual(issueUsage(null, { session: 1, weekly: 1 }), { session: null, weekly: null });
});

test('the usage note names what was measured', () => {
  assert.equal(usageNote({ session: 4, weekly: 1 }), 'used about 4% of the 5-hour window, 1% of the week');
  assert.equal(usageNote({ session: null, weekly: 0 }), 'used about 0% of the week');
  assert.equal(usageNote({ session: null, weekly: null }), null);
});

test('per-size averages from the board ignore unmeasured and unsized rows', () => {
  const rows = [{ size: 'S', usage: 4 }, { size: 'size:S', usage: 3 }, { size: 'M', usage: 9 }, { size: 'M', usage: null }, { size: null, usage: 5 }];
  assert.deepEqual(sizeAverages(rows), { S: { n: 2, avg: 3.5 }, M: { n: 1, avg: 9 } });
});

test('expected cost: the measured average from MEASURED_AFTER issues, else a scaled guess', () => {
  const few = { M: { n: MEASURED_AFTER - 1, avg: 30 } };
  assert.deepEqual(expectedCost('size:M', few), { cost: DEFAULT_ISSUE_COST * 2, measured: false, n: MEASURED_AFTER - 1 });
  assert.deepEqual(expectedCost('size:M', few, 3), { cost: 6, measured: false, n: MEASURED_AFTER - 1 }, "this sprint's average beats the default");
  assert.deepEqual(expectedCost('size:M', { M: { n: MEASURED_AFTER, avg: 30 } }), { cost: 30, measured: true, n: MEASURED_AFTER });
  assert.equal(expectedCost(undefined, {}).cost, DEFAULT_ISSUE_COST, 'unsized counts as an S');
});

test('mis-sized issues sit nearer another size average', () => {
  const rows = [
    ...[3, 4, 5].map((usage, i) => ({ n: i + 1, size: 'S', usage })),
    ...[10, 12, 14].map((usage, i) => ({ n: i + 10, size: 'M', usage })),
    { n: 20, size: 'S', usage: 13 },
    { n: 21, size: 'L', usage: 4 },
  ];
  const odd = misSized(rows, sizeAverages(rows));
  assert.deepEqual(odd.map(o => [o.n, o.looks]), [[20, 'M']], 'L has too few measured to judge');
  assert.deepEqual(misSized(rows.slice(0, 3), sizeAverages(rows.slice(0, 3))), [], 'one size alone says nothing');
});

// ---------- the checkpoint's decisions and the reset times ----------
import { resetLabel, readingLine, usageLines, decisionsComment, answersSince, DECISIONS_MARK } from '../skills/ezaa-sprint/verdict.mjs';

test('reset times: the time alone on the same day, the weekday on another', () => {
  const now = new Date('2026-11-20T15:00:00Z');
  assert.equal(resetLabel('2026-11-20T20:00:00Z', now, 'UTC'), '8:00 PM');
  assert.equal(resetLabel('2026-11-22T09:00:00Z', now, 'UTC'), 'Sun 9:00 AM');
  assert.equal(resetLabel(null, now, 'UTC'), null);
  assert.equal(resetLabel('not a date', now, 'UTC'), null);
});

test('a reading says when each window resets, and leaves it out when unknown', () => {
  const now = new Date('2026-11-20T15:00:00Z');
  assert.equal(readingLine({ session: 77, sessionResets: '2026-11-20T20:00:00Z', weekly: 39, weeklyResets: '2026-11-22T09:00:00Z' }, now, 'UTC'),
    '5-hour 77% (resets 8:00 PM), weekly 39% (resets Sun 9:00 AM)');
  assert.equal(readingLine({ session: 5, weekly: null }, now, 'UTC'), '5-hour 5%, weekly ?%');
});

test('usage: the start, every checkpoint, then the latest reading unless it is the last checkpoint', () => {
  const r = (at, session, step) => ({ at, session, weekly: 10, step });
  const start = r('2026-11-20T06:00:00Z', 5, 'start');
  const one = r('2026-11-20T09:00:00Z', 95, 'checkpoint');
  const mid = r('2026-11-20T12:00:00Z', 30, 'finish');
  const two = r('2026-11-20T14:00:00Z', 96, 'checkpoint');
  const late = r('2026-11-20T15:00:00Z', 12, 'finish');
  const labels = lines => lines.slice(1).map(l => l.match(/^- ([^(]+?) \(/)?.[1] ?? l);

  assert.deepEqual(usageLines([]), []);
  assert.deepEqual(labels(usageLines([start], 0, 'UTC')), ['At the start']);
  assert.deepEqual(labels(usageLines([start, one, mid, two, late], 0, 'UTC')), ['At the start', 'Checkpoint 1', 'Checkpoint 2', 'Latest reading']);
  assert.deepEqual(labels(usageLines([start, one, mid, two], 0, 'UTC')), ['At the start', 'Checkpoint 1', 'Checkpoint 2'], 'no repeat of the last checkpoint');
  const lines = usageLines([start, one, late], 2, 'UTC');
  assert.equal(lines[0], '## Usage');
  assert.match(lines[2], /^- Checkpoint 1 \(.+\): 5-hour 95%, weekly 10%$/);
  assert.equal(lines.at(-1), '- The 5-hour window reset 2× during the sprint');
});

test('the decisions comment: options lettered, the recommended one marked, the link, nothing when none are open', () => {
  assert.equal(decisionsComment([]), null);
  assert.equal(decisionsComment([{ text: 'old', posted: true, answered: true }]), null, 'answered: not asked again');
  assert.equal(decisionsComment([{ text: 'old', posted: true, settled: { why: 'x' } }]), null, 'settled: not asked again');
  const c = decisionsComment([
    { issue: 12, text: 'Which header?', options: ['Compact', 'Large'], recommend: 'A', link: 'https://example.com/mock' },
    { text: 'Merge conflict in x', recommend: 'keep main' },
  ], 'attrib');
  assert.ok(c.startsWith(DECISIONS_MARK));
  assert.match(c, /1\. \*\*#12:\*\* Which header\?/);
  assert.match(c, /A\. Compact \*\*\(recommended\)\*\*/);
  assert.doesNotMatch(c, /B\. Large \*\*/);
  assert.match(c, /Mock-ups: https:\/\/example\.com\/mock/);
  assert.match(c, /2\. Merge conflict in x\n   - Recommended: keep main/);
  assert.ok(c.endsWith('attrib'));
});

import { answeredTexts, answeredNumbers, postedQuestions, openQuestions, numberQuestions } from '../skills/ezaa-sprint/verdict.mjs';

test('every decisions post carries all open questions; an unanswered one is asked again under its own number (claude-workflow#7)', () => {
  const qs = [
    { at: '2026-11-22T20:00:00Z', issue: 793, text: 'Sheets: full height, floating, or our own?', options: ['Full', 'Floating', 'Own'] },
    { at: '2026-11-22T20:05:00Z', issue: 162, text: 'Storage: pass sealed files on, or not?', options: ['Sealed', 'Plain'] },
  ];
  const first = decisionsComment(qs, '');
  assert.match(first, /^1\. \*\*#793:\*\* Sheets/m);
  assert.match(first, /^2\. \*\*#162:\*\* Storage/m);
  for (const q of qs) { q.posted = true; q.firstPosted = '2026-11-22T21:00:00Z'; }
  qs.push({ at: '2026-11-23T03:00:00Z', issue: 811, text: 'Keep the greeting?', options: ['Keep', 'Day'] });
  // Only #811's question is answered: the owner replied "3 A" under the second post.
  const thread = [
    { association: 'COLLABORATOR', body: first },
    { association: 'NONE', body: '1 A' }, // a stranger: does not count
    { association: 'COLLABORATOR', body: decisionsComment(qs, '') },
    { association: 'OWNER', body: '3. A' },
  ];
  const answered = answeredTexts(thread);
  assert.deepEqual([...answered], ['Keep the greeting?']);
  const third = decisionsComment(qs, '', answered);
  assert.match(third, /including 2 asked before and not answered yet/);
  assert.match(third, /^1\. \*\*#793:\*\* Sheets/m, 'the buried one is asked again, same number');
  assert.match(third, /^2\. \*\*#162:\*\* Storage/m);
  assert.match(third, /_Asked before \(first .+\), still open\._/);
  assert.doesNotMatch(third, /greeting/, 'the answered one is gone');
  assert.deepEqual(openQuestions(qs, answered).map(q => q.n), [1, 2]);
});

test('answers count against the post above them, in that post\'s own numbering', () => {
  // An old-style post numbered per post: "1." there was #802, whatever its stable number.
  const old = `${DECISIONS_MARK}\n## Decisions waiting\nx\n\n1. **#802:** Lock screen shows?\n   - A. Timer\n   - B. Set\n2. Merge conflict in x\n   - Recommended: keep main`;
  assert.deepEqual([...postedQuestions(old)], [[1, 'Lock screen shows?'], [2, 'Merge conflict in x']]);
  const listed = postedQuestions(old);
  assert.deepEqual([...answeredNumbers('1.B', listed)], [1]);
  assert.deepEqual([...answeredNumbers('1. A\n2. B', listed)], [1, 2]);
  assert.deepEqual([...answeredNumbers('2 keep main', listed)], [2]);
  assert.deepEqual([...answeredNumbers('see PR 784 A and #1 B', listed)], [], 'other numbers and #issue refs are not answers');
  assert.deepEqual([...answeredNumbers('looks good to me', listed)], [], 'two questions: a reply without a number answers neither');
  assert.deepEqual([...answeredNumbers('yes, do it', postedQuestions(`${DECISIONS_MARK}\n1. Only one?`))], [1], 'one question: any reply answers it');
  assert.deepEqual(numberQuestions([{ n: 4 }, {}, {}]).map(q => q.n), [4, 5, 6], 'new questions number on from the highest');
});

test('answers are the comments after the last decisions post, minus the ones seen', () => {
  const list = [
    { at: '2026-11-20T10:00:00Z', body: 'before' },
    { at: '2026-11-20T11:00:00Z', body: `${DECISIONS_MARK} first` },
    { at: '2026-11-20T12:00:00Z', body: 'stale answer' },
    { at: '2026-11-20T13:00:00Z', body: `${DECISIONS_MARK} second` },
    { at: '2026-11-20T14:00:00Z', body: '1 A' },
    { at: '2026-11-20T15:00:00Z', body: '2 keep main' },
  ];
  assert.deepEqual(answersSince(list).map(c => c.body), ['1 A', '2 keep main']);
  assert.deepEqual(answersSince(list, '2026-11-20T14:00:00Z').map(c => c.body), ['2 keep main']);
  assert.deepEqual(answersSince(list.slice(0, 1)), []);
});

import { nowLine, withDone, findStalls, stallSummary, toolLabel } from '../skills/ezaa-sprint/verdict.mjs';

test('the PR names the issue being built while the sprint runs, and drops the line at a checkpoint', () => {
  const at = new Date(Date.now() - 42 * 60000).toISOString();
  const s = { current: { n: 723, title: 'Android: TikTok in Follow us', at }, done: [] };
  const line = nowLine(s, true);
  assert.match(line, /^\*\*Now working on:\*\* #723 Android: TikTok in Follow us · since /);
  assert.match(line, /\(42 min at the last update\)$/);
  assert.match(nowLine({ current: null, done: [{ n: 1, at }] }, true), /^\*\*Now:\*\* between issues \(last one finished /);
  assert.equal(nowLine({ current: null, done: [] }, true), '**Now:** between issues');
  assert.match(nowLine(s, false), /^\*\*Status:\*\* ⏸ Checkpointed · no check-up scheduled · 0 done$/, 'a checkpointed PR says so');
  assert.match(nowLine({ current: { n: 5, at: new Date(Date.now() - 125 * 60000).toISOString() } }, true), /2 h 05 min/);
});

import { stopReason } from '../skills/ezaa-sprint/verdict.mjs';

test('the top of the PR always shows a status: working, waiting on an answer, or why it stopped', () => {
  const at = new Date(Date.now() - 5 * 60000).toISOString();
  assert.match(nowLine({ current: { n: 817, title: 'Prompt audit', at, waitingOn: { id: 'P2', at } } }, true),
    /^\*\*Now:\*\* ⏳ waiting on a permission answer on this PR \(P2, asked .+\) for #817 Prompt audit\. Reply `allow` or `deny` under it\.$/);
  const base = { done: [{ n: 1 }, { n: 2 }, { n: 9, repo: 'other' }], handedOff: [{ n: 3 }], questions: [{ text: 'a' }, { text: 'b', answered: true }, { text: 'c', settled: {} }] };
  assert.match(nowLine({ ...base, status: { reason: 'limit', at } }, false),
    /^\*\*Status:\*\* ⏸ Usage limit reached, checkpointed .+ · no check-up scheduled · 2 done · 1 waiting on a person · 1 decision open/);
  // Which limit, and when it resets; when the next check-up is (each 55-minute wake moves it).
  const soon = new Date(Date.now() + 90 * 60000).toISOString(), later = new Date(Date.now() + 4 * 86400e3).toISOString();
  const limited = { ...base, status: { reason: 'limit', at }, nextWake: soon };
  assert.match(nowLine({ ...limited, readings: [{ session: 97, sessionResets: soon, weekly: 40, weeklyResets: later }] }, false),
    /checkpointed .+ · 5-hour limit resets .*\d{1,2}:\d\d [AP]M · next check-up .*\d{1,2}:\d\d [AP]M · 2 done/);
  assert.match(nowLine({ ...limited, readings: [{ session: 20, sessionResets: soon, weekly: 99, weeklyResets: later }] }, false),
    / · weekly limit resets [A-Z][a-z]{2} \d{1,2}:\d\d [AP]M · next check-up /, 'the weekly limit, on another day');
  assert.doesNotMatch(nowLine({ ...base, status: { reason: 'nothing-left', at }, readings: [{ session: 97, sessionResets: soon }] }, false), /resets/, 'not stopped by a limit: no reset named');
  assert.match(nowLine({ ...base, status: { reason: 'nothing-left', at } }, false), /✅ Work done: nothing left this sprint can take/);
  assert.match(nowLine({ ...base, status: { reason: 'wind-down', at } }, false), /⏹ Wound down on request/);
  assert.match(nowLine({ ...base, ended: true, nextWake: at, status: { reason: 'ended', at } }, false), /^\*\*Status:\*\* ⏹ Sprint ended [^·]+ · 2 done/, 'ended: no check-up named');
  assert.equal(stopReason({ verdict: 'STOP' }), 'limit');
  assert.equal(stopReason({ verdict: 'WRAP', windDown: true }), 'limit', 'the limit is the reason when both');
  assert.equal(stopReason({ verdict: 'GO', windDown: { at } }), 'wind-down');
  assert.equal(stopReason({ verdict: 'GO', nothingLeftAt: at }), 'nothing-left');
  assert.equal(stopReason({ verdict: 'GO' }), 'checkpoint');
  assert.equal(stopReason({ given: 'nothing-left', verdict: 'STOP' }), 'nothing-left', 'the person\'s --reason wins');
  assert.equal(stopReason({ given: 'made-up', verdict: 'GO' }), 'checkpoint');
});

test('a finish run again replaces its own line and keeps what the first run knew', () => {
  const first = withDone([{ n: 1, cost: 2 }], { n: 716, title: 'Android: Follow us', cost: 3, weeklyCost: 1 });
  const marked = first.map(d => (d.n === 716 ? { ...d, reviewed: true } : d));
  const again = withDone(marked, { n: 716, title: 'Android: Follow us', cost: null, weeklyCost: null, device: true });
  assert.equal(again.length, 2, 'no second #716 line');
  assert.deepEqual(again[1], { n: 716, title: 'Android: Follow us', cost: 3, weeklyCost: 1, reviewed: true, device: true });
  assert.equal(withDone(again, { n: 716, repo: 'other' }).length, 3, 'the same number in a linked repo is another issue');
});

// Transcript lines as Claude Code writes them (only the fields the finder reads).
const t0 = Date.parse('2026-11-22T06:00:00Z');
const at = min => new Date(t0 + min * 60000).toISOString();
const toolUse = (min, name, input) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'tool_use', name, input }] } });
const result = min => ({ type: 'user', timestamp: at(min), message: { content: [{ type: 'tool_result', content: 'x' }] } });
const reply = min => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'text', text: 'done' }] } });
const prompt = (min, text) => ({ type: 'user', timestamp: at(min), message: { content: text } });

test('stalls: a hung tool, an ended turn and a slow reply are told apart', () => {
  const entries = [
    prompt(0, 'go'),
    toolUse(1, 'Bash', { command: 'node .claude/skills/x-sprint/sprint.mjs finish 723 --note "Android: a TikTok row"' }),
    result(25),                                         // the finish hung for 24 min
    toolUse(26, 'Bash', { command: './gradlew :app:testDebugUnitTest', run_in_background: true }),
    result(26),
    toolUse(27, 'ScheduleWakeup', { delaySeconds: 3300 }),
    result(27),
    reply(27),                                          // the turn ends here
    prompt(82, '<command-name>/x-sprint</command-name> keep going'),
    reply(90),                                          // 8 min for a reply
    { type: 'assistant', timestamp: at(60), isSidechain: true, message: { content: [{ type: 'text', text: 'a subagent' }] } },
  ];
  const stalls = findStalls(entries, { minMinutes: 5 });
  assert.deepEqual(stalls.map(g => [g.minutes, g.cause]), [[24, 'tool'], [55, 'idle'], [8, 'model']]);
  assert.match(stalls[0].what, /^Bash: node \.claude\/skills\/x-sprint\/sprint\.mjs finish 723/);
  assert.match(stalls[1].what, /the turn ended with ScheduleWakeup 3300 s, leaving Bash: \.\/gradlew :app:testDebugUnitTest \(in the background\); woken by the loop prompt/);
  const summary = stallSummary(stalls, 90).join('\n');
  assert.match(summary, /^session span: 1 h 30 min\nidle, the turn had ended: 55 min\nwaiting on a tool: 24 min\nwaiting on Claude's reply: 8 min\nlongest:/);
});

test('stalls: labels say what ran, never what a file or message held', () => {
  assert.equal(toolLabel({ name: 'Write', input: { file_path: 'C:/repo/app/secret-plan.md', content: 'private' } }), 'Write: secret-plan.md');
  assert.equal(toolLabel({ name: 'ScheduleWakeup', input: { stop: true } }), 'ScheduleWakeup stop');
  assert.ok(toolLabel({ name: 'Bash', input: { command: 'x'.repeat(500) } }).length < 80);
  assert.deepEqual(findStalls([prompt(0, 'a'), reply(1)], { minMinutes: 5 }), []);
});

import { takeable, nothingLeft, HANDED_OFF } from '../skills/ezaa-sprint/verdict.mjs';

const issue = (labels, assignees = []) => ({ labels, assignees });
const greedy = { me: 'bora', keepGoing: true, greedy: true };
const tierOf = (i, status, o = greedy) => takeable(i, status ?? null, o).tier;

test('keep going takes, in order: yours, unassigned, another developer\'s, Claude\'s part of shared ones, the owner\'s', () => {
  assert.equal(tierOf(issue(['who:claude'], ['bora'])), 0);
  assert.equal(tierOf(issue(['who:claude'])), 1);
  assert.equal(tierOf(issue(['who:claude'], ['tc'])), 2);
  assert.equal(tierOf(issue(['who:together'], ['tc'])), 3);
  assert.equal(tierOf(issue(['who:claude', 'type:decision'])), 3, 'a decision: Claude builds the options, then hands off');
  assert.equal(tierOf(issue([])), 3, 'no who label: treated as shared');
  assert.equal(tierOf(issue(['who:you'], ['tc'])), 4);
  assert.equal(tierOf(issue(['who:lawyer'])), 4);
});

test('never someone else\'s In Progress, anything waiting on a person, in review, a parent or the Inbox', () => {
  const left = (i, status) => takeable(i, status, greedy);
  assert.deepEqual(left(issue(['who:claude'], ['tc']), 'In Progress'), { tier: null, why: 'in progress under tc' });
  assert.equal(left(issue(['who:claude']), 'In Progress').why, 'in progress', 'unassigned but someone moved it: leave it');
  assert.equal(left(issue(['who:claude'], ['bora']), 'In Progress').tier, 0, 'your own In Progress is yours to carry on');
  assert.equal(left(issue(['who:together', 'status:needs-decision']), null).why, 'waiting on a person (status:needs-decision)');
  assert.equal(left(issue(['who:you', HANDED_OFF]), null).why, `waiting on a person (${HANDED_OFF})`, 'a handed-off issue is not done twice');
  assert.equal(left(issue(['who:claude']), 'In Review').why, 'in review');
  assert.equal(left(issue(['type:epic', 'who:claude']), null).tier, null);
  assert.equal(left(issue(['inbox']), null).tier, null);
});

test('without keep going (or with --no-greedy) a sprint stays with yours and unassigned who:claude issues', () => {
  for (const o of [{ me: 'bora' }, { me: 'bora', keepGoing: true, greedy: false }]) {
    assert.equal(tierOf(issue(['who:claude']), null, o), 1);
    assert.equal(takeable(issue(['who:claude'], ['tc']), null, o).why, 'assigned to tc');
    assert.equal(takeable(issue(['who:together']), null, o).why, 'who:together');
    assert.equal(tierOf(issue(['who:claude', 'type:decision']), null, o), 3, 'a who:claude decision: Claude prepares the options in any sprint, then hands off');
    assert.equal(takeable(issue(['who:claude', 'type:decision'], ['tc']), null, o).why, 'a decision', "someone else's decision waits for keep going");
  }
  assert.equal(takeable(issue(['who:claude']), null, { me: 'bora', mine: true }).why, 'unassigned (--mine)');
  assert.equal(tierOf(issue(['who:claude'], ['tc']), null, { me: 'bora', also: ['tc'] }), 0, 'take-from still makes theirs yours');
});

import { WATCHED, watchedLines } from '../skills/ezaa-sprint/verdict.mjs';

test('an issue skipped for want of a permission answer is still offered to later sprints, and the PR says it was on purpose (claude-workflow#8)', () => {
  // The permission hook asks on the PR now, so the label no longer keeps sprints off an issue.
  assert.equal(tierOf(issue(['who:claude', WATCHED]), null, { me: 'bora' }), 1);
  assert.equal(tierOf(issue(['who:claude', WATCHED])), 1, 'keep going too');
  assert.equal(takeable(issue(['type:epic', WATCHED]), null, { me: 'bora' }).tier, null, 'a parent stays a parent');
  assert.deepEqual(watchedLines([]), [], 'no section without one');
  const lines = watchedLines([{ n: 817, title: 'Prompt audit', why: 'edits the agents and skills' }]);
  assert.equal(lines[1], '## Left for a watched session (on purpose)');
  assert.match(lines[2], /skipped them deliberately/);
  assert.match(lines[2], /allow P<n>/);
  assert.match(lines[2], /needs:watched-session/);
  assert.equal(lines[3], '- #817 Prompt audit: edits the agents and skills');
  assert.equal(watchedLines([{ n: 5 }])[3], '- #5');
});

test('the done line counts why every open issue was left', () => {
  assert.equal(nothingLeft(['in review', 'in review', 'waiting on a person (status:needs-decision)', 'in progress under tc', 'in progress under bora', 'assigned to tc']),
    'NOTHING LEFT on the board that this sprint can work on: 2 in review · 2 in progress · 1 waiting on a person (status:needs-decision) · 1 assigned to someone else.');
  assert.equal(nothingLeft([]), 'NOTHING LEFT on the board that this sprint can work on.');
});

import { wakeAt, pauseLine } from '../skills/ezaa-sprint/verdict.mjs';
import { readFileSync as readSource } from 'node:fs';

test('a paused sprint PR names its next wake; an ended one says no wake follows (claude-workflow#4)', () => {
  const now = Date.parse('2026-11-22T20:00:00Z');
  assert.equal(wakeAt({ wakeIn: '3300' }, now), '2026-11-22T20:55:00.000Z');
  assert.equal(wakeAt({ nextWake: '2026-11-23T04:50:00Z' }, now), '2026-11-23T04:50:00.000Z');
  assert.equal(wakeAt({}, now), null, 'none given, none said');
  assert.equal(wakeAt({ wakeIn: 'soon' }, now), null, 'an unreadable delay names no wake');
  assert.equal(wakeAt({ wakeIn: '-5' }, now), null);
  assert.equal(wakeAt({ nextWake: 'tomorrow-ish' }, now), null);
  const paused = pauseLine({ nextWake: '2026-11-22T20:55:00.000Z' });
  assert.match(paused, /^_The sprint is paused: next wake about .+\. Then it reads the answers under its questions and the Inbox, and carries on\._$/);
  assert.match(pauseLine({ ended: true, nextWake: '2026-11-22T20:55:00.000Z' }), /^_The sprint has ended: no wake follows\./, 'ended wins over a stale wake');
  assert.match(pauseLine({}), /^_The sprint has checkpointed:/);
});

test('work.mjs accepts every action it handles after the issue lookup, handoff included (claude-workflow#5)', () => {
  const source = readSource(new URL('../skills/ezaa-issues/work.mjs', import.meta.url), 'utf8');
  const accepted = JSON.parse(source.match(/export const ISSUE_ACTIONS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  const lookup = source.indexOf('const issue = ghJson(');
  const handled = [...source.slice(lookup).matchAll(/action === '([a-z-]+)'/g)].map(m => m[1]);
  assert.ok(handled.includes('handoff'));
  for (const name of handled) assert.ok(accepted.includes(name), `work.mjs ${name} is handled but refused by the usage check`);
});
