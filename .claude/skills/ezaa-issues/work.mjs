// Start and finish work on a issue of this repo (config.mjs NAME), the same way every time.
//
//   node .claude/skills/<prefix>-issues/work.mjs start 65 [--to <login>]
//     Assigns the issue to the person (default: whoever this machine's gh is signed in as),
//     moves its board card to In Progress, and comments who started it.
//   node .claude/skills/<prefix>-issues/work.mjs review 65 --note "What changed, where; PR #N"
//     The work is finished and pushed, waiting for its PR to merge: comments the note,
//     keeps the issue open and moves the card to In Review. The merge closes it (the PR
//     says `Fixes #65`) and the board's "Item closed" workflow moves it to Done.
//   node .claude/skills/<prefix>-issues/work.mjs done 65 --note "What changed, where"
//     For work with no PR to wait for (accounts, decisions, research), or to close by hand:
//     comments the note, closes the issue as completed, moves the card to Done,
//     and closes the parent too when this was its last open sub-issue.
//   node .claude/skills/<prefix>-issues/work.mjs handoff 65 --note "What Claude built; what is left, for whom"
//     Claude's part of a shared or owner's issue is done and the rest needs a person (a decision,
//     a real-world step): comments the note, labels it status:claude-part-done so no sprint takes
//     it again until that label comes off, keeps it open and moves the card back to Todo.
//   node .claude/skills/<prefix>-issues/work.mjs tidy
//     Moves the card of every closed issue that is not on Done to Done, and closes every
//     open parent whose sub-issues are all closed (a merge closes sub-issues, never their
//     parent). Run it after opening a PR and after a merge.
//     Also assigns sub-issues from their parent (assign-down, below).
//   node .claude/skills/<prefix>-issues/work.mjs assign-down [65]
//     Whoever a parent is assigned to owns its sub-issues: every open issue nobody is assigned to
//     gets the assignees of the nearest assigned parent above it, at any depth (only under #65 if
//     given). Never replaces an assignee. `start` on a parent and `tidy` run it too.
//   Add --dry to print what would happen without changing anything.
import { gh as ghRun } from './gh.mjs';

import { REPO, REPO_NAME, OWNER, PROJECT } from './config.mjs';
const args = process.argv.slice(2);
const [action, numberArg] = args;
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const dry = args.includes('--dry');
const number = Number(numberArg);
const gh = list => ghRun(list);
const ghJson = list => JSON.parse(gh(list));
const run = (what, list) => { console.log(`${dry ? '[dry] ' : ''}${what}`); if (!dry) gh(list); };

// Whoever a parent is assigned to also owns its sub-issues: every open issue with nobody assigned
// gets the assignees of the nearest assigned issue above it (any depth). Never replaces or removes
// an assignee. `under` limits it to one parent's tree.
function assignDown(under) {
  const q = `query($after:String){ repository(owner:"${OWNER}", name:"${REPO_NAME}"){ issues(states:OPEN, first:100, after:$after){
    pageInfo { hasNextPage endCursor } nodes { number parent { number } assignees(first:10){ nodes { login } } } } } }`;
  const tree = new Map();
  let after = null;
  do {
    const list = ['api', 'graphql', '-f', `query=${q}`];
    if (after) list.push('-f', `after=${after}`);
    const page = ghJson(list).data.repository.issues;
    for (const n of page.nodes) tree.set(n.number, { parent: n.parent?.number ?? null, assignees: n.assignees.nodes.map(a => a.login) });
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  let changed = 0;
  for (const [n, it] of tree) {
    if (it.assignees.length) continue;
    let from = null, inside = under === undefined;
    for (let at = it.parent, depth = 0; at && depth < 10; at = tree.get(at)?.parent, depth++) {
      if (at === under) inside = true;
      if (!from && tree.get(at)?.assignees.length) from = at;
    }
    if (!from || !inside) continue;
    const who = tree.get(from).assignees;
    run(`#${n}: assign ${who.join(', ')} (from #${from})`, ['issue', 'edit', String(n), '--repo', REPO, ...who.flatMap(w => ['--add-assignee', w])]);
    if (!dry) it.assignees = [...who];
    changed += 1;
  }
  console.log(changed ? `${changed} sub-issue(s) assigned from their parent` : 'every sub-issue of an assigned parent is already assigned');
}

if (action === 'assign-down') {
  assignDown(Number.isInteger(number) ? number : undefined);
  process.exit(0);
}

if (action === 'tidy') {
  assignDown();
  const q = `query($o:String!,$n:Int!,$after:String){ user(login:$o){ projectV2(number:$n){ id
    field(name:"Status"){ ... on ProjectV2SingleSelectField { id options { id name } } }
    items(first:100, after:$after){ pageInfo { hasNextPage endCursor }
      nodes { id content { ... on Issue { number state } } fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`;
  let after = null, moved = 0, project;
  do {
    const list = ['api', 'graphql', '-f', `query=${q}`, '-f', `o=${OWNER}`, '-F', `n=${PROJECT}`];
    if (after) list.push('-f', `after=${after}`);
    project = ghJson(list).data.user.projectV2;
    const done = project.field.options.find(o => o.name === 'Done');
    for (const item of project.items.nodes) {
      const status = item.fieldValueByName?.name;
      if (item.content?.state !== 'CLOSED' || status === 'Done') continue;
      run(`#${item.content.number}: ${status || 'no status'} -> Done`, ['project', 'item-edit', '--id', item.id, '--project-id', project.id, '--field-id', project.field.id, '--single-select-option-id', done.id]);
      moved += 1;
    }
    after = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
  } while (after);
  console.log(moved ? `${moved} card(s) moved to Done` : 'every closed issue is already on Done');
  // Parents whose every sub-issue is closed.
  const pq = `query($o:String!,$r:String!,$after:String){ repository(owner:$o,name:$r){ issues(states:OPEN, first:100, after:$after){
    pageInfo { hasNextPage endCursor } nodes { number subIssuesSummary { total completed } } } } }`;
  let pAfter = null, closedParents = 0;
  do {
    const list = ['api', 'graphql', '-f', `query=${pq}`, '-f', `o=${OWNER}`, '-f', `r=${REPO_NAME}`];
    if (pAfter) list.push('-f', `after=${pAfter}`);
    const page = ghJson(list).data.repository.issues;
    for (const p of page.nodes) {
      const s = p.subIssuesSummary;
      if (!s.total || s.completed < s.total) continue;
      run(`close parent #${p.number} (all ${s.total} sub-issues closed)`, ['issue', 'close', String(p.number), '--repo', REPO, '--reason', 'completed', '--comment', 'All sub-issues are done.']);
      closedParents += 1;
    }
    pAfter = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (pAfter);
  if (closedParents) console.log(`${closedParents} parent(s) closed; run tidy again to move their cards to Done`);
  archiveFinishedFamilies();
  process.exit(0);
}

// Done work leaves the board's views (maintainer, 2026-11-12: "we don't need to
// see them in the overview"): every closed issue is archived, whether it stands
// alone, sits under a parent still open, ends a finished family, or was closed
// with sub-issues still open (maintainer, 2026-11-13: #296 stayed in Now's Done
// column while #300 and #301 were open; those keep their own cards). A parent's progress bar still counts its archived
// sub-issues (GitHub keeps that on the issue). Archived, not deleted: the
// project's "Archived items" puts a card back.
function archiveFinishedFamilies() {
  const q = `query($o:String!,$n:Int!,$after:String){ user(login:$o){ projectV2(number:$n){
    items(first:100, after:$after){ pageInfo { hasNextPage endCursor }
      nodes { id isArchived content { ... on Issue { number state } } } } } } }`;
  const finished = issue => issue.state === 'CLOSED';
  let after = null, archived = 0;
  do {
    const list = ['api', 'graphql', '-f', `query=${q}`, '-f', `o=${OWNER}`, '-F', `n=${PROJECT}`];
    if (after) list.push('-f', `after=${after}`);
    const items = ghJson(list).data.user.projectV2.items;
    for (const item of items.nodes) {
      const issue = item.content;
      if (item.isArchived || !issue?.number || !finished(issue)) continue;
      run(`#${issue.number}: archived (done)`, ['project', 'item-archive', PROJECT, '--owner', OWNER, '--id', item.id]);
      archived += 1;
    }
    after = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (after);
  console.log(archived ? `${archived} done card(s) archived` : 'nothing done left on the board');
}

// Every action handled below the issue lookup (claude-workflow#5: handoff was missing,
// so every sprint handoff stopped here with the usage line).
export const ISSUE_ACTIONS = ['start', 'review', 'done', 'handoff'];
if (!ISSUE_ACTIONS.includes(action) || !Number.isInteger(number)) {
  console.error('usage: work.mjs start <issue> [--to <login>] | review <issue> --note "…" | done <issue> --note "…" | handoff <issue> --note "…" | tidy | assign-down [issue]  [--dry]');
  process.exit(1);
}

const issue = ghJson(['issue', 'view', String(number), '--repo', REPO, '--json', 'number,title,state,url,assignees']);
console.log(`#${issue.number} ${issue.title} (${issue.state})`);

// The issue's card on the board, and the Status field.
function setStatus(name) {
  const q = `query($o:String!,$n:Int!,$r:String!,$i:Int!){
    user(login:$o){ projectV2(number:$n){ id field(name:"Status"){ ... on ProjectV2SingleSelectField { id options { id name } } } } }
    repository(owner:$o,name:$r){ issue(number:$i){ projectItems(first:10, includeArchived:true){ nodes { id isArchived project { number } } } } } }`;
  const d = ghJson(['api', 'graphql', '-f', `query=${q}`, '-f', `o=${OWNER}`, '-F', `n=${PROJECT}`, '-f', `r=${REPO_NAME}`, '-F', `i=${number}`]).data;
  const project = d.user.projectV2, field = project.field;
  let item = d.repository.issue.projectItems.nodes.find(n => String(n.project.number) === PROJECT);
  if (!item) {
    if (dry) { console.log('[dry] add to the board'); return; }
    item = ghJson(['project', 'item-add', PROJECT, '--owner', OWNER, '--url', issue.url, '--format', 'json']);
  }
  // tidy archives every closed card; a reopened issue's card comes back first
  // (an archived card can't be edited).
  if (item.isArchived) run('board: unarchive', ['project', 'item-archive', PROJECT, '--owner', OWNER, '--id', item.id, '--undo']);
  const option = field.options.find(o => o.name === name);
  run(`board: ${name}`, ['project', 'item-edit', '--id', item.id, '--project-id', project.id, '--field-id', field.id, '--single-select-option-id', option.id]);
}

if (action === 'start') {
  const who = opt('to') || gh(['api', 'user', '--jq', '.login']);
  if (issue.state !== 'OPEN') run('reopen', ['issue', 'reopen', String(number), '--repo', REPO]);
  if (!issue.assignees.some(a => a.login === who)) run(`assign ${who}`, ['issue', 'edit', String(number), '--repo', REPO, '--add-assignee', who]);
  setStatus('In Progress');
  run('comment', ['issue', 'comment', String(number), '--repo', REPO, '--body', `Started by @${who} (with Claude).`]);
  assignDown(number); // a parent's sub-issues are theirs too
} else if (action === 'handoff') {
  const note = opt('note');
  if (!note) { console.error('handoff needs --note "what Claude built; what is left, for whom"'); process.exit(1); }
  const HANDED = 'status:claude-part-done';
  run(`label ${HANDED}`, ['label', 'create', HANDED, '--repo', REPO, '--color', 'bfdadc', '--description', "Claude's part is done; the rest waits on a person", '--force']);
  run(`add ${HANDED}`, ['issue', 'edit', String(number), '--repo', REPO, '--add-label', HANDED]);
  run('comment', ['issue', 'comment', String(number), '--repo', REPO, '--body', `**Claude's part is done; the rest is for a person.** ${note}\n\nTake the \`${HANDED}\` label off when there is more for a sprint to do here.`]);
  setStatus('Todo');
} else if (action === 'review') {
  const note = opt('note');
  if (!note) { console.error('review needs --note "what changed, where, and the PR"'); process.exit(1); }
  if (issue.state !== 'OPEN') run('reopen', ['issue', 'reopen', String(number), '--repo', REPO]);
  run('comment', ['issue', 'comment', String(number), '--repo', REPO, '--body', `**Done, waiting for the merge.** ${note}`]);
  setStatus('In Review');
} else {
  const note = opt('note');
  if (!note) { console.error('done needs --note "what changed and where"'); process.exit(1); }
  run('comment', ['issue', 'comment', String(number), '--repo', REPO, '--body', `**Done.** ${note}`]);
  if (issue.state === 'OPEN') run('close', ['issue', 'close', String(number), '--repo', REPO, '--reason', 'completed']);
  setStatus('Done');
  // Close the parent when every one of its sub-issues is now closed.
  const q = `query($r:String!,$o:String!,$i:Int!){ repository(owner:$o,name:$r){ issue(number:$i){ parent { number state subIssues(first:50){ nodes { number state } } } } } }`;
  const parent = ghJson(['api', 'graphql', '-f', `query=${q}`, '-f', `r=${REPO_NAME}`, '-f', `o=${OWNER}`, '-F', `i=${number}`]).data.repository.issue.parent;
  if (parent && parent.state === 'OPEN') {
    const open = parent.subIssues.nodes.filter(s => s.number !== number && s.state === 'OPEN');
    if (open.length === 0) {
      run(`close parent #${parent.number} (all sub-issues done)`, ['issue', 'close', String(parent.number), '--repo', REPO, '--reason', 'completed', '--comment', `All sub-issues are done (last: #${number}).`]);
    } else {
      console.log(`parent #${parent.number} stays open: ${open.map(s => '#' + s.number).join(', ')} left`);
    }
  }
}
