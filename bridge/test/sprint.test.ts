import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSprint, sprintView, verdictOf } from '../src/sprint.ts';
import { LINES, sampleState } from './sample-sprint.ts';

const NOW = Date.parse('2026-11-18T12:00:00Z');

test('the verdict follows the same lines as verdict.mjs, either limit counting (#50)', () => {
  const u = (session: number, weekly: number) => ({ session, weekly, at: NOW });
  assert.deepEqual([u(10, 70), u(10, 80), u(94, 0), u(10, 96)].map((x) => verdictOf(x, LINES)), ['GO', 'SMALL', 'WRAP', 'STOP']);
  assert.equal(verdictOf(null, LINES), 'UNKNOWN');
  assert.equal(verdictOf(u(85, 0), { smallAt: 90, newAt: 82, stopAt: 88 }), 'WRAP', 'small never sits above new');
});

test('the view: the issue it is on, done, passed over (minus those done later), the PRs', () => {
  const v = sprintView(sampleState(), { session: 17, weekly: 70, at: NOW }, NOW)!;
  assert.deepEqual(v.current, { n: 50, title: 'Bridge: show a running sprint' });
  assert.deepEqual(v.done.map((d) => [d.n, d.cost]), [[32, 9], [41, 5]]);
  assert.deepEqual(v.skipped, [{ n: 28, why: 'another repo' }]);
  assert.equal(v.pr, 51);
  assert.deepEqual(v.linkedPrs, [{ repo: 'TC6IDM/ai-job-search', number: 2, url: 'https://github.com/TC6IDM/ai-job-search/pull/2' }]);
  assert.deepEqual([v.verdict, v.windingDown, v.keepGoing], ['GO', false, true]);
  assert.equal(sprintView(sampleState({ windDown: { at: '2026-11-18T11:59:00Z' } }), null, NOW)!.windingDown, true);
});

test('a sprint left behind stops showing, as sprint.mjs stops counting it', () => {
  const old = { readings: [{ at: '2026-11-17T20:00:00Z' }] };
  assert.equal(sprintView(sampleState({ ...old, keepGoing: false }), null, NOW), null, '16 hours without a step');
  assert.notEqual(sprintView(sampleState(old), null, NOW), null, 'keep-going waits out a reset');
  assert.equal(sprintView(null, null, NOW), null);
});

test('usage comes from the status line while fresh, else the endpoint cache while under 20 minutes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-sprint-view-'));
  assert.equal(readSprint(dir, NOW), null, 'no state file: no sprint');
  writeFileSync(join(dir, 'state.json'), JSON.stringify(sampleState()));
  assert.equal(readSprint(dir, NOW)!.usage, null);
  writeFileSync(join(dir, 'usage.json'), JSON.stringify({ session: 50, weekly: 60, at: NOW - 10 * 60e3 }));
  assert.equal(readSprint(dir, NOW)!.usage?.session, 50);
  writeFileSync(join(dir, 'statusline-usage.json'), JSON.stringify({ session: 81, weekly: 60, at: NOW - 60e3 }));
  assert.deepEqual([readSprint(dir, NOW)!.usage?.session, readSprint(dir, NOW)!.verdict], [81, 'SMALL']);
  writeFileSync(join(dir, 'statusline-usage.json'), JSON.stringify({ session: 81, weekly: 60, at: NOW - 6 * 60e3 }));
  assert.equal(readSprint(dir, NOW)!.usage?.session, 50, 'a stale status line falls back to the cache');
  writeFileSync(join(dir, 'state.json'), '{ half');
  assert.equal(readSprint(dir, NOW), null);
});
