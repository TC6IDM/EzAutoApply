import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunState } from '../../extension/src/run/types.ts';
import { jobEvents, officeJob, officeSnapshot, switchEvents, ticketEvents } from '../src/office.ts';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/settings.ts';
import type { QueueJob } from '../src/queue.ts';

const NOW = Date.parse('2026-11-18T15:00:00Z');
const job = (id: string, over: Partial<QueueJob> = {}): QueueJob => ({
  id,
  applyUrl: `https://boards.greenhouse.io/acme/jobs/${id}`,
  company: 'Acme',
  title: 'Junior Developer',
  status: 'queued',
  createdAt: '2026-11-18T10:00:00Z',
  updatedAt: '2026-11-18T10:00:00Z',
  history: [{ at: '2026-11-18T10:00:00Z', status: 'queued' }],
  ...over,
});
const run = (over: Partial<RunState> = {}): RunState => ({ tabId: 1, startUrl: 'x', page: 2, status: 'running', history: [], startedAt: 0, updatedAt: 0, ...over });

test('a job on its second page: pages from the Run, who filled what from the fields, agent answers by label', () => {
  const j = job('a', { status: 'running', worker: 'w1', ats: 'greenhouse', fit: { score: 82 }, agentAnswers: [{ fieldId: 'f4', at: '' }] });
  const fields = [
    { id: 'f1', label: 'Email', status: 'filled', source: 'rule' },
    { id: 'f2', label: 'Phone', status: 'review', source: 'rule' },
    { id: 'f3', label: 'Why us?', status: 'filled', source: 'answerBank' },
    { id: 'f4', label: 'Notice period', status: 'filled', source: 'answerBank' },
    { id: 'f5', label: 'Pronouns', status: 'skipped' },
    { id: 'f6', label: 'Salary expectation', status: 'needs' },
  ];
  const v = officeJob(j, { run: run({ history: [{ page: 1, url: 'x', filled: 7, review: 1, needs: 0, pressed: 'Next' }] }), fields });
  assert.deepEqual(v.pages, [{ filled: 8, total: 8 }, { filled: 4, total: 5 }]);
  assert.deepEqual(v.src, { rules: 2, answers: 1, classifier: 0, agent: 1 });
  assert.deepEqual(v.agentAnswered, ['Notice period']);
  assert.deepEqual(v.needs, ['Salary expectation']);
  assert.equal(v.ats, 'Greenhouse');
  assert.equal(v.fit, 82);
  assert.equal(v.doc, 'Default resume');
});

test('a job with no Run yet has one empty page, and a tailored CV is named', () => {
  const v = officeJob(job('b', { tier: 'A', documents: { resume: 'cv/acme/Tailored.pdf' } }));
  assert.deepEqual(v.pages, [{ filled: 0, total: 0 }]);
  assert.equal(v.doc, 'Tailored CV (Tailored.pdf)');
  assert.equal(v.fit, null);
});

test('history reads as plain words, each line under the worker that held the job', () => {
  const j = job('c', {
    company: 'Northwind',
    history: [
      { at: '2026-11-18T10:00:00Z', status: 'queued' },
      { at: '2026-11-18T10:01:00Z', status: 'claimed', note: 'claimed by w2' },
      { at: '2026-11-18T10:02:00Z', status: 'running', page: 1 },
      { at: '2026-11-18T10:05:00Z', status: 'ready', note: 'submitReady' },
    ],
  });
  assert.deepEqual(jobEvents(j).map((e) => [e.who, e.text, e.tone]), [
    ['Queue', 'Queued Northwind: Junior Developer', undefined],
    ['w2', 'Claimed Northwind: Junior Developer', undefined],
    ['w2', 'Run is on page 1 at Northwind', undefined],
    ['w2', "Stopped at Submit on Northwind. It's in your inbox.", 'ok'],
  ]);
});

test('a change of switches reads as one ticker line per switch (#55)', () => {
  const after = mergeSettings(DEFAULT_SETTINGS, { parts: { outreach: false }, apply: { linkedinEasy: true, external: true } }).settings;
  assert.deepEqual(switchEvents(DEFAULT_SETTINGS, after, 't').map((e) => [e.text, e.tone]), [
    ['Switched off: Outreach', 'warn'],
    ['Switched on: LinkedIn Easy Apply', undefined],
  ]);
});

test('the snapshot: desks by first-seen worker, the queue in claim order, the inbox, today\'s counts', () => {
  const jobs = [
    job('q-old', { createdAt: '2026-11-18T08:00:00Z' }),
    job('q-a', { tier: 'A', createdAt: '2026-11-18T09:00:00Z' }),
    job('held', { status: 'running', worker: 'w-late' }),
    job('r', { status: 'ready', updatedAt: '2026-11-18T12:00:00Z' }),
    job('n', { status: 'needsYou', statusNote: 'captcha' }),
    job('s1', { status: 'submitted', updatedAt: '2026-11-18T11:00:00Z' }),
    job('s0', { status: 'submitted', updatedAt: '2026-11-17T11:00:00Z' }),
  ];
  const snap = officeSnapshot({
    jobs,
    runs: new Map(),
    workersSeen: new Map([['w-late', 200], ['w-first', 100]]),
    stopped: false,
    maxReadyOpen: 6,
    incidentsToday: 3,
    now: NOW,
  });
  assert.deepEqual(snap.workers.map((w) => [w.name, w.job?.id ?? null]), [['w-first', null], ['w-late', 'held']]);
  assert.deepEqual(snap.queue.map((j) => j.id), ['q-a', 'q-old']);
  assert.deepEqual([snap.ready.map((j) => j.id), snap.needs.map((j) => j.id)], [['r'], ['n']]);
  assert.equal(snap.counts.queued, 2);
  assert.equal(snap.submittedToday, 1);
  assert.equal(snap.incidentsToday, 3);
  assert.ok(snap.events.length > 0 && snap.events.every((e, i, a) => i === 0 || a[i - 1].at >= e.at), 'newest first');
});

test('a ticket the Fixer resolved goes on the ticker; an unresolved one doesn\'t (#32)', () => {
  const base = { key: 't-0123456789', ats: 'lever', kind: 'unmatched', label: 'Notice period', count: 2, first: '2026-11-18T01:00:00Z', last: '2026-11-18T01:05:00Z', incidents: ['a', 'b'], jobIds: ['j1'], open: true, resolution: null };
  assert.deepEqual(ticketEvents(base), []);
  const [e] = ticketEvents({ ...base, open: false, resolution: { outcome: 'cantFix', at: '2026-11-18T02:00:00Z' } });
  assert.deepEqual([e.who, e.tone, e.text.startsWith('Can’t fix: “Notice period” on lever')], ['Fixer', 'warn', true]);
});
