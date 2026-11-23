#!/usr/bin/env node
// PermissionRequest hook: during a sprint, a permission prompt is asked on the
// sprint's PR instead of on a screen nobody is watching (permission-rules.mjs says why).
//
// Outside a sprint it prints nothing, so Claude Code shows its normal prompt.
// In a sprint: an approval remembered from earlier → allow at once. Otherwise it
// posts the question on the PR (or the current issue before the PR exists),
// waits up to WAIT_MINUTES for "allow"/"deny" from someone with write access,
// and answers with that; no answer → deny, with the steps to skip the issue.
// The hook's timeout in settings.json must be longer than the wait (1200 s for 15 min).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as repo from './repo.mjs';
import { requestKey, describe, askBody, readAnswer, denyMessage, WAIT_MINUTES, POLL_SECONDS } from './permission-rules.mjs';

const DIR = join(tmpdir(), `${repo.PREFIX}-sprint`);
const STATE = join(DIR, 'state.json');
const readState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return null; } };
// Re-read before each write: the state file is the sprint's, and only this hook's fields change here.
function update(change) {
  const s = readState();
  if (!s) return;
  change(s);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}
const answer = decision => { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })); process.exit(0); };
const sleep = s => new Promise(r => setTimeout(r, s * 1000));
// The PR's top line: "waiting on a permission answer" while it waits, the issue again after.
const SPRINT = fileURLToPath(new URL(`../skills/${repo.PREFIX}-sprint/sprint.mjs`, import.meta.url));
const refresh = () => { try { execFileSync(process.execPath, [SPRINT, 'refresh'], { stdio: 'ignore', timeout: 90000 }); } catch { /* the top line catches up later */ } };
const waiting = on => { update(s => { if (s.current) { if (on) s.current.waitingOn = on; else delete s.current.waitingOn; } }); refresh(); };

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const state = readState();
// No sprint, or one whose work is in another checkout: the person answers as usual.
if (!state || state.external) process.exit(0);

let root = '';
try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' }).trim(); } catch { /* paths stay absolute */ }
const tool = input.tool_name, args = input.tool_input || {};
const key = requestKey(tool, args, root);
if ((state.approvals || []).some(a => a.key === key)) answer({ behavior: 'allow' });

const { gh } = await import(new URL(`../skills/${repo.PREFIX}-issues/gh.mjs`, import.meta.url));
const REPO = repo.REPO;
const what = describe(tool, args, root);
const issue = state.current?.n ?? null;
let pr = state.pr ?? null;
if (!pr) { try { pr = JSON.parse(gh(['pr', 'list', '--repo', REPO, '--head', state.branch, '--state', 'open', '--json', 'number', '--limit', '1'], { quiet: true }))[0]?.number ?? null; } catch { /* asked on the issue instead */ } }
const target = pr ? ['pr', String(pr)] : issue ? ['issue', String(issue)] : null;
if (!target) answer({ behavior: 'deny', message: denyMessage({ why: 'no-answer', what, issue, id: '-', pr: null, prefix: repo.PREFIX }) });

const id = `P${(state.permissionAsks || []).length + 1}`;
const askedAt = new Date(Date.now() - 1000).toISOString();
let url = null;
try {
  const file = join(DIR, `permission-${id}.md`);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, askBody({ id, what, issue }));
  url = gh([target[0], 'comment', target[1], '--repo', REPO, '--body-file', file], { quiet: true });
} catch { answer({ behavior: 'deny', message: denyMessage({ why: 'no-answer', what, issue, id, pr, prefix: repo.PREFIX }) }); }
update(s => { s.permissionAsks = [...(s.permissionAsks || []), { id, key, what, issue, target, url, at: askedAt, status: 'waiting' }]; });
waiting({ id, at: askedAt });

const comments = () => {
  const list = JSON.parse(gh([target[0], 'view', target[1], '--repo', REPO, '--json', 'comments'], { quiet: true })).comments;
  return list.map(c => ({ login: c.author?.login, association: c.authorAssociation, at: c.createdAt, body: c.body }));
};
const say = text => { try { gh([target[0], 'comment', target[1], '--repo', REPO, '--body', text], { quiet: true }); } catch { /* the answer still stands */ } };
const deadline = Date.now() + WAIT_MINUTES * 60e3;
while (Date.now() < deadline) {
  await sleep(POLL_SECONDS);
  let got = null;
  try { got = readAnswer(comments(), { id, askedAt }); } catch { continue; }
  if (!got) continue;
  waiting(null);
  update(s => {
    const a = (s.permissionAsks || []).find(x => x.id === id);
    if (a) Object.assign(a, { status: got.answer === 'allow' ? 'allowed' : 'denied', by: got.by, answeredAt: got.at });
    if (got.answer === 'allow') s.approvals = [...(s.approvals || []), { key, id, by: got.by, at: got.at }];
  });
  if (got.answer === 'allow') { say(`✅ ${id} allowed by @${got.by}; the sprint carries on.`); answer({ behavior: 'allow' }); }
  say(`⛔ ${id} denied by @${got.by}; the sprint skips${issue ? ` #${issue}` : ' it'}.`);
  answer({ behavior: 'deny', message: denyMessage({ why: 'denied', what, issue, id, pr, prefix: repo.PREFIX }) });
}
update(s => { const a = (s.permissionAsks || []).find(x => x.id === id); if (a) a.status = 'no-answer'; });
waiting(null);
say(`⏱ No answer to ${id} in ${WAIT_MINUTES} minutes: the sprint skips${issue ? ` #${issue}` : ' it'} for now. Reply \`allow ${id}\` any time and its next pass puts it back.`);
answer({ behavior: 'deny', message: denyMessage({ why: 'no-answer', what, issue, id, pr, prefix: repo.PREFIX }) });
