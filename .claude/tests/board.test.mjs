// bootstrap.mjs's plan: what a board needs changed to match config.mjs's BOARD (#47).
// Run: node --test ".claude/tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBoard, withProjectNumber, describe } from '../skills/ezaa-issues/board-plan.mjs';
import { BOARD, MILESTONE_ORDER } from '../skills/ezaa-issues/config.mjs';

const opts = names => names.map(name => ({ name, color: 'GRAY' }));
// PTrainr's board as copyProjectV2 brings it (the template).
const ptrainr = () => ({
  title: 'EzAutoApply',
  fields: [
    { id: 'st', name: 'Status', options: opts(['Todo', 'In Progress', 'In Review', 'Done']) },
    { id: 'pr', name: 'Priority', options: opts(['P0', 'P1', 'P2', 'P3']) },
    { id: 'sz', name: 'Size', options: opts(['S', 'M', 'L']) },
    { id: 'wh', name: 'Who', options: opts(['you', 'claude', 'together', 'lawyer']) },
    { id: 'pl', name: 'Platform', options: opts(['Web', 'Android', 'iOS', 'Server', 'Several', 'None']) },
    { id: 'kd', name: 'Kind', options: opts(['Epic', 'Feature', 'Bug', 'Task', 'Research', 'Decision']) },
    { id: 'ti', name: 'Title' },
  ],
  views: [
    { id: 'v1', name: 'Overview', filter: '' },
    { id: 'v2', name: 'Now', filter: 'milestone:"Now: pilot polish" -kind:Epic ' },
    { id: 'v3', name: 'Needs you', filter: 'who:you,together,lawyer -kind:Epic is:open' },
    { id: 'v4', name: 'By platform', filter: '-kind:Epic is:open' },
    { id: 'v5', name: 'My work', filter: 'assignee:@me is:open -status:Done' },
    { id: 'v6', name: 'Pre-business', filter: 'is:open -label:post-business -kind:Epic' },
  ],
});

test('a fresh copy of PTrainr needs exactly what was done by hand on 2026-11-17', () => {
  const steps = planBoard(BOARD, ptrainr());
  assert.deepEqual(steps.map(s => [s.kind, s.name]), [
    ['options', 'Who'], ['options', 'Platform'], ['filter', 'Now'], ['filter', 'Needs you'], ['dropView', 'Pre-business'],
  ]);
  assert.deepEqual(steps[0].to, ['you', 'claude', 'together']);
  assert.deepEqual(steps[1].to, ['Extension', 'Classifier', 'Bridge', 'Agents', 'Tooling', 'Site', 'Several', 'None']);
  assert.equal(steps[2].to, `milestone:"${MILESTONE_ORDER[0]}" -kind:Epic`);
});

test('a board that matches needs nothing, so a re-run changes nothing', () => {
  const board = ptrainr();
  for (const step of planBoard(BOARD, board)) {
    if (step.kind === 'options') board.fields.find(f => f.id === step.fieldId).options = step.options;
    if (step.kind === 'filter') board.views.find(v => v.id === step.viewId).filter = step.to;
    if (step.kind === 'dropView') board.views = board.views.filter(v => v.id !== step.viewId);
  }
  assert.deepEqual(planBoard(BOARD, board), []);
});

test('surviving options keep their colour; new ones get one', () => {
  const board = ptrainr();
  board.fields.find(f => f.name === 'Who').options = [{ name: 'you', color: 'RED' }, { name: 'lawyer', color: 'BLUE' }];
  const who = planBoard(BOARD, board).find(s => s.name === 'Who');
  assert.equal(who.options.find(o => o.name === 'you').color, 'RED');
  assert.ok(who.options.every(o => /^[A-Z]+$/.test(o.color)));
});

test('a rename, a missing field and a missing view are reported', () => {
  const board = ptrainr();
  board.title = 'EzAutoApply (copy)';
  board.fields = board.fields.filter(f => f.name !== 'Kind');
  board.views = board.views.filter(v => v.name !== 'Now');
  const kinds = planBoard(BOARD, board).map(s => `${s.kind}:${s.name ?? s.to}`);
  assert.ok(kinds.includes('title:EzAutoApply'));
  assert.ok(kinds.includes('missingField:Kind'));
  assert.ok(kinds.includes('missingView:Now'));
  for (const s of planBoard(BOARD, board)) assert.equal(typeof describe(s), 'string');
});

test('withProjectNumber rewrites only the PROJECT line', () => {
  const src = "export const OWNER = 'x';\nexport const PROJECT = '4';\nexport const PROJECT_URL = `…/${PROJECT}`;\n";
  assert.equal(withProjectNumber(src, 5), "export const OWNER = 'x';\nexport const PROJECT = '5';\nexport const PROJECT_URL = `…/${PROJECT}`;\n");
  assert.equal(withProjectNumber("export const PROJECT = '';", 7), "export const PROJECT = '7';");
  assert.throws(() => withProjectNumber('no project here', 1));
});
