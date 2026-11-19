import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ACTIVITY_KEPT, activityOf, ANSWERER_TOOLS, answererArgs, APPLIER_TOOLS, applierArgs, REPORTER_TOOLS, reporterArgs, findClaude, FIXER_CHECKS, FIXER_TOOLS, fixerArgs, type Git, Launcher, OUTREACH_TOOLS, outreachArgs, SCOUT_TOOLS, scoutArgs } from '../src/launcher.ts';
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

test('the Fixer: Opus running /ezaa-fixer in its worktree, editing only extension/, committing working fixes to its own PR (#69, #101)', () => {
  const args = fixerArgs('C:/Users/x/Desktop/EzAutoApply-fix', 'fix/2026-11-18-fleet');
  assert.equal(args[0], '-p');
  assert.match(args[1], /^\/ezaa-fixer .*EzAutoApply-fix, branch fix\/2026-11-18-fleet/);
  assert.match(args[1], /Every fix is its own commit, and every commit must leave the extension working/);
  assert.match(args[1], /git push -u origin fix\/2026-11-18-fleet at once/);
  assert.match(args[1], /gh pr create --base main --head fix\/2026-11-18-fleet/);
  assert.match(args[1], /never merge, never force-push/);
  assert.doesNotMatch(args[1], /left uncommitted|git stash list/, 'nothing left over: nothing said');
  assert.match(fixerArgs('d', 'b', 'kept')[1], /left uncommitted changes here/);
  assert.match(fixerArgs('d', 'b', 'stashed')[1], /they are in git stash/);
  assert.deepEqual(args.slice(2, 4), ['--model', 'opus']);
  assert.ok(args.join(' ').includes('--output-format stream-json --verbose'));
  assert.deepEqual(toolsOf(args), FIXER_TOOLS);
  assert.ok(!FIXER_TOOLS.some((t) => t === 'Bash' || t === 'Edit' || t === 'Write' || t.startsWith('Write(') || /curl|gh pr (merge|edit|close|ready)|git (merge|rebase|reset|checkout|switch|branch|tag)|--force|--amend/.test(t)), 'no open shell, no merge, no rewriting, no curl');
  // The only ways to publish: its own commit, a push naming origin, its own PR.
  const publishing = FIXER_TOOLS.filter((t) => /git (commit|push)|gh pr/.test(t));
  assert.deepEqual(publishing, ['Bash(git commit -m:*)', 'Bash(git push -u origin:*)', 'Bash(gh pr create:*)', 'Bash(gh pr view:*)', 'Bash(gh pr comment:*)']);
  assert.ok(!args.includes('--chrome'), 'the Fixer works through the bridge, not a browser');
  // #89: no cd, no PowerShell; every check it is told to run is on its list.
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--disallowedTools') + 2), ['--disallowedTools', 'PowerShell']);
  assert.ok(!FIXER_TOOLS.some((t) => /^Bash\(cd\b/.test(t)));
  assert.match(args[1], /never cd/);
  const allowed = (cmd: string) => FIXER_TOOLS.some((t) => { const m = /^Bash\((.*):\*\)$/.exec(t); return !!m && cmd.startsWith(m[1]); });
  for (const check of FIXER_CHECKS) assert.ok(allowed(check), `allowed: ${check}`);
  for (const cmd of ['git add extension', 'git commit -m "Fixer: x (ticket k)"', 'git push -u origin fix/2026-11-18-fleet', 'gh pr view', 'gh pr create --base main --head fix/x --title t --body b', 'git stash push -m k']) {
    assert.ok(allowed(cmd), `allowed: ${cmd}`);
  }
  for (const cmd of ['git push origin main', 'gh pr merge 1', 'git reset --hard', 'git add .claude']) assert.ok(!allowed(cmd), `refused: ${cmd}`);
});

/**
 * Stands in for git in the Fixer's worktree: `worktree add` makes the folder, `switch -c` moves
 * HEAD, and the tree's state (dirty, merged into main, stash applies) is set by the test.
 */
function fakeGit(o: { fail?: RegExp; dirty?: boolean; merged?: boolean; popFails?: boolean } = {}) {
  const calls: string[] = [];
  const state = { head: 'fix/2026-11-18-fleet', dirty: o.dirty ?? false, merged: o.merged ?? true };
  const git: Git = (args, cwd) => {
    const cmd = args.join(' ');
    calls.push(`${cmd} @ ${cwd}`);
    if (o.fail?.test(cmd)) return { ok: false, out: 'fatal: a branch named it already exists' };
    if (args[0] === 'worktree') mkdirSync(args[4], { recursive: true });
    if (args[0] === 'switch') state.head = args[2];
    if (args[0] === 'rev-parse') return { ok: true, out: state.head + '\n' };
    if (args[0] === 'status') return { ok: true, out: state.dirty ? ' M extension/src/core/fieldKeys.ts\n' : '' };
    if (args[0] === 'merge-base') return { ok: state.merged, out: '' };
    if (cmd === 'stash pop' && o.popFails) return { ok: false, out: 'CONFLICT (content)' };
    return { ok: true, out: '' };
  };
  return { git, calls, state };
}

function fixerLauncher(dir: string, git: Git, at = '2026-11-18T20:05:00Z') {
  const { spawn, started } = fakeSpawn();
  const repo = join(dir, 'EzAutoApply');
  const launcher = new Launcher({ claude: 'claude.exe', cwd: join(dir, 'ai-job-search'), logDir: join(dir, 'fleet'), repo, git, spawn, now: () => Date.parse(at) });
  return { launcher, started, repo, fixDir: join(dir, 'EzAutoApply-fix') };
}

test('launchFixer makes the worktree from origin/main once, beside the checkout, and runs there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-fixer-'));
  const { git, calls } = fakeGit({ fail: /-b fix\/2026-11-18-fleet / });
  const { launcher, started, repo, fixDir } = fixerLauncher(dir, git);
  assert.equal(launcher.launchFixer(), true);
  assert.equal(launcher.launchFixer(), false, 'one at a time');
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
});

test('a Fixer whose PR is not merged yet carries on on its branch, uncommitted work and all (#101)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-fixer-open-'));
  mkdirSync(join(dir, 'EzAutoApply-fix'));
  const { git, calls } = fakeGit({ merged: false, dirty: true });
  const { launcher, started, fixDir } = fixerLauncher(dir, git);
  assert.equal(launcher.launchFixer(), true);
  assert.ok(!calls.some((c) => /^(switch|stash|reset)/.test(c)), 'the branch and the tree are left as they are');
  assert.match(started[0].args[1], /branch fix\/2026-11-18-fleet\)/);
  assert.match(started[0].args[1], /left uncommitted changes here/);
  assert.equal(started[0].cwd, fixDir);
});

test('once main has its PR, the next Fixer starts a fresh branch from origin/main (#101)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-fixer-merged-'));
  mkdirSync(join(dir, 'EzAutoApply-fix'));
  const { git, calls } = fakeGit();
  const { launcher, started, repo, fixDir } = fixerLauncher(dir, git, '2026-11-19T09:30:00Z');
  assert.equal(launcher.launchFixer(), true);
  assert.deepEqual(calls, [
    `fetch origin main @ ${repo}`,
    `rev-parse --abbrev-ref HEAD @ ${fixDir}`,
    `status --porcelain @ ${fixDir}`,
    `merge-base --is-ancestor HEAD origin/main @ ${fixDir}`,
    `switch -c fix/2026-11-19-fleet origin/main @ ${fixDir}`,
  ]);
  assert.match(started[0].args[1], /branch fix\/2026-11-19-fleet\)/);
  assert.doesNotMatch(started[0].args[1], /git stash list|left uncommitted/);
});

test('uncommitted work from a stopped Fixer comes along to the fresh branch, or waits in the stash (#101)', () => {
  for (const popFails of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'ezaa-fixer-left-'));
    mkdirSync(join(dir, 'EzAutoApply-fix'));
    const { git, calls } = fakeGit({ dirty: true, popFails, fail: /switch -c fix\/2026-11-19-fleet / });
    const { launcher, started, fixDir } = fixerLauncher(dir, git, '2026-11-19T09:30:00Z');
    assert.equal(launcher.launchFixer(), true);
    const after = calls.slice(3).map((c) => c.replace(` @ ${fixDir}`, ''));
    assert.deepEqual(after, [
      'merge-base --is-ancestor HEAD origin/main',
      'stash push -u -m fixer: left on fix/2026-11-18-fleet',
      'switch -c fix/2026-11-19-fleet origin/main',
      'switch -c fix/2026-11-19-fleet-0930 origin/main',
      'stash pop',
      ...(popFails ? ['reset --hard HEAD'] : []),
    ]);
    assert.match(started[0].args[1], /branch fix\/2026-11-19-fleet-0930\)/);
    assert.match(started[0].args[1], popFails ? /they are in git stash/ : /left uncommitted changes here/);
  }
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
    // …but the ticket is there, open, for when the Fixer is switched on (owner, 2026-11-18).
    const open = (await call('GET', '/tickets')).json as { open: boolean; label?: string; count?: number }[];
    assert.equal(open.filter((t) => t.open).length, 1);
    assert.equal(bridge.snapshot().tickets.filter((t) => t.open).length, 1, 'and the Office shows it');

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

test('an applier whose job waited on the owner starts again once that job is settled and others wait (#80)', async () => {
  const TOKEN = 'test-token-topup-01234567890';
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-topup-'));
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
  const appliers = () => started.filter((s) => !s.args[1].startsWith('/scout')).length;
  try {
    await call('POST', '/queue', { jobs: [{ id: 'j1', applyUrl: 'https://jobs.ashbyhq.com/acme/1' }, { id: 'j2', applyUrl: 'https://jobs.lever.co/acme/2' }] });
    assert.equal((await call('POST', '/fleet/launch', { appliers: 1 })).status, 202);
    assert.equal(appliers(), 1);
    // w1 takes j1, it waits on the owner, and w1 stops.
    assert.equal((await call('GET', '/queue/next?worker=w1')).json.id, 'j1');
    await call('POST', '/queue/j1/status', { status: 'needsYou', note: 'a question for you' });
    started[0].child.emit('exit', 0);
    await tick();
    await tick();
    assert.equal(appliers(), 1, 'one application at a time: j2 waits while j1 waits on the owner');
    // The owner skips j1 in the Office: w1 comes back for j2.
    await call('POST', '/queue/j1/status', { status: 'skipped', note: 'skipped in the Office' });
    assert.equal(appliers(), 2);
    assert.equal(started.at(-1)!.args.join(' ').includes('w1'), true);
    // It doesn't start over and over when it ends at once.
    started.at(-1)!.child.emit('exit', 0);
    await tick();
    await call('POST', '/queue', { jobs: [{ id: 'j3', applyUrl: 'https://jobs.lever.co/acme/3' }] });
    assert.equal(appliers(), 2);
    // A posting already queued, however it is linked, isn't queued again (#79).
    const again = await call('POST', '/queue', { jobs: [{ id: 'own-x', applyUrl: 'https://jobs.lever.co/acme/2/?utm_source=linkedin#apply' }] });
    assert.deepEqual(again.json, { added: [], already: [{ id: 'j2', status: 'queued' }] });
    // Pause ends it.
    await call('POST', '/fleet/pause');
    assert.equal(appliers(), 2);
  } finally {
    bridge.server.close();
  }
});

test('Send back: a job you fixed goes back to the applier that waited on you, which starts again (#82)', async () => {
  const TOKEN = 'test-token-sendback-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-back-'));
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
    await call('POST', '/queue', { jobs: [{ id: 'j1', applyUrl: 'https://jobs.ashbyhq.com/acme/1', company: 'Acme' }] });
    await call('POST', '/fleet/launch', { appliers: 1 });
    await call('GET', '/queue/next?worker=w1');
    await call('POST', '/queue/j1/status', { status: 'needsYou', note: 'Location' });
    started[0].child.emit('exit', 0);
    await tick();
    assert.equal(started.length, 1);
    const back = await call('POST', '/queue/j1/back');
    assert.deepEqual([back.status, back.json.status, back.json.worker], [200, 'claimed', 'w1']);
    assert.equal(started.length, 2, 'w1 starts again');
    assert.match(started[1].args[1], /w1/);
    // w1 is told to finish j1 first.
    assert.equal((await call('GET', '/queue/next?worker=w1')).json.unfinished.id, 'j1');
    assert.equal((await call('POST', '/queue/j1/back')).status, 409, 'only a job that waits on you');
    assert.equal((await call('POST', '/queue/nope/back')).status, 404);
  } finally {
    bridge.server.close();
  }
});

test('Outreach (#97): its switch on starts /prospects once, with no browser and nothing that sends; never while stopped', async () => {
  const args = outreachArgs();
  assert.deepEqual(args.slice(0, 4), ['-p', '/prospects', '--model', 'sonnet']);
  assert.deepEqual(toolsOf(args), OUTREACH_TOOLS);
  assert.ok(!OUTREACH_TOOLS.some((t) => /chrome|gmail|slack|send|curl|^Bash$|^Edit|^Write/i.test(t)), 'web search and prospects.py only');

  const TOKEN = 'test-token-outreach-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-outreach-'));
  const { spawn, started } = fakeSpawn();
  const launcher = new Launcher({ claude: 'claude.exe', cwd: dir, logDir: join(dir, 'fleet'), spawn });
  const bridge = createBridge({ token: TOKEN, queue: new QueueStore(join(dir, 'queue.jsonl')), incidentsDir: join(dir, 'incidents'), port: 0, launcher });
  await new Promise<void>((r) => bridge.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const outreachRuns = () => started.filter((s) => s.args[1] === '/prospects').length;
  try {
    await call('POST', '/stop-all');
    await call('PUT', '/settings', { parts: { outreach: true } });
    assert.equal(outreachRuns(), 0, 'not while the fleet is stopped');
    await call('POST', '/resume');
    await call('PUT', '/settings', { parts: { outreach: false } });
    await call('PUT', '/settings', { parts: { outreach: true } });
    assert.equal(outreachRuns(), 1);
    assert.equal(launcher.outreachRunning(), true);
    await call('PUT', '/settings', { parts: { outreach: false } });
    await call('PUT', '/settings', { parts: { outreach: true } });
    assert.equal(outreachRuns(), 1, 'one at a time');
    assert.equal(launcher.appliers(), 0, 'Outreach is not an applier');
  } finally {
    bridge.server.close();
  }
});

test('the Answerer: Sonnet running /answer --ask with the rule-keeping script, no browser, no shell (#103)', () => {
  const args = answererArgs();
  assert.deepEqual(args.slice(0, 4), ['-p', '/answer --ask', '--model', 'sonnet']);
  assert.deepEqual(toolsOf(args), ANSWERER_TOOLS);
  assert.ok(!ANSWERER_TOOLS.some((t) => t === 'Bash' || t === 'Write' || t === 'Edit' || t.startsWith('mcp__') || /curl|git /.test(t)));
  assert.ok(!args.includes('--chrome'));
});

test('"Ask an agent" (#103): an ask starts the Answerer, and its answer or its no reaches the asking tab', async () => {
  const TOKEN = 'test-token-asks-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-asks-'));
  const { spawn, started } = fakeSpawn();
  const launcher = new Launcher({ claude: 'claude.exe', cwd: dir, logDir: join(dir, 'fleet'), spawn });
  const bridge = createBridge({ token: TOKEN, queue: new QueueStore(join(dir, 'queue.jsonl')), incidentsDir: join(dir, 'incidents'), port: 0, launcher });
  await new Promise<void>((r) => bridge.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const answerers = () => started.filter((s) => s.args[1] === '/answer --ask');
  const question = (fieldId: string, label: string) => ({ tabId: 7, frameId: 0, fieldId, label, kind: 'textarea', required: true, options: [], url: 'https://jobs.example.test/apply?token=secret', title: 'Engineer at Example' });
  try {
    await call('PUT', '/settings', { parts: { answerer: false } });
    assert.equal((await call('POST', '/asks', question('f1', 'Why us?'))).status, 423, 'switched off: refused, so the panel can say so');
    await call('PUT', '/settings', { parts: { answerer: true } });
    assert.equal((await call('POST', '/asks', { ...question('f1', 'Why us?'), tabId: 'x' })).status, 400);

    const one = (await call('POST', '/asks', question('f1', 'Why do you want to work here?'))).json.id as string;
    const two = (await call('POST', '/asks', question('f2', 'Have you been convicted of a crime?'))).json.id as string;
    assert.equal(answerers().length, 1, 'one Answerer for both');
    const waiting = (await call('GET', '/asks?waiting=1')).json as { id: string; page: { url: string; host: string } }[];
    assert.deepEqual(waiting.map((a) => a.id), [one, two]);
    assert.equal(waiting[0].page.url, 'https://jobs.example.test/apply', 'the address without its query');

    assert.equal((await call('POST', `/asks/${one}/answer`, { answer: 'Because…', save: { scope: 'jobs.example.test', sourceRefs: ['CLAUDE.md'], createdBy: 'answerer' } })).status, 200);
    assert.equal((await call('POST', `/asks/${one}/answer`, { answer: 'again' })).status, 409, 'answered once');
    assert.equal((await call('POST', `/asks/${two}/stop`, { why: 'an attestation: only you answer it' })).status, 200);
    const cmds = (await call('GET', '/ext/commands?wait=0')).json as Record<string, unknown>[];
    const answer = cmds.find((c) => c.type === 'answer')!;
    assert.deepEqual([answer.askId, answer.tabId, answer.frameId, answer.fieldId, answer.answer], [one, 7, 0, 'f1', 'Because…']);
    const done = cmds.find((c) => c.type === 'askDone')!;
    assert.deepEqual([done.askId, done.fieldId, done.why], [two, 'f2', 'an attestation: only you answer it']);

    // Asked while it works: it starts again once it ends.
    await wait(5);
    const three = (await call('POST', '/asks', question('f3', 'Notice period'))).json.id as string;
    assert.equal(answerers().length, 1, 'one at a time');
    answerers()[0].child.kill();
    await wait(60);
    assert.equal(answerers().length, 2, 'again, for the ask it never saw');
    assert.equal(launcher.appliers(), 0, 'the Answerer is not an applier');
    // That one ends without a word on it: the owner hears so, and it doesn't start a third time.
    answerers()[1].child.kill();
    await wait(60);
    const later = (await call('GET', '/ext/commands?wait=0')).json as Record<string, unknown>[];
    assert.match(String(later.find((c) => c.type === 'askDone' && c.askId === three)?.why), /ended without answering/);
    assert.equal(answerers().length, 2);
    assert.deepEqual((await call('GET', '/asks?waiting=1')).json, []);
  } finally {
    bridge.server.close();
  }
});

test('the Reporter: Sonnet in the owner’s checkout, reading reports and logging issues, editing only its drafts (#115)', () => {
  const args = reporterArgs();
  assert.match(args[1], /^\/ezaa-field-report /);
  assert.deepEqual(toolsOf(args), REPORTER_TOOLS);
  assert.ok(!REPORTER_TOOLS.some((t) => t === 'Bash' || t === 'Edit' || t === 'Write' || /git |gh pr|curl|mcp__/.test(t)), 'no shell, no git, no PRs, no browser');
  assert.deepEqual(REPORTER_TOOLS.filter((t) => t.startsWith('Edit(')), ['Edit(.field-reports/**)']);
});

test('field reports (#115): kept on disk without values, the Reporter starts in the checkout, and the issue is recorded', async () => {
  const TOKEN = 'test-token-reports-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-reports-'));
  const repo = join(dir, 'EzAutoApply');
  mkdirSync(repo);
  const { spawn, started } = fakeSpawn();
  const launcher = new Launcher({ claude: 'claude.exe', cwd: dir, logDir: join(dir, 'fleet'), repo, spawn });
  const bridge = createBridge({ token: TOKEN, queue: new QueueStore(join(dir, 'queue.jsonl')), incidentsDir: join(dir, 'incidents'), port: 0, launcher });
  await new Promise<void>((r) => bridge.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  try {
    assert.equal((await call('POST', '/reports', { url: 'https://x.test/a', note: '' })).status, 400, 'a note is required');
    const sent = await call('POST', '/reports', {
      url: 'https://acme.wd1.myworkdayjobs.com/apply?token=abc',
      ats: 'workday',
      title: 'Engineer at Acme',
      note: 'The Notice period dropdown was never found',
      html: '<div><label>Notice period</label><div class="fake-select"></div></div>',
      screen: 'data:image/jpeg;base64,' + Buffer.from('jpeg').toString('base64'),
      fields: [{ frameId: 0, id: 'f1', label: 'Phone', kind: 'text', status: 'filled', required: true, source: 'rule', key: 'phone', options: [], valueText: '555 0100', current: '555 0100' }],
    });
    assert.equal(sent.status, 202);
    const id = sent.json.id as string;
    const reporters = started.filter((s) => s.args[1].startsWith('/ezaa-field-report'));
    assert.equal(reporters.length, 1);
    assert.equal(reporters[0].cwd, repo, 'in the owner’s checkout');

    const folder = join(dir, 'reports', id);
    const saved = JSON.parse(readFileSync(join(folder, 'report.json'), 'utf8'));
    assert.equal(saved.url, 'https://acme.wd1.myworkdayjobs.com/apply', 'no query');
    assert.deepEqual(Object.keys(saved.fields[0]).sort(), ['frameId', 'id', 'key', 'kind', 'label', 'options', 'required', 'source', 'status']);
    assert.ok(!readFileSync(join(folder, 'report.json'), 'utf8').includes('555'), 'no value kept');
    assert.ok(existsSync(join(folder, 'page.html')) && existsSync(join(folder, 'screen.jpg')));

    const open = (await call('GET', '/reports?open=1')).json as { id: string }[];
    assert.deepEqual(open.map((r) => r.id), [id]);
    const one = (await call('GET', `/reports/${id}`)).json;
    assert.match(one.html, /fake-select/);
    assert.equal((await call('POST', `/reports/${id}/issue`, { url: 'https://example.com/x' })).status, 400);
    assert.equal((await call('POST', `/reports/${id}/issue`, { url: 'https://github.com/TC6IDM/EzAutoApply/issues/200' })).status, 200);
    assert.deepEqual((await call('GET', '/reports?open=1')).json, []);
    assert.equal((await call('GET', '/reports/..%2F..%2Fx')).status, 404);
    reporters[0].child.kill();
  } finally {
    bridge.server.close();
  }
});
