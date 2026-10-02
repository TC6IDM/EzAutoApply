import { normalize, questionSimilarity } from '../../core/normalize';
import type { FieldKind, SavedAnswer } from '../../core/types';
import type { FieldInfo } from '../types';

/** Tier 3: answers the user gave on earlier applications. */

export interface BankHit {
  answer: SavedAnswer;
  score: number;
}

const CHOICE: FieldKind[] = ['select', 'radio', 'combobox', 'checkboxGroup', 'checkbox'];

function optionOverlap(a: string[] | undefined, b: string[]): number {
  if (!a?.length || !b.length) return 0;
  const sa = new Set(a.map(normalize));
  const sb = new Set(b.map(normalize));
  let inter = 0;
  for (const o of sa) if (sb.has(o)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

function compatible(answer: SavedAnswer, field: FieldInfo): boolean {
  if (field.kind === 'file') return false;
  if (typeof answer.answer === 'boolean') return CHOICE.includes(field.kind);
  if (Array.isArray(answer.answer)) return field.kind === 'checkboxGroup' || field.kind === 'select' || field.kind === 'text' || field.kind === 'textarea';
  return field.kind !== 'checkbox' || /^(yes|no|true|false)$/i.test(String(answer.answer));
}

/** Saved answers that may apply to this field, best first. */
export function findAnswers(field: FieldInfo, answers: SavedAnswer[], host: string, limit = 5): BankHit[] {
  const question = field.label || field.placeholder;
  if (!question) return [];
  const norm = normalize(question);
  const opts = field.options.map((o) => o.label);
  const hits: BankHit[] = [];
  for (const a of answers) {
    if (a.scope !== 'global' && a.scope !== host) continue;
    if (!compatible(a, field)) continue;
    let score = a.normalized === norm ? 1 : questionSimilarity(question, a.question);
    if (score < 0.3) continue;
    // The same option list is strong evidence it's the same question; a different one is weak evidence against.
    const overlap = optionOverlap(a.options, opts);
    if (opts.length && a.options?.length) score = Math.min(1, score + (overlap - 0.5) * 0.1);
    // Prefer company-specific answers on their own site.
    if (a.scope === host) score = Math.min(1, score + 0.02);
    hits.push({ answer: a, score });
  }
  return hits.sort((x, y) => y.score - x.score || y.answer.timesUsed - x.answer.timesUsed).slice(0, limit);
}
