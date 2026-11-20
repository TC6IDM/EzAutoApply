// The commit guard enforces CLAUDE.md's first ground rule, so every way through it is pinned here.
// Run: node --test .claude/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, gitDirs, normPath, sprintBranch, STALE_HOURS, KEEP_GOING_STALE_HOURS } from '../hooks/guard-rules.mjs';
import * as verdict from '../skills/ezaa-sprint/verdict.mjs';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const hoursAgo = h => new Date(NOW - h * 3600e3).toISOString();
const sprint = (over = {}) => ({ branch: 'sprint/2026-11-18-0039', startedAt: hoursAgo(1), readings: [{ at: hoursAgo(0.1) }], ...over });
const d = (cmd, ctx = {}) => decide(cmd, { now: NOW, branch: 'feature', state: null, ...ctx })?.decision ?? null;

test('with no sprint, commit and push on a branch are left to the permission rules (the yes is given in chat)', () => {
  assert.equal(d('git commit -m "x"'), null);
  assert.equal(d('git add -A && git commit -m "x"'), null);
  assert.equal(d('git push origin feature'), null);
  assert.equal(d('git push -u origin feature'), null);
  assert.equal(d('cd /repo && git -C extension commit -q -F -'), null);
});

test('main and upstream still ask, sprint or not', () => {
  assert.equal(d('git push origin main:main', { branch: 'main' }), 'ask');
  assert.equal(d('git commit -m x', { branch: 'main' }), 'ask');
  assert.equal(d('git commit -m x', { branch: 'master' }), 'ask');
  assert.equal(d('git push origin HEAD:main'), 'ask');
  assert.equal(d('git push -u upstream feature'), 'ask');
});

test('force-push is denied, even on a sprint branch', () => {
  for (const cmd of ['git push --force origin x', 'git push --force-with-lease', 'git push -f origin x', 'git push origin +x']) {
    assert.equal(d(cmd), 'deny', cmd);
    assert.equal(d(cmd, { branch: sprint().branch, state: sprint() }), 'deny', cmd);
  }
});

test('a bare push from main is denied; from another branch the permission rules decide', () => {
  assert.equal(d('git push', { branch: 'main' }), 'deny');
  assert.equal(d('git push origin', { branch: 'main' }), 'deny');
  assert.equal(d('git push', { branch: 'feature' }), null);
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
  assert.equal(d('git commit -m x', { branch: state.branch, state: sprint({ branch: 'feature/x' }) }), null, 'state must name a sprint/ branch: otherwise no sprint runs');
});

test('a stale sprint state counts as no sprint', () => {
  const old = sprint({ readings: [{ at: hoursAgo(STALE_HOURS + 1) }] });
  assert.equal(sprintBranch(old, old.branch, NOW), null);
  assert.equal(d('git commit -m x', { branch: old.branch, state: old }), null);
  assert.equal(d('git commit -m x', { branch: 'main', state: old }), 'ask');
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

// #57: one sprint works EzAutoApply and the linked ai-job-search worktree.
const HOME = 'C:/Users/me/Desktop/EzAutoApply';
const WT = 'C:/Users/me/Desktop/ai-job-search-sprint';
const linked = (over = {}) => sprint({ linked: { 'ai-job-search': { worktree: 'C:\\Users\\me\\Desktop\\ai-job-search-sprint', branch: sprint().branch } }, ...over });
const at = (toplevel, branch) => ({ toplevel, branch });

test('gitDirs finds every checkout a command reaches', () => {
  assert.deepEqual(gitDirs('git commit -m x', HOME), [HOME]);
  assert.deepEqual(gitDirs('cd ../ai-job-search && git commit -m x', HOME), [`${HOME}/../ai-job-search`]);
  assert.deepEqual(gitDirs(`git -C "${WT}" commit -m x`, HOME), [HOME, WT]);
  assert.deepEqual(gitDirs('cd /c/x && git add -A && git -C sub commit', HOME), ['/c/x', '/c/x/sub']);
  assert.equal(normPath('/c/Users/Me/'), normPath('C:\\Users\\me'));
});

test('a live sprint may commit and push in its linked worktree, on its branch only', () => {
  const state = linked();
  const ok = { state, home: HOME, places: [at(WT, state.branch)] };
  assert.equal(d('git commit -m "Queue: x (TC6IDM/EzAutoApply#25)"', ok), 'allow');
  assert.equal(d(`git push -u origin ${state.branch}`, ok), 'allow');
  // Both checkouts at once: each must be the sprint's.
  assert.equal(d('git commit -m x', { state, home: HOME, places: [at(HOME, state.branch), at(WT, state.branch)] }), 'allow');
  assert.equal(d('git commit -m x', { state, home: HOME, places: [at(HOME, 'main'), at(WT, state.branch)] }), 'ask');
});

test('the linked exception never reaches the owner\'s own checkout, its main, or upstream', () => {
  const state = linked();
  const owner = 'C:/Users/me/Desktop/ai-job-search';
  assert.equal(d('git commit -m x', { state, home: HOME, places: [at(owner, 'resume-update')] }), 'ask', 'the owner\'s checkout');
  assert.equal(d('git commit -m x', { state, home: HOME, places: [at(owner, state.branch)] }), 'ask', 'same branch name, wrong folder');
  assert.equal(d('git commit -m x', { state, home: HOME, places: [at(WT, 'main')] }), 'ask');
  assert.equal(d('git push origin HEAD:main', { state, home: HOME, places: [at(WT, state.branch)] }), 'ask');
  assert.equal(d(`git push upstream ${state.branch}`, { state, home: HOME, places: [at(WT, state.branch)] }), 'ask');
  assert.equal(d(`git push -u upstream ${state.branch}`, { state, home: HOME, places: [at(HOME, state.branch)] }), 'ask');
  assert.equal(d('git push --force origin x', { state, home: HOME, places: [at(WT, state.branch)] }), 'deny');
  assert.equal(d('git commit -m x', { state: sprint(), home: HOME, places: [at(WT, state.branch)] }), 'ask', 'no link in the state');
  const stale = linked({ readings: [{ at: hoursAgo(STALE_HOURS + 1) }] });
  assert.equal(d('git commit -m x', { state: stale, home: HOME, places: [at(WT, state.branch)] }), null, 'a stale sprint links nothing (and runs nothing)');
});

test('git -C into another checkout is judged there, not by the session\'s branch', () => {
  const state = sprint();
  // Before #57 this was allowed: the session sat on the sprint branch.
  assert.equal(d('git -C ../elsewhere commit -m x', { state, home: HOME, places: [at(HOME, state.branch), at('C:/Users/me/Desktop/elsewhere', 'feature')] }), 'ask');
  assert.equal(d('git push', { state, home: HOME, places: [at(HOME, state.branch), at(WT, 'main')] }), 'deny', 'a bare push from any main');
});

test('guard.mjs speaks the PreToolUse hook protocol', () => {
  const hook = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [hook], { input, encoding: 'utf8' });
  const denied = run(JSON.stringify({ tool_input: { command: 'git push --force origin x' } }));
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  const quiet = run(JSON.stringify({ tool_input: { command: 'ls' } }));
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '');
  assert.equal(run('not json').stdout, '');
});

test("a repo's own deny list wins, and only matches what it names", () => {
  const deny = [{ re: String.raw`\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b`, reason: 'A 10-minute build: the owner runs it.' }];
  const r = decide('npm run build', { deny });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /10-minute/);
  assert.equal(decide('npm run check', { deny }), null);
  assert.equal(decide('npm run build', {}), null, 'no list, no denial');
});

test("guard.mjs applies the repo's GUARD_DENY before it looks at git", () => {
  const hook = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
  const out = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command: 'ls' } }), encoding: 'utf8' });
  assert.equal(out.status, 0);
});

test('askAlways asks before a commit or push on any branch; off, a plain branch is left to the permission rules', () => {
  assert.equal(d('git commit -m x', { branch: 'feature' }), null);
  assert.equal(d('git commit -m x', { branch: 'feature', askAlways: true }), 'ask');
  assert.equal(d('git push origin feature', { branch: 'feature', askAlways: true }), 'ask');
  assert.equal(d('git status', { branch: 'feature', askAlways: true }), null);
  assert.equal(d('git commit -m x', { branch: sprint().branch, state: sprint(), askAlways: true }), 'allow', 'a running sprint is still the owner\'s yes');
});
