// The pinned Inbox issue: what is waiting, and writing what each comment became UNDER that comment
// (GitHub issue comments cannot be threaded, so the comment itself is edited instead of replied to).
// Ported from PTrainr (the newest copy: count, and log refusing a comment already logged) with
// Ride The Bus's SessionStart hook mode.
//
//   node .claude/skills/ezaa-issues/inbox.mjs pending
//     Comments not yet logged (with id, author, date, text), and stand-in replies waiting to be folded.
//   node .claude/skills/ezaa-issues/inbox.mjs count [--json | --hook]
//     One line when something waits, nothing otherwise (sprint.mjs prints it on every loop).
//     --json: {"waiting":N,"standIns":N}. --hook: the SessionStart hook's output; silent on any failure.
//   node .claude/skills/ezaa-issues/inbox.mjs log <commentId> --text "#31 Extension: … (Bridge #32)"
//     Appends "✅ Logged: <text>" under the comment. If GitHub refuses the edit, it posts a stand-in
//     reply that points at the comment instead; `fold` merges it later. It reads the comment again
//     first and refuses one already logged (PTrainr #518: two passes at once logged twelve comments
//     twice). --add appends to a logged comment on purpose (a later follow-up).
//   node .claude/skills/ezaa-issues/inbox.mjs fold
//     Moves every stand-in reply's text under the comment it answers and deletes the stand-in.
//     Run it at the start of every Inbox pass.
//   Add --dry to print what would happen without changing anything.
import { execFileSync } from 'node:child_process';
import { REPO } from './config.mjs';

const args = process.argv.slice(2);
const [action, idArg] = args;
const dry = args.includes('--dry');
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const gh = list => execFileSync('gh', list, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const ghJson = list => JSON.parse(gh(list));

export const LOGGED = '✅ **Logged:**';
const STAND_IN = /<!-- inbox-log-for:(\d+) -->/;

function inboxNumber() {
  const n = ghJson(['issue', 'list', '--repo', REPO, '--label', 'inbox', '--state', 'open', '--json', 'number']);
  if (!n.length) throw new Error('no open issue labelled inbox');
  return n[0].number;
}
const comments = number => ghJson(['api', '--paginate', '--slurp', `repos/${REPO}/issues/${number}/comments?per_page=100`]).flat();
const withLog = (body, text) => body.includes(LOGGED)
  ? `${body.trimEnd()}\n${LOGGED} ${text}`
  : `${body.trimEnd()}\n\n---\n${LOGGED} ${text}`;

function editComment(id, body) {
  if (dry) { console.log(`[dry] edit ${id}`); return true; }
  try { gh(['api', '-X', 'PATCH', `repos/${REPO}/issues/comments/${id}`, '-f', `body=${body}`]); return true; }
  catch (error) { console.log(`edit of ${id} refused: ${String(error.stderr || error.message).split('\n')[0]}`); return false; }
}

const sortInbox = list => ({ standIns: list.filter(c => STAND_IN.test(c.body)), waiting: list.filter(c => !STAND_IN.test(c.body) && !c.body.includes(LOGGED)) });

if (action === 'count') {
  const hook = args.includes('--hook');
  try {
    const n = inboxNumber();
    const { standIns, waiting } = sortInbox(comments(n));
    if (args.includes('--json')) { console.log(JSON.stringify({ waiting: waiting.length, standIns: standIns.length })); process.exit(0); }
    if (!waiting.length && !standIns.length) process.exit(0);
    const line = `Inbox: ${waiting.length} comment${waiting.length === 1 ? '' : 's'} waiting on #${n}${standIns.length ? ` and ${standIns.length} stand-in repl${standIns.length === 1 ? 'y' : 'ies'} to fold` : ''}.`;
    if (hook) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `[ezaa-issues] ${line} Mention it to the owner; "go through the inbox" runs the ezaa-issues Inbox pass.` } }));
    else console.log(line);
  } catch (error) {
    if (!hook) { console.error(`Inbox could not be read: ${String(error.message).split(/\r?\n/)[0]}`); process.exit(1); }
  }
  process.exit(0);
} else if (action === 'pending') {
  const { standIns, waiting } = sortInbox(comments(inboxNumber()));
  if (standIns.length) console.log(`${standIns.length} stand-in repl${standIns.length === 1 ? 'y' : 'ies'} to fold first: run \`inbox.mjs fold\`\n`);
  console.log(waiting.length ? `${waiting.length} comment(s) to log:\n` : 'Nothing waiting: every comment is logged.');
  for (const c of waiting) console.log(`--- ${c.id} · ${c.user.login} · ${c.created_at.slice(0, 10)} · ${c.html_url}\n${c.body.trim()}\n`);
} else if (action === 'log') {
  const text = opt('text');
  if (!/^\d+$/.test(idArg || '') || !text) { console.error('usage: inbox.mjs log <commentId> --text "…" [--add]'); process.exit(1); }
  const c = ghJson(['api', `repos/${REPO}/issues/comments/${idArg}`]);
  // Read just now, so a pass that ran `pending` before another pass logged this comment stops here.
  const standIn = comments(inboxNumber()).find(x => STAND_IN.test(x.body) && x.body.match(STAND_IN)[1] === String(c.id));
  if ((c.body.includes(LOGGED) || standIn) && !args.includes('--add')) {
    console.log(`already logged (${c.html_url}), by another pass meanwhile? Nothing changed; --add appends anyway.`);
    process.exit(0);
  }
  if (editComment(c.id, withLog(c.body, text))) { console.log(`logged under ${c.html_url}`); process.exit(0); }
  const body = `<!-- inbox-log-for:${c.id} -->\n↪ For [this comment](${c.html_url}) (to be folded into it on the next Inbox pass):\n${LOGGED} ${text}`;
  if (!dry) gh(['issue', 'comment', String(inboxNumber()), '--repo', REPO, '--body', body]);
  console.log(`${dry ? '[dry] ' : ''}posted a stand-in reply; the next \`inbox.mjs fold\` moves it under the comment`);
} else if (action === 'fold') {
  const list = comments(inboxNumber());
  const byId = new Map(list.map(c => [String(c.id), c]));
  let folded = 0;
  for (const standIn of list.filter(c => STAND_IN.test(c.body))) {
    const target = byId.get(standIn.body.match(STAND_IN)[1]);
    const text = standIn.body.slice(standIn.body.indexOf(LOGGED) + LOGGED.length).trim();
    if (!target) { console.log(`stand-in ${standIn.id}: its comment is gone; leaving it`); continue; }
    if (target.body.includes(`${LOGGED} ${text}`)) {
      // Another pass folded it already: only the stand-in is left to delete.
      if (!dry) gh(['api', '-X', 'DELETE', `repos/${REPO}/issues/comments/${standIn.id}`]);
      console.log(`${dry ? '[dry] ' : ''}${standIn.id} was already under ${target.id}; stand-in deleted`);
      folded += 1;
      continue;
    }
    if (!editComment(target.id, withLog(target.body, text))) continue;
    target.body = withLog(target.body, text);
    if (!dry) gh(['api', '-X', 'DELETE', `repos/${REPO}/issues/comments/${standIn.id}`]);
    console.log(`${dry ? '[dry] ' : ''}folded ${standIn.id} into ${target.id}`);
    folded += 1;
  }
  console.log(folded ? `${folded} folded` : 'no stand-in replies');
} else {
  console.error('usage: inbox.mjs pending | count [--json|--hook] | log <commentId> --text "…" [--add] | fold  [--dry]');
  process.exit(1);
}
