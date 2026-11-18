import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, mergeSettings, saveSettings, switchedOff } from '../src/settings.ts';

test('the defaults: Indeed and LinkedIn Easy Apply off, everything else on', () => {
  assert.equal(DEFAULT_SETTINGS.sources.indeed, false);
  assert.equal(DEFAULT_SETTINGS.apply.indeedApply, false);
  assert.equal(DEFAULT_SETTINGS.apply.linkedinEasy, false);
  const on = Object.values(DEFAULT_SETTINGS).flatMap((g) => Object.entries(g)).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(on.sort(), ['indeed', 'indeedApply', 'linkedinEasy']);
});

test('a partial update changes only what it names, and refuses typos and non-booleans', () => {
  const { settings, errors } = mergeSettings(DEFAULT_SETTINGS, { parts: { outreach: false } });
  assert.deepEqual(errors, []);
  assert.equal(settings.parts.outreach, false);
  assert.equal(settings.parts.appliers, true);
  assert.equal(DEFAULT_SETTINGS.parts.outreach, true, 'the defaults are untouched');
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, { parts: { outreech: false }, apply: { external: 'no' }, nope: {} }).errors, [
    'unknown switch "parts.outreech"',
    'apply.external must be true or false',
    'unknown group "nope"',
  ]);
});

test('saved switches load over the defaults; a broken entry or file falls back to the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ezaa-settings-'));
  const file = join(dir, 'fleet-settings.json');
  assert.deepEqual(loadSettings(file), DEFAULT_SETTINGS);
  saveSettings(file, mergeSettings(DEFAULT_SETTINGS, { apply: { linkedinEasy: true } }).settings);
  assert.equal(loadSettings(file).apply.linkedinEasy, true);
  writeFileSync(file, JSON.stringify({ parts: { fixer: false, appliers: 'maybe' }, old: { x: true } }));
  const s = loadSettings(file);
  assert.equal(s.parts.fixer, false);
  assert.equal(s.parts.appliers, true);
  writeFileSync(file, '{ not json');
  assert.deepEqual(loadSettings(file), DEFAULT_SETTINGS);
});

test('which jobs the switches keep from appliers', () => {
  const gh = 'https://boards.greenhouse.io/x/jobs/1';
  assert.equal(switchedOff({ source: 'linkedin', applyKind: 'external', applyUrl: gh }, DEFAULT_SETTINGS), null);
  assert.equal(switchedOff({ source: 'company', applyKind: 'linkedin-easy', applyUrl: 'https://www.linkedin.com/jobs/view/1' }, DEFAULT_SETTINGS), 'LinkedIn Easy Apply is off');
  assert.equal(switchedOff({ source: 'indeed', applyUrl: gh }, DEFAULT_SETTINGS), 'the indeed source is off');
  assert.equal(switchedOff({ source: 'simplify', applyUrl: 'https://ca.indeed.com/viewjob?jk=1' }, DEFAULT_SETTINGS), 'Indeed Apply is off');
  const noLinkedIn = mergeSettings(DEFAULT_SETTINGS, { sources: { linkedin: false } }).settings;
  assert.equal(switchedOff({ source: 'LinkedIn', applyKind: 'external', applyUrl: gh }, noLinkedIn), 'the linkedin source is off');
  const noExternal = mergeSettings(DEFAULT_SETTINGS, { apply: { external: false } }).settings;
  assert.equal(switchedOff({ source: 'simplify', applyKind: 'external', applyUrl: gh }, noExternal), 'applying on company sites is off');
});
