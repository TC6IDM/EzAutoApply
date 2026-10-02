import { FIELD_KEYS, type FieldKeyDef, kindAccepts } from '../../core/fieldKeys';
import { normalize, splitIdentifier } from '../../core/normalize';
import type { FieldInfo } from '../types';

/**
 * Tier 2 of the pipeline: recognize a field from its autocomplete token,
 * label text and name/id attributes. Each key scores by its most specific
 * (longest) matching pattern, so "Preferred first name" beats "first name".
 */

export interface RuleMatch {
  key: string;
  score: number;
  via: 'autocomplete' | 'label' | 'attr' | 'type';
}

const AUTOCOMPLETE_IGNORED = new Set(['on', 'off', 'none', 'false', 'true', 'nope', 'chrome-off', 'disabled']);

function longestMatch(patterns: RegExp[] | undefined, text: string): number {
  if (!patterns || !text) return 0;
  let best = 0;
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) best = Math.max(best, m[0].length || 1);
  }
  return best;
}

function eligible(def: FieldKeyDef, field: FieldInfo, label: string, section: string): boolean {
  if (!kindAccepts(def, field.kind)) return false;
  if (def.section && !def.section.test(section)) return false;
  if (def.notSection && section && def.notSection.test(section)) return false;
  if (def.exclude?.some((re) => re.test(label))) return false;
  return true;
}

export function fieldLabelText(field: FieldInfo): string {
  return normalize(field.label || field.placeholder);
}

export function matchRules(field: FieldInfo): RuleMatch | null {
  const label = fieldLabelText(field);
  const section = normalize(field.section);
  const attrs = [field.name, field.htmlId].map((a) => normalize(splitIdentifier(a))).filter(Boolean);
  const words = label ? label.split(' ').length : 0;

  const tokens = field.autocomplete
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t && !AUTOCOMPLETE_IGNORED.has(t));

  let best: RuleMatch | null = null;
  const consider = (m: RuleMatch) => {
    if (!best || m.score > best.score) best = m;
  };

  for (const def of FIELD_KEYS) {
    if (!eligible(def, field, label, section)) continue;

    if (def.autocomplete && tokens.some((t) => def.autocomplete!.includes(t))) {
      consider({ key: def.key, score: 100, via: 'autocomplete' });
      continue;
    }

    const sectionBonus = def.section ? 20 : 0;
    let score = 0;
    let via: RuleMatch['via'] = 'label';

    if (!def.maxWords || words <= def.maxWords) {
      const l = longestMatch(def.label, label);
      if (l) score = 10 + l + sectionBonus;
    }

    let a = 0;
    for (const attr of attrs) a = Math.max(a, longestMatch(def.attr, attr));
    if (a) {
      if (score) score += 5;
      else if (!label || words <= (def.maxWords ?? 8)) {
        // Attribute-only evidence is weaker, and only trusted when the label doesn't contradict it.
        score = 5 + a / 2 + sectionBonus;
        via = 'attr';
      }
    }

    if (score) consider({ key: def.key, score, via });
  }

  // Upload boxes are often labelled by their section heading ("Resume/CV"), with the box itself
  // saying only "Drop files here or select files".
  if (!best && field.kind === 'file' && field.section && field.section !== field.label) {
    return matchRules({ ...field, label: field.section, placeholder: '', section: '' });
  }

  // Input types are a last resort for unlabeled fields.
  if (!best) {
    if (field.inputType === 'email') return { key: 'email', score: 4, via: 'type' };
    if (field.inputType === 'tel') return { key: 'phone', score: 4, via: 'type' };
  }
  return best;
}
