// The Inbox: log appends under the comment, never twice; fold moves stand-in replies back.
// Run: node --test .claude/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGGED, withLog, sortInbox, refuseLog, standInBody, standInText, foldPlan } from '../skills/ezaa-issues/inbox-rules.mjs';

const comment = (id, body) => ({ id, body, html_url: `https://github.com/o/r/issues/1#issuecomment-${id}` });

test('log appends under a rule the first time, then line by line', () => {
  const once = withLog('Idea: show the page count  \n', '#31 Extension: page count');
  assert.equal(once, `Idea: show the page count\n\n---\n${LOGGED} #31 Extension: page count`);
  const twice = withLog(once, 'already #31 (added this detail there)');
  assert.equal(twice, `${once}\n${LOGGED} already #31 (added this detail there)`);
  assert.equal(twice.split('---').length, 2, 'one rule only');
});

test('waiting = not logged and not a stand-in', () => {
  const a = comment(1, 'new idea');
  const b = comment(2, withLog('old idea', '#5'));
  const s = comment(3, standInBody(comment(4, 'x'), '#6'));
  const { waiting, standIns } = sortInbox([a, b, s]);
  assert.deepEqual(waiting.map(c => c.id), [1]);
  assert.deepEqual(standIns.map(c => c.id), [3]);
});

test('log refuses a comment already logged, unless --add', () => {
  const logged = comment(7, withLog('idea', '#9'));
  assert.equal(refuseLog(logged, [logged]), true);
  assert.equal(refuseLog(logged, [logged], true), false);
  const fresh = comment(8, 'idea');
  assert.equal(refuseLog(fresh, [fresh]), false);
});

test('log refuses a comment a stand-in reply already answers (two passes at once)', () => {
  const target = comment(10, 'idea');
  const standIn = comment(11, standInBody(target, '#12'));
  assert.equal(refuseLog(target, [target, standIn]), true);
  assert.equal(refuseLog(comment(99, 'other'), [target, standIn]), false, 'a stand-in for another comment does not count');
});

test('a stand-in carries the comment id, a link and the log text', () => {
  const body = standInBody(comment(20, 'idea'), '#21 Bridge: …');
  assert.match(body, /<!-- inbox-log-for:20 -->/);
  assert.match(body, /issuecomment-20/);
  assert.equal(standInText({ body }), '#21 Bridge: …');
});

test('fold: folds, deletes a stand-in already folded, leaves one whose comment is gone', () => {
  const a = comment(30, 'idea A');
  const b = comment(31, withLog('idea B', '#40'));
  const sa = comment(32, standInBody(a, '#41'));
  const sb = comment(33, standInBody(b, '#40'));
  const orphan = comment(34, standInBody(comment(35, 'deleted'), '#42'));
  const plan = foldPlan([a, b, sa, sb, orphan]);
  assert.deepEqual(plan.map(p => [p.standIn.id, p.action]), [[32, 'fold'], [33, 'delete'], [34, 'gone']]);
  assert.equal(plan[0].target.id, 30);
  assert.equal(plan[0].text, '#41');
  assert.equal(plan[2].target, null);
});
