import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from '../../src/core/profile';
import { resolveFields } from '../../src/fill/pipeline';
import { scanFields } from '../../src/fill/scan';
import type { Incident } from '../../src/incidents/incident';
import { outcomeOf, pickField, type ReplayCase, replayable } from '../../src/incidents/replay';
import { settings } from '../unit/helpers';

/** Every incident file under `dir` (the bridge writes `<date>/<id>.json`), skipping replay's own files. */
export function readIncidents(dir: string): Incident[] {
  if (!existsSync(dir)) return [];
  const out: Incident[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...readIncidents(p));
    else if (name.endsWith('.json') && !name.startsWith('replay-')) {
      try {
        out.push(JSON.parse(readFileSync(p, 'utf8')) as Incident);
      } catch {
        /* a half-written file: skipped */
      }
    }
  }
  return out;
}

/**
 * Scan each incident's snippet again and resolve its field with the classifier off. The
 * profile is the sample one: the snippet's own values were swapped for {{placeholders}}, and
 * what matters is which key the field matches and whether it fills.
 */
export async function replayIncidents(list: Incident[], profile: Profile): Promise<ReplayCase[]> {
  const cases: ReplayCase[] = [];
  for (const i of list.filter(replayable)) {
    document.body.innerHTML = i.domSnippet!;
    const field = pickField(scanFields(document), i.field!.label, i.field!.kind);
    const [r] = field ? await resolveFields([field], { profile, answers: [], host: i.host, settings: settings({ provider: 'none' }), classifier: null }) : [];
    cases.push({
      id: i.id,
      ats: i.ats,
      label: i.field!.label,
      then: { ...(i.pipeline?.key && { key: i.pipeline.key }), status: i.field!.status, source: i.pipeline?.source },
      now: r ? outcomeOf(r) : null,
    });
  }
  document.body.innerHTML = '';
  return cases;
}
