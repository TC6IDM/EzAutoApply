/**
 * PreToolUse guard shared by the repos that use claude-workflow (names come from config.mjs).
 *
 * WHY THIS EXISTS. CLAUDE.md's first ground rule is "never git commit or git
 * push without the owner's explicit approval for that specific commit or push".
 * Prose alone is the model choosing to obey. A hook is enforcement.
 *
 * Reads the PreToolUse payload on stdin, prints a decision on stdout, exits 0.
 * The decision itself is guard-rules.mjs › decide (ask / deny / allow), tested
 * in .claude/tests/guard.test.mjs.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, gitDirs, isCommit, isPush, isMerge } from './guard-rules.mjs';
import * as repo from './repo.mjs';

const read = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

const payload = await read().catch(() => '');
let cmd = '';
try { cmd = JSON.parse(payload)?.tool_input?.command ?? ''; } catch { process.exit(0); }
if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0);
// Only git commit/push and gh pr merge need git or the state file read; the repo's own denials need only the text.
const deny = repo.GUARD_DENY ?? [];
if (!isCommit(cmd) && !isPush(cmd) && !isMerge(cmd) && !deny.some(d => new RegExp(d.re).test(cmd))) process.exit(0);

const git = (args, cwd) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
let state = null;
try { state = JSON.parse(readFileSync(join(tmpdir(), `${repo.PREFIX}-sprint`, 'state.json'), 'utf8')); } catch { /* no sprint */ }

// Every checkout the command reaches (`cd <dir> &&`, `git -C <dir>`), with its branch (#57).
let cwd = process.cwd();
try { cwd = JSON.parse(payload)?.cwd || cwd; } catch { /* the process's own */ }
const toWin = p => p.replace(/^\/([a-zA-Z])\//, '$1:/'); // a Git Bash /c/ path, for Node on Windows
const home = git(['rev-parse', '--show-toplevel'], fileURLToPath(new URL('.', import.meta.url)));
const places = gitDirs(cmd, cwd).map(dir => {
  const at = resolve(process.platform === 'win32' ? toWin(dir) : dir);
  // A directory that isn't a checkout (yet) has no branch: it never counts as the sprint's.
  return { toplevel: git(['rev-parse', '--show-toplevel'], at) || at, branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], at) };
});

const result = decide(cmd, { state, places, home, name: repo.NAME, prefix: repo.PREFIX, deny, askAlways: repo.GUARD_ASK_ALWAYS === true });
if (result) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision, permissionDecisionReason: result.reason },
  }));
}
process.exit(0);
