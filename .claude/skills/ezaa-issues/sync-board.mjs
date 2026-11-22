// Puts every open issue on the repo's Project (config.mjs PROJECT) and fills its Priority, Size,
// Who, Platform and Kind fields from its labels, for items where those are still empty.
// Run after creating issues: node .claude/skills/<prefix>-issues/sync-board.mjs
// Needs the gh token's project scope (gh auth refresh -s project).
import { gh as ghRun } from './gh.mjs';
import { OWNER, REPO, PROJECT, boardFields } from './config.mjs';

const gh = args => ghRun(args);
const ghJson = args => JSON.parse(gh(args));

const project = ghJson(['project', 'view', PROJECT, '--owner', OWNER, '--format', 'json']);
const fields = ghJson(['project', 'field-list', PROJECT, '--owner', OWNER, '--format', 'json', '--limit', '50']).fields;
const field = name => fields.find(f => f.name === name);
const items = ghJson(['project', 'item-list', PROJECT, '--owner', OWNER, '--format', 'json', '--limit', '1000']).items;
const byUrl = new Map(items.map(i => [i.content?.url, i]));

const issues = ghJson(['issue', 'list', '--repo', REPO, '--state', 'open', '--limit', '1000', '--json', 'number,url,labels']);
let added = 0, set = 0;
for (const is of issues) {
  let item = byUrl.get(is.url);
  if (!item) { item = ghJson(['project', 'item-add', PROJECT, '--owner', OWNER, '--url', is.url, '--format', 'json']); added++; }
  for (const [name, value] of Object.entries(boardFields(is.labels.map(l => l.name)))) {
    if (!value || item[name.toLowerCase()]) continue; // already set on the board
    const f = field(name), opt = f?.options?.find(o => o.name === value);
    if (!opt) continue;
    gh(['project', 'item-edit', '--id', item.id, '--project-id', project.id, '--field-id', f.id, '--single-select-option-id', opt.id]);
    set++;
  }
}
console.log(`board: ${added} issues added, ${set} field values set`);
