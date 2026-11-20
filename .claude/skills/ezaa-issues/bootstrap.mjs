// Sets up a repo for the issue and sprint scripts in one command (#47): its labels
// and milestones, the Project board (a copy of the template board in config.mjs's
// BOARD, retuned), the repo linked to it, PROJECT written into config.mjs, and the
// pinned Inbox issue. Safe to run again: it only changes what differs.
//
//   node .claude/skills/<prefix>-issues/bootstrap.mjs [--dry] [--new-board]
//     --dry        print every change without making it
//     --new-board  copy the template even if config.mjs's PROJECT already names a board
//
// One step stays by hand (GitHub's API can't set it, and a copy doesn't bring it):
// Workflows → "Auto-add to project", printed at the end.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OWNER, REPO, PROJECT, LABELS, MILESTONES, BOARD, PREFIX } from './config.mjs';
import { planBoard, withProjectNumber, describe } from './board-plan.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const read = list => execFileSync('gh', list, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (what, list) => { if (dry) { console.log(`[dry] ${what}`); return ''; } console.log(what); return read(list); };
const gql = (query, vars = {}) => JSON.parse(read(['api', 'graphql', '-f', `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ['-F', `${k}=${v}`])])).data;
const gqlWrite = (what, query) => { if (dry) { console.log(`[dry] ${what}`); return null; } console.log(what); return gql(query); };
const q = s => JSON.stringify(String(s));

// ---- labels and milestones ----
const haveLabels = new Set(JSON.parse(read(['label', 'list', '--repo', REPO, '--limit', '300', '--json', 'name'])).map(l => l.name));
for (const [name, [color, desc]] of Object.entries(LABELS)) {
  if (!haveLabels.has(name)) write(`label ${name}`, ['label', 'create', name, '--repo', REPO, '--color', color, '--description', desc]);
}
const haveMilestones = JSON.parse(read(['api', `repos/${REPO}/milestones?state=all&per_page=100`])).map(m => m.title);
for (const [title, desc] of Object.values(MILESTONES)) {
  if (!haveMilestones.includes(title)) write(`milestone ${title}`, ['api', `repos/${REPO}/milestones`, '-f', `title=${title}`, '-f', `description=${desc}`]);
}

// ---- the board ----
const BOARD_QUERY = `query($owner: String!, $number: Int!) { user(login: $owner) { projectV2(number: $number) {
  id number title
  fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { options { name color } } } }
  views(first: 30) { nodes { id name filter } } } } }`;
const loadBoard = number => {
  try {
    const p = gql(BOARD_QUERY, { owner: OWNER, number })?.user?.projectV2;
    return p && { ...p, fields: p.fields.nodes.filter(f => f.id), views: p.views.nodes };
  } catch { return null; }
};

let board = PROJECT && !args.includes('--new-board') ? loadBoard(PROJECT) : null;
if (board && board.title !== BOARD.title) console.log(`config.mjs's PROJECT ${PROJECT} is "${board.title}", not "${BOARD.title}": checking it anyway (--new-board to copy a fresh one)`);
if (!board) {
  const template = loadBoard(BOARD.template.number);
  if (!template) { console.error(`template board ${BOARD.template.owner}/${BOARD.template.number} not found`); process.exit(1); }
  const ownerId = gql(`query($l: String!) { user(login: $l) { id } }`, { l: OWNER }).user.id;
  const made = gqlWrite(`copy board "${template.title}" (#${template.number}) as "${BOARD.title}"`,
    `mutation { copyProjectV2(input: { projectId: ${q(template.id)}, ownerId: ${q(ownerId)}, title: ${q(BOARD.title)}, includeDraftIssues: false }) { projectV2 { number } } }`);
  if (dry) {
    console.log(`[dry] then retune the copy (as a copy of #${template.number} it would need):`);
    for (const step of planBoard(BOARD, { ...template, title: BOARD.title })) console.log(`[dry]   ${describe(step)}`);
    board = null;
  } else {
    board = loadBoard(made.copyProjectV2.projectV2.number);
  }
}

if (board) {
  console.log(`board #${board.number} "${board.title}": https://github.com/users/${OWNER}/projects/${board.number}`);
  const steps = planBoard(BOARD, board);
  if (!steps.length) console.log('  matches config.mjs: nothing to change');
  for (const step of steps) {
    const what = `  ${describe(step)}`;
    if (step.kind === 'title') write(what, ['project', 'edit', String(board.number), '--owner', OWNER, '--title', step.to]);
    if (step.kind === 'options') {
      const opts = step.options.map(o => `{ name: ${q(o.name)}, color: ${o.color}, description: "" }`).join(', ');
      gqlWrite(what, `mutation { updateProjectV2Field(input: { fieldId: ${q(step.fieldId)}, singleSelectOptions: [${opts}] }) { clientMutationId } }`);
    }
    if (step.kind === 'filter') gqlWrite(what, `mutation { updateProjectV2View(input: { viewId: ${q(step.viewId)}, filter: ${q(step.to)} }) { clientMutationId } }`);
    if (step.kind === 'dropView') gqlWrite(what, `mutation { deleteProjectV2View(input: { viewId: ${q(step.viewId)} }) { clientMutationId } }`);
    if (step.kind === 'missingField' || step.kind === 'missingView') console.log(`${what}: add it by hand or fix the template`);
  }
  const linked = JSON.parse(read(['api', 'graphql', '-f', `query={ repository(owner: ${q(OWNER)}, name: ${q(REPO.split('/')[1])}) { projectsV2(first: 20) { nodes { number } } } }`])).data.repository.projectsV2.nodes.map(p => p.number);
  if (!linked.includes(board.number)) write(`link ${REPO} to board #${board.number}`, ['project', 'link', String(board.number), '--owner', OWNER, '--repo', REPO]);
  if (String(board.number) !== String(PROJECT)) {
    const file = fileURLToPath(new URL('./config.mjs', import.meta.url));
    if (dry) console.log(`[dry] config.mjs: PROJECT ${PROJECT || '(none)'} → ${board.number}`);
    else { writeFileSync(file, withProjectNumber(readFileSync(file, 'utf8'), board.number)); console.log(`config.mjs: PROJECT → ${board.number}`); }
  }
}

// ---- the Inbox ----
const inbox = JSON.parse(read(['issue', 'list', '--repo', REPO, '--label', 'inbox', '--state', 'open', '--json', 'number']));
if (inbox.length) console.log(`Inbox: #${inbox[0].number}`);
else {
  const body = 'Drop raw ideas, bugs, screenshots and links here as comments. Claude turns each into issues and writes what it became under that comment (`✅ Logged: #N …`); it never replies with a new comment.';
  const url = write('create the pinned Inbox issue', ['issue', 'create', '--repo', REPO, '--title', 'Inbox', '--label', 'inbox', '--body', body]);
  if (url) write(`pin ${url}`, ['issue', 'pin', url, '--repo', REPO]);
}

console.log(`\nBy hand, once: the board's ⋯ → Workflows → "Auto-add to project" → repo ${REPO}, filter is:issue is:open → Save and turn on.`);
console.log(`Then: node .claude/skills/${PREFIX}-issues/sync-board.mjs (adds the open issues and fills the fields from labels).`);
