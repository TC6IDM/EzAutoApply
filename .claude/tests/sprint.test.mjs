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
