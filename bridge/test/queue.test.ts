import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LEASE_MS, QueueStore } from '../src/queue.ts';

const fresh = () => {
  let t = Date.parse('2026-11-18T10:00:00Z');
  const file = join(mkdtempSync(join(tmpdir(), 'ezaa-queue-')), 'apply_queue', 'queue.jsonl');
  return { q: new QueueStore(file, () => t), file, tick: (ms: number) => (t += ms) };
};
const job = (id: string, extra = {}) => ({ id, applyUrl: `https://boards.greenhouse.io/acme/jobs/${id}`, company: 'Acme', ...extra });

test('adds jobs once each, queued, with a history', () => {
  const { q } = fresh();
  assert.deepEqual(q.add([job('1'), job('2'), job('1'), { id: 'no-url' }]), ['1', '2']);
  assert.deepEqual(q.add([job('2')]), []);
  assert.deepEqual(q.all().map((j) => [j.id, j.status, j.history.length]), [['1', 'queued', 1], ['2', 'queued', 1]]);
});

test('hands out Tier A first, then the oldest, each to one worker', () => {
  const { q, tick } = fresh();
  q.add([job('old')]);
  tick(1000);
  q.add([job('new')]);
  tick(1000);
  q.add([job('tailored', { tier: 'A' })]);
  assert.equal(q.claim('w1')?.id, 'tailored');
  assert.equal(q.claim('w2')?.id, 'old');
  assert.equal(q.claim('w1')?.id, 'new');
  assert.equal(q.claim('w2'), null);
  assert.equal(q.get('old')?.worker, 'w2');
});

test('a lease that runs out puts the job back; reporting renews it', () => {
  const { q, tick } = fresh();
  q.add([job('1'), job('2')]);
  q.claim('w1');
  q.claim('w2');
  tick(LEASE_MS - 1000);
  q.setStatus('2', 'running', { page: 2 });
  tick(2000);
  // Job 1's lease ran out; job 2 reported in time.
  assert.equal(q.claim('w3')?.id, '1');
  assert.equal(q.get('2')?.status, 'running');
  assert.equal(q.get('1')?.history.some((h) => h.note === 'lease ran out'), true);
});

test('a finished status ends the lease; Stop all releases every held job', () => {
  const { q } = fresh();
  q.add([job('1'), job('2'), job('3')]);
  q.claim('w1');
  q.claim('w2');
  q.setStatus('1', 'ready', { note: 'submitReady', tabUrl: 'https://boards.greenhouse.io/acme/jobs/1' });
  assert.equal(q.get('1')?.leaseUntil, undefined);
  assert.equal(q.get('1')?.tabUrl, 'https://boards.greenhouse.io/acme/jobs/1');
  assert.equal(q.releaseAll(), 1);
  assert.deepEqual(q.all().map((j) => j.status), ['ready', 'queued', 'queued']);
  assert.equal(q.setStatus('missing', 'stuck'), null);
});

test('lines it can\'t read are kept as they were', () => {
  const { q, file } = fresh();
  q.add([job('1')]);
  writeFileSync(file, `${readFileSync(file, 'utf8')}not json, written by hand\n`);
  q.claim('w1');
  assert.match(readFileSync(file, 'utf8'), /not json, written by hand\n$/);
  assert.equal(q.all().length, 1);
});
