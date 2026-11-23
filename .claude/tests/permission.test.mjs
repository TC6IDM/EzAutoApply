// The permission hook's rules: a prompt during a sprint is asked on the PR (claude-workflow#8).
// Run: node --test .claude/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestKey, describe, askBody, readAnswer, denyMessage, relPath, PERMISSION_MARK, WAIT_MINUTES } from '../hooks/permission-rules.mjs';

const ROOT = 'C:\\repo';

test('a request is keyed by tool and repo-relative path, or by the command', () => {
  assert.equal(relPath('C:\\repo\\.claude\\agents\\a.md', ROOT), '.claude/agents/a.md');
  assert.equal(relPath('/elsewhere/x.md', ROOT), '/elsewhere/x.md');
  assert.equal(requestKey('Edit', { file_path: 'C:\\repo\\CLAUDE.md' }, ROOT), 'Edit:claude.md');
  assert.equal(requestKey('Edit', { file_path: 'c:/REPO/CLAUDE.md' }, ROOT), 'Edit:claude.md', 'the same file however it is spelled');
  assert.notEqual(requestKey('Write', { file_path: 'C:\\repo\\CLAUDE.md' }, ROOT), requestKey('Edit', { file_path: 'C:\\repo\\CLAUDE.md' }, ROOT));
  assert.equal(requestKey('Bash', { command: ' rm -rf build ' }), 'Bash:rm -rf build');
  assert.equal(describe('Edit', { file_path: 'C:\\repo\\.claude\\agents\\a.md' }, ROOT), 'edit `.claude/agents/a.md`');
  assert.equal(describe('Write', { file_path: 'C:\\repo\\CLAUDE.md' }, ROOT), 'write `CLAUDE.md`');
  assert.ok(describe('Bash', { command: 'x'.repeat(400) }).length < 180);
});

test('the PR comment carries the ask id in its mark and says what happens with no answer', () => {
  const body = askBody({ id: 'P2', what: 'edit `CLAUDE.md`', issue: 817 });
  assert.ok(body.startsWith('<!-- sprint-permission P2 -->'));
  assert.ok(PERMISSION_MARK.startsWith('<!-- sprint-permission'));
  assert.match(body, /Permission needed \(P2\)\*\* for #817: the sprint wants to edit `CLAUDE\.md`/);
  assert.match(body, new RegExp(`within ${WAIT_MINUTES} minutes`));
  assert.match(body, /Left for a watched session/);
});

const at = m => new Date(Date.parse('2026-11-23T10:00:00Z') + m * 60e3).toISOString();
const ask = (id, m) => ({ login: 'bora', association: 'COLLABORATOR', at: at(m), body: `<!-- sprint-permission ${id} -->\n🔐 ...` });
const say = (body, m, login = 'tc', association = 'OWNER') => ({ login, association, at: at(m), body });

test('an answer counts only from someone with write access, after the ask, for that ask', () => {
  const askedAt = at(0);
  assert.equal(readAnswer([ask('P1', 0)], { id: 'P1', askedAt }), null, 'no reply yet');
  assert.deepEqual(readAnswer([ask('P1', 0), say('allow', 2)], { id: 'P1', askedAt }), { answer: 'allow', by: 'tc', at: at(2) });
  assert.equal(readAnswer([ask('P1', 0), say('Deny, not now', 2)], { id: 'P1', askedAt }).answer, 'deny');
  assert.equal(readAnswer([ask('P1', 0), say('allow', 2, 'stranger', 'NONE')], { id: 'P1', askedAt }), null, 'a stranger cannot approve');
  assert.equal(readAnswer([say('allow', -5), ask('P1', 0)], { id: 'P1', askedAt }), null, 'an allow from before the ask does not count');
  assert.equal(readAnswer([ask('P1', 0), say('looks fine to me', 2)], { id: 'P1', askedAt }), null, 'it must start with allow or deny');
  assert.equal(readAnswer([ask('P1', 0), say('✅ P1 allowed by @tc', 2, 'bora', 'COLLABORATOR')], { id: 'P1', askedAt }), null, "the hook's own notes are not answers");
});

test('with several asks, a bare reply answers the latest one; a named reply answers its own', () => {
  const thread = [ask('P1', 0), ask('P2', 20), say('allow', 22), say('deny P1', 25)];
  assert.equal(readAnswer(thread, { id: 'P2', askedAt: at(20) }).answer, 'allow');
  assert.equal(readAnswer(thread, { id: 'P1', askedAt: at(0) }).answer, 'deny', 'not the bare allow meant for P2');
  assert.equal(readAnswer([ask('P1', 0), ask('P2', 20), say('allow P1', 30)], { id: 'P1', askedAt: at(0) }).answer, 'allow', 'a late answer by id');
});

test("after the wait, the sprint's own account cannot answer (Claude can comment then)", () => {
  const thread = [ask('P1', 0), say('allow P1', 30, 'bora', 'COLLABORATOR')];
  assert.equal(readAnswer(thread, { id: 'P1', askedAt: at(0), notLogin: 'bora' }), null);
  assert.equal(readAnswer(thread, { id: 'P1', askedAt: at(0) }).by, 'bora', 'during the wait Claude is blocked, so the person on that account may answer');
});

test("Claude's message on a no says how to skip, and how a late allow brings it back", () => {
  const m = denyMessage({ why: 'no-answer', what: 'edit `CLAUDE.md`', issue: 817, id: 'P3', pr: 784, prefix: 'ptrainr' });
  assert.match(m, /^NO ANSWER on PR #784 within \d+ minutes \(P3\)/);
  assert.match(m, /sprint\.mjs skip 817 --watched --why "no answer to a permission question \(P3\)/);
  assert.match(m, /A later "allow P3" on the PR puts #817 back/);
  const d = denyMessage({ why: 'denied', what: 'edit `"x"`', issue: 5, id: 'P1', pr: 1, prefix: 'rtb' });
  assert.match(d, /^DENIED on the PR \(P1\)/);
  assert.doesNotMatch(d, /later "allow/);
  assert.doesNotMatch(d.match(/--why "(.*)" and/)[1], /"/, 'quotes in the request cannot break the command');
});
