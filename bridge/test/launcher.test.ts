import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ACTIVITY_KEPT, activityOf, APPLIER_TOOLS, applierArgs, findClaude, FIXER_TOOLS, fixerArgs, type Git, Launcher, SCOUT_TOOLS, scoutArgs } from '../src/launcher.ts';
import { QueueStore } from '../src/queue.ts';
import { createBridge } from '../src/server.ts';

/** A stand-in for a Claude Code process: it records how it was started and ends when killed. */
function fakeSpawn() {
  const started: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string | undefined>; child: EventEmitter & { kill: () => boolean } }[] = [];
  let pid = 100;
  const spawn = (cmd: string, args: string[], opts: { cwd?: unknown; env?: unknown }) => {
    const child = Object.assign(new EventEmitter(), {
      pid: pid++,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        setImmediate(() => child.emit('exit', null));
        return true;
      },
    });
    started.push({ cmd, args, cwd: opts.cwd as string | undefined, env: opts.env as Record<string, string | undefined> | undefined, child });
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
  assert.deepEqual(toolsOf(args), APPLIER_TOOLS);
  assert.ok(args.join(' ').includes('--output-format stream-json --verbose'), 'every step streamed, for the Office (#64)');
  assert.ok(!APPLIER_TOOLS.some((t) => t === 'Bash' || t.startsWith('Bash(*') || t === 'Write' || t === 'Edit'), 'no open-ended shell or file writes');
  assert.ok(![...APPLIER_TOOLS, ...SCOUT_TOOLS].some((t) => t.startsWith('Write(')), 'Claude Code ignores Write(path) rules: Edit(path) only (#64)');
});

const toolsOf = (args: string[]) => args.slice(args.indexOf('--allowedTools') + 1);

test('what each agent is doing: one short line per step, refusals and the end (#64)', () => {
  assert.deepEqual(activityOf({ type: 'system', subtype: 'init' }), [{ text: 'Started' }]);
  assert.deepEqual(activityOf({ type: 'system', subtype: 'hook_started' }), []);
  const said = activityOf({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'x' },
    { type: 'text', text: 'Ranking   the\nnew jobs' },
    { type: 'tool_use', name: 'WebFetch', input: { url: 'https://www.linkedin.com/jobs/view/123?trk=x' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'python tools/apply_queue.py plan apply_queue/c.json' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\Users\\x\\ai-job-search\\apply_queue\\plan.json' } },
    { type: 'tool_use', name: 'ToolSearch', input: {} },
    { type: 'tool_use', name: 'mcp__claude-in-chrome__navigate', input: { url: 'https://boards.greenhouse.io/acme/jobs/1' } },
  ] } }).map((a) => a.text);
  assert.deepEqual(said, ['Ranking the new jobs', 'Fetched linkedin.com/jobs/view/123', 'Ran: python tools/apply_queue.py plan apply_queue/c.json', 'Wrote ai-job-search/apply_queue/plan.json', 'Opened boards.greenhouse.io/acme/jobs/1']);
  assert.equal(activityOf({ type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a/b/c/d.md' } }] } })[0].text, '↳ Read b/c/d.md', 'a helper’s steps are marked');
  assert.deepEqual(activityOf({ type: 'user', message: { content: [
    { type: 'tool_result', is_error: false, content: 'ok' },
    { type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'Permission to use Bash has been denied.' }] },
  ] } }), [{ text: 'A step failed or was refused: Permission to use Bash has been denied.', tone: 'warn' }]);
  assert.equal(activityOf({ type: 'result', subtype: 'success', result: 'Queued 4 jobs.' })[0].text, 'Finished: Queued 4 jobs.');
  assert.equal(activityOf({ type: 'result', subtype: 'error_max_turns', is_error: true })[0].tone, 'warn');
  assert.equal(activityOf('not an event').length, 0);
});

test('the launcher keeps each agent’s latest steps from its stream, and keeps them after it ends', async () => {
  const { spawn, started } = fakeSpawn();
  const l = new Launcher({ claude: 'claude.exe', cwd: '.', logDir: mkdtempSync(join(tmpdir(), 'ezaa-act-')), spawn });
  l.launchScout(5);
  const out = (started[0].child as unknown as { stdout: PassThrough }).stdout;
  out.write('{"type":"system","subtype":"init"}\nnot json\n');
  for (let i = 0; i < ACTIVITY_KEPT + 5; i++) out.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: `q${i}` } }] } })}\n`);
  await tick();
  const scout = l.list()[0];
  assert.equal(scout.activity.length, ACTIVITY_KEPT);
  assert.equal(scout.activity.at(-1)!.text, `Searched the web: q${ACTIVITY_KEPT + 4}`);
  started[0].child.emit('exit', 0);
  await tick();
  assert.equal(l.list()[0].status, 'ended');
  assert.equal(l.list()[0].activity.length, ACTIVITY_KEPT);
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
  assert.deepEqual(toolsOf(scoutArgs(8)), SCOUT_TOOLS);
  assert.ok(SCOUT_TOOLS.includes('Edit(company_research/**)'));
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

test('the Fixer: Opus running /ezaa-fixer in its worktree, editing only extension/, never committing (#69)', () => {
  const args = fixerArgs('C:/Users/x/Desktop/EzAutoApply-fix','fix/2026-11-18-fleet');
  assert.equal(args[0], '-p');
  assert.match(args[1], /^\/ezaa-fixer .*EzAutoApply-fix, branch fix\/2026-11-18-fleet.*Never commit or push/);
  assert.deepEqual(args.slice(2, 4), ['--model', 'opus']);
  assert.ok(args.join(' ').includes('--output-format stream-json --verbose'));
  assert.deepEqual(toolsOf(args), FIXER_TOOLS);
  assert.ok(!FIXER_TOOLS.some((t) => t === 'Bash' || t === 'Edit' || t === 'Write' || t.startsWith('Write(') || /git (commit|push)|gh pr|curl/.test(t)), 'no open shell, no commits, no pushes, no curl');
  assert.ok(!args.includes('--chrome'), 'the Fixer works through the bridge, not a browser');
});

/** Records git calls; `worktree add` makes the folder so the next start reuses it. */
function fakeGit(fail: RegExp | null = null) {
  const calls: string[] = [];
  const git: Git = (args, cwd) => {
    calls.push(`${args.join(' ')} @ ${cwd}`);
    if (fail?.test(args.join(' '))) return { ok: false, out: 'fatal: a branch named it already exists' };
    if (args[0] === 'worktree') mkdirSync(args[4], { recursive: true });
    return { ok: true, out: args[0] === 'rev-parse' ? 'fix/2026-11-18-fleet' : '' };
  };
  return { git, calls };
}

test('launchFixer makes the worktree from origin/main once, beside the checkout, and runs there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-fixer-'));
  const repo = join(dir, 'EzAutoApply');
  const { spawn, started } = fakeSpawn();
  const { git, calls } = fakeGit(/-b fix\/2026-11-18-fleet /);
  const launcher = new Launcher({ claude: 'claude.exe', cwd: join(dir, 'ai-job-search'), logDir: join(dir, 'fleet'), repo, git, spawn, now: () => Date.parse('2026-11-18T20:05:00Z') });
  assert.equal(launcher.launchFixer(), true);
  assert.equal(launcher.launchFixer(), false, 'one at a time');
  const fixDir = join(dir, 'EzAutoApply-fix');
  assert.deepEqual(calls, [
    `fetch origin main @ ${repo}`,
    `worktree add -b fix/2026-11-18-fleet ${fixDir} origin/main @ ${repo}`,
    `worktree add -b fix/2026-11-18-fleet-2005 ${fixDir} origin/main @ ${repo}`,
  ], 'a branch of that name already there: the next one gets the time');
  assert.equal(started[0].cwd, fixDir);
  assert.equal(started[0].env?.BASH_DEFAULT_TIMEOUT_MS, '600000', 'a shell call may take 10 minutes (#74)');
  assert.equal(started[0].env?.BASH_MAX_TIMEOUT_MS, '600000');
  assert.match(started[0].args[1], /branch fix\/2026-11-18-fleet-2005/);
  assert.equal(launcher.appliers(), 0, 'the Fixer is not an applier');
  started[0].child.kill();
  await tick();
  await tick();
  calls.length = 0;
  assert.equal(launcher.launchFixer(), true);
  assert.deepEqual(calls, [`rev-parse --abbrev-ref HEAD @ ${fixDir}`], 'the worktree is reused');
});

test('the bridge starts the Fixer a moment after a ticket opens, and only while it may (#69)', async () => {
  const TOKEN = 'test-token-fixer-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-fixer-bridge-'));
  const queue = new QueueStore(join(dir, 'queue.jsonl'));
  const { spawn, started } = fakeSpawn();
  const { git } = fakeGit();
  const launcher = new Launcher({ claude: 'claude.exe', cwd: dir, logDir: join(dir, 'fleet'), repo: join(dir, 'EzAutoApply'), git, spawn });
  const bridge = createBridge({ token: TOKEN, queue, incidentsDir: join(dir, 'incidents'), port: 0, launcher, fixerDelayMs: 20 });
  await new Promise<void>((r) => bridge.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const incident = (label: string) => call('POST', '/incidents', { at: new Date().toISOString(), ats: 'greenhouse', kind: 'unmatched', jobId: 'j1', field: { label } });
  const fixers = () => started.filter((s) => s.args[1].startsWith('/ezaa-fixer'));
  try {
    await call('PUT', '/settings', { parts: { fixer: false } });
    await incident('Notice period');
    await wait(60);
    assert.equal(fixers().length, 0, 'switched off: no Fixer');

    await call('PUT', '/settings', { parts: { fixer: true } });
    await incident('Notice period');
    await incident('Start date');
    assert.equal(fixers().length, 0, 'not at once: a burst of incidents is one start');
    await wait(60);
    assert.equal(fixers().length, 1);
    assert.equal((await call('GET', '/fleet')).json.fixing, true);
    assert.equal(bridge.snapshot().events.find((e) => e.who === 'Fleet')?.text, 'A ticket is open: the Fixer started');

    // A ticket that comes in while it works: it starts again once it ends.
    await wait(5);
    await incident('Pronouns');
    await wait(60);
    assert.equal(fixers().length, 1, 'one at a time');
    fixers()[0].child.kill();
    await wait(60);
    assert.equal(fixers().length, 2);

    // It ended with only the old tickets open: no new start until a new incident.
    fixers()[1].child.kill();
    await wait(60);
    assert.equal(fixers().length, 2);

    await call('POST', '/stop-all');
    await incident('Salary');
    await wait(60);
    assert.equal(fixers().length, 2, 'stopped: no Fixer');
  } finally {
    bridge.server.close();
  }
});

test('the Scout refills the queue when it runs dry while appliers work, not again soon after finding nothing (#72)', async () => {
  const TOKEN = 'test-token-refill-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-refill-'));
  const queue = new QueueStore(join(dir, 'queue.jsonl'));
  const { spawn, started } = fakeSpawn();
  let t = Date.parse('2026-11-18T21:00:00Z');
  const launcher = new Launcher({ claude: 'claude.exe', cwd: dir, logDir: join(dir, 'fleet'), spawn });
  const bridge = createBridge({ token: TOKEN, queue, incidentsDir: join(dir, 'incidents'), port: 0, launcher, now: () => t });
  await new Promise<void>((r) => bridge.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const scouts = () => started.filter((s) => s.args[1].startsWith('/scout'));
  try {
    await call('POST', '/queue', { jobs: [{ id: 'j1', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' }] });
    await call('POST', '/fleet/launch', { appliers: 1 });
    assert.equal(scouts().length, 0, 'a job was queued: no Scout at Start');
    assert.equal((await call('GET', '/queue/next?worker=w1')).json.id, 'j1');
    await call('POST', '/queue/j1/status', { status: 'skipped', note: 'skipped in the Office' });

    assert.equal((await call('GET', '/queue/next?worker=w1')).status, 204);
    assert.equal(scouts().length, 1, 'the queue ran dry: the Scout refills it');
    assert.equal((await call('GET', '/queue/next?worker=w1')).status, 204);
    assert.equal(scouts().length, 1, 'one at a time');

    // It found nothing: no new Scout for 15 minutes, then one more try.
    scouts()[0].child.kill();
    await tick();
    await tick();
    t += 10 * 60_000;
    await call('GET', '/queue/next?worker=w1');
    assert.equal(scouts().length, 1);
    t += 6 * 60_000;
    await call('GET', '/queue/next?worker=w1');
    assert.equal(scouts().length, 2);

    // Switched off: no refill.
    scouts()[1].child.kill();
    await tick();
    await tick();
    await call('PUT', '/settings', { parts: { scout: false } });
    t += 60 * 60_000;
    await call('GET', '/queue/next?worker=w1');
    assert.equal(scouts().length, 2);
  } finally {
    bridge.server.close();
  }
});

test('Start gives the jobs of an applier that ended mid-job to the appliers it starts (#77)', async () => {
  const TOKEN = 'test-token-orphans-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-orphans-'));
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
    await call('POST', '/queue', { jobs: [{ id: 'j1', applyUrl: 'https://jobs.ashbyhq.com/acme/1' }, { id: 'j2', applyUrl: 'https://jobs.lever.co/acme/2' }] });
    // w1 claimed j1 and w2 held j2 on a CAPTCHA; neither runs any more.
    queue.claim('w1');
    queue.claim('w2');
    queue.setStatus('j2', 'needsYou', { note: 'captcha' });
    const go = await call('POST', '/fleet/launch', { appliers: 1 });
    assert.deepEqual([go.status, go.json.started, go.json.scout], [202, ['w1'], undefined], 'work to do: an applier, not the Scout');
    assert.deepEqual([queue.get('j1')?.status, queue.get('j2')?.status, queue.get('j2')?.worker], ['queued', 'queued', undefined]);
    assert.equal(started.filter((s) => s.args[1].startsWith('/scout')).length, 0);
    // A running applier keeps its job.
    assert.equal((await call('GET', '/queue/next?worker=w1')).json.id, 'j1');
    await call('POST', '/fleet/launch', { appliers: 1 });
    assert.equal(queue.get('j1')?.worker, 'w1');
  } finally {
    bridge.server.close();
  }
});
