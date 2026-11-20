// A sprint (config.mjs NAME): Claude works GitHub issues one after another and checkpoints
// (push, the PR brought up to date, issue notes) before the 5-hour or weekly usage limit runs out. See SKILL.md.
//
//   node .claude/skills/<prefix>-sprint/sprint.mjs start [--mine] [--small-at 80] [--new-at 94] [--stop-at 96] [--keep-going] [--autocompact [tokens]]   (on Fable the three default to 70 / 82 / 88)
//       --autocompact: compact at ~200k tokens (or the number given) for this sprint only
//       (.claude/settings.local.json), put back by `end` (or by the hook if the sprint died).
//       Without it, compaction is left alone. `compact-window <tokens>|off` by hand.
//       Needs a clean working tree and room in the budget. --here: carry on the current sprint/
//       branch (and its PR), merging origin/main in, instead of a new branch. Otherwise fetches origin/main, makes the
//       branch sprint/<date-time> from it, and remembers the sprint (state file in the temp folder).
//       --mine: issues already assigned to whoever gh is signed in as first; without it, also
//       unassigned ones. With --keep-going, once those are done it moves on to unassigned
//       ones (maintainer, 2026-11-13). Never an issue assigned to someone else.
//       --issues 12,34,56: do these first, in this order (a parent = its open sub-issues), then
//       the board as usual; add --only to stop after them.
//       --label <name>: only issues that also carry this label (named issues still go first).
//       --external <path>: the work lands in another repo's checkout (the showcase site). This
//       repo's branch is left alone and gets no commits; finish then checks THAT checkout and
//       takes --pr <url>, and checkpoint pushes nothing.
//       --avoid 86,131: never these or anything under them. Anything under a parent assigned to
//       someone else is left out without being asked.
//   ... budget            GO / SMALL / WRAP / STOP / UNKNOWN, with both limits and when they reset.
//   ... budget --hook     The PostToolUse hook: silent unless a sprint is on and it is SMALL, WRAP or STOP.
//   ... next [--limit 8] [--mine] [--issues …] [--only]  The issues Claude can take, named ones first,
//                         then the board best first, and the room left (flags only without a sprint).
//   ... begin N           Re-checks the assignee on GitHub (exit 4 and skipped if someone else has
//                         taken it since), then notes the issue and the usage when it started.
//   ... finish N --note "…" [--needs-live | --needs-device]  After the issue's own commit (refused if the tree is
//                         dirty or the last commit does not name #N): notes what it cost, pushes, opens
//                         the PR on the first issue (labelled "sprint: running", so CI waits; a new one if the last was merged) or updates
//                         it, and moves the issue to In Review (work.mjs review: the note + the PR).
//                         --needs-live: nobody has tried it on a live job site yet. The PR still says Fixes
//                         (the merge closes it, maintainer 2026-11-12) and adds that it is not yet seen.
//   ... checkpoint [--title "…"] [--intro-file f.md]  Rewrite the PR (title, Claude's description
//                         above the generated part, usage) and take the running label off: CI runs once.
//   ... sizes             What each size has cost, measured on the board ("Usage %", set by finish
//                         from the 5-hour reading at begin and finish), and issues whose size label
//                         looks wrong. `next` shows each candidate's expected cost from the same figures.
//   ... statusline        The status line command: saves the 5-hour and weekly figures Claude Code
//                         hands it, so usage() rarely needs the endpoint (and its 429s).
//   ... skip N --why "…"  Note an issue passed over (needs a phone, a decision, too big…).
//   ... unskip 12,34      Put passed-over issues back among the candidates (their blocker was answered).
//   ... take-from LOGIN[,LOGIN] [--undo]  The person said the sprint may also take issues assigned to
//                         these developers (e.g. "and Andrew's"): they count as the person's own for
//                         `next`, `begin` and the parent rule. Only on the person's word, never on a guess.
//   ... precompact        PreCompact hook: tells the summary what to keep (silent without a sprint).
//   ... aftercompact      SessionStart "compact" hook: puts the sprint back in Claude's context.
//   ... status            Where the sprint stands, its PR and the questions waiting.
//   ... ask "…"           Note a question for the checkpoint instead of stopping to ask it.
//   ... summary [--final] The PR body as it stands: Fixes lines, in progress, passed over, usage.
//   ... wind-down [--undo] Shut the sprint down gently: no new issue; the one in progress is
//                         finished and committed, then the checkpoint. Run it from any terminal
//                         while the sprint runs (the hook tells Claude on its next step), or say
//                         "wind down" / "/<prefix>-sprint wind down". --undo carries on as before.
//   ... end               Forget the sprint (after the checkpoint).
//
// The usage figures come from the endpoint Claude Code's /usage reads, with this machine's own
// Claude login. The token is read from ~/.claude/.credentials.json (or the macOS Keychain),
// sent only to api.anthropic.com, and never printed or stored anywhere else.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import https from 'node:https';

import { REPO, REPO_NAME, OWNER, PROJECT, MILESTONE_ORDER as MILESTONES, LINKED_REPOS, linkedRepoOf, NAME, PREFIX, NEEDS_LIVE_TEXT } from './repo.mjs';
import { STALE_HOURS, KEEP_GOING_STALE_HOURS, DEFAULT_SMALL_AT, DEFAULT_NEW_AT, DEFAULT_STOP_AT, FABLE_LINES, LARGE_SESSION_AT, LARGE_WEEKLY_UNDER, DEFAULT_ISSUE_COST, defaultLines, until, judge, isLarge, largeAllowed, averageCost, finishRefusal, USAGE_FIELD, MEASURED_AFTER, issueUsage, usageNote, sizeAverages, expectedCost, misSized } from './verdict.mjs';
const DIR = join(tmpdir(), `${PREFIX}-sprint`);
const STATE = join(DIR, 'state.json');
const CACHE = join(DIR, 'usage.json');
const RESTORE = join(DIR, 'compact-restore.json'); // what settings.local.json had before a sprint
const FAILED = join(DIR, 'usage-failed.json');      // the last failed read, for the back-off
const MODEL = join(DIR, 'statusline-model.json');   // the model id Claude Code last gave the status line
const STATUS = join(DIR, 'statusline-usage.json');  // the figures Claude Code last gave the status line

const args = process.argv.slice(2);
const action = args[0];
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = name => args.includes(`--${name}`);
const sh = (cmd, list, quiet) => execFileSync(cmd, list, { encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'] }).trim();

// ---------- state ----------
function readState() {
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    const last = Date.parse(s.readings?.at(-1)?.at || s.startedAt);
    return Date.now() - last > (s.keepGoing ? KEEP_GOING_STALE_HOURS : STALE_HOURS) * 3600e3 ? null : s;
  } catch { return null; }
}
function writeState(s) { mkdirSync(DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); }

// ---------- usage ----------
function claudeToken() {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  try { return JSON.parse(readFileSync(join(config, '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken || null; } catch {}
  if (platform() === 'darwin') {
    try { return JSON.parse(sh('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], true)).claudeAiOauth?.accessToken || null; } catch {}
  }
  return null;
}

// The status line's copy (see `statusline` below): Claude Code hands the status
// line the same 5-hour and weekly figures on every refresh, from its own API
// replies, so reading them costs nothing and never trips the endpoint's 429.
function statusLineUsage() {
  try {
    const s = JSON.parse(readFileSync(STATUS, 'utf8'));
    return Date.now() - s.at < 5 * 60000 ? s : null;
  } catch { return null; }
}

// The session's model, as the status line last saw it. Trusted for half an
// hour: the line refreshes on every turn, so anything older is another session.
function sessionModel() {
  try {
    const m = JSON.parse(readFileSync(MODEL, 'utf8'));
    return Date.now() - m.at < 30 * 60000 ? m : null;
  } catch { return null; }
}

// The three lines a sprint starts with when none is named, and why.

async function usage(maxAgeSeconds = 60) {
  const fromStatusLine = statusLineUsage();
  if (fromStatusLine) return fromStatusLine;
  let cached = null;
  try { cached = JSON.parse(readFileSync(CACHE, 'utf8')); } catch {}
  if (cached && Date.now() - cached.at < maxAgeSeconds * 1000) return cached;
  // The endpoint rate-limits (429) when asked too often, and every retry keeps
  // it limited: after a failure, leave it alone for two minutes.
  let failed = null;
  try { failed = JSON.parse(readFileSync(FAILED, 'utf8')); } catch {}
  const fresh = failed && Date.now() - failed.at < 2 * 60000 ? { error: failed.error } : await readUsage();
  if (fresh.error && !(failed && Date.now() - failed.at < 2 * 60000)) { try { mkdirSync(DIR, { recursive: true }); writeFileSync(FAILED, JSON.stringify({ at: Date.now(), error: fresh.error })); } catch {} }
  if (!fresh.error) rmSync(FAILED, { force: true });
  // A reading under twenty minutes old is still a fair guide; older, UNKNOWN.
  if (fresh.error && cached && Date.now() - cached.at < 20 * 60000) return { ...cached, stale: `${fresh.error}; using the reading from ${Math.round((Date.now() - cached.at) / 60000)} min ago` };
  return fresh;
}

async function readUsage() {
  const token = claudeToken();
  if (!token) return { error: 'no Claude login found on this machine' };
  try {
    // node:https without keep-alive, not fetch: on Windows, process.exit() while fetch's pooled
    // socket is closing trips a libuv assertion and the process dies with exit 127.
    const r = await new Promise((resolve, reject) => {
      const req = https.get('https://api.anthropic.com/api/oauth/usage', {
        agent: false,
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        timeout: 8000,
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
      req.on('error', reject);
    });
    if (r.status !== 200) return { error: `the usage endpoint answered ${r.status}` };
    const j = JSON.parse(r.body);
    const pct = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    // Weekly: the overall limit, and the Opus-only one when the plan has it.
    const weeklies = [j.seven_day, j.seven_day_opus].filter(w => pct(w?.utilization) !== null);
    const weekly = weeklies.sort((a, b) => b.utilization - a.utilization)[0];
    const out = {
      at: Date.now(),
      session: pct(j.five_hour?.utilization), sessionResets: j.five_hour?.resets_at || null,
      weekly: pct(weekly?.utilization), weeklyResets: weekly?.resets_at || null,
    };
    if (out.session === null && out.weekly === null) return { error: 'the usage endpoint gave no figures' };
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CACHE, JSON.stringify(out));
    return out;
  } catch (e) { return { error: `could not reach the usage endpoint (${e.name})` }; }
}



function record(s, u, step) {
  if (!s || u.error) return;
  // A 5-hour reading well below the last one: the window reset (keep-going carried on past it).
  const prev = s.readings?.at(-1);
  if (prev && typeof prev.session === 'number' && typeof u.session === 'number' && u.session < prev.session - 5) s.resets = (s.resets || 0) + 1;
  s.readings = [...(s.readings || []), { at: new Date().toISOString(), session: u.session, weekly: u.weekly, step }].slice(-300);
}



// ---------- the sprint's PR (maintainer, 2026-11-13) ----------
// The PR is open from the first finished issue on, so anyone can watch a sprint
// come in commit by commit, each issue reaching In Review as its commit lands,
// and merge it when its owner stops. A real PR, never a draft. While the sprint
// works, the PR carries RUNNING and CI skips it (.github/workflows/ci.yml, once it exists); the
// checkpoint takes the label off, and that one `unlabeled` event runs CI once
// (maintainer's yes, 2026-11-13; it keeps issue #307's saving). While paused the
// PR carries CHECKPOINT (blue) instead, and it swaps back when the sprint works
// again (#334). Taking CHECKPOINT off runs nothing: a CI workflow should react only to RUNNING coming off.
const RUNNING = 'sprint: running';
const CHECKPOINT = 'sprint: checkpoint';
const LABELS = {
  [RUNNING]: ['FBCA04', 'A sprint is still adding commits; CI runs when it checkpoints'],
  [CHECKPOINT]: ['3659E3', 'The sprint is paused at a checkpoint; CI has run on this state']
};
// Puts one sprint label on and the other off. The new one goes on first, so the
// PR is never without a label in between, and only RUNNING's removal runs CI.
function sprintLabel(pr, on) {
  const off = on === RUNNING ? CHECKPOINT : RUNNING;
  sh('gh', ['label', 'create', on, '--repo', REPO, '--color', LABELS[on][0], '--description', LABELS[on][1], '--force'], true);
  sh('gh', ['pr', 'edit', String(pr), '--repo', REPO, '--add-label', on], true);
  try { sh('gh', ['pr', 'edit', String(pr), '--repo', REPO, '--remove-label', off], true); }
  catch { /* not on (or taken off by hand) */ }
}
const ATTRIBUTION = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

function openPr(branch) {
  const list = JSON.parse(sh('gh', ['pr', 'list', '--repo', REPO, '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '5']));
  return list[0] || null;
}

const percent = v => (v ?? '?') + '%';

// The body is written here, never by hand, so every sprint PR says what it
// cost (maintainer, 2026-11-13: "keep putting the weekly / 5hr usage in the PRs").
// Claude's own description goes above it with `checkpoint --intro-file`.
function prBody(s, pr, running) {
  // A linked repo's issues are on that repo's PR (#57), never Fixes lines here:
  // this PR's merge would close them with their code still unmerged there.
  const done = s.done.filter(d => d.pr === pr && !d.repo);
  const lines = [];
  if (s.intro?.pr === pr) lines.push(s.intro.text.trim(), '');
  lines.push(...(done.length ? ['## Done',
    // Every finished issue closes on merge (maintainer, 2026-11-12), including one
    // nobody has seen on a phone yet; the line says so instead of keeping it open.
    ...done.map(d => `- ${d.title ? `${d.title}: ` : ''}Fixes #${d.n}${d.device ? ` (${NEEDS_LIVE_TEXT})` : ''}${d.cost != null ? ` · ${d.cost}% of the 5-hour window` : ''}${d.weeklyCost != null ? `, ${d.weeklyCost}% of the week` : ''}`)]
    : ['Nothing finished yet.']));
  // Commits on the branch from an earlier sprint on it (a restart, --here) are
  // not in s.done, and without their Fixes lines the merge left them open (#473,
  // 2026-11-14: PR #428 closed only #424 of twelve).
  const listed = new Set([...done.map(d => d.n), ...(s.current ? [s.current.n] : [])]);
  const earlier = [];
  let subjects = '';
  try { subjects = sh('git', ['log', '--no-merges', '--format=%s', 'origin/main..HEAD'], true); } catch {}
  for (const subject of subjects.split('\n')) {
    if (/^WIP\b/.test(subject)) continue;
    const named = subject.match(/\((#\d+(?:, #\d+)*)\)\s*$/);
    for (const n of named ? named[1].match(/\d+/g).map(Number) : []) if (!listed.has(n)) { listed.add(n); earlier.push(`- ${subject.replace(/\s*\((#\d+(?:, #\d+)*)\)\s*$/, '')}: Fixes #${n}`); }
  }
  if (earlier.length) lines.push('', '## Also on this branch (an earlier sprint)', ...earlier);
  for (const [name, l] of Object.entries(s.linked || {})) {
    const there = s.done.filter(d => d.repo === name);
    if (there.length) lines.push('', `## In ${name}`, `${l.pr ? `${l.repo}#${l.pr}` : l.repo} holds these; its merge closes them:`, ...there.map(d => `- ${d.title ? `${d.title}: ` : ''}#${d.n}`));
  }
  if (s.current) lines.push('', '## In progress', `- #${s.current.n}${s.current.repo ? ` (in ${s.current.repo})` : ''}${running ? `: being built now; it joins ${s.current.repo ? 'that repo\'s sprint PR' : 'this PR'} as its own commit when its checks pass` : ': not finished, kept off this PR (see its "Next" comment)'}`);
  if (s.skipped.length) lines.push('', '## Passed over', ...s.skipped.map(d => `- #${d.n}: ${d.why}`));
  const first = s.readings[0], last = s.readings.at(-1);
  if (first && last) {
    lines.push('', '## Usage', `- At the start (${new Date(first.at).toLocaleString()}): 5-hour ${percent(first.session)}, weekly ${percent(first.weekly)}`,
      `- Last reading (${new Date(last.at).toLocaleString()}): 5-hour ${percent(last.session)}, weekly ${percent(last.weekly)}`);
    if (s.resets) lines.push(`- The 5-hour window reset ${s.resets}× during the sprint`);
  }
  lines.push('', running
    ? `_The sprint is still running: each issue arrives as its own commit and its card moves to In Review. The "${RUNNING}" label holds CI back until the checkpoint takes it off (CI then runs once; take it off by hand to run CI sooner). It can be merged at any time; a later issue then opens a new PR._`
    : '_The sprint has checkpointed: CI runs once on this state. Nothing more arrives unless it resumes after a usage reset._', '', ATTRIBUTION);
  return lines.join('\n');
}

// Pushes the branch and makes sure the PR exists and says what is on it.
// Returns the PR's number, or null when nothing is finished yet. A PR merged
// mid-sprint is left alone: the next finished issue opens a new one.
function publish(s, running) {
  const file = join(DIR, 'pr.md');
  let pr = openPr(s.branch);
  // The label goes on before the push, so the push's CI run skips.
  if (pr && running) sprintLabel(pr.number, RUNNING);
  sh('git', ['push', '-u', 'origin', s.branch], true);
  const loose = s.done.filter(d => d.pr == null && !d.repo);
  if (!pr) {
    if (!loose.length) return null;
    writeFileSync(file, prBody(s, null, running));
    const title = s.title || loose[0].title || `Sprint ${s.branch}`;
    // Draft, label, then ready: a PR opened before its label would run CI at once.
    const url = sh('gh', ['pr', 'create', '--repo', REPO, '--base', 'main', '--head', s.branch, '--draft', '--title', title, '--body-file', file]);
    pr = { number: Number(url.match(/\/pull\/(\d+)/)[1]), url };
    if (running) sprintLabel(pr.number, RUNNING);
    sh('gh', ['pr', 'ready', String(pr.number), '--repo', REPO], true);
    if (s.intro?.pr == null && s.intro) s.intro.pr = pr.number;     // written before this PR existed
    else if (s.intro && s.intro.pr !== pr.number) delete s.intro;  // written for a PR already merged
  }
  for (const d of loose) d.pr = pr.number;
  s.pr = pr.number;
  writeState(s);
  writeFileSync(file, prBody(s, pr.number, running));
  const edit = ['pr', 'edit', String(pr.number), '--repo', REPO, '--body-file', file];
  if (!running && s.title) edit.push('--title', s.title);
  sh('gh', edit);
  if (!running) sprintLabel(pr.number, CHECKPOINT); // RUNNING comes off: CI runs once
  return pr.number;
}

// ---------- linked repos (#57) ----------
// One sprint also works ai-job-search (config.mjs LINKED_REPOS). The owner's own
// checkout is never switched, committed to or cleaned: often it is mid-edit on
// a branch of its own. The sprint adds a git worktree beside it instead
// (<parent>/<name>-sprint) on a branch named like this sprint's, made from that
// repo's own main. guard.mjs allows commits and pushes there on that branch only.
const repoRoot = () => sh('git', ['rev-parse', '--show-toplevel']);
const branchExists = (dir, branch) => { try { sh('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true); return true; } catch { return false; } };

/** Adds the worktree for each linked repo (or only `only`) to s.linked. Returns what happened, one line each. */
function linkRepos(s, only) {
  s.linked = s.linked || {};
  const said = [];
  for (const [name, cfg] of Object.entries(LINKED_REPOS)) {
    if (only && only !== name) continue;
    if (s.linked[name]) { said.push(`${name}: linked at ${s.linked[name].worktree} on ${s.linked[name].branch}`); continue; }
    const checkout = resolve(repoRoot(), cfg.path);
    try { sh('git', ['-C', checkout, 'rev-parse', '--show-toplevel'], true); }
    catch { said.push(`${name}: no checkout at ${checkout}; its issues are skipped this sprint`); continue; }
    const worktree = resolve(checkout, '..', `${name}-sprint`);
    const branch = s.branch;
    try {
      sh('git', ['-C', checkout, 'fetch', cfg.remote, cfg.base], true);
      const start = ['--no-track', '-b', branch, `${cfg.remote}/${cfg.base}`];
      if (existsSync(worktree)) {
        // Left by an earlier sprint (end keeps one that still had work in it).
        const dirty = sh('git', ['-C', worktree, 'status', '--porcelain']);
        if (dirty) { said.push(`${name}: ${worktree} still has uncommitted work from before; left alone, not linked (ask the owner)`); continue; }
        sh('git', ['-C', worktree, 'switch', ...(branchExists(checkout, branch) ? [branch] : ['--no-track', '-c', branch, `${cfg.remote}/${cfg.base}`])], true);
      } else {
        sh('git', ['-C', checkout, 'worktree', 'add', worktree, ...(branchExists(checkout, branch) ? [branch] : start)], true);
      }
    } catch (e) { said.push(`${name}: could not make the worktree (${String(e.message).split('\n')[0]}); not linked`); continue; }
    s.linked[name] = { checkout, worktree, branch, repo: cfg.repo, remote: cfg.remote, base: cfg.base, pr: null };
    said.push(`${name}: worktree ${worktree} on ${branch} from ${cfg.remote}/${cfg.base} (your checkout ${checkout} is untouched)`);
  }
  writeState(s);
  return said;
}

function linkedPrBody(s, name, running) {
  const done = s.done.filter(d => d.repo === name);
  const lines = [];
  // Titles and numbers only: when the board is public (config.mjs PUBLIC_BOARD) no private data goes in either PR.
  lines.push(...(done.length ? ['## Done', ...done.map(d => `- ${d.title ? `${d.title}: ` : ''}Fixes ${REPO}#${d.n}${d.cost != null ? ` · ${d.cost}% of the 5-hour window` : ''}`)] : ['Nothing finished yet.']));
  if (s.current?.repo === name) lines.push('', '## In progress', `- ${REPO}#${s.current.n}`);
  lines.push('', `The issues live on the ${REPO_NAME} board; this PR's merge closes them. ${s.pr ? `The same sprint's ${REPO_NAME} PR: ${REPO}#${s.pr}.` : ''}`.trim());
  lines.push('', running ? '_The sprint is still running: each issue arrives as its own commit._' : '_The sprint has checkpointed._', '', ATTRIBUTION);
  return lines.join('\n');
}

/** Pushes the linked worktree's branch and opens or updates that repo's PR. Returns the PR's number, or null. */
function publishLinked(s, name, running) {
  const l = s.linked?.[name];
  if (!l) return null;
  const done = s.done.filter(d => d.repo === name);
  if (!done.length && !l.pr) return null;
  sh('git', ['-C', l.worktree, 'push', '-u', l.remote, l.branch], true);
  const file = join(DIR, `pr-${name}.md`);
  writeFileSync(file, linkedPrBody(s, name, running));
  let pr = JSON.parse(sh('gh', ['pr', 'list', '--repo', l.repo, '--head', l.branch, '--state', 'open', '--json', 'number,url', '--limit', '5']))[0] || null;
  // Its own title, from what is on it (the sprint's title describes this repo's PR, not that one).
  const title = `${NAME} sprint ${l.branch.replace(/^sprint\//, '')}: ${done.length === 1 ? done[0].title : `${done.length} fleet issues`}`;
  if (!pr) {
    const url = sh('gh', ['pr', 'create', '--repo', l.repo, '--base', l.base, '--head', l.branch, '--title', title, '--body-file', file]);
    pr = { number: Number(url.match(/\/pull\/(\d+)/)[1]), url };
  } else {
    sh('gh', ['pr', 'edit', String(pr.number), '--repo', l.repo, '--body-file', file, '--title', title]);
  }
  l.pr = pr.number;
  for (const d of done) d.pr = pr.number;
  writeState(s);
  return pr.number;
}

// ---------- issues ----------
// ---------- usage per issue on the board (#49) ----------
// Every finished issue's 5-hour usage goes into the board's "Usage %" number
// field, so the cost of each size is measured across sprints (the state file is
// deleted by `end`; the board stays). The field is made on first use.
function boardItems() {
  return JSON.parse(sh('gh', ['project', 'item-list', PROJECT, '--owner', OWNER, '--limit', '1000', '--format', 'json'])).items;
}
// [{ n, size, usage }] for the board's issues (the field keys are the lowercased field names).
function boardUsage() {
  const key = USAGE_FIELD.toLowerCase();
  return boardItems().filter(i => i.content?.number).map(i => ({ n: i.content.number, size: i.size ?? null, usage: typeof i[key] === 'number' ? i[key] : null }));
}
function setBoardUsage(n, value) {
  const fields = JSON.parse(sh('gh', ['project', 'field-list', PROJECT, '--owner', OWNER, '--format', 'json', '--limit', '50'])).fields;
  let field = fields.find(f => f.name === USAGE_FIELD);
  if (!field) field = JSON.parse(sh('gh', ['project', 'field-create', PROJECT, '--owner', OWNER, '--name', USAGE_FIELD, '--data-type', 'NUMBER', '--format', 'json']));
  const item = boardItems().find(i => i.content?.number === n);
  if (!item) return false;
  const projectId = sh('gh', ['project', 'view', PROJECT, '--owner', OWNER, '--format', 'json', '--jq', '.id']);
  sh('gh', ['project', 'item-edit', '--id', item.id, '--project-id', projectId, '--field-id', field.id, '--number', String(value)]);
  return true;
}

const has = (issue, name) => issue.labels.some(l => l.name === name);
const rank = (issue, prefix, order) => { const i = order.findIndex(v => has(issue, `${prefix}${v}`)); return i < 0 ? order.length : i; };

const whoAmI = () => sh('gh', ['api', 'user', '--jq', '.login']);

// Every open issue with its parent and assignees, to answer "is this under someone else's work?"
function openTree() {
  const q = `query($after:String){ repository(owner:"${OWNER}", name:"${REPO_NAME}"){ issues(states:OPEN, first:100, after:$after){
    pageInfo { hasNextPage endCursor } nodes { number parent { number } assignees(first:10){ nodes { login } } } } } }`;
  const tree = new Map();
  let after = null;
  do {
    const list = ['api', 'graphql', '-f', `query=${q}`];
    if (after) list.push('-f', `after=${after}`);
    const page = JSON.parse(sh('gh', list)).data.repository.issues;
    for (const n of page.nodes) tree.set(n.number, { parent: n.parent?.number ?? null, assignees: n.assignees.nodes.map(a => a.login) });
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return tree;
}

// Why an issue is someone else's or off limits, or null. An issue is off limits when it, or any
// issue above it, is assigned to someone else and not to me, or is on the avoid list.
function offLimits(n, tree, me, avoid, also = []) {
  const ours = new Set([me, ...also]);
  for (let at = n, depth = 0; at && depth < 10; at = tree.get(at)?.parent, depth++) {
    if (avoid.has(at)) return at === n ? 'on the avoid list' : `under #${at} (avoid list)`;
    const who = tree.get(at)?.assignees || [];
    if (who.length && !who.some(w => ours.has(w))) return at === n ? `assigned to ${who.join(', ')}` : `under #${at}, assigned to ${who.join(', ')}`;
  }
  return null;
}

// Issues whose board card is In Review: built and pushed, waiting for a merge
// (an earlier sprint's, or anyone's). Not work to pick up again.
function inReview() {
  const q = `query($after:String){ user(login:"${OWNER}"){ projectV2(number:${PROJECT}){ items(first:100, after:$after){
    pageInfo { hasNextPage endCursor } nodes { content { ... on Issue { number state } } fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`;
  const numbers = new Set();
  try {
    let after = null;
    do {
      const list = ['api', 'graphql', '-f', `query=${q}`];
      if (after) list.push('-f', `after=${after}`);
      const items = JSON.parse(sh('gh', list)).data.user.projectV2.items;
      for (const item of items.nodes) if (item.content?.state === 'OPEN' && item.fieldValueByName?.name === 'In Review') numbers.add(item.content.number);
      after = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
    } while (after);
  } catch { /* the board is a help here, not a must: without it, nothing is left out */ }
  return numbers;
}

// mine: issues already assigned to the person running the sprint. Otherwise also
// unassigned ones (never someone else's). mine with keep-going: theirs first, then,
// once those are done, unassigned ones (maintainer, 2026-11-13).
const mineThenOpen = s => Boolean(s?.mine && s?.keepGoing);
function candidates(s, mine, tree, avoid) {
  const me = whoAmI();
  const thenOpen = mine && mineThenOpen(s);
  // --label <name>: only issues that also carry it. Several --label
  // flags to gh are an AND.
  const only = s?.label ?? opt('label');
  const list = JSON.parse(sh('gh', ['issue', 'list', '--repo', REPO, '--state', 'open', '--label', 'who:claude', ...(only ? ['--label', only] : []), '--limit', '400',
    '--json', 'number,title,labels,milestone,assignees']));
  const passed = new Set([...(s?.done || []).map(d => d.n), ...(s?.skipped || []).map(d => d.n), ...inReview()]);
  return list
    .filter(i => !passed.has(i.number))
    .filter(i => !has(i, 'type:epic') && !has(i, 'type:decision') && !has(i, 'inbox'))
    .filter(i => !i.labels.some(l => l.name.startsWith('status:')))
    .filter(i => i.assignees.some(a => a.login === me || (s?.takeFrom || []).includes(a.login)) || ((!mine || thenOpen) && i.assignees.length === 0))
    .filter(i => !offLimits(i.number, tree, me, avoid, s?.takeFrom))
    .map(i => ({
      ...i,
      key: [thenOpen && !i.assignees.some(a => a.login === me) ? 1 : 0, MILESTONES.indexOf(i.milestone?.title) < 0 ? MILESTONES.length : MILESTONES.indexOf(i.milestone?.title),
        rank(i, 'P', ['0', '1', '2', '3']), rank(i, 'size:', ['S', 'M', 'L']), i.number],
    }))
    .sort((a, b) => { for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) return a.key[k] - b.key[k]; return 0; });
}

// --issues 12,34,56: the issues the person named, in their order. A parent becomes its open
// sub-issues. Named issues skip the who:claude/status filters (the person asked for them, Claude
// still judges whether it can do one alone) but never one assigned to someone else.
const parseIssues = text => (text || '').split(/[\s,]+/).map(v => Number(v.replace('#', ''))).filter(Number.isInteger).filter(n => n > 0);

function expandNamed(numbers) {
  const out = [];
  for (const n of numbers) {
    const subs = JSON.parse(sh('gh', ['api', `repos/${REPO}/issues/${n}/sub_issues`, '--jq', '[.[] | select(.state == "open") | .number]']) || '[]');
    out.push(...(subs.length ? subs : [n]));
  }
  return [...new Set(out)];
}

function named(s, queue, tree, avoid) {
  const me = whoAmI();
  const passed = new Set([...(s?.done || []).map(d => d.n), ...(s?.skipped || []).map(d => d.n)]);
  const out = [];
  for (const n of queue.filter(n => !passed.has(n))) {
    if (!tree.has(n)) { console.log(`#${n} (named) is closed: left out`); continue; }
    const why = offLimits(n, tree, me, avoid);
    if (why) { console.log(`#${n} (named) is ${why}: left out`); continue; }
    const i = JSON.parse(sh('gh', ['issue', 'view', String(n), '--repo', REPO, '--json', 'number,title,labels,milestone,assignees,state']));
    out.push({ ...i, named: true });
  }
  return out;
}

// ---------- commands ----------
const s = readState();

if (action === 'budget') {
  if (flag('hook')) {
    // PostToolUse hook: quiet and quick unless a sprint is running and it is time to stop.
    // A sprint that died without `end` must not leave the small compaction window behind.
    if (!s) { try { readFileSync(RESTORE); restoreCompactWindow(); } catch {} process.exit(0); }
    if (s.windDown && !s.windDown.told) {
      // Said once, the moment Claude next uses a tool; `next` and `begin` hold the line after that.
      s.windDown.told = new Date().toISOString();
      writeState(s);
      const what = s.current
        ? `WIND DOWN (asked by the person): start no new issue. Finish #${s.current.n} properly (its checks, commit, sprint.mjs finish), then checkpoint (SKILL.md, "Checkpoint").`
        : 'WIND DOWN (asked by the person): start no new issue. Nothing is in progress, so checkpoint now (SKILL.md, "Checkpoint").';
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `[${PREFIX}-sprint] ${what}` } }));
      process.exit(0);
    }
    const u = await usage(120);
    const j = judge(u, s);
    if (j.verdict === 'GO') process.exit(0);
    const last = s.lastWarned || {};
    const again = j.verdict === 'STOP' ? 2 : 15; // minutes between reminders
    if (last.verdict === j.verdict && Date.now() - Date.parse(last.at) < again * 60000) process.exit(0);
    s.lastWarned = { verdict: j.verdict, at: new Date().toISOString() };
    record(s, u, `hook ${j.verdict}`);
    writeState(s);
    const what = j.verdict === 'STOP'
      ? `STOP: checkpoint NOW (${PREFIX}-sprint SKILL.md, "Checkpoint"): unfinished work to a wip/ branch, merge main, sprint.mjs checkpoint, issue notes. Start nothing else.`
      : j.verdict === 'SMALL'
        ? 'SMALL: carry on with the current issue; a new one only if it is size:S.'
      : j.verdict === 'WRAP'
        ? 'WRAP: start no new issue. Finish the current one only if it is a step or two away, otherwise checkpoint now.'
        : 'UNKNOWN: usage cannot be read. Finish the current issue, then checkpoint.';
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `[${PREFIX}-sprint] ${what} (${j.line})` } }));
    process.exit(0);
  }
  const u = await usage(30);
  const j = judge(u, s);
  if (s) { record(s, u, 'budget'); writeState(s); }
  console.log(j.line);
  if (j.verdict !== 'GO' && j.verdict !== 'SMALL' && j.resumeInSeconds !== null) console.log(`the ${j.binding} limit resets in ${Math.round(j.resumeInSeconds / 60)} min (resumeInSeconds=${j.resumeInSeconds})`);
  // A keep-going wake that only reads the budget still sees the Inbox (PTrainr, 2026-11-16).
  try {
    const inbox = sh('node', [new URL(`../${PREFIX}-issues/inbox.mjs`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'count'], true);
    console.log(inbox ? `${inbox} Do the Inbox pass before taking an issue (unless STOP).` : 'Inbox: nothing waiting.');
  } catch { console.log('Inbox: could not be read.'); }
  process.exit(0);
}

// ---------- the status line (statusLine in .claude/settings.json) ----------
// Claude Code runs this on every refresh with a JSON description of the session
// on stdin, including rate_limits.five_hour / seven_day { used_percentage,
// resets_at }. It saves those for usage() and prints one short line. Quick and
// quiet: anything missing just prints less.
if (action === 'statusline') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let limits = null;
  let model = null;
  try { const parsed = JSON.parse(input); limits = parsed.rate_limits || null; model = parsed.model || null; } catch {}
  if (model && (model.id || model.display_name)) {
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(MODEL, JSON.stringify({ at: Date.now(), id: model.id || null, name: model.display_name || null }));
    } catch {}
  }
  const pct = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const when = v => (v == null ? null : typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v).toISOString() : String(v));
  const session = pct(limits?.five_hour?.used_percentage), weekly = pct(limits?.seven_day?.used_percentage);
  if (session !== null || weekly !== null) {
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(STATUS, JSON.stringify({ at: Date.now(), source: 'status line', session, sessionResets: when(limits?.five_hour?.resets_at), weekly, weeklyResets: when(limits?.seven_day?.resets_at) }));
    } catch {}
  }
  const parts = [];
  if (session !== null) parts.push(`5h ${session}%`);
  if (weekly !== null) parts.push(`week ${weekly}%`);
  if (s) parts.push(`sprint${s.current ? ` #${s.current.n}` : ''} · ${s.done.length} done`);
  // Both PRs when a linked repo has one (#57): "PR #51 + ai-job-search #3".
  if (s?.pr || Object.values(s?.linked || {}).some(l => l.pr)) {
    parts.push([s.pr ? `PR #${s.pr}` : '', ...Object.entries(s.linked || {}).filter(([, l]) => l.pr).map(([name, l]) => `${name} #${l.pr}`)].filter(Boolean).join(' + '));
  }
  process.stdout.write(parts.join(' · ') || NAME);
  process.exit(0);
}

// ---------- the compaction window: only during a sprint ----------
// start sets autoCompactWindow in this machine's .claude/settings.local.json (gitignored, read live
// by Claude Code); end puts back what was there. RESTORE survives the sprint's state expiring, and
// the PostToolUse hook restores it if a sprint died without `end`.
function localSettings() { return join(sh('git', ['rev-parse', '--show-toplevel']), '.claude', 'settings.local.json'); }

function setCompactWindow(tokens) {
  const file = localSettings();
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`${file} is not valid JSON; not touching it`); }
  let restore = null;
  try { restore = JSON.parse(readFileSync(RESTORE, 'utf8')); } catch {}
  if (!restore) {
    restore = { file, had: 'autoCompactWindow' in settings, value: settings.autoCompactWindow ?? null };
    mkdirSync(DIR, { recursive: true });
    writeFileSync(RESTORE, JSON.stringify(restore));
  }
  settings.autoCompactWindow = tokens;
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function restoreCompactWindow() {
  let restore;
  try { restore = JSON.parse(readFileSync(RESTORE, 'utf8')); } catch { return false; }
  try {
    const settings = JSON.parse(readFileSync(restore.file, 'utf8'));
    if (restore.had) settings.autoCompactWindow = restore.value; else delete settings.autoCompactWindow;
    writeFileSync(restore.file, `${JSON.stringify(settings, null, 2)}\n`);
  } catch {}
  rmSync(RESTORE, { force: true });
  return true;
}

if (action === 'compact-window') {
  const v = args[1];
  if (v === 'off') { console.log(restoreCompactWindow() ? 'auto-compact window put back as it was' : 'nothing to put back'); process.exit(0); }
  const tokens = Number(v);
  if (!(tokens >= 100000 && tokens <= 1000000)) { console.log('usage: sprint.mjs compact-window <100000-1000000> | off'); process.exit(1); }
  setCompactWindow(tokens);
  console.log(`auto-compact at ~${tokens / 1000}k tokens until the sprint ends`);
  process.exit(0);
}

// ---------- compaction (hooks; both silent unless a sprint is on) ----------
// PreCompact: what the hook prints is added to the summary's instructions (never exit 2: that
// would block the compaction and the context would overflow instead).
if (action === 'precompact') {
  if (!s) process.exit(0);
  s.compactions = [...(s.compactions || []), new Date().toISOString()].slice(-50);
  writeState(s);
  console.log([
    `A /${PREFIX}-sprint is running. In the summary, keep exactly:`,
    `- the sprint: branch ${s.branch}; issues done ${s.done.map(d => `#${d.n}`).join(' ') || 'none'}; skipped ${s.skipped.map(d => `#${d.n}`).join(' ') || 'none'}${s.queue?.length ? `; named first ${s.queue.map(n => `#${n}`).join(' ')}${s.only ? ' (only these)' : ''}` : ''}${s.mine ? '; --mine' : ''}${s.takeFrom?.length ? `; also taking ${s.takeFrom.join(', ')}'s issues` : ''}${s.keepGoing ? '; keep going' : ''}`,
    `- the issue in progress${s.current ? ` (#${s.current.n})` : ''}: which of its boxes are done, every file changed and why, what was tried and failed, the checks still to run, and the next step`,
    '- any decision or instruction the person gave during the sprint, word for word',
    'Drop: tool output and file contents from issues already committed, and budget readings (sprint.mjs status has them).',
  ].join('\n'));
  process.exit(0);
}

// SessionStart with source "compact": put the sprint back in front of Claude.
if (action === 'aftercompact') {
  if (!s) process.exit(0);
  const context = [
    `[${PREFIX}-sprint] The conversation was just compacted in the middle of a sprint on ${s.branch}. Before anything else:`,
    `1. Re-read .claude/skills/${PREFIX}-sprint/SKILL.md (the loop, the checkpoint, what the sprint may and may not do).`,
    `2. Run \`node .claude/skills/${PREFIX}-sprint/sprint.mjs status\` and \`sprint.mjs budget\`, then \`git status\` and \`git diff --stat\` to see the work in progress.`,
    s.current ? `3. Issue #${s.current.n} is in progress: \`gh issue view ${s.current.n}\` (its ticked boxes say what landed), then carry on from the summary's next step.` : '3. No issue is in progress: carry on with `sprint.mjs next`.',
  ].join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  process.exit(0);
}

// `lines [--model <id>]`: the lines `start` would choose now, and why. Changes nothing.
if (action === 'sizes') {
  // The measured cost of each size, from the board's "Usage %" (#49), and issues whose label looks wrong.
  const rows = boardUsage();
  const averages = sizeAverages(rows);
  const measured = rows.filter(r => r.usage !== null).length;
  if (!measured) { console.log(`No issue has a ${USAGE_FIELD} yet: \`finish\` sets it for each issue a sprint finishes.`); process.exit(0); }
  console.log(`${measured} issue${measured === 1 ? '' : 's'} measured (${USAGE_FIELD}: the 5-hour window an issue used):`);
  for (const size of ['XS', 'S', 'M', 'L', 'XL']) {
    const a = averages[size];
    if (a) console.log(`  size:${size}  ${a.avg}% on average over ${a.n}${a.n >= MEASURED_AFTER ? '' : ` (next uses it from ${MEASURED_AFTER})`}`);
  }
  const odd = misSized(rows, averages);
  for (const o of odd) console.log(`  #${o.n} is size:${o.size} but used ${o.usage}%, nearer size:${o.looks}'s average`);
  if (!odd.length) console.log('  no size label looks wrong yet (needs two sizes with 3+ measured each)');
  process.exit(0);
}

if (action === 'lines') {
  const d = defaultLines(opt('model') ? { id: opt('model'), name: null } : sessionModel());
  console.log(`small issues only from ${d.smallAt}%, no new issue from ${d.newAt}%, checkpoint at ${d.stopAt}%: ${d.why}`);
  process.exit(0);
}

if (action === 'start') {
  if (s) { console.log(`A sprint is already on: ${s.branch}, started ${s.startedAt}. Carry on with it, or run "end" first.`); process.exit(1); }
  const dirty = sh('git', ['status', '--porcelain']);
  if (dirty) { console.log(`The working tree has changes; a sprint starts clean so its PR holds only its own work:\n${dirty}`); process.exit(2); }
  // The lines: a named flag wins; the rest follow the session's model (#82).
  const chosen = defaultLines(sessionModel());
  const newAt = Number(opt('new-at') ?? chosen.newAt), stopAt = Number(opt('stop-at') ?? chosen.stopAt);
  const smallAt = Math.min(Number(opt('small-at') ?? chosen.smallAt), newAt);
  if (!(smallAt > 0 && newAt > 0 && stopAt > newAt && stopAt <= 100)) { console.log('need 0 < --small-at <= --new-at < --stop-at <= 100'); process.exit(1); }
  const named = ['small-at', 'new-at', 'stop-at'].filter(k => opt(k) != null);
  console.log(`lines: small issues only from ${smallAt}%, no new issue from ${newAt}%, checkpoint at ${stopAt}% (${named.length === 3 ? 'all three named' : `${chosen.why}${named.length ? `; --${named.join(', --')} named` : ''}`})`);
  const u = await usage(30);
  const j = judge(u, { smallAt, newAt, stopAt });
  console.log(j.line);
  if (j.verdict !== 'GO' && j.verdict !== 'SMALL') { console.log('Not enough room to start a sprint now.'); process.exit(3); }
  let branch;
  // --external <path>: the issues' work lands in ANOTHER repo's checkout (the
  // showcase site, TC6IDM.github.io: its own rules, its own fable/* branch and
  // PR). This repo's branch is left exactly where it is and gets no commits;
  // the sprint still does the queue, the budget, the board and the notes.
  const external = opt('external') ? resolve(opt('external')) : null;
  if (external) {
    try { sh('git', ['-C', external, 'rev-parse', '--show-toplevel']); }
    catch { console.log(`--external ${external} is not a git checkout`); process.exit(1); }
    branch = sh('git', ['branch', '--show-current']);
  } else if (flag('here')) {
    sh('git', ['fetch', 'origin', 'main']);
    // --here: carry on an earlier sprint's branch and its open PR (the person
    // chose it), with main brought in first. Only a sprint/ branch.
    branch = sh('git', ['branch', '--show-current']);
    if (!branch.startsWith('sprint/')) { console.log(`--here needs a sprint/ branch; this is ${branch || 'no branch'}`); process.exit(1); }
    sh('git', ['merge', '--no-edit', 'origin/main']);
  } else {
    sh('git', ['fetch', 'origin', 'main']);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    branch = `sprint/${stamp}`;
    sh('git', ['switch', '-c', branch, 'origin/main']);
  }
  // Cards a merge closed since the last tidy leave the board before the sprint adds its own.
  try { sh(process.execPath, [join(sh('git', ['rev-parse', '--show-toplevel']), '.claude', 'skills', `${PREFIX}-issues`, 'work.mjs'), 'tidy'], true); }
  catch { console.log('(work.mjs tidy failed; the board may still show done cards)'); }
  const queue = expandNamed(parseIssues(opt('issues')));
  if (flag('only') && !queue.length) { console.log('--only needs --issues'); process.exit(1); }
  const avoid = parseIssues(opt('avoid'));
  const state = { startedAt: new Date().toISOString(), branch, smallAt, newAt, stopAt, keepGoing: flag('keep-going'), mine: flag('mine'), label: opt('label') || null, external, queue, only: flag('only'), avoid, done: [], skipped: [], current: null, readings: [] };
  record(state, u, 'start');
  writeState(state);
  // The linked repos' worktrees (#57); an --external sprint works one other checkout by hand instead.
  if (!external) { try { for (const line of linkRepos(state)) console.log(`linked ${line}`); } catch (e) { console.log(`(linking the other repos failed: ${e.message}; sprint.mjs link retries)`); } }
  // Only when asked: --autocompact [tokens] (default 200000). Without it compaction is untouched.
  if (flag('autocompact')) {
    const given = Number(opt('autocompact'));
    const tokens = Number.isFinite(given) && given > 0 ? given : 200000;
    if (!(tokens >= 100000 && tokens <= 1000000)) console.log('--autocompact takes 100000 to 1000000 tokens; compaction stays at its usual point');
    else {
      // Claude Code reads the window once, when a session starts (2.1.322: the
      // session's launch options), so the settings file only reaches the next
      // session. This one changes with /autocompact, which only the person can type.
      try {
        setCompactWindow(tokens);
        console.log(`auto-compact at ~${tokens / 1000}k tokens for the next session until the sprint ends.`);
        console.log(`THIS session: ask the person to type  /autocompact ${tokens}  now (it applies at once and is saved in their settings; /autocompact auto puts it back after the sprint).`);
      }
      catch (e) { console.log(`could not set the auto-compact window (${e.message}); compaction stays at its usual point`); }
    }
  }
  console.log(`sprint on: ${external ? `work lands in ${external} (this repo stays on ${branch}, no commits here)` : `branch ${branch} from origin/main`}${queue.length ? `, first ${queue.map(n => `#${n}`).join(' ')}${state.only ? ' and nothing else' : ''}` : ''}${state.mine ? ', only issues assigned to you' : ''}${state.label ? `, only issues labelled ${state.label}` : ''}${state.keepGoing ? ', keep going after resets' : ''}`);
  process.exit(0);
}

if (!s && action !== 'next') { console.log('No sprint is running (start one with: sprint.mjs start).'); process.exit(1); }

if (action === 'wind-down') {
  if (flag('undo')) { delete s.windDown; writeState(s); console.log('wind-down cancelled: the sprint carries on taking issues'); process.exit(0); }
  s.windDown = { at: new Date().toISOString() };
  writeState(s);
  console.log(`winding down: no new issue${s.current ? `; #${s.current.n} is finished and committed first` : ''}, then the checkpoint (push, PR, issue notes).`);
  console.log('Claude hears it on its next step (the PostToolUse hook). `sprint.mjs wind-down --undo` carries on instead.');
  process.exit(0);
}

if (action === 'next') {
  if (s?.windDown) {
    console.log(`WIND DOWN: asked ${new Date(s.windDown.at).toLocaleTimeString()}. Start no new issue${s.current ? `; finish #${s.current.n}, then checkpoint` : '; checkpoint now'}.`);
    process.exit(0);
  }
  const u = await usage(30);
  const j = judge(u, s);
  const mine = Boolean(s?.mine || flag('mine'));
  const queue = s ? s.queue || [] : expandNamed(parseIssues(opt('issues')));
  const only = s ? s.only : flag('only');
  const avoid = new Set(s ? s.avoid || [] : parseIssues(opt('avoid')));
  const tree = openTree();
  const first = named(s, queue, tree, avoid);
  const firstSet = new Set(first.map(i => i.number));
  const rest = only ? [] : candidates(s, mine, tree, avoid).filter(i => !firstSet.has(i.number));
  if (avoid.size) console.log(`avoiding ${[...avoid].map(n => `#${n}`).join(' ')} and everything under them`);
  const small = i => i.labels.some(l => l.name === 'size:S' || l.name === 'size:XS');
  const large = largeAllowed(u, s);
  const list = [...first, ...rest].filter(i => j.verdict !== 'SMALL' || small(i)).filter(i => large.ok || !isLarge(i.labels)).slice(0, Number(opt('limit') || 8));
  const cost = averageCost(s);
  console.log(j.line);
  // Every pass of the loop starts with the Inbox (the owner, 2026-11-17): a
  // comment waiting there becomes issues before anything is chosen.
  try {
    const inbox = sh('node', [new URL(`../${PREFIX}-issues/inbox.mjs`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'count'], true);
    console.log(inbox ? `${inbox} Log them first (inbox.mjs pending), then run next again.` : 'Inbox: nothing waiting.');
  } catch {
    console.log('Inbox: could not be read (offline or signed out); run inbox.mjs pending by hand.');
  }
  console.log([queue.length ? `named first: ${queue.map(n => `#${n}`).join(' ')}${only ? ' (only these)' : ''}` : '',
    only ? '' : mine ? (mineThenOpen(s) ? 'then issues assigned to you, then unassigned ones (never anyone else\'s)' : 'then only issues assigned to you') : 'then issues assigned to you and unassigned ones (never anyone else\'s)'].filter(Boolean).join('; '));
  if (j.used !== null) console.log(`room before checkpoint: ${j.stopAt - j.used}% · an issue has cost ${cost ? `${cost}% on average this sprint` : `~${DEFAULT_ISSUE_COST}% (a guess until one is measured)`}`);
  // What each size costs, measured on the board across sprints (#49); a guess until MEASURED_AFTER of a size.
  let averages = {};
  try { averages = sizeAverages(boardUsage()); } catch { /* the board is a nicety here; the list still prints */ }
  const measured = Object.entries(averages).map(([k, v]) => `${k} ${v.avg}% (${v.n})`);
  if (measured.length) console.log(`measured per size on the board: ${measured.join(' · ')}; a size's own average counts from ${MEASURED_AFTER} issues`);
  const sizeLabel = i => i.labels.map(l => l.name).find(n => n.startsWith('size:'));
  const fits = i => { const e = expectedCost(sizeLabel(i), averages, cost); return { ...e, ok: j.used === null || e.cost <= j.stopAt - j.used }; };
  if (j.verdict === 'GO') console.log(large.ok ? `${large.why}; work it in steps, wip/issue-N at each pause.` : `${large.why}: large issues are left out of this list.`);
  if (j.verdict === 'SMALL') console.log(`Past ${j.smallAt}%: size:S issues only.`);
  else if (j.verdict !== 'GO') console.log('Not GO: start no new issue.');
  for (const i of list) {
    const labels = i.labels.map(l => l.name).filter(n => /^(P\d|size:|platform:|type:)/.test(n)).join(' ');
    const f = fits(i);
    console.log(`#${i.number}  ${i.title}${i.named ? '  [named]' : ''}\n        ${labels} · ${i.milestone?.title || 'no milestone'} · ~${f.cost}%${f.measured ? ' (measured)' : ''}${f.ok ? '' : ` · does not fit the ${j.stopAt - j.used}% left`}`);
  }
  if (!list.length) console.log('Nothing left that Claude can take on its own.');
  process.exit(0);
}

// `link [name]`: give a running sprint the linked repos' worktrees (start does it
// for a new sprint; a sprint begun before #57 has none).
if (action === 'link') {
  if (s.external) { console.log('an --external sprint works its other checkout by hand; nothing to link'); process.exit(1); }
  for (const line of linkRepos(s, args[1])) console.log(line);
  process.exit(0);
}

// The linked repo an issue's code goes to (#57), from its labels.
const issueRepo = n => linkedRepoOf(JSON.parse(sh('gh', ['issue', 'view', String(n), '--repo', REPO, '--json', 'labels'])).labels);

if (action === 'begin' || action === 'finish' || action === 'skip') {
  const n = Number(args[1]);
  if (!Number.isInteger(n)) { console.log(`usage: sprint.mjs ${action} <issue>`); process.exit(1); }
  const where = action === 'skip' ? null : s.current?.n === n && 'repo' in s.current ? s.current.repo : issueRepo(n);
  if (where && !s.external && !s.linked?.[where]) {
    for (const line of linkRepos(s, where)) console.log(line);
    if (!s.linked?.[where]) { console.log(`#${n} goes to ${where}, which this sprint could not link: skip it (sprint.mjs skip ${n} --why "…").`); process.exit(7); }
  }
  const linked = where && !s.external ? s.linked[where] : null;
  if (action === 'finish') {
    // The issue's own commit must be in place: nothing left over, and the last
    // commit names it ("<title> (#N)"), so the PR gains exactly that one commit.
    // An external sprint asks the same two questions of the OTHER checkout, and
    // needs the PR that commit is on (--pr <url>): this script pushes nothing there.
    // A linked repo's issue asks them of its worktree, and this script pushes it (#57).
    const at = s.external ? ['-C', s.external] : linked ? ['-C', linked.worktree] : [];
    if (s.external && !opt('pr')) { console.log('an external sprint\'s finish needs --pr <url of the PR in the other repo>'); process.exit(1); }
    const dirty = sh('git', [...at, 'status', '--porcelain']);
    const subject = dirty ? '' : sh('git', [...at, 'log', '-1', '--no-merges', '--format=%s']); // a merge of main may sit on top
    const refused = finishRefusal({ n, dirty, subject, note: opt('note') });
    if (refused) { console.log(refused.why); process.exit(refused.code); }
  }
  if (action === 'begin' && s.windDown) {
    console.log(`winding down since ${new Date(s.windDown.at).toLocaleTimeString()}: no new issue. Checkpoint instead.`);
    process.exit(5);
  }
  if (action === 'begin') {
    // Asked again at the moment of taking it: another developer may have taken it since `next`.
    const me = whoAmI();
    const tree = openTree();
    const off = tree.has(n) ? offLimits(n, tree, me, new Set(s.avoid || []), s.takeFrom) : null;
    const assignees = tree.get(n)?.assignees || [];
    // mine + keep-going may take an unassigned issue once the person's own are done.
    const notMine = s.mine && !(s.queue || []).includes(n) && !assignees.includes(me) && !(mineThenOpen(s) && assignees.length === 0);
    if (!tree.has(n) || off || notMine) {
      const why = !tree.has(n) ? 'closed' : off || 'not assigned to you (--mine)';
      s.skipped.push({ n, why });
      writeState(s);
      console.log(`#${n} is ${why}: not taking it. Pick the next one.`);
      process.exit(4);
    }
  }
  const u = await usage(30);
  if (action === 'begin') {
    const b = judge(u, s);
    if (b.verdict === 'WRAP' || b.verdict === 'STOP') { console.log(`${b.line}\nNo new issue now: checkpoint instead.`); process.exit(6); }
    const sizes = JSON.parse(sh('gh', ['issue', 'view', String(n), '--repo', REPO, '--json', 'labels'])).labels.map(l => l.name);
    // --asked: the person asked for this issue now (maintainer, 2026-11-14), so the
    // fresh-window rule gives way; keep-going and the weekly room still hold.
    if (isLarge(sizes)) { const large = largeAllowed(u, s, flag('asked')); if (!large.ok) { console.log(`${b.line}\n#${n}: ${large.why}.`); process.exit(6); } }
    if (b.verdict === 'SMALL') {
      const size = sizes.find(x => x.startsWith('size:'));
      if (size !== 'size:S' && size !== 'size:XS') { console.log(`${b.line}\n#${n} is ${size || 'unsized'}: past ${b.smallAt}% only size:S issues start. Pick a small one or checkpoint.`); process.exit(6); }
    }
  }
  record(s, u, `${action} #${n}`);
  const used = u.error ? null : u.session;
  if (action === 'begin') s.current = { n, at: new Date().toISOString(), sessionAtStart: used, weeklyAtStart: u.weekly ?? null, repo: linked ? where : null };
  if (action === 'begin' && linked) {
    console.log(`#${n} is ${where} work: build it in ${linked.worktree} (branch ${linked.branch}), under that repo's CLAUDE.md, never in ${linked.checkout}.`);
    console.log(`Commit there as "<title> (${REPO}#${n})" with git -C "${linked.worktree}"; finish pushes it and opens or updates ${linked.repo}'s PR.`);
  }
  // Working again after a checkpoint: the PR says so at once, not at the next finish.
  if (action === 'begin' && !s.external) { try { const pr = openPr(s.branch); if (pr) sprintLabel(pr.number, RUNNING); } catch { /* the label is cosmetic; never block the work on it */ } }
  if (action === 'finish') {
    const start = s.current?.n === n ? s.current : null;
    const took = issueUsage(start, u);
    const cost = took.session;
    // Into the In Review note, and onto the board where `next` and `sizes` read it back (#49).
    const usageLine = usageNote(took);
    if (cost !== null) { try { setBoardUsage(n, cost); } catch { console.log(`(could not set ${USAGE_FIELD} on the board for #${n})`); } }
    // --needs-live: built and checked as far as tests and fixtures can (unit,
    // e2e fixtures), but nobody has run it on a real application site yet.
    let title = null;
    try { title = sh('gh', ['issue', 'view', String(n), '--repo', REPO, '--json', 'title', '--jq', '.title']); } catch { /* the PR line goes without it */ }
    s.done.push({ n, title, at: new Date().toISOString(), cost, weeklyCost: took.weekly, ...((flag('needs-live') || flag('needs-device')) && { device: true }), ...(linked && { repo: where }) });
    s.current = null;
    writeState(s);
    console.log(`#${n} done${cost !== null ? `, cost ${cost}% of the 5-hour window` : ''}`);
    const work = join(sh('git', ['rev-parse', '--show-toplevel']), '.claude', 'skills', `${PREFIX}-issues`, 'work.mjs');
    if (linked) {
      // That repo's branch and PR (#57); this repo's PR then lists it under "In <name>".
      const pr = publishLinked(s, where, true);
      console.log(`pushed ${linked.branch} in ${where}; ${linked.repo}#${pr} updated`);
      try { const own = publish(s, true); if (own) console.log(`${REPO_NAME} PR #${own} now lists it`); } catch (e) { console.log(`(could not update this repo's PR: ${String(e.message).split('\n')[0]})`); }
      console.log(sh(process.execPath, [work, 'review', String(n), '--note', `${opt('note')}; ${linked.repo}#${pr}${usageLine ? `; ${usageLine}` : ''}`]));
    } else if (s.external) {
      // The commit and its PR are the other repo's (already pushed there, under
      // that repo's own rule); here only the card moves, with the PR's address.
      console.log(sh(process.execPath, [work, 'review', String(n), '--note', `${opt('note')}; ${opt('pr')}${usageLine ? `; ${usageLine}` : ''}`]));
    } else {
      // Straight onto the PR and into In Review (maintainer, 2026-11-13), not at the checkpoint.
      const pr = publish(s, true);
      console.log(`pushed; PR #${pr} updated ("${RUNNING}": CI waits for the checkpoint)`);
      console.log(sh(process.execPath, [work, 'review', String(n), '--note', `${opt('note')}; PR #${pr}${usageLine ? `; ${usageLine}` : ''}`]));
    }
  }
  if (action === 'skip') {
    s.skipped.push({ n, why: opt('why') || 'no reason given' });
    if (s.current?.n === n) s.current = null;
  }
  writeState(s);
  console.log(judge(u, s).line);
  process.exit(0);
}

if (action === 'unskip' || action === 'take-from') {
  const s = readState();
  if (!s) { console.log('no sprint running'); process.exit(1); }
  if (action === 'unskip') {
    const back = new Set(parseIssues(process.argv[3]));
    s.skipped = s.skipped.filter(d => !back.has(d.n));
    console.log(`back among the candidates: ${[...back].map(n => `#${n}`).join(' ') || 'none'}`);
  } else {
    const logins = (process.argv[3] || '').split(',').map(v => v.trim()).filter(v => /^[A-Za-z0-9-]+$/.test(v));
    s.takeFrom = flag('undo') ? (s.takeFrom || []).filter(l => !logins.includes(l)) : [...new Set([...(s.takeFrom || []), ...logins])];
    console.log(`also taking issues assigned to: ${s.takeFrom.join(', ') || 'nobody else'}`);
  }
  writeState(s);
  process.exit(0);
}

if (action === 'status') {
  console.log(`branch ${s.branch}, started ${new Date(s.startedAt).toLocaleString()}, keep going: ${s.keepGoing ? 'yes' : 'no'}`);
  console.log(`done: ${s.done.map(d => `#${d.n}`).join(' ') || 'none'} · skipped: ${s.skipped.map(d => `#${d.n}`).join(' ') || 'none'} · now: ${s.current ? `#${s.current.n}` : 'nothing'}`);
  const r = s.readings.at(-1);
  if (r) console.log(`last reading: 5-hour ${r.session}%, weekly ${r.weekly}% (${r.step})`);
  if (s.pr) console.log(`PR #${s.pr}`);
  for (const [name, l] of Object.entries(s.linked || {})) console.log(`linked ${name}: ${l.worktree} on ${l.branch}${l.pr ? `, PR ${l.repo}#${l.pr}` : ', no PR yet'} · done there: ${s.done.filter(d => d.repo === name).map(d => `#${d.n}`).join(' ') || 'none'}`);
  for (const q of s.questions || []) console.log(`question for the checkpoint${q.issue ? ` (#${q.issue})` : ''}: ${q.text}`);
  if (s.windDown) console.log(`winding down since ${new Date(s.windDown.at).toLocaleTimeString()}: no new issue`);
  if (s.compactions?.length) console.log(`compacted ${s.compactions.length}× this sprint, last ${new Date(s.compactions.at(-1)).toLocaleTimeString()}`);
  process.exit(0);
}

// Questions wait for the checkpoint (maintainer, 2026-11-13): a sprint never
// stops to ask; it notes the question here and carries on. `status` lists them.
if (action === 'ask') {
  const text = args.slice(1).join(' ').trim();
  if (!text) { console.log('usage: sprint.mjs ask "<question, with the issue number>"'); process.exit(1); }
  s.questions = [...(s.questions || []), { at: new Date().toISOString(), issue: s.current?.n ?? null, text }];
  writeState(s);
  console.log(`noted (${s.questions.length} waiting for the checkpoint). Carry on: take the default or skip the issue.`);
  process.exit(0);
}

if (action === 'summary') {
  // What the PR body says now (publish() writes it; this only prints it).
  console.log(prBody(s, s.pr ?? null, !flag('final')));
  process.exit(0);
}

// The checkpoint's PR step: --title "<what the issues add up to>" and
// --intro-file <markdown> (Claude's description, kept above the generated part),
// then the body is rewritten with the latest usage and the running label comes off (CI runs once).
if (action === 'checkpoint') {
  if (opt('title')) s.title = opt('title');
  if (opt('intro-file') && !s.external) s.intro = { pr: openPr(s.branch)?.number ?? null, text: readFileSync(opt('intro-file'), 'utf8') };
  const u = await usage(30);
  record(s, u, 'checkpoint');
  writeState(s);
  if (s.external) console.log(`external sprint: nothing to push here; the work and its PR are in ${s.external} (done ${s.done.map(d => `#${d.n}`).join(' ') || 'none'})`);
  else {
    // Each linked repo first (#57): its own main merged in, then its PR, so this PR's body can name it.
    for (const [name, l] of Object.entries(s.linked || {})) {
      if (!l.pr && !s.done.some(d => d.repo === name)) continue;
      try {
        sh('git', ['-C', l.worktree, 'fetch', l.remote, l.base], true);
        sh('git', ['-C', l.worktree, 'merge', '--no-edit', `${l.remote}/${l.base}`], true);
      } catch {
        try { sh('git', ['-C', l.worktree, 'merge', '--abort'], true); } catch { /* nothing to abort */ }
        console.log(`${name}: merging ${l.remote}/${l.base} needs judgment; aborted, ask about it (sprint.mjs ask)`);
      }
      try { const p = publishLinked(s, name, false); console.log(p ? `${name}: ${l.repo}#${p} checkpointed` : `${name}: nothing finished there`); }
      catch (e) { console.log(`${name}: could not update its PR (${String(e.message).split('\n')[0]})`); }
    }
    const pr = publish(s, false);
    console.log(pr ? `PR #${pr} checkpointed: title, body and usage updated, "${RUNNING}" off and "${CHECKPOINT}" on, so CI runs once` : 'nothing finished: no PR');
  }
  const jc = judge(u, s);
  console.log(jc.line);
  // A wait longer than the prompt cache's hour: the first message after it
  // re-writes the whole context at full price, so a smaller context then costs
  // far less. Only the person can run /compact (maintainer, 2026-11-13).
  if (jc.verdict !== 'GO' && jc.verdict !== 'SMALL' && jc.resumeInSeconds > 3600) {
    console.log(`pause message: the reset is ${Math.round(jc.resumeInSeconds / 3600 * 10) / 10} h away, so say "a good moment to type /compact" (Claude cannot run it)`);
  }
  process.exit(0);
}

if (action === 'end') {
  // A linked worktree goes once it is clean (its branch and commits stay); one with work left in it stays.
  for (const [name, l] of Object.entries(s.linked || {})) {
    try { sh('git', ['-C', l.checkout, 'worktree', 'remove', l.worktree], true); console.log(`${name}: worktree ${l.worktree} removed (branch ${l.branch} kept)`); }
    catch { console.log(`${name}: worktree ${l.worktree} kept: it still has uncommitted work`); }
  }
  rmSync(STATE, { force: true });
  if (restoreCompactWindow()) console.log('auto-compact window put back as it was');
  console.log(`sprint ${s.branch} forgotten (done ${s.done.length}, skipped ${s.skipped.length})`);
  process.exit(0);
}

console.log('usage: sprint.mjs start|budget [--hook]|next|sizes|link [repo]|begin N|finish N --note "…"|checkpoint|ask "…"|skip N --why "…"|wind-down [--undo]|status|summary|end');
process.exit(1);
