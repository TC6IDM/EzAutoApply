// The rules of the permission hook (permission.mjs), kept apart so they can be tested.
//
// WHY (the owner, 2026-11-23): an unattended sprint stopped for hours on a
// "may Claude edit .claude/…?" prompt nobody was there to answer. During a
// sprint the hook answers instead: it posts the question on the sprint's PR,
// waits WAIT_MINUTES for "allow" or "deny" from someone with write access, and
// answers the prompt with that. No answer: it says no, and the sprint skips the
// issue on purpose (`skip N --watched`), listed on the PR. A later "allow P<n>"
// puts the issue back, and the same request is then allowed without asking.
// Outside a sprint the hook says nothing and the normal prompt appears.
// Tested in claude-workflow: a hook's allow passes even a protected-path prompt,
// a deny's message reaches Claude, and a hook may wait 700 s and more.

export const PERMISSION_MARK = '<!-- sprint-permission -->';
export const WAIT_MINUTES = Number(process.env.SPRINT_PERMISSION_WAIT_MINUTES) || 15;
export const POLL_SECONDS = 20;
/** Who may answer: the comment's author association on GitHub. */
export const ANSWERERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const slash = p => String(p || '').replace(/\\/g, '/');
/** A path relative to the repo when it is inside it. */
export function relPath(path, root) {
  const p = slash(path), r = slash(root).replace(/\/$/, '');
  return r && p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p;
}

/** What identifies a request, so an approval is remembered for exactly that request. */
export function requestKey(tool, input = {}, root = '') {
  if (input.file_path) return `${tool}:${relPath(input.file_path, root).toLowerCase()}`;
  if (input.notebook_path) return `${tool}:${relPath(input.notebook_path, root).toLowerCase()}`;
  if (input.command) return `${tool}:${String(input.command).trim()}`;
  return `${tool}:${JSON.stringify(input)}`;
}

/** The request in a few words, for the PR comment and Claude's message. */
export function describe(tool, input = {}, root = '') {
  const file = input.file_path || input.notebook_path;
  if (file) return `${tool === 'Write' ? 'write' : 'edit'} \`${relPath(file, root)}\``;
  if (input.command) { const c = String(input.command).replace(/\s+/g, ' ').trim(); return `run \`${c.length > 160 ? `${c.slice(0, 157)}…` : c}\``; }
  return `use ${tool}`;
}

/** The comment the hook posts. */
export function askBody({ id, what, issue, waitMinutes = WAIT_MINUTES }) {
  return [PERMISSION_MARK.replace('-->', `${id} -->`),
    `🔐 **Permission needed (${id})**${issue ? ` for #${issue}` : ''}: the sprint wants to ${what}.`,
    '',
    `Reply \`allow\` or \`deny\` (or \`allow ${id}\`) within ${waitMinutes} minutes; the sprint is waiting on it. With no answer it skips${issue ? ` #${issue}` : ' the issue'} and lists it under "Left for a watched session"; a later \`allow ${id}\` puts it back. Only replies from people with write access count.`,
  ].join('\n');
}

/** The ask ids a comment names ("allow P3"); empty when it names none. */
const named = body => [...String(body || '').matchAll(/\bP(\d{1,4})\b/g)].map(m => `P${m[1]}`);
const verdictOf = body => {
  const t = String(body || '').trim().toLowerCase();
  if (/^(allow|allowed|yes|approve|approved|ok)\b/.test(t)) return 'allow';
  if (/^(deny|denied|no|reject)\b/.test(t)) return 'deny';
  return null;
};

/**
 * The answer to ask `id` among the comments: [{ login, association, at, body }]
 * oldest first. A reply counts when it is from someone who may answer, comes after
 * the ask, starts with allow/deny, and either names `id` or names no ask and
 * follows this ask more closely than any other. `notLogin`: a login whose replies
 * don't count (the sprint's own account, for answers after the wait: Claude can
 * comment then). Returns { answer, by, at } or null.
 */
export function readAnswer(comments, { id, askedAt, notLogin = null, answerers = ANSWERERS }) {
  let latestAsk = null;
  for (const c of comments) {
    const body = String(c.body || '');
    const m = body.match(/<!-- sprint-permission (P\d+) -->/);
    if (m) { latestAsk = m[1]; continue; }
    if (c.at <= askedAt || !answerers.has(c.association) || (notLogin && c.login === notLogin)) continue;
    const answer = verdictOf(body);
    if (!answer) continue;
    const ids = named(body);
    if (ids.length ? ids.includes(id) : latestAsk === id) return { answer, by: c.login, at: c.at };
  }
  return null;
}

/** Claude's message when the hook says no. */
export function denyMessage({ why, what, issue, id, pr, prefix }) {
  const n = issue ?? 'N';
  return `${why === 'denied' ? `DENIED on the PR (${id})` : `NO ANSWER on ${pr ? `PR #${pr}` : 'GitHub'} within ${WAIT_MINUTES} minutes (${id})`}: ${what}. `
    + `Put back anything changed for #${n} (git restore, or park it on wip/issue-${n}), then run `
    + `node .claude/skills/${prefix}-sprint/sprint.mjs skip ${n} --watched --why "${why === 'denied' ? 'permission denied' : 'no answer to a permission question'} (${id}): ${what.replace(/"/g, "'")}" `
    + `and carry on with the next issue.${why === 'denied' ? '' : ` A later "allow ${id}" on the PR puts #${n} back.`}`;
}
