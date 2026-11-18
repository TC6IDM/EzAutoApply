/**
 * The commit guard's decision, as a pure function (guard.mjs reads the hook
 * payload, git and the sprint state file, then asks this). Tested by
 * .claude/tests/guard.test.mjs, because this is what enforces CLAUDE.md's
 * first ground rule.
 *
 *   ask   commit and push, every time (not deny: the owner does commit, they want
 *         to be asked first, and "ask" cannot be allowlisted away).
 *   deny  a bare `git push` from main, a force-push anywhere, and `gh pr merge`
 *         while a sprint runs.
 *   allow commit and push on a running sprint's own branches (the sprint exception).
 *   null  anything else: the normal permission rules apply.
 */

// The same lines sprint.mjs uses: a sprint left behind stops counting this long after its last step.
export const STALE_HOURS = 14;
export const KEEP_GOING_STALE_HOURS = 8 * 24;

export const isCommit = cmd => /\bgit\b[^|;&]*\bcommit\b/.test(cmd);
export const isPush = cmd => /\bgit\b[^|;&]*\bpush\b/.test(cmd);
export const isForcePush = cmd => isPush(cmd) && /--force\b|--force-with-lease\b|\s-f\b|\s\+\S/.test(cmd);
// A push with no refspec from main publishes straight to origin/main with no branch named.
export const hasRefspec = cmd => /\bpush\b\s+\S+\s+\S+/.test(cmd) || /\bpush\b[^|;&]*(--set-upstream|-u)\b/.test(cmd);
export const isMerge = cmd => /\bgh\b[^|;&]*\bpr\b\s+merge\b/.test(cmd);
export const namesMain = cmd => /\b(?:main|master)\b/.test(cmd.replace(/\borigin\/main\b/g, ''));

/**
 * The branch a live sprint may commit on, or null. Invoking /ezaa-sprint is the
 * owner's yes for THAT sprint only: its own sprint/<stamp> branch and wip/issue-N
 * backups, while its state file is fresh.
 */
export function sprintBranch(state, branch, now = Date.now()) {
  if (!state || !branch) return null;
  const last = Date.parse(state.readings?.at(-1)?.at || state.startedAt);
  if (!Number.isFinite(last)) return null;
  const staleHours = state.keepGoing ? KEEP_GOING_STALE_HOURS : STALE_HOURS;
  if (now - last > staleHours * 3600e3) return null;
  if (!String(state.branch).startsWith('sprint/')) return null;
  return branch === state.branch || branch.startsWith('wip/issue-') ? branch : null;
}

/** ctx: { branch: the checked-out branch, state: the sprint state (or null), now }. */
export function decide(cmd, { branch = '', state = null, now = Date.now() } = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (isForcePush(cmd)) return { decision: 'deny', reason: 'Force-push is blocked in EzAutoApply. Ask the owner, and do it by hand if they agree.' };
  if (isPush(cmd) && !hasRefspec(cmd) && branch === 'main') {
    return { decision: 'deny', reason: 'Bare `git push` from main is blocked. Name the branch (`git push origin main:main`), after asking.' };
  }
  const onSprint = sprintBranch(state, branch, now);
  if (isMerge(cmd) && onSprint) return { decision: 'deny', reason: 'A sprint never merges (ezaa-sprint SKILL.md). The owner merges the sprint PR.' };
  if (isCommit(cmd) || isPush(cmd)) {
    if (onSprint && !(isPush(cmd) && namesMain(cmd))) {
      return { decision: 'allow', reason: `ezaa-sprint is running on ${onSprint}: the sprint exception to the commit rule (its own branches only).` };
    }
    return { decision: 'ask', reason: 'CLAUDE.md ground rule: never commit or push without the owner\'s yes for this specific commit or push.' };
  }
  return null;
}
