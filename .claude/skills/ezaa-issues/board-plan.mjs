// What bootstrap.mjs has to change on a board to match config.mjs's BOARD, as a
// list of steps, without GitHub (tested by .claude/tests/board.test.mjs).
//
// `board` is { title, fields: [{ id, name, options: [{ name, color }] }], views: [{ id, name, filter }] }.
// Steps: { kind: 'title' | 'options' | 'filter' | 'dropView' | 'missingField' | 'missingView', … }.

const COLORS = ['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE'];

export function planBoard(want, board) {
  const steps = [];
  if (board.title !== want.title) steps.push({ kind: 'title', from: board.title, to: want.title });
  const field = name => board.fields.find(f => f.name === name);
  const wantOptions = { Status: want.status, ...want.options };
  for (const [name, names] of Object.entries(wantOptions)) {
    const f = field(name);
    if (!f) { steps.push({ kind: 'missingField', name }); continue; }
    const have = (f.options || []).map(o => o.name);
    if (have.join('|') === names.join('|')) continue;
    // Keep an option's colour when it survives, so a re-run doesn't repaint the board.
    const options = names.map((n, i) => ({ name: n, color: f.options?.find(o => o.name === n)?.color || COLORS[i % COLORS.length], description: '' }));
    steps.push({ kind: 'options', fieldId: f.id, name, from: have, to: names, options });
  }
  for (const [name, filter] of Object.entries(want.views)) {
    const v = board.views.find(x => x.name === name);
    if (!v) steps.push({ kind: 'missingView', name });
    else if ((v.filter || '').trim() !== filter.trim()) steps.push({ kind: 'filter', viewId: v.id, name, from: v.filter, to: filter });
  }
  for (const name of want.dropViews || []) {
    const v = board.views.find(x => x.name === name);
    if (v) steps.push({ kind: 'dropView', viewId: v.id, name });
  }
  return steps;
}

/** config.mjs's source with PROJECT set to `number`. */
export function withProjectNumber(source, number) {
  const re = /^export const PROJECT = '\d*';/m;
  if (!re.test(source)) throw new Error('config.mjs has no `export const PROJECT = \'…\';` line');
  return source.replace(re, `export const PROJECT = '${number}';`);
}

/** A step as one line for the person. */
export function describe(step) {
  switch (step.kind) {
    case 'title': return `rename the board "${step.from}" → "${step.to}"`;
    case 'options': return `${step.name}: ${step.from.join('|') || '(none)'} → ${step.to.join('|')}`;
    case 'filter': return `view "${step.name}" filter: ${step.from || '(none)'} → ${step.to}`;
    case 'dropView': return `delete the view "${step.name}"`;
    case 'missingField': return `the board has no "${step.name}" field (the template should have it)`;
    case 'missingView': return `the board has no "${step.name}" view (the template should have it)`;
    default: return JSON.stringify(step);
  }
}
