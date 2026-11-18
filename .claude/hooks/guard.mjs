/**
 * PreToolUse guard for EzAutoApply (ported from Ride The Bus, 2026-11-17).
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
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { decide, isCommit, isPush, isMerge } from './guard-rules.mjs';

const read = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

const payload = await read().catch(() => '');
let cmd = '';
try { cmd = JSON.parse(payload)?.tool_input?.command ?? ''; } catch { process.exit(0); }
if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0);
// Only git commit/push and gh pr merge need git or the state file read.
if (!isCommit(cmd) && !isPush(cmd) && !isMerge(cmd)) process.exit(0);

const git = (args) => { try { return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
let state = null;
try { state = JSON.parse(readFileSync(join(tmpdir(), 'ezaa-sprint', 'state.json'), 'utf8')); } catch { /* no sprint */ }

const result = decide(cmd, { branch: git('rev-parse --abbrev-ref HEAD'), state });
if (result) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision, permissionDecisionReason: result.reason },
  }));
}
process.exit(0);
