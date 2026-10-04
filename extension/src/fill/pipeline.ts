import { profileFacts } from '../core/facts';
import { type Category, FIELD_KEY_MAP, isUncertain } from '../core/fieldKeys';
import { cleanText, normalize, truncate } from '../core/normalize';
import { boolOf, fallbackOption, matchBoolOption, matchOption, scoreOption } from '../core/options';
import type { Profile } from '../core/profile';
import { CHOICE_KINDS, type FieldValue, isFileRef, isSecretRef, type SavedAnswer, type Settings } from '../core/types';
import { type BankHit, findAnswers } from './match/answerBank';
import {
  type Classifier,
  chooseOption,
  classifyGroups,
  deriveYesNo,
  type GroupId,
  KEY_MARGIN,
  likelyGroups,
  pickSavedQuestion,
  rankKeys,
} from './match/classify';
import { matchRules } from './match/rules';
import type { FieldInfo, FillStatus, Resolution, ResolutionSource } from './types';

/**
 * Decide what goes into each field, cheapest tier first:
 *   rules → saved answers → classifier (category → key → option) → ask the user.
 * Pure logic over FieldInfo, so it runs the same in tests and in the page.
 */

export interface PipelineDeps {
  profile: Profile;
  answers: SavedAnswer[];
  host: string;
  settings: Settings;
  /** Null when the classifier is disabled or offline; tiers 1–3 still run. */
  classifier: Classifier | null;
  onClassifierError?(e: Error): void;
}

interface PlanMeta {
  key?: string;
  source: ResolutionSource;
  confidence: number;
  forceReview?: boolean;
  variants?: string[];
  answerId?: string;
}

/** Groups where a yes/no question can sensibly be answered from the profile. */
const DERIVABLE: GroupId[] = ['experience', 'education', 'about', 'workAuth', 'logistics'];

export const fallbackNote = (wanted: string, picked: string) => `"${wanted}" isn't an option here, so "${picked}" was picked`;

/** What sites fill in by themselves from a resume they read, so what's worth checking against the profile. */
const SITE_FILLED: Category[] = ['contact', 'address', 'links', 'experience', 'education', 'about'];
/** The field that names a job or school; the one flagged when the site added an entry the profile doesn't have. */
const ENTRY_NAMES = ['expCompany', 'school'];

/** Whether what a field holds already says what the profile says, in the field's own format. */
export function agrees(current: string, want: FieldValue): boolean {
  const c = cleanText(current);
  const w = valueText(want).trim();
  if (!c) return false;
  if (!w || normalize(c) === normalize(w)) return true;
  const nums = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  // Dates: the same year, and the same month where the box shows one ("06/2021" for 2021-06).
  if (/^\d{4}(-\d{1,2}){0,2}$/.test(w)) {
    const wn = nums(w);
    const cn = nums(c);
    return cn.includes(wn[0]) && cn.every((n) => wn.includes(n) || n === 1);
  }
  // Phone numbers: the same digits, with or without a country code.
  const numeric = /^[\d\s()+.-]+$/;
  if (numeric.test(c) && numeric.test(w)) {
    const dc = c.replace(/\D/g, '');
    const dw = w.replace(/\D/g, '');
    const n = Math.min(dc.length, dw.length, 10);
    return n > 0 && dc.slice(-n) === dw.slice(-n);
  }
  return scoreOption(c, w) >= 0.85;
}

export function valueText(v: FieldValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  if (isFileRef(v)) return `[${v.fileKind}]`;
  if (isSecretRef(v)) return '••••••••';
  return v;
}

function isYesNoField(f: FieldInfo): boolean {
  if (f.kind === 'checkbox') return true;
  return !!matchBoolOption(f.options, true) && !!matchBoolOption(f.options, false);
}

export async function resolveFields(fields: FieldInfo[], deps: PipelineDeps): Promise<Resolution[]> {
  const { settings, profile } = deps;
  const auto = settings.classifier.autoThreshold;
  const review = settings.classifier.reviewThreshold;
  let classifier = deps.classifier;

  const statusFor = (confidence: number, forceReview = false): FillStatus =>
    confidence >= auto && !forceReview ? 'filled' : confidence >= review ? 'review' : 'needs';

  /** Run a classifier call; on the first failure stop using the classifier for this run. */
  const ask = async <T>(fn: (c: Classifier) => Promise<T>): Promise<T | null> => {
    if (!classifier) return null;
    try {
      return await fn(classifier);
    } catch (e) {
      classifier = null;
      deps.onClassifierError?.(e as Error);
      return null;
    }
  };

  const counters = new Map<string, number>();
  const nextIndex = (key: string) => {
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    return n;
  };

  const unresolved = (f: FieldInfo, key?: string, note?: string): Resolution => ({
    fieldId: f.id,
    key,
    source: 'none',
    confidence: 0,
    // A question left at "Select One" almost always needs an answer, even when the page doesn't mark it required.
    status: f.required || CHOICE_KINDS.includes(f.kind) ? 'needs' : 'skipped',
    note,
  });

  /** Turn a value into a concrete plan for this field (choosing an option when it has options). */
  const plan = async (f: FieldInfo, value: FieldValue, meta: PlanMeta): Promise<Resolution> => {
    const base: Resolution = {
      fieldId: f.id,
      key: meta.key,
      value,
      source: meta.source,
      confidence: meta.confidence,
      status: statusFor(meta.confidence, meta.forceReview),
      answerId: meta.answerId,
    };
    if (isFileRef(value) || isSecretRef(value)) return base;

    if (f.kind === 'checkbox') {
      const b = typeof value === 'boolean' ? value : Array.isArray(value) ? null : boolOf(value);
      if (b === null) return unresolved(f, meta.key, `"${valueText(value)}" isn't a yes/no answer`);
      return { ...base, value: b };
    }

    const hasOptions = f.options.length > 0 && (f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkboxGroup');
    if (!hasOptions) return base; // text fields, and comboboxes whose options load when opened

    if (Array.isArray(value) && f.kind === 'checkboxGroup') {
      const picked = value.map((v) => matchOption(f.options, v)).filter((m) => m !== null);
      if (!picked.length) return unresolved(f, meta.key, `None of "${valueText(value)}" matched an option`);
      const conf = meta.confidence * Math.min(...picked.map((m) => m.score));
      return { ...base, value: picked.map((m) => f.options[m.index].label), confidence: conf, status: statusFor(conf, meta.forceReview) };
    }

    const want = Array.isArray(value) ? value[0] : value;
    const m = matchOption(f.options, want, typeof want === 'string' ? (meta.variants ?? []) : []);
    if (m) {
      const conf = meta.confidence * m.score;
      return { ...base, optionIndex: m.index, value: f.options[m.index].label, confidence: conf, status: statusFor(conf, meta.forceReview) };
    }

    // Questions that shouldn't be left blank ("How did you hear about us?" → "Other").
    const def = meta.key ? FIELD_KEY_MAP[meta.key] : undefined;
    const fb = def && (def.fallbacks || def.anyOption) ? fallbackOption(f.options, def.fallbacks ?? [], !!def.anyOption) : null;
    if (fb) {
      const label = f.options[fb.index].label;
      return { ...base, optionIndex: fb.index, value: label, status: 'review', note: fallbackNote(valueText(want), label) };
    }

    const picked = await ask((c) => chooseOption(f, valueText(want), c));
    if (picked && picked.value !== null && picked.confidence >= review) {
      const conf = Math.min(meta.confidence, picked.confidence);
      return {
        ...base,
        optionIndex: picked.value,
        value: f.options[picked.value].label,
        source: meta.source === 'rule' ? 'classifier' : meta.source,
        confidence: conf,
        status: statusFor(conf, true),
        note: `Matched your answer "${valueText(want)}" to this option`,
      };
    }
    return unresolved(f, meta.key, `Your answer "${valueText(want)}" didn't match any option`);
  };

  /** Resolve a canonical key against the profile; null when the profile doesn't have it. */
  const fromKey = async (f: FieldInfo, key: string, meta: Omit<PlanMeta, 'key'>): Promise<Resolution | null> => {
    const def = FIELD_KEY_MAP[key];
    if (!def) return null;
    const index = def.repeat ? nextIndex(key) : 0;
    const resolved = def.resolve({ profile, index, label: f.label || f.placeholder, section: f.section, kind: f.kind });
    if (resolved === null) return null;
    const uncertain = isUncertain(resolved);
    const value = uncertain ? resolved.uncertain : resolved;
    const variants = typeof value === 'string' && def.variants ? def.variants(value) : [];
    return plan(f, value, { ...meta, key, forceReview: meta.forceReview || uncertain, variants });
  };

  const fromAnswer = (f: FieldInfo, hit: BankHit, confidence: number, forceReview = false) =>
    plan(f, hit.answer.answer, {
      key: hit.answer.canonicalKey,
      source: 'answerBank',
      confidence,
      forceReview,
      answerId: hit.answer.id,
    });

  /** Tier 3: saved answers. Close-but-not-exact matches are confirmed by the classifier when it's available. */
  const fromBank = async (f: FieldInfo): Promise<Resolution | null> => {
    const hits = findAnswers(f, deps.answers, deps.host);
    const top = hits[0];
    // With a classifier, loosely similar questions are worth asking it about; without one, only close ones.
    if (!top || top.score < (classifier ? 0.35 : 0.6)) return null;
    if (top.score >= 0.9) return fromAnswer(f, top, top.score);
    const picked = await ask((c) => pickSavedQuestion(f, hits, c));
    if (picked) {
      if (picked.value !== null && picked.confidence >= review) {
        return fromAnswer(f, hits[picked.value], Math.min(picked.confidence, hits[picked.value].score + 0.1));
      }
      return null;
    }
    return top.score >= 0.75 ? fromAnswer(f, top, top.score, true) : null;
  };

  const results = new Map<string, Resolution>();
  const leftovers: FieldInfo[] = [];

  /** A multi-choice prompt that already holds some pills (skills Workday guessed from the resume) still gets the rest of a list. */
  const addsToList = (f: FieldInfo) => {
    if (f.kind !== 'combobox' || !f.multiple) return false;
    const key = matchRules(f)?.key;
    return !!key && FIELD_KEY_MAP[key]?.valueType === 'list';
  };

  /**
   * A field that already has a value. Sites that read the uploaded resume fill fields themselves,
   * often wrongly: where the profile has a different answer and the user hasn't touched the field,
   * the profile's answer replaces the site's, for review. Repeating entries still count, so the
   * next empty "Work Experience" block gets the next job, not the first one again.
   */
  const prefilled = async (f: FieldInfo): Promise<Resolution> => {
    const keep: Resolution = { fieldId: f.id, source: 'none', confidence: 1, status: 'prefilled' };
    const rule = matchRules(f);
    if (!rule) return keep;
    const def = FIELD_KEY_MAP[rule.key];
    const correctable =
      settings.fixSiteValues && !f.touched && f.current !== undefined && SITE_FILLED.includes(def.category) && (def.valueType === 'text' || def.valueType === 'date');
    if (!correctable) {
      if (def.repeat) nextIndex(rule.key);
      return { ...keep, key: rule.key };
    }
    const index = counters.get(rule.key) ?? 0;
    const r = await fromKey(f, rule.key, { source: 'rule', confidence: 1, forceReview: true });
    if (!r || r.value === undefined || r.status === 'needs' || r.status === 'skipped') {
      // An entry beyond the profile's jobs or schools came from the site, not the user's profile.
      const entries = def.category === 'experience' ? profile.experience.length : profile.education.length;
      if (ENTRY_NAMES.includes(rule.key) && index >= entries) {
        return { ...keep, key: rule.key, status: 'review', note: 'This entry isn’t in your profile; the site may have added it from your resume. Delete it if it’s wrong' };
      }
      return { ...keep, key: rule.key };
    }
    if (agrees(f.current!, r.value)) return { ...keep, key: rule.key };
    return { ...r, status: 'review', note: `Replaced “${truncate(f.current!, 80)}”, which the site filled in, with your profile` };
  };

  // Tiers 2–3: rules, then the answer bank.
  for (const f of fields) {
    if (f.hasValue && !settings.overwriteFilled && !addsToList(f)) {
      results.set(f.id, await prefilled(f));
      continue;
    }
    const rule = matchRules(f);
    if (rule) {
      const confidence = rule.via === 'attr' || rule.via === 'type' ? 0.9 : 1;
      const r = await fromKey(f, rule.key, { source: 'rule', confidence });
      if (r) {
        results.set(f.id, r);
        continue;
      }
      const saved = await fromBank(f);
      const def = FIELD_KEY_MAP[rule.key];
      results.set(f.id, saved ?? unresolved(f, rule.key, `Your profile has no “${def.title}” yet. Answer here, or add it on the Profile tab.`));
      continue;
    }
    const saved = await fromBank(f);
    if (saved) results.set(f.id, saved);
    else leftovers.push(f);
  }

  // Tier 4: the classifier, for fields neither rules nor saved answers recognized.
  const groups = leftovers.length ? await ask((c) => classifyGroups(leftovers, c)) : null;
  for (let i = 0; i < leftovers.length; i++) {
    const f = leftovers[i];
    const group = groups?.[i];
    if (!group) {
      results.set(f.id, unresolved(f));
      continue;
    }
    const likely = likelyGroups(group);
    const ranked = (await ask((c) => rankKeys(f, likely, c))) ?? [];
    const [best, second] = ranked;
    if (best && best.p >= review && best.p - (second?.p ?? 0) >= KEY_MARGIN) {
      const r = await fromKey(f, best.key, { source: 'classifier', confidence: best.p, forceReview: best.p < auto });
      if (r) {
        results.set(f.id, r);
        continue;
      }
    }
    if (DERIVABLE.includes(likely[0]) && isYesNoField(f)) {
      const p = await ask((c) => deriveYesNo(f, profileFacts(profile), c));
      if (p !== null && (p >= 0.85 || p <= 0.15)) {
        const yes = p >= 0.5;
        const confidence = yes ? p : 1 - p;
        // Answers inferred from the profile are always shown for review, never filled silently.
        const r = await plan(f, yes, { source: 'classifier', confidence, forceReview: true });
        results.set(f.id, { ...r, note: `Inferred from your profile (${Math.round(confidence * 100)}% sure)` });
        continue;
      }
    }
    const personal = group.value === 'other' && (f.kind === 'textarea' || f.kind === 'text');
    results.set(f.id, unresolved(f, undefined, personal ? 'Needs a personal answer' : undefined));
  }

  return fields.map((f) => results.get(f.id)!);
}
