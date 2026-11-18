// What inbox.mjs decides, without GitHub: which comments wait, how a log line is
// appended, when a comment counts as logged, and what folding a stand-in does.
// Tested by .claude/tests/inbox.test.mjs.

export const LOGGED = '✅ **Logged:**';
export const STAND_IN = /<!-- inbox-log-for:(\d+) -->/;

/** The comment's body with "✅ Logged: <text>" appended (under a rule the first time). */
export const withLog = (body, text) => body.includes(LOGGED)
  ? `${body.trimEnd()}\n${LOGGED} ${text}`
  : `${body.trimEnd()}\n\n---\n${LOGGED} ${text}`;

/** Stand-in replies, and the comments still waiting to be logged. */
export const sortInbox = list => ({
  standIns: list.filter(c => STAND_IN.test(c.body)),
  waiting: list.filter(c => !STAND_IN.test(c.body) && !c.body.includes(LOGGED)),
});

/** The stand-in reply that answers comment `id`, if one is on the Inbox. */
export const standInFor = (list, id) => list.find(x => STAND_IN.test(x.body) && x.body.match(STAND_IN)[1] === String(id));

/**
 * Whether `log` should leave the comment alone: it is logged already, or a
 * stand-in reply answers it, and --add wasn't given. Read just before logging,
 * so two passes at once can't log the same comment twice (PTrainr #518).
 */
export const refuseLog = (comment, list, add = false) => !add && (comment.body.includes(LOGGED) || Boolean(standInFor(list, comment.id)));

/** The stand-in reply posted when GitHub refuses the edit. */
export const standInBody = (comment, text) =>
  `<!-- inbox-log-for:${comment.id} -->\n↪ For [this comment](${comment.html_url}) (to be folded into it on the next Inbox pass):\n${LOGGED} ${text}`;

/** The log text a stand-in carries. */
export const standInText = standIn => standIn.body.slice(standIn.body.indexOf(LOGGED) + LOGGED.length).trim();

/**
 * What `fold` does with each stand-in: { standIn, target, action } where action is
 * 'gone' (its comment was deleted: leave it), 'delete' (already folded: only the
 * stand-in is left to delete) or 'fold' (append its text under the target, then delete it).
 */
export function foldPlan(list) {
  const byId = new Map(list.map(c => [String(c.id), c]));
  return list.filter(c => STAND_IN.test(c.body)).map(standIn => {
    const target = byId.get(standIn.body.match(STAND_IN)[1]) || null;
    const text = standInText(standIn);
    const action = !target ? 'gone' : target.body.includes(`${LOGGED} ${text}`) ? 'delete' : 'fold';
    return { standIn, target, text, action };
  });
}
