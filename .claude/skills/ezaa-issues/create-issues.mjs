// Creates issues for this repo (config.mjs) from a text file (format in SKILL.md), plus any missing labels and milestones.
// Resumable: created numbers are kept in <file>.created.json and skipped on the next run.
// Usage: node create-issues.mjs <issues.txt> [more.txt …] [--dry]
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { REPO, MILESTONES, LABELS, PREFIX } from './config.mjs';
const files = process.argv.slice(2).filter(a => !a.startsWith('--')).map(f => resolve(f));
if (!files.length) { console.error('usage: node create-issues.mjs <issues.txt> [--dry]'); process.exit(1); }
const dry = process.argv.includes('--dry');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();


// ---- parse ----
const issues = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  for (const chunk of text.split(/^@@@ /m).slice(1)) {
    const [head, ...rest] = chunk.split(/^---$/m);
    const body = rest.join('---').trim();
    const lines = head.trim().split('\n');
    const it = { key: lines[0].trim(), body, labels: [], parent: null, milestone: null };
    for (const line of lines.slice(1)) {
      const m = line.match(/^(\w+):\s*(.*)$/); if (!m) continue;
      if (m[1] === 'title') it.title = m[2].trim();
      if (m[1] === 'labels') it.labels = m[2].split(',').map(s => s.trim()).filter(Boolean);
      if (m[1] === 'parent') it.parent = m[2].trim() || null;
      if (m[1] === 'milestone') it.milestone = m[2].trim() || null;
    }
    issues.push(it);
  }
}
const keys = new Set();
for (const it of issues) {
  if (!it.title) throw new Error(`no title: ${it.key}`);
  if (keys.has(it.key)) throw new Error(`duplicate key ${it.key}`);
  if (it.parent && !/^\d+$/.test(it.parent) && !keys.has(it.parent)) throw new Error(`${it.key}: parent ${it.parent} not defined before it`);
  if (it.milestone && !MILESTONES[it.milestone]) throw new Error(`${it.key}: milestone ${it.milestone}`);
  for (const l of it.labels) if (!LABELS[l]) throw new Error(`${it.key}: unknown label ${l}`);
  keys.add(it.key);
}
console.log(`${issues.length} issues parsed, ${issues.filter(i => i.parent).length} sub-issues`);
if (dry) process.exit(0);

// ---- labels ----
const existing = new Set(JSON.parse(gh(['label', 'list', '--repo', REPO, '--limit', '300', '--json', 'name'])).map(l => l.name));
for (const [name, [color, desc]] of Object.entries(LABELS)) {
  if (existing.has(name)) continue;
  gh(['label', 'create', name, '--repo', REPO, '--color', color, '--description', desc]);
  console.log('label', name);
}

// ---- milestones ----
const ms = JSON.parse(gh(['api', `repos/${REPO}/milestones?state=all&per_page=100`])).map(m => m.title);
for (const [title, desc] of Object.values(MILESTONES)) {
  if (ms.includes(title)) continue;
  gh(['api', `repos/${REPO}/milestones`, '-f', `title=${title}`, '-f', `description=${desc}`]);
  console.log('milestone', title);
}

// ---- issues ----
const statePath = files[0] + '.created.json';
const created = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const tmp = mkdtempSync(join(tmpdir(), `${PREFIX}-issue-`));
for (const it of issues) {
  if (created[it.key]) continue;
  const bodyPath = join(tmp, `${it.key}.md`);
  writeFileSync(bodyPath, it.body + '\n');
  const args = ['issue', 'create', '--repo', REPO, '--title', it.title, '--body-file', bodyPath];
  for (const l of it.labels) args.push('--label', l);
  if (it.milestone) args.push('--milestone', MILESTONES[it.milestone][0]);
  if (it.parent) args.push('--parent', String(created[it.parent] ?? it.parent));
  let url;
  for (let attempt = 1; ; attempt++) {
    try { url = gh(args); break; }
    catch (e) {
      const msg = String(e.stderr || e.message);
      if (attempt >= 4) throw new Error(`${it.key}: ${msg}`);
      console.log(`retry ${it.key} (${msg.split('\n')[0]})`); await sleep(20000 * attempt);
    }
  }
  created[it.key] = Number(url.match(/\/issues\/(\d+)/)[1]);
  writeFileSync(statePath, JSON.stringify(created, null, 1));
  console.log(`#${created[it.key]} ${it.key}${it.parent ? ` (under #${created[it.parent] ?? it.parent})` : ''}`);
  await sleep(2500);
}
// ---- cross-references ----
// A body may name another issue in the same file by its key (`#upload`,
// `Blocked by #site-host`) before either exists. Once every issue has a number,
// rewrite those keys into numbers. A key must contain a letter, so `#307` is
// never mistaken for one; a key that is not in this file is left alone.
const keyRef = /#([a-z][a-z0-9-]*)\b/gi;
for (const it of issues) {
  if (!keyRef.test(it.body)) continue;
  keyRef.lastIndex = 0;
  const body = it.body.replace(keyRef, (m, key) => (created[key] ? `#${created[key]}` : m));
  if (body === it.body) continue;
  const bodyPath = join(tmp, `${it.key}.refs.md`);
  writeFileSync(bodyPath, body + '\n');
  gh(['issue', 'edit', String(created[it.key]), '--repo', REPO, '--body-file', bodyPath]);
  console.log(`#${created[it.key]} ${it.key}: cross-references numbered`);
  await sleep(1500);
}
console.log('done', Object.keys(created).length);
