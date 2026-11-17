/**
 * PreToolUse guard for EzAutoApply (ported from Ride The Bus, 2026-11-17).
 *
 * WHY THIS EXISTS. CLAUDE.md's first ground rule is "never git commit or git
 * push without the owner's explicit approval for that specific commit or push".
 * Prose alone is the model choosing to obey. A hook is enforcement.
 *
 * Reads the PreToolUse payload on stdin, prints a decision on stdout, exits 0.
 *
 * Decisions:
 *   ask   commit and push, every time (NOT deny: the owner does commit, they want
 *         to be asked first, and "ask" cannot be allowlisted away).
 *   deny  a bare `git push` from main, a force-push anywhere, and `gh pr merge`
 *         while a sprint runs.
 *   allow commit and push on a running sprint's own branches (the sprint
 *         exception, below).
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const read = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

const decide = (decision, reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
};

const payload = await read().catch(() => '');
let cmd = '';
try { cmd = JSON.parse(payload)?.tool_input?.command ?? ''; } catch { process.exit(0); }
if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0);

const git = (args) => { try { return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

const isCommit = /\bgit\b[^|;&]*\bcommit\b/.test(cmd);
const isPush = /\bgit\b[^|;&]*\bpush\b/.test(cmd);
const forced = isPush && /--force\b|--force-with-lease\b|\s-f\b|\s\+\S/.test(cmd);

if (forced) decide('deny', 'Force-push is blocked in EzAutoApply. Ask the owner, and do it by hand if they agree.');

if (isPush) {
  // A push with no refspec from main publishes straight to origin/main with no branch named.
  const hasRefspec = /\bpush\b\s+\S+\s+\S+/.test(cmd) || /\bpush\b[^|;&]*(--set-upstream|-u)\b/.test(cmd);
  if (!hasRefspec && git('rev-parse --abbrev-ref HEAD') === 'main') {
    decide('deny', 'Bare `git push` from main is blocked. Name the branch (`git push origin main:main`), after asking.');
  }
}

// --- The sprint exception -------------------------------------------------
// Invoking /ezaa-sprint is the owner's yes for THAT sprint only (CLAUDE.md,
// "Issues and sprints"): one commit per issue on its own sprint/<stamp> branch,
// wip/issue-N backups, pushes of those branches. A sprint runs unattended, and
// an "ask" here would stall it for hours at its first commit. So while a
// sprint's state file is live AND the checkout is that sprint's branch (or a
// wip/issue- branch), commit and push are allowed. main is never a target,
// never a force-push, and a sprint never merges.
function sprintBranch() {
  try {
    const s = JSON.parse(readFileSync(join(tmpdir(), 'ezaa-sprint', 'state.json'), 'utf8'));
    const last = Date.parse(s.readings?.at(-1)?.at || s.startedAt);
    const staleHours = s.keepGoing ? 8 * 24 : 14; // the same lines sprint.mjs uses
    if (Date.now() - last > staleHours * 3600e3) return null;
    if (!String(s.branch).startsWith('sprint/')) return null;
    const branch = git('rev-parse --abbrev-ref HEAD');
    return branch === s.branch || branch.startsWith('wip/issue-') ? branch : null;
  } catch {
    return null;
  }
}

if (/\bgh\b[^|;&]*\bpr\b\s+merge\b/.test(cmd) && sprintBranch()) {
  decide('deny', 'A sprint never merges (ezaa-sprint SKILL.md). The owner merges the sprint PR.');
}

if (isCommit || isPush) {
  const onSprint = sprintBranch();
  const namesMain = isPush && /\b(?:main|master)\b/.test(cmd.replace(/\borigin\/main\b/g, ''));
  if (onSprint && !namesMain) {
    decide('allow', `ezaa-sprint is running on ${onSprint}: the sprint exception to the commit rule (its own branches only).`);
  }
  decide('ask', 'CLAUDE.md ground rule: never commit or push without the owner\'s yes for this specific commit or push.');
}

process.exit(0);
