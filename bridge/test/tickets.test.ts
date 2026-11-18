import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { groupTickets, readIncidentFiles, readResolutions, ticketOf, writeResolutions } from '../src/tickets.ts';

const inc = (id: string, at: string, label: string, extra: Record<string, unknown> = {}) => ({ id, at, ats: 'greenhouse', kind: 'unmatched', field: { label }, ...extra });

test('the same question on the same site is one ticket, whatever its punctuation (#32)', () => {
  assert.equal(ticketOf(inc('a', '', 'Notice period?')).key, ticketOf(inc('b', '', 'notice  period')).key);
  assert.notEqual(ticketOf(inc('a', '', 'Notice period')).key, ticketOf(inc('b', '', 'Notice period', { ats: 'lever' })).key);
  assert.notEqual(ticketOf(inc('a', '', 'Notice period')).key, ticketOf(inc('b', '', 'Notice period', { kind: 'rejected' })).key);
  // A page that wouldn't move has no field: its stop reason names it.
  assert.equal(ticketOf({ id: 'n', kind: 'navigation', stop: { reason: 'noProgress' } }).label, 'noProgress');
});

test('tickets count their incidents and jobs, newest first, and reopen when it happens again', () => {
  const incidents = [
    inc('1', '2026-11-18T01:00:00Z', 'Notice period', { jobId: 'j1' }),
    inc('2', '2026-11-18T02:00:00Z', 'Notice period?', { jobId: 'j2' }),
    inc('3', '2026-11-18T01:30:00Z', 'Pronouns', { jobId: 'j1' }),
  ];
  const [notice, pronouns] = groupTickets(incidents, {});
  assert.deepEqual([notice.label, notice.count, notice.jobIds, notice.first, notice.open], ['Notice period', 2, ['j1', 'j2'], '2026-11-18T01:00:00Z', true]);
  assert.equal(pronouns.count, 1);

  const fixed = { [notice.key]: { outcome: 'fixed' as const, at: '2026-11-18T03:00:00Z' } };
  assert.equal(groupTickets(incidents, fixed)[0].open, false);
  const again = [...incidents, inc('4', '2026-11-18T04:00:00Z', 'Notice period', { jobId: 'j3' })];
  const reopened = groupTickets(again, fixed)[0];
  assert.deepEqual([reopened.open, reopened.count, reopened.resolution?.outcome], [true, 3, 'fixed']);
});

test('incident files are read from the day folders, without the bridge\'s and replay\'s own files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-tickets-'));
  mkdirSync(join(dir, '2026-11-18'));
  writeFileSync(join(dir, '2026-11-18', 'a.json'), JSON.stringify(inc('a', '2026-11-18T01:00:00Z', 'Notice period')));
  writeFileSync(join(dir, '2026-11-18', 'half.json'), '{"id":');
  writeFileSync(join(dir, 'replay-baseline.json'), JSON.stringify({ id: 'not an incident' }));
  writeResolutions(join(dir, 'tickets.json'), { 't-0000000000': { outcome: 'cantFix', at: '2026-11-18T00:00:00Z' } });
  assert.deepEqual(readIncidentFiles(dir).map((i) => i.id), ['a']);
  assert.equal(readResolutions(join(dir, 'tickets.json'))['t-0000000000'].outcome, 'cantFix');
  assert.deepEqual(readResolutions(join(dir, 'missing.json')), {});
});
