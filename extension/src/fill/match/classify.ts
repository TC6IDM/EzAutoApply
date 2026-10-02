import {
  type Answer,
  choiceConfidence,
  noulProbability,
  type SystemOneBatchRequest,
  type SystemOneRequest,
  type SystemOneResponse,
} from '../../classifier/systemone';
import { CATEGORY_DESCRIPTIONS, type Category, keysInCategory, kindAccepts } from '../../core/fieldKeys';
import { isPlaceholderOption } from '../../core/options';
import { truncate } from '../../core/normalize';
import type { FieldInfo } from '../types';
import type { BankHit } from './answerBank';

/**
 * Tier 4: questions for the Laya/Jev decision model. Every state is kept short
 * (Laya reads ~512-1024 tokens and gets slower past ~400). Multiple-choice
 * questions offer at most 10 labels, because Laya's checkpoints only calibrate
 * confidence up to 10 options; picking among many keys uses one yes/no
 * question per key instead.
 */

export interface Classifier {
  predict(req: SystemOneRequest): Promise<SystemOneResponse>;
  predictBatch(req: SystemOneBatchRequest): Promise<SystemOneResponse[]>;
}

/** Step 1 sorts a field into one of these groups; step 2 picks a key inside it. */
export type GroupId = 'contact' | 'address' | 'links' | 'workAuth' | 'eeo' | 'experience' | 'education' | 'logistics' | 'about' | 'other';

export const CLASSIFIER_GROUPS: Record<GroupId, { description: string; categories: Category[] }> = {
  contact: { description: CATEGORY_DESCRIPTIONS.contact, categories: ['contact'] },
  address: { description: CATEGORY_DESCRIPTIONS.address, categories: ['address'] },
  links: { description: CATEGORY_DESCRIPTIONS.links, categories: ['links'] },
  workAuth: { description: CATEGORY_DESCRIPTIONS.workAuth, categories: ['workAuth'] },
  eeo: { description: CATEGORY_DESCRIPTIONS.eeo, categories: ['eeo'] },
  experience: { description: CATEGORY_DESCRIPTIONS.experience, categories: ['experience'] },
  education: { description: CATEGORY_DESCRIPTIONS.education, categories: ['education'] },
  logistics: {
    description: 'Availability, pay and preferences: start date, notice period, salary expectations, relocation, remote or onsite work, or how the applicant heard about the job',
    categories: ['logistics', 'compensation'],
  },
  about: {
    description: 'A resume, cover letter or transcript (upload or paste), a professional summary, skills, spoken languages or certifications',
    categories: ['about', 'documents'],
  },
  other: {
    description: 'Anything else: an open-ended question needing a written personal answer (why this company, a project story), consent checkboxes, referrals, or questions about this specific company',
    categories: [],
  },
};

/** Laya's choice confidences are only calibrated up to this many options. */
const MAX_CALIBRATED_OPTIONS = 10;
const MAX_OPTIONS_IN_STATE = 12;

/** The field as the model sees it. */
export function describeField(f: FieldInfo): string {
  const lines = [`Form field: ${truncate(f.label || f.placeholder || f.name || '(unlabeled)', 300)}`];
  if (f.help) lines.push(`Hint: ${truncate(f.help, 200)}`);
  if (f.section) lines.push(`Section: ${truncate(f.section, 80)}`);
  const opts = f.options.filter((o) => !isPlaceholderOption(o)).map((o) => truncate(o.label, 40));
  if (opts.length) {
    const shown = opts.slice(0, MAX_OPTIONS_IN_STATE).join(' | ');
    lines.push(`Options: ${shown}${opts.length > MAX_OPTIONS_IN_STATE ? ` | … (${opts.length} total)` : ''}`);
  }
  lines.push(`Input type: ${f.kind === 'checkboxGroup' ? 'checkboxes' : f.kind}`);
  return lines.join('\n');
}

const GROUP_QUESTION = {
  group: {
    type: 'choice' as const,
    instructions: 'What information is this job application form field asking for?',
    criteria: Object.fromEntries(Object.entries(CLASSIFIER_GROUPS).map(([id, g]) => [id, g.description])),
  },
};

export interface Decision<T> {
  value: T;
  confidence: number;
}

export interface GroupDecision extends Decision<GroupId> {
  /** Every group with its probability, most likely first. */
  ranked: [GroupId, number][];
}

/** Step 1 for every unresolved field at once: which group is it in? */
export async function classifyGroups(fields: FieldInfo[], c: Classifier): Promise<GroupDecision[]> {
  if (!fields.length) return [];
  const results = await c.predictBatch({
    states: fields.map((f) => ({ body: describeField(f) })),
    questions: GROUP_QUESTION,
  });
  return results.map((r) => {
    const a = r.answers.group;
    const value = a?.choice && a.choice in CLASSIFIER_GROUPS ? (a.choice as GroupId) : 'other';
    const ranked = Object.entries(a?.probabilities ?? { [value]: choiceConfidence(a) })
      .filter(([id]) => id in CLASSIFIER_GROUPS)
      .sort((x, y) => y[1] - x[1]) as [GroupId, number][];
    return { value, confidence: choiceConfidence(a), ranked };
  });
}

/**
 * The groups worth searching for a field's key. Laya leans toward "other" for
 * almost everything, so the two likeliest real groups are used instead.
 */
export function likelyGroups(d: GroupDecision, n = 2): GroupId[] {
  return d.ranked.filter(([id]) => id !== 'other').slice(0, n).map(([id]) => id);
}

const MAX_KEY_QUESTIONS = 20;

/** The keys the classifier may pick for a field, from the given groups. */
export function candidateKeys(f: FieldInfo, groups: GroupId[]) {
  return groups
    .flatMap((g) => CLASSIFIER_GROUPS[g].categories)
    .flatMap((cat) => keysInCategory(cat))
    .filter((k) => !k.noClassify && kindAccepts(k, f.kind))
    .slice(0, MAX_KEY_QUESTIONS);
}

export interface KeyScore {
  key: string;
  p: number;
}

/**
 * Step 2: one yes/no question per candidate key ("This form field asks for:
 * <description>"), all answered in a single request, ranked by P(yes).
 * Measured on live Laya this ranks the right key first far more often than a
 * single multiple-choice question does.
 */
export async function rankKeys(f: FieldInfo, groups: GroupId[], c: Classifier): Promise<KeyScore[]> {
  const keys = candidateKeys(f, groups);
  if (!keys.length) return [];
  const questions: Record<string, { type: 'noul'; instructions: string }> = {};
  for (const k of keys) questions[k.key] = { type: 'noul', instructions: `This form field asks for: ${k.description}` };
  const res = await c.predict({ state: { body: describeField(f) }, questions });
  return keys
    .map((k) => ({ key: k.key, p: noulProbability(res.answers[k.key]) ?? 0 }))
    .sort((a, b) => b.p - a.p);
}

/** How far the best key must lead the runner-up before it's trusted. */
export const KEY_MARGIN = 0.04;

/** Is this field the same question as one of these saved ones? Returns the hit index or null. */
export async function pickSavedQuestion(f: FieldInfo, hits: BankHit[], c: Classifier): Promise<Decision<number | null>> {
  const criteria: Record<string, string> = {};
  hits.slice(0, MAX_CALIBRATED_OPTIONS - 1).forEach((h, i) => {
    criteria[`q${i}`] = truncate(h.answer.question, 120);
  });
  criteria.none = 'A different question from all of these';
  const res = await c.predict({
    state: { body: describeField(f) },
    questions: { same: { type: 'choice', instructions: 'Which saved question asks the same thing as this form field?', criteria } },
  });
  const a = res.answers.same;
  const m = /^q(\d+)$/.exec(a?.choice ?? '');
  return { value: m ? Number(m[1]) : null, confidence: choiceConfidence(a) };
}

/**
 * Map a known answer onto the field's options when wording differs, e.g. answer
 * "U.S. citizen" onto options "Authorized without sponsorship" / "Requires sponsorship".
 */
export async function chooseOption(f: FieldInfo, answerText: string, c: Classifier): Promise<Decision<number | null>> {
  const candidates = f.options.map((o, index) => ({ o, index })).filter(({ o }) => !isPlaceholderOption(o));
  // Beyond ~20 labels Laya trims each one to fit its budget; long lists (countries) are left to the user.
  if (!candidates.length || candidates.length > 20) return { value: null, confidence: 0 };
  // Duplicate labels can't be told apart by the model, so they're numbered.
  const labels = candidates.map(({ o }, i) => `${i + 1}. ${truncate(o.label, 60)}`);
  const res = await c.predict({
    state: { body: `Question: ${truncate(f.label, 300)}\nApplicant's answer: ${truncate(answerText, 300)}` },
    questions: { option: { type: 'choice', instructions: "Which option best matches the applicant's answer?", criteria: labels } },
  });
  const a: Answer | undefined = res.answers.option;
  const pos = a?.choice ? labels.indexOf(a.choice) : -1;
  return { value: pos >= 0 ? candidates[pos].index : null, confidence: choiceConfidence(a) };
}

/** A yes/no question answered from the applicant's facts. Returns P(yes). */
export async function deriveYesNo(f: FieldInfo, facts: string, c: Classifier): Promise<number | null> {
  const res = await c.predict({
    state: { body: `Applicant facts:\n${truncate(facts, 1200)}` },
    questions: { yes: { type: 'noul', instructions: truncate(f.label, 300) } },
  });
  return noulProbability(res.answers.yes);
}
