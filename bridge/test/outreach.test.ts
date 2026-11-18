import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { markProspect, readProspects, recruiterView } from '../src/outreach.ts';
import { sampleProspects } from './sample-prospects.ts';

test('the recruiter page: messages to send oldest first, then those written to; no draft yet or skipped stay out (#41)', () => {
  assert.deepEqual(recruiterView(sampleProspects()).map((p) => p.name), ['Sam Example', 'Alex Sample', 'Pat Sent']);
});

test('marking a prospect writes the same fields tools/prospects.py does, and keeps every other line', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ezaa-outreach-')), 'prospects.jsonl');
  writeFileSync(file, sampleProspects().map((p) => JSON.stringify(p)).join('\n') + '\n{"half":\n');
  const p = markProspect(file, 'p-000000000a', 'sent', 'linkedin', '2026-11-18T12:00:00Z');
  assert.deepEqual([p?.status, p?.sent_at, p?.channel], ['sent', '2026-11-18T12:00:00Z', 'linkedin']);
  assert.equal(readProspects(file).length, 5);
  assert.equal(readProspects(file).find((x) => x.id === 'p-000000000b')?.status, 'found');
  assert.equal(markProspect(file, 'p-ffffffffff', 'sent', undefined, ''), null);
  assert.equal(readFileSync(file, 'utf8').includes('"half"'), false, 'a half-written line is dropped on the next write');
  assert.deepEqual(readProspects(join(tmpdir(), 'no-such-dir', 'prospects.jsonl')), []);
});
