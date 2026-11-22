// gh.mjs: which calls are tried again, and a stalled call gives up instead of hanging.
// Run: node --test .claude/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghReadOnly, ghTransient, ghRetry, ghName, ghWith } from '../skills/ezaa-issues/gh.mjs';

test('reads are read-only; writes, mutations and field-sending api calls are not', () => {
  for (const args of [
    ['issue', 'view', '5', '--json', 'title'],
    ['issue', 'list', '--state', 'open'],
    ['pr', 'list', '--head', 'x'],
    ['project', 'field-list', '2', '--owner', 'o'],
    ['project', 'item-list', '2', '--owner', 'o'],
    ['api', 'repos/o/r/issues/5/comments', '--paginate'],
    ['api', '-X', 'GET', 'search/issues', '-f', 'q=x'],
    ['api', 'graphql', '-f', 'query=query { viewer { login } }'],
    ['auth', 'status'],
  ]) assert.equal(ghReadOnly(args), true, args.join(' '));
  for (const args of [
    ['issue', 'create', '--title', 't'],
    ['issue', 'edit', '5', '--body-file', 'b'],
    ['issue', 'comment', '5', '--body', 'b'],
    ['pr', 'edit', '9', '--body-file', 'b'],
    ['pr', 'create', '--title', 't'],
    ['label', 'create', 'x', '--force'],
    ['project', 'item-edit', '--id', 'i'],
    ['api', 'repos/o/r/milestones', '-f', 'title=x'],
    ['api', '--method', 'PATCH', 'repos/o/r/issues/comments/1', '-f', 'body=x'],
    ['api', '-X', 'DELETE', 'repos/o/r/labels/x'],
    ['api', 'graphql', '-f', 'query=mutation { addSubIssue(input: {}) { clientMutationId } }'],
    ['api', 'repos/o/r/issues', '--input', 'body.json'],
    ['auth', 'refresh', '-s', 'project'],
  ]) assert.equal(ghReadOnly(args), false, args.join(' '));
});

test('network failures are transient; a refusal or a missing thing is not', () => {
  for (const said of ['timeout', 'read tcp 10.0.0.2:5123->140.82.112.6:443: read: connection reset by peer', 'Post "https://api.github.com/graphql": EOF', 'HTTP 502: Bad Gateway', 'HTTP 504', 'net/http: TLS handshake timeout', 'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host'])
    assert.equal(ghTransient(said), true, said);
  for (const said of ['GraphQL: Could not resolve to an issue or pull request with the number of 999.', 'HTTP 404: Not Found', 'HTTP 403: Resource not accessible by integration', 'HTTP 422: Validation Failed', ''])
    assert.equal(ghTransient(said), false, said);
});

test('only a read-only call that failed on the network is tried again, at most three times', () => {
  const view = ['issue', 'view', '5'];
  assert.equal(ghRetry(view, 'timeout', 1), 'retry');
  assert.equal(ghRetry(view, 'connection reset by peer', 2), 'retry');
  assert.equal(ghRetry(view, 'timeout', 3), 'fail', 'three tries in all');
  assert.equal(ghRetry(view, 'HTTP 404: Not Found', 1), 'fail', 'asking again will not find it');
  assert.equal(ghRetry(['issue', 'comment', '5', '--body', 'x'], 'timeout', 1), 'fail', 'a write that may have landed is never sent twice');
});

test('a call is named by its command words only, never its values', () => {
  assert.equal(ghName(['issue', 'comment', '5', '--body', 'a private note']), 'gh issue comment');
  assert.equal(ghName(['project', 'field-list', '2', '--owner', 'o']), 'gh project field-list');
});

// A stand-in gh: node running a script that stalls on its first `stalls` runs,
// then answers. It counts its runs in a file, so the test sees every try.
function standIn(stalls) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-test-'));
  const count = join(dir, 'count');
  writeFileSync(count, '0');
  const script = join(dir, 'gh.cjs');
  writeFileSync(script, `const fs = require('fs'); const n = Number(fs.readFileSync(${JSON.stringify(count)}, 'utf8')) + 1;
fs.writeFileSync(${JSON.stringify(count)}, String(n));
if (n <= ${stalls}) setTimeout(() => {}, 60000); else process.stdout.write('answered ' + n + '\\n');`);
  return { program: { bin: process.execPath, pre: [script] }, runs: () => Number(readFileSync(count, 'utf8')), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a stalled read gives up at its limit and is tried again', () => {
  const s = standIn(1);
  try {
    const began = Date.now();
    assert.equal(ghWith(s.program, ['issue', 'view', '5'], { timeoutMs: 700, logTo: null }), 'answered 2');
    assert.equal(s.runs(), 2);
    assert.ok(Date.now() - began < 15000, 'nowhere near the minute a stall without a limit would take');
  } finally { s.done(); }
});

test('a stalled write gives up once and says it may have landed', () => {
  const s = standIn(5);
  try {
    assert.throws(() => ghWith(s.program, ['issue', 'comment', '5', '--body', 'x'], { timeoutMs: 700, logTo: null }), e => {
      assert.match(e.message, /gh issue comment: no answer in 1 s; it may have landed/);
      assert.equal(e.stalled, true);
      return true;
    });
    assert.equal(s.runs(), 1, 'never sent twice');
  } finally { s.done(); }
});

test('a read that keeps stalling stops after three tries', () => {
  const s = standIn(5);
  try {
    assert.throws(() => ghWith(s.program, ['pr', 'list'], { timeoutMs: 500, logTo: null }), /gh pr list: no answer in 1 s \(tried 3 times\)/);
    assert.equal(s.runs(), 3);
  } finally { s.done(); }
});
