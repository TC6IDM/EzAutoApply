import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { APPLIER_TOOLS, applierArgs, findClaude, Launcher, SCOUT_TOOLS, scoutArgs } from '../src/launcher.ts';
import { QueueStore } from '../src/queue.ts';
import { createBridge } from '../src/server.ts';

/** A stand-in for a Claude Code process: it records how it was started and ends when killed. */
function fakeSpawn() {
  const started: { cmd: string; args: string[]; cwd?: string; child: EventEmitter & { kill: () => boolean } }[] = [];
  let pid = 100;
  const spawn = (cmd: string, args: string[], opts: { cwd?: unknown }) => {
    const child = Object.assign(new EventEmitter(), {
      pid: pid++,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        setImmediate(() => child.emit('exit', null));
        return true;
      },
    });
    started.push({ cmd, args, cwd: opts.cwd as string | undefined, child });
    return child as never;
  };
  return { spawn, started };
}

const tick = () => new Promise((r) => setImmediate(r));

test('an applier is a headless Claude Code with Claude in Chrome and only the apply-runner tools (#36)', () => {
  const args = applierArgs('w2', 'haiku', 3);
  assert.equal(args[0], '-p');
  assert.match(args[1], /applier w2 .*apply-runner\/SKILL\.md.*--jobs 3.*Never press Submit/);
  assert.deepEqual(args.slice(2, 5), ['--chrome', '--model', 'haiku']);
  assert.deepEqual(args.slice(6), APPLIER_TOOLS);
  assert.ok(!APPLIER_TOOLS.some((t) => t === 'Bash' || t.startsWith('Bash(*') || t === 'Write' || t === 'Edit'), 'no open-ended shell or file writes');
});

test('the Start count is how many run at once: 1 to 4, filling the free worker names', async () => {
  const { spawn, started } = fakeSpawn();
  const l = new Launcher({ claude: 'claude.exe', cwd: '/ajs', logDir: mkdtempSync(join(tmpdir(), 'ezaa-fleet-')), spawn });
  assert.deepEqual(l.launch({ appliers: 2 }), { started: ['w1', 'w2'], running: 2 });
  assert.equal(started[0].cwd, '/ajs');
  assert.deepEqual(l.launch({ appliers: 2 }), { started: [], running: 2 }, 'already running: nothing more');
  started[0].child.emit('exit', 0);
  await tick();
  assert.deepEqual(l.launch({ appliers: 9, model: 'sonnet' }), { started: ['w1', 'w3', 'w4'], running: 4 }, 'at most four');
  assert.ok(started.at(-1)!.args.includes('sonnet'));
  assert.deepEqual(l.list().map((a) => [a.worker, a.status]), [['w2', 'running'], ['w1', 'running'], ['w3', 'running'], ['w4', 'running'], ['w1', 'ended']]);
  assert.equal(l.stopAll(), 4);
  await tick();
  assert.equal(l.running(), 0);
});

test('no Claude Code, no start', () => {
  const l = new Launcher({ claude: null, cwd: '.', logDir: tmpdir() });
  assert.equal(l.found, false);
  assert.throws(() => l.launch({ appliers: 1 }), /EZAA_CLAUDE/);
});

test('findClaude: EZAA_CLAUDE, then the PATH, then the newest VS Code copy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ezaa-home-'));
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const v of ['2.1.9', '2.1.10']) {
    const d = join(home, '.vscode-insiders', 'extensions', `anthropic.claude-code-${v}-x64`, 'resources', 'native-binary');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, exe), '');
  }
  assert.match(findClaude({ PATH: '' }, home)!, /claude-code-2\.1\.10-x64/, 'by version, not by name');
  const bin = mkdtempSync(join(tmpdir(), 'ezaa-bin-'));
  writeFileSync(join(bin, exe), '');
  assert.equal(findClaude({ PATH: bin }, home), join(bin, exe));
  assert.equal(findClaude({ PATH: bin, EZAA_CLAUDE: join(bin, exe) }, home), join(bin, exe));
  assert.equal(findClaude({ PATH: bin, EZAA_CLAUDE: join(bin, 'missing') }, home), null);
  assert.equal(findClaude({ PATH: '' }, mkdtempSync(join(tmpdir(), 'ezaa-empty-'))), null);
});

test('the bridge: Start refuses what it must, Pause stops the claims, Stop all ends the appliers', async () => {
  const TOKEN = 'test-token-launch-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-launch-'));
  const queue = new QueueStore(join(dir, 'queue.jsonl'));
  const { spawn, started } = fakeSpawn();
  const launcher = new Launcher({ claude: 'claude.exe', cwd: dir, logDir: join(dir, 'fleet'), spawn });
  const bridge = createBridge({ token: TOKEN, queue, incidentsDir: join(dir, 'incidents'), port: 0, launcher });
  await new Promise<void>((r) => bridge.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  try {
    await call('PUT', '/settings', { parts: { scout: false } });
    assert.equal((await call('POST', '/fleet/launch', { appliers: 2 })).status, 409, 'an empty queue and no Scout: nothing to start for');
    await call('PUT', '/settings', { parts: { scout: true } });
    await call('POST', '/queue', { jobs: [{ id: 'j1', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' }, { id: 'j2', applyUrl: 'https://boards.greenhouse.io/acme/jobs/2' }] });
    await call('PUT', '/settings', { parts: { appliers: false } });
    assert.equal((await call('POST', '/fleet/launch', { appliers: 2 })).status, 423, 'appliers switched off');
    await call('PUT', '/settings', { parts: { appliers: true } });

    const go = await call('POST', '/fleet/launch', { appliers: 2, jobs: 5 });
    assert.deepEqual([go.status, go.json.started], [202, ['w1', 'w2']]);
    assert.match(started[0].args[1], /--jobs 5/);
    const view = (await call('GET', '/fleet')).json;
    assert.deepEqual([view.found, view.paused, view.max, view.appliers.length], [true, false, 4, 2]);

    assert.equal((await call('GET', '/queue/next?worker=w1')).json.id, 'j1');
    await call('POST', '/fleet/pause');
    const claim = await call('GET', '/queue/next?worker=w2');
    assert.deepEqual([claim.status, claim.json.error], [423, 'Paused: finish the job you have and stop']);

    const stop = await call('POST', '/stop-all');
    assert.deepEqual([stop.json.ended, stop.json.released], [2, 1]);
    await tick();
    assert.equal((await call('GET', '/fleet')).json.appliers.every((a: { status: string }) => a.status === 'ended'), true);
    assert.equal((await call('POST', '/fleet/launch', { appliers: 1 })).status, 423, 'stopped: Resume first');
    await call('POST', '/resume');
    assert.equal((await call('GET', '/queue/next?worker=w2')).status, 200, 'Resume clears the pause too');
  } finally {
    bridge.server.close();
  }
});

test('the Scout: sonnet running /scout, with only the scrape, rank and queue tools (#62)', () => {
  assert.deepEqual(scoutArgs(8).slice(0, 4), ['-p', '/scout --top 8', '--model', 'sonnet']);
  assert.deepEqual(scoutArgs(8).slice(5), SCOUT_TOOLS);
  assert.ok(!SCOUT_TOOLS.some((t) => t === 'Bash' || t === 'Write' || t === 'Edit' || /claude-in-chrome/.test(t)), 'no open shell, no free writes, no browser');
  assert.ok(SCOUT_TOOLS.includes('Bash(python tools/apply_queue.py:*)'));
});

test('Start on an empty queue: the Scout fills it, the appliers start with the first job, or not at all', async () => {
  const TOKEN = 'test-token-scout-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-scout-'));
  const queue = new QueueStore(join(dir, 'queue.jsonl'));
  const { spawn, started } = fakeSpawn();
  const launcher = new Launcher({ claude: 'claude.exe', cwd: dir, logDir: join(dir, 'fleet'), spawn });
  const bridge = createBridge({ token: TOKEN, queue, incidentsDir: join(dir, 'incidents'), port: 0, launcher });
  await new Promise<void>((r) => bridge.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  try {
    const go = await call('POST', '/fleet/launch', { appliers: 2, jobs: 3 });
    assert.deepEqual([go.status, go.json.scout, go.json.started], [202, true, []]);
    assert.deepEqual(started.map((x) => x.args[1]), ['/scout --top 6'], 'two appliers × three jobs');
    let view = (await call('GET', '/fleet')).json;
    assert.deepEqual([view.scouting, view.waiting], [true, 2]);
    assert.equal((await call('POST', '/fleet/launch', { appliers: 2, jobs: 3 })).json.scout, true, 'pressing again while it scouts starts no second Scout (the latest press wins)');
    assert.equal(started.length, 1);

    // The Scout queues a job: the waiting appliers start.
    await call('POST', '/queue', { jobs: [{ id: 'j1', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' }] });
    assert.deepEqual(started.slice(1).map((x) => x.args[1].match(/applier (w\d)/)![1]), ['w1', 'w2']);
    assert.match(started[1].args[1], /--jobs 3/);
    view = (await call('GET', '/fleet')).json;
    assert.equal(view.waiting, 0);
    started[0].child.emit('exit', 0);
    await tick();
    assert.equal((await call('GET', '/fleet')).json.scouting, false);
  } finally {
    bridge.server.close();
  }

  // A Scout that queues nothing: no appliers, and the Office is told.
  const dir2 = mkdtempSync(join(tmpdir(), 'ezaa-scout-'));
  const two = fakeSpawn();
  const launcher2 = new Launcher({ claude: 'claude.exe', cwd: dir2, logDir: join(dir2, 'fleet'), spawn: two.spawn });
  const bridge2 = createBridge({ token: TOKEN, queue: new QueueStore(join(dir2, 'queue.jsonl')), incidentsDir: join(dir2, 'incidents'), port: 0, launcher: launcher2 });
  await new Promise<void>((r) => bridge2.server.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${(bridge2.server.address() as AddressInfo).port}`;
  try {
    await fetch(base2 + '/fleet/launch', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{"appliers":1}' });
    two.started[0].child.emit('exit', 0);
    await tick();
    const view = await (await fetch(base2 + '/fleet', { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.deepEqual([view.scouting, view.waiting, two.started.length], [false, 0, 1]);
  } finally {
    bridge2.server.close();
  }
});
