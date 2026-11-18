import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { QueueStore } from '../src/queue.ts';
import { createBridge } from '../src/server.ts';
import { sampleProspects } from './sample-prospects.ts';
import { sampleState } from './sample-sprint.ts';

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
  await call('POST', '/ext/runs', { jobId: 'j1', run: state, fields: [{ id: 'f1', label: 'Phone', status: 'filled' }] });
  const status = (await call('GET', '/tabs/j1/status')).json;
  assert.equal(status.run.stop.reason, 'submitReady');
  assert.deepEqual(status.fields, [{ id: 'f1', label: 'Phone', status: 'filled' }]);
  // w1 holds it, so it isn't ready until w1 has checked every field, and w1 gets nothing else meanwhile (#67).
  assert.equal(queue.get('j1')?.status, 'running');
  assert.equal(queue.get('j1')?.statusNote, 'at Submit ("Submit application"): the applier is checking every field');
  assert.deepEqual((await call('GET', '/ready')).json, []);
  const busy = await call('GET', '/queue/next?worker=w1');
  assert.equal(busy.status, 409);
  assert.equal(busy.json.unfinished.id, 'j1');
  await call('POST', '/queue/j1/status', { status: 'needsYou', note: 'captcha' });
  assert.equal(queue.get('j1')?.worker, 'w1', 'a job waiting on the owner stays with w1');
  assert.equal((await call('GET', '/queue/next?worker=w1')).status, 409);
  await call('POST', '/queue/j1/status', { status: 'ready', note: 'checked: 12 required fields filled' });
  assert.deepEqual((await call('GET', '/ready')).json.map((j: { id: string }) => j.id), ['j1']);
  assert.equal(queue.get('j1')?.worker, undefined);
  assert.equal((await call('GET', '/tabs/nope/status')).status, 404);
});

test('a Run with no address goes to the job’s own', async () => {
  await call('POST', '/run', { jobId: 'j2' });
  const [cmd] = (await call('GET', '/ext/commands')).json;
  assert.equal(cmd.urlPrefix, 'https://boards.greenhouse.io/acme/jobs/j2');
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

test('the Fixer (#32): incidents become tickets, a resolution closes one, and the fleet build can be told to reload', async () => {
  await call('POST', '/incidents', { id: 'tk1', at: '2026-11-18T01:00:00.000Z', ats: 'lever', kind: 'unmatched', jobId: 'j9', field: { label: 'Notice period' } });
  await call('POST', '/incidents', { id: 'tk2', at: '2026-11-18T01:05:00.000Z', ats: 'lever', kind: 'unmatched', jobId: 'j10', field: { label: 'Notice period?' } });
  const open = (await call('GET', '/tickets?open=1')).json as { key: string; label: string; count: number }[];
  const t = open.find((x) => x.label === 'Notice period');
  assert.equal(t?.count, 2);
  const one = await call('GET', `/tickets/${t!.key}`);
  assert.deepEqual(one.json.details.map((d: { id: string }) => d.id).sort(), ['tk1', 'tk2']);

  assert.equal((await call('POST', `/tickets/${t!.key}/resolution`, { outcome: 'maybe' })).status, 400);
  assert.equal((await call('POST', '/tickets/t-0000000000/resolution', { outcome: 'fixed' })).status, 404);
  const done = await call('POST', `/tickets/${t!.key}/resolution`, { outcome: 'answered', note: 'Saved an agent answer for review' });
  assert.deepEqual([done.status, done.json.open, done.json.resolution.outcome], [200, false, 'answered']);
  assert.equal(((await call('GET', '/tickets?open=1')).json as { key: string }[]).some((x) => x.key === t!.key), false);

  assert.equal((await call('POST', '/fleet/reload')).status, 202);
  assert.deepEqual((await call('GET', '/ext/commands')).json.map((c: { type: string }) => c.type), ['reload']);
});

test('the recruiter page (#41): prospects from ai-job-search, marked by the owner, shown on the Office', async () => {
  const dir4 = mkdtempSync(join(tmpdir(), 'ezaa-bridge-outreach-'));
  const prospectsFile = join(dir4, 'outreach', 'prospects.jsonl');
  mkdirSync(join(dir4, 'outreach'));
  writeFileSync(prospectsFile, sampleProspects().map((p) => JSON.stringify(p)).join('\n') + '\n');
  const b = createBridge({ token: TOKEN, queue: new QueueStore(join(dir4, 'queue.jsonl')), incidentsDir: join(dir4, 'incidents'), port: 0, prospectsFile });
  await new Promise<void>((r) => b.server.listen(0, '127.0.0.1', r));
  const base4 = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  const c = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base4 + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    assert.equal((await c('GET', '/outreach')).json.length, 5);
    assert.equal((await c('POST', '/outreach/p-000000000a/status', { status: 'emailed' })).status, 400);
    assert.equal((await c('POST', '/outreach/p-000000000a/status', { status: 'sent', channel: 'fax' })).status, 400);
    assert.equal((await c('POST', '/outreach/p-ffffffffff/status', { status: 'sent' })).status, 404);
    const sent = await c('POST', '/outreach/p-000000000a/status', { status: 'sent', channel: 'linkedin' });
    assert.deepEqual([sent.status, sent.json.status, sent.json.channel], [200, 'sent', 'linkedin']);
    assert.equal(readFileSync(prospectsFile, 'utf8').includes('"sent_at"'), true);
    assert.deepEqual(b.snapshot().recruiters.map((p) => [p.name, p.status]), [['Sam Example', 'found'], ['Alex Sample', 'sent'], ['Pat Sent', 'sent']]);
    // Without the file the page is empty, never an error.
    assert.deepEqual((await call('GET', '/outreach')).json, []);
  } finally {
    b.server.close();
  }
});

test('a running sprint (#50): shown read-only, and Wind down runs the sprint\'s own script', async () => {
  const dir5 = mkdtempSync(join(tmpdir(), 'ezaa-bridge-sprint-'));
  const sprintDir = join(dir5, 'ezaa-sprint');
  mkdirSync(sprintDir);
  // A stand-in for sprint.mjs: records its arguments, so the test never touches a real sprint.
  const script = join(dir5, 'fake-sprint.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir5, 'called.json'))}, JSON.stringify(process.argv.slice(2)));\nconsole.log('wind-down: finishing the current issue');\n`);
  const b = createBridge({ token: TOKEN, queue: new QueueStore(join(dir5, 'queue.jsonl')), incidentsDir: join(dir5, 'incidents'), port: 0, sprint: { dir: sprintDir, script } });
  await new Promise<void>((r) => b.server.listen(0, '127.0.0.1', r));
  const base5 = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  const c = async (method: string, path: string) => {
    const res = await fetch(base5 + path, { method, headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    assert.equal((await c('GET', '/sprint')).json, null);
    assert.equal((await c('POST', '/sprint/wind-down')).status, 404, 'nothing to wind down');
    writeFileSync(join(sprintDir, 'state.json'), JSON.stringify(sampleState({ readings: [{ at: new Date().toISOString() }] })));
    assert.equal((await c('GET', '/sprint')).json.current.n, 50);
    assert.equal(b.snapshot().sprint?.branch, 'sprint/2026-11-18-0039');
    const wd = await c('POST', '/sprint/wind-down');
    assert.deepEqual([wd.status, wd.json.said], [200, 'wind-down: finishing the current issue']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir5, 'called.json'), 'utf8')), ['wind-down']);
    assert.equal((await call('GET', '/sprint')).json, null, 'a bridge without the option shows no sprint');
  } finally {
    b.server.close();
  }
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

test('the ready list says what agents answered, "go to tab" reaches the extension, and claims pause when too many wait (#29)', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'ezaa-bridge-ready-'));
  const q = new QueueStore(join(dir2, 'queue.jsonl'));
  const b = createBridge({ token: TOKEN, queue: q, incidentsDir: join(dir2, 'incidents'), port: 0, maxWaitMs: 500, maxReadyOpen: 2 });
  await new Promise<void>((r) => b.server.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  const go = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(at + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  try {
    q.add([job('r1'), job('r2'), job('r3'), job('r4')]);
    await go('POST', '/answers', { jobId: 'r1', fieldId: 'f7', answer: 'Two weeks' });
    const stopped = { tabId: 1, startUrl: 'x', page: 2, status: 'stopped', history: [], startedAt: 0, updatedAt: 0, stop: { reason: 'submitReady' } };
    await go('POST', '/ext/runs', { jobId: 'r1', run: stopped, fields: [{ id: 'f7', label: 'Notice period' }] });
    const ready = (await go('GET', '/ready')).json;
    assert.deepEqual(ready.map((j: { id: string; agentAnswered: string[] }) => [j.id, j.agentAnswered]), [['r1', ['Notice period']]]);

    assert.equal((await go('GET', '/queue/next?worker=w1')).status, 200, 'one ready job: still under 2');
    // r3 was run by hand (nobody holds it): ready at once.
    await go('POST', '/ext/runs', { jobId: 'r3', run: stopped });
    const paused = await go('GET', '/queue/next?worker=w2');
    assert.equal(paused.status, 429);
    assert.deepEqual([paused.json.ready, paused.json.maxReadyOpen], [2, 2]);

    await go('GET', '/ext/commands');
    assert.equal((await go('POST', '/ready/r1/focus')).status, 202);
    assert.deepEqual((await go('GET', '/ext/commands')).json.map((c: { type: string; jobId: string }) => [c.type, c.jobId]), [['focus', 'r1']]);
    assert.equal((await go('POST', '/ready/nope/focus')).status, 404);

    // Marked submitted (by hand, or the extension seeing the confirmation page): claims go on.
    await go('POST', '/queue/r3/status', { status: 'submitted', note: 'marked by hand' });
    assert.equal((await go('GET', '/queue/next?worker=w2')).json?.id, 'r4');
  } finally {
    b.server.close();
  }
});

test('the Office (#35): the page needs no token, its stream does, and a change shows up on it', async () => {
  const page = await fetch(base + '/office');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
  assert.match(await page.text(), /<title>Fleet Office<\/title>/);

  assert.equal((await fetch(base + '/office/events')).status, 401);
  assert.equal((await fetch(base + '/office/events?token=wrong-token-0123456789')).status, 401);
  // A page on another site can't read the stream even with the token in hand.
  assert.equal((await fetch(base + `/office/events?token=${TOKEN}`, { headers: { origin: 'https://evil.example' } })).status, 403);

  const ac = new AbortController();
  const res = await fetch(base + `/office/events?token=${TOKEN}`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const nextSnapshot = async () => {
    for (;;) {
      const at = buffered.indexOf('\n\n');
      if (at >= 0) {
        const chunk = buffered.slice(0, at);
        buffered = buffered.slice(at + 2);
        const data = /^event: snapshot\ndata: (.*)$/m.exec(chunk);
        if (data) return JSON.parse(data[1]);
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffered += decoder.decode(value, { stream: true });
    }
  };
  try {
    const first = await nextSnapshot();
    assert.equal(typeof first.counts.queued, 'number');
    assert.ok(first.workers.some((w: { name: string }) => w.name === 'w1'), 'a worker that asked for a job has a desk');
    // The page's own origin may act (Stop all, Resume, "I submitted it").
    const own = await fetch(base + '/queue', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ jobs: [job('office-1')] }),
    });
    assert.equal(own.status, 201);
    const next = await nextSnapshot();
    assert.ok(next.queue.some((j: { id: string }) => j.id === 'office-1'));
  } finally {
    ac.abort();
  }
});

test('screenshots (#37): the latest per job, in memory, shown on the Office only with the token', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  assert.equal((await call('POST', '/ext/screens', { jobId: 'j1', image: 'https://x.test/a.jpg' })).status, 400);
  assert.equal((await call('POST', '/ext/screens', { jobId: 'j1', image: `data:image/jpeg;base64,${jpeg.toString('base64')}` })).status, 201);
  assert.equal(bridge.snapshot().ready.find((j) => j.id === 'j1')?.screenAt !== null, true, 'the snapshot says there is one');

  assert.equal((await fetch(base + '/office/screens/j1')).status, 401);
  const got = await fetch(base + `/office/screens/j1?token=${TOKEN}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), jpeg);
  assert.equal((await fetch(base + `/office/screens/none?token=${TOKEN}`)).status, 404);
  assert.equal(existsSync(join(dir, 'screens')), false, 'nothing on disk');
});

test('the fleet switches (#54): read, change in part, and claims obey them', async () => {
  const dir3 = mkdtempSync(join(tmpdir(), 'ezaa-bridge-switches-'));
  const q = new QueueStore(join(dir3, 'queue.jsonl'));
  const settingsFile = join(dir3, 'fleet-settings.json');
  const b = createBridge({ token: TOKEN, queue: q, incidentsDir: join(dir3, 'incidents'), port: 0, settingsFile });
  await new Promise<void>((r) => b.server.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  const go = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(at + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  try {
    assert.equal((await go('GET', '/settings')).json.apply.linkedinEasy, false);
    q.add([{ ...job('easy'), applyKind: 'linkedin-easy' }, { ...job('ext'), applyKind: 'external', source: 'linkedin' }]);
    // Easy Apply is off by default: the external job goes out, the Easy Apply one stays queued.
    assert.equal((await go('GET', '/queue/next?worker=w1')).json.id, 'ext');
    assert.equal((await go('GET', '/queue/next?worker=w2')).status, 204);
    assert.equal(q.get('easy')?.status, 'queued');

    assert.equal((await go('PUT', '/settings', { apply: { linkedinEasy: true } })).json.apply.linkedinEasy, true);
    assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).apply.linkedinEasy, true, 'saved');
    // The Office sees the switches and the change on its ticker (#55).
    assert.equal(b.snapshot().settings.apply.linkedinEasy, true);
    assert.equal(b.snapshot().events.find((e) => e.who === 'You')?.text, 'Switched on: LinkedIn Easy Apply');
    assert.equal((await go('PUT', '/settings', { apply: { linkedinEazy: true } })).status, 400);

    await go('PUT', '/settings', { parts: { appliers: false } });
    q.add([job('later')]);
    assert.equal((await go('GET', '/queue/next?worker=w1')).status, 423, 'appliers off: no claims');
    await go('PUT', '/settings', { parts: { appliers: true } });
    assert.ok(['easy', 'later'].includes((await go('GET', '/queue/next?worker=w2')).json.id));
  } finally {
    b.server.close();
  }
});

test('bad requests say what is wrong', async () => {
  assert.equal((await call('POST', '/queue/j2/status', { status: 'done' })).status, 400);
  assert.equal((await call('POST', '/queue/missing/status', { status: 'stuck' })).status, 404);
  assert.equal((await call('POST', '/run', { jobId: 'missing' })).status, 404);
  assert.equal((await call('GET', '/nowhere')).status, 404);
});
