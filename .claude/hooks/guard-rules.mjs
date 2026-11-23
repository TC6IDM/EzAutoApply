/**
 * The commit guard's decision, as a pure function (guard.mjs reads the hook
 * payload, git and the sprint state file, then asks this). Tested by
 * .claude/tests/guard.test.mjs, because this is what enforces CLAUDE.md's
 * first ground rule.
 *
 *   ask   a commit on main, a push naming main or upstream, and any commit or push
 *         while a sprint runs that reaches outside its own branches ("ask" cannot be
 *         allowlisted away).
 *   null  also a commit or push on a branch with no sprint running: the owner gives
 *         their yes in chat, and the allow rules in settings.local.json skip the popup.
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
 * The branch a live sprint may commit on, or null. Invoking the repo's sprint command is the
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

// ---------- which checkouts a command touches (#57) ----------
// A sprint also works a linked repo (ai-job-search) in its own worktree, and a
// command can reach any checkout with `cd <dir> &&` or `git -C <dir>`. The guard
// judges every checkout the command names, not only the session's own (before
// #57, `git -C ../other commit` from a sprint branch was let through).

/** Forward slashes, a Git Bash /c/ drive as c:, lower case, no trailing slash: for comparing only. */
export const normPath = p => String(p || '').replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/').replace(/\/+$/, '').toLowerCase();
const unquote = v => v.replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1');
const ARG = `("[^"]*"|'[^']*'|[^\\s;&|]+)`;
const absolute = p => /^([a-zA-Z]:|\/|\\)/.test(p);
const joinDir = (a, b) => (absolute(b) ? b : `${a}/${b}`);

/**
 * The directories a command's git calls run in: a leading `cd <dir> &&` (or `;`)
 * moves the base off `cwd`, and each `git -C <dir>` adds one. Always at least the base.
 */
export function gitDirs(cmd, cwd) {
  let base = cwd;
  const cd = String(cmd).match(new RegExp(`^\\s*cd\\s+${ARG}\\s*(?:&&|;)`));
  if (cd) base = joinDir(cwd, unquote(cd[1]));
  const dirs = [base];
  for (const m of String(cmd).matchAll(new RegExp(`\\bgit\\s+(?:-c\\s+\\S+\\s+)*-C\\s+${ARG}`, 'g'))) dirs.push(joinDir(base, unquote(m[1])));
  return [...new Set(dirs)];
}

/** A push to the remote named upstream (the project ai-job-search came from): never the sprint's. */
export const pushesUpstream = cmd => /\bgit\b[^|;&]*\bpush\b(?:\s+-\S+)*\s+upstream\b/.test(cmd);

/**
 * The linked checkout's branch a live sprint may commit on there, or null: only
 * the worktree sprint.mjs made (state.linked[name].worktree), on its own branch.
 */
export function linkedBranch(state, place, now = Date.now()) {
  if (!place?.toplevel || !sprintBranch(state, state?.branch, now)) return null;
  for (const l of Object.values(state.linked || {})) {
    if (l?.worktree && normPath(l.worktree) === normPath(place.toplevel)
      && String(l.branch).startsWith('sprint/') && place.branch === l.branch) return l.branch;
  }
  return null;
}

/** The sprint branch a place ({ toplevel, branch }) is, or null. `home` is this repo's toplevel. */
export function sprintPlace(state, place, home, now = Date.now()) {
  const inHome = !home || !place.toplevel || normPath(place.toplevel) === normPath(home);
  return inHome ? sprintBranch(state, place.branch, now) : linkedBranch(state, place, now);
}

/**
 * ctx: { branch: the checked-out branch, state: the sprint state (or null), now,
 *        places: [{ toplevel, branch }] for every checkout the command touches
 *        (guard.mjs fills it in; without it, `branch` in this repo), home: this repo's toplevel }.
 */
export function decide(cmd, { branch = '', state = null, now = Date.now(), places = null, home = '', name = 'this repo', prefix = 'sprint', deny = [], askAlways = false } = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (isForcePush(cmd)) return { decision: 'deny', reason: `Force-push is blocked in ${name}. Ask the owner, and do it by hand if they agree.` };
  // The repo's own hard denials (config.mjs GUARD_DENY: [{ re: 'regex source', reason }]), e.g. a build that takes 40 minutes.
  for (const d of deny) if (new RegExp(d.re).test(cmd)) return { decision: 'deny', reason: d.reason };
  // claude-workflow's sync-all.mjs commits and pushes the library, then a branch, commit, push and PR per repo:
  // one question covers all of it (the owner, 2026-11-23: "we only need to ask permission once"). --dry changes nothing.
  if (/\bsync-all\.mjs\b/.test(cmd) && !/(^|\s)--dry\b/.test(cmd)) {
    return { decision: 'ask', reason: 'claude-workflow sync-all: one yes covers it all (the library\'s commit and push to its main, then a branch, commit, push and PR per repo; never a repo\'s main, never a merge).' };
  }
  const where = places?.length ? places : [{ toplevel: home, branch }];
  if (isPush(cmd) && !hasRefspec(cmd) && where.some(p => p.branch === 'main')) {
    return { decision: 'deny', reason: 'Bare `git push` from main is blocked. Name the branch (`git push origin main:main`), after asking.' };
  }
  // Every checkout the command touches must be the sprint's, or none of it is.
  const allowed = where.map(p => sprintPlace(state, p, home, now));
  const onSprint = allowed.every(Boolean) ? [...new Set(allowed)].join(', ') : null;
  if (isMerge(cmd) && allowed.some(Boolean)) return { decision: 'deny', reason: `A sprint never merges (${prefix}-sprint SKILL.md). The owner merges the sprint PR.` };
  if (isCommit(cmd) || isPush(cmd)) {
    const toMain = isPush(cmd) && (namesMain(cmd) || pushesUpstream(cmd));
    if (onSprint && !toMain) {
      return { decision: 'allow', reason: `${prefix}-sprint is running on ${onSprint}: the sprint exception to the commit rule (its own branches only).` };
    }
    // The owner's yes is given in chat (2026-11-18: "dont pop open this allow this bash command thing").
    // On a branch, with no sprint running, the permission rules decide (settings.local.json allows it).
    // Main, upstream, and anything a running sprint reaches outside its own branches still ask.
    const onMain = where.some(p => /^(main|master)$/.test(p.branch || ''));
    // askAlways (config.mjs GUARD_ASK_ALWAYS): this repo wants a question before EVERY commit and push outside a sprint,
    // even where a permission rule would allow it (Ride The Bus, PTrainr). Default off (EzAutoApply: the owner's yes in chat).
    if (toMain || onMain || askAlways || sprintBranch(state, state?.branch, now)) {
      return { decision: 'ask', reason: 'CLAUDE.md ground rule: main, upstream, and anything outside a running sprint\'s branches need the owner\'s yes here.' };
    }
  }
  return null;
}
