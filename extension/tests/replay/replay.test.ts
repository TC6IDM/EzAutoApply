import { writeFileSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { acceptReplay, compareReplay, type Outcome, replayLines } from '../../src/incidents/replay';
import { sampleProfile } from '../unit/helpers';
import { readIncidents, replayIncidents } from './run';

/**
 * `npm run replay` (#19): the stored incidents (outside git: they hold page markup) as
 * regression cases. Fails when a case does worse than its accepted outcome.
 *   EZAA_INCIDENTS=<dir>     where the incidents are (default ~/.ezautoapply/incidents)
 *   EZAA_REPLAY_ACCEPT=1     accept this run's outcomes as the new baseline
 */
const dir = process.env.EZAA_INCIDENTS || join(homedir(), '.ezautoapply', 'incidents');
const baselineFile = join(dir, 'replay-baseline.json');

test('replay the stored incidents', async () => {
  const cases = await replayIncidents(readIncidents(dir), sampleProfile());
  if (!cases.length) {
    console.log(`replay: no incidents to replay in ${dir}`);
    return;
  }
  const baseline = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<string, Outcome | null>) : {};
  const report = compareReplay(baseline, cases);
  console.log(replayLines(report).join('\n'));
  if (process.env.EZAA_REPLAY_ACCEPT === '1') {
    writeFileSync(baselineFile, JSON.stringify(acceptReplay(cases), null, 2));
    console.log(`replay: accepted ${cases.length} outcomes into ${baselineFile}`);
    return;
  }
  expect(report.regressed.map((r) => `${r.case.ats} · ${r.case.label}`), 'cases worse than their accepted outcome').toEqual([]);
}, 120_000);
