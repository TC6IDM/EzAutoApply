import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FieldInfo } from '../../src/fill/types';
import type { Incident } from '../../src/incidents/incident';
import { acceptReplay, compareReplay, pickField, type ReplayCase, replayable, replayLines } from '../../src/incidents/replay';
import { readIncidents, replayIncidents } from '../replay/run';
import { sampleProfile } from './helpers';

const c = (id: string, now: ReplayCase['now']): ReplayCase => ({ id, ats: 'greenhouse', label: id, then: { status: 'needs' }, now });

describe('npm run replay (#19)', () => {
  it('compares a run with the accepted outcomes: worse, better, unchanged, new', () => {
    const baseline = { a: { key: 'phone', status: 'filled' }, b: { status: 'needs' }, c: { key: 'email', status: 'filled' }, d: { key: 'city', status: 'review' } };
    const r = compareReplay(baseline, [
      c('a', { key: 'phone', status: 'review' }), // status down
      c('b', { key: 'firstName', status: 'filled' }), // now fills
      c('c', { key: 'email', status: 'filled' }),
      c('d', { key: 'location', status: 'review' }), // a different key than the accepted one
      c('e', null),
    ]);
    expect(r.regressed.map((x) => x.case.id)).toEqual(['a', 'd']);
    expect(r.improved.map((x) => x.case.id)).toEqual(['b']);
    expect(r.unchanged.map((x) => x.id)).toEqual(['c']);
    expect(r.fresh.map((x) => x.id)).toEqual(['e']);
    expect(replayLines(r)[0]).toBe('replay: 2 worse, 1 better, 1 unchanged, 1 new');
    expect(acceptReplay([c('a', { key: 'phone', status: 'filled' })])).toEqual({ a: { key: 'phone', status: 'filled' } });
  });

  it('finds the incident’s field again by its label, or as the only one of its kind', () => {
    const f = (label: string, kind = 'text') => ({ label, kind }) as FieldInfo;
    expect(pickField([f('Email'), f('Mobile #')], 'Mobile #')?.label).toBe('Mobile #');
    expect(pickField([f('Email'), f('Mobile phone number *')], 'mobile phone number')?.label).toBe('Mobile phone number *');
    expect(pickField([f('Email'), f('', 'select')], 'Province', 'select')?.kind).toBe('select');
    expect(pickField([f('Email'), f('Name')], 'Province', 'select')).toBeNull();
  });

  it('replays a stored incident through the scanner and the pipeline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezaa-replay-'));
    mkdirSync(join(dir, '2026-11-18'));
    const incident: Partial<Incident> = {
      id: 'i1',
      host: 'boards.greenhouse.io',
      ats: 'greenhouse',
      kind: 'unmatched',
      field: { id: 'f1', frameId: 0, label: 'Email address', kind: 'text', options: [], required: true, status: 'needs' },
      domSnippet: '<div class="field"><label for="em">Email address</label><input id="em" name="contact_email" type="email"></div>',
    };
    writeFileSync(join(dir, '2026-11-18', 'i1.json'), JSON.stringify(incident));
    writeFileSync(join(dir, 'replay-baseline.json'), '{}');
    writeFileSync(join(dir, '2026-11-18', 'nav.json'), JSON.stringify({ id: 'n1', kind: 'navigation' }));

    const list = readIncidents(dir);
    expect(list.map((i) => i.id).sort()).toEqual(['i1', 'n1']);
    expect(list.filter(replayable).map((i) => i.id)).toEqual(['i1']);
    const [got] = await replayIncidents(list, sampleProfile());
    expect(got.then).toEqual({ status: 'needs', source: undefined });
    expect(got.now).toMatchObject({ key: 'email', status: 'filled' });
  });
});
