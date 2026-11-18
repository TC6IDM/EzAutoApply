import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { QueueStore } from '../src/queue.ts';
import { createBridge } from '../src/server.ts';

const TOKEN = 'test-token-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'ezaa-bridge-'));
const incidentsDir = join(dir, 'incidents');
const queue = new QueueStore(join(dir, 'queue.jsonl'));
const bridge = createBridge({ token: TOKEN, queue, incidentsDir, port: 0, maxWaitMs: 2000 });
let base = '';

before(async () => {
  await new Promise<void>((r) => bridge.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
});
after(() => bridge.server.close());

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const job = (id: string) => ({ id, applyUrl: `https://boards.greenhouse.io/acme/jobs/${id}`, company: 'Acme', title: 'Junior Developer' });

test('health needs no token; everything else does', async () => {
  assert.deepEqual((await call('GET', '/health', undefined, { authorization: '' })).json, { ok: true, stopped: false });
  assert.equal((await call('GET', '/queue', undefined, { authorization: '' })).status, 401);
  assert.equal((await call('GET', '/queue', undefined, { authorization: 'Bearer wrong-token-0123456789' })).status, 401);
  assert.equal((await call('GET', '/queue')).status, 200);
});

test('a web page can\'t call it, even with the token', async () => {
  assert.equal((await call('GET', '/queue', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('GET', '/queue', undefined, { origin: 'chrome-extension://abcdef' })).status, 200);
});

test('queue, claim, Run, the extension picks it up, and its report sets the job\'s status', async () => {
  assert.deepEqual((await call('POST', '/queue', { jobs: [job('j1'), job('j2')] })).json, { added: ['j1', 'j2'] });
  const claimed = await call('GET', '/queue/next?worker=w1');
  assert.equal(claimed.json.id, 'j1');
  assert.equal(claimed.json.worker, 'w1');

  // The extension is already waiting when the Run command comes in.
  const polling = call('GET', '/ext/commands?wait=2');
  const run = await call('POST', '/run', { jobId: 'j1', urlPrefix: 'https://boards.greenhouse.io/acme/jobs/j1' });
  assert.equal(run.status, 202);
  const got = (await polling).json;
  assert.deepEqual(got.map((c: { type: string; jobId: string }) => [c.type, c.jobId]), [['run', 'j1']]);
  assert.deepEqual((await call('GET', '/ext/commands')).json, [], 'each command is handed out once');

  const state = { tabId: 4, startUrl: 'x', page: 3, status: 'stopped', history: [], startedAt: 0, updatedAt: 0, stop: { reason: 'submitReady', detail: '"Submit application"' } };
  await call('POST', '/ext/runs', { jobId: 'j1', run: { ...state, status: 'running', stop: undefined } });
  assert.equal(queue.get('j1')?.status, 'running');
  await call('POST', '/ext/runs', { jobId: 'j1', run: state });
  assert.equal((await call('GET', '/tabs/j1/status')).json.run.stop.reason, 'submitReady');
  assert.deepEqual((await call('GET', '/ready')).json.map((j: { id: string }) => j.id), ['j1']);
  assert.equal(queue.get('j1')?.statusNote, 'submitReady: "Submit application"');
  assert.equal((await call('GET', '/tabs/nope/status')).status, 404);
});

test('answers become a command for the extension', async () => {
  const r = await call('POST', '/answers', { jobId: 'j2', fieldId: 'f7', frameId: 0, answer: 'Two weeks', save: { scope: 'global' } });
  assert.equal(r.status, 202);
  const [cmd] = (await call('GET', '/ext/commands')).json;
  assert.deepEqual([cmd.type, cmd.fieldId, cmd.answer], ['answer', 'f7', 'Two weeks']);
  assert.equal((await call('POST', '/answers', { jobId: 'j2', fieldId: 'f7' })).status, 400);
});

test('incidents land in the day\'s folder, and an id can\'t climb out of it', async () => {
  const r = await call('POST', '/incidents', { id: '../../evil', field: { label: 'Mobile #' } });
  assert.equal(r.status, 201);
  assert.equal(relative(incidentsDir, r.json.file).startsWith('..'), false);
  assert.equal(existsSync(r.json.file), true);
  assert.equal(JSON.parse(readFileSync(r.json.file, 'utf8')).field.label, 'Mobile #');
});

test('Stop all releases every lease, drops waiting commands and refuses new work until resumed', async () => {
  queue.add([job('j3')]);
  await call('GET', '/queue/next?worker=w2');
  await call('POST', '/run', { jobId: 'j3' });
  const stop = await call('POST', '/stop-all');
  assert.equal(stop.json.released >= 1, true);
  assert.deepEqual((await call('GET', '/ext/commands')).json.map((c: { type: string }) => c.type), ['stopAll']);
  assert.equal((await call('GET', '/queue/next?worker=w2')).status, 423);
  assert.equal((await call('POST', '/run', { jobId: 'j3' })).status, 423);
  assert.equal((await call('GET', '/health')).json.stopped, true);
  await call('POST', '/resume');
  assert.equal((await call('GET', '/queue/next?worker=w2')).status, 200);
});

test('bad requests say what is wrong', async () => {
  assert.equal((await call('POST', '/queue/j2/status', { status: 'done' })).status, 400);
  assert.equal((await call('POST', '/queue/missing/status', { status: 'stuck' })).status, 404);
  assert.equal((await call('POST', '/run', { jobId: 'missing' })).status, 404);
  assert.equal((await call('GET', '/nowhere')).status, 404);
});
