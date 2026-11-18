// The commit guard enforces CLAUDE.md's first ground rule, so every way through it is pinned here.
// Run: node --test .claude/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, sprintBranch, STALE_HOURS, KEEP_GOING_STALE_HOURS } from '../hooks/guard-rules.mjs';
import * as verdict from '../skills/ezaa-sprint/verdict.mjs';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const hoursAgo = h => new Date(NOW - h * 3600e3).toISOString();
const sprint = (over = {}) => ({ branch: 'sprint/2026-11-18-0039', startedAt: hoursAgo(1), readings: [{ at: hoursAgo(0.1) }], ...over });
const d = (cmd, ctx = {}) => decide(cmd, { now: NOW, branch: 'feature', state: null, ...ctx })?.decision ?? null;

test('commit and push ask when no sprint runs', () => {
  assert.equal(d('git commit -m "x"'), 'ask');
  assert.equal(d('git add -A && git commit -m "x"'), 'ask');
  assert.equal(d('git push origin feature'), 'ask');
  assert.equal(d('git push -u origin feature'), 'ask');
  assert.equal(d('git push origin main:main', { branch: 'main' }), 'ask');
  assert.equal(d('cd /repo && git -C extension commit -q -F -'), 'ask');
});

test('force-push is denied, even on a sprint branch', () => {
  for (const cmd of ['git push --force origin x', 'git push --force-with-lease', 'git push -f origin x', 'git push origin +x']) {
    assert.equal(d(cmd), 'deny', cmd);
    assert.equal(d(cmd, { branch: sprint().branch, state: sprint() }), 'deny', cmd);
  }
});

test('a bare push from main is denied; from another branch it asks', () => {
  assert.equal(d('git push', { branch: 'main' }), 'deny');
  assert.equal(d('git push origin', { branch: 'main' }), 'deny');
  assert.equal(d('git push', { branch: 'feature' }), 'ask');
});

test('a live sprint may commit and push on its own branch and wip/issue-N', () => {
  const state = sprint();
  assert.equal(d('git commit -m "Fix it (#12)"', { branch: state.branch, state }), 'allow');
  assert.equal(d(`git push -u origin ${state.branch}`, { branch: state.branch, state }), 'allow');
  assert.equal(d('git push -u origin wip/issue-12', { branch: 'wip/issue-12', state }), 'allow');
  assert.equal(d('git merge origin/main && git commit -m m', { branch: state.branch, state }), 'allow', 'origin/main alone is not "naming main"');
});

test('the sprint exception never reaches main or another branch', () => {
  const state = sprint();
  assert.equal(d('git push origin HEAD:main', { branch: state.branch, state }), 'ask');
  assert.equal(d('git push origin master', { branch: state.branch, state }), 'ask');
  assert.equal(d('git commit -m x', { branch: 'main', state }), 'ask');
  assert.equal(d('git commit -m x', { branch: 'sprint/an-older-one', state }), 'ask');
  assert.equal(d('git commit -m x', { branch: state.branch, state: sprint({ branch: 'feature/x' }) }), 'ask', 'state must name a sprint/ branch');
});

test('a stale sprint state counts as no sprint', () => {
  const old = sprint({ readings: [{ at: hoursAgo(STALE_HOURS + 1) }] });
  assert.equal(sprintBranch(old, old.branch, NOW), null);
  assert.equal(d('git commit -m x', { branch: old.branch, state: old }), 'ask');
  const keepGoing = { ...old, keepGoing: true };
  assert.equal(sprintBranch(keepGoing, old.branch, NOW), old.branch, 'keep-going waits out resets');
  const tooOld = sprint({ keepGoing: true, readings: [{ at: hoursAgo(KEEP_GOING_STALE_HOURS + 1) }] });
  assert.equal(sprintBranch(tooOld, tooOld.branch, NOW), null);
  assert.equal(sprintBranch({ branch: 'sprint/x' }, 'sprint/x', NOW), null, 'no dates at all');
});

test('the guard and sprint.mjs agree on when a sprint is stale', () => {
  assert.equal(STALE_HOURS, verdict.STALE_HOURS);
  assert.equal(KEEP_GOING_STALE_HOURS, verdict.KEEP_GOING_STALE_HOURS);
});

test('gh pr merge is denied during a sprint, left alone otherwise', () => {
  const state = sprint();
  assert.equal(d('gh pr merge 51 --squash', { branch: state.branch, state }), 'deny');
  assert.equal(d('gh pr merge 51 --squash'), null);
});

test('other commands are left to the normal permission rules', () => {
  for (const cmd of ['git status', 'git log --oneline', 'npm test', '', '   ']) assert.equal(d(cmd), null, JSON.stringify(cmd));
});

test('guard.mjs speaks the PreToolUse hook protocol', () => {
  const hook = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [hook], { input, encoding: 'utf8' });
  const asked = run(JSON.stringify({ tool_input: { command: 'git commit -m x' } }));
  assert.equal(asked.status, 0);
  const out = JSON.parse(asked.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.ok(['ask', 'allow'].includes(out.permissionDecision), out.permissionDecision);
  const quiet = run(JSON.stringify({ tool_input: { command: 'ls' } }));
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '');
  assert.equal(run('not json').stdout, '');
});
