import { profileFacts } from '../core/facts';
import { FIELD_KEY_MAP, isUncertain } from '../core/fieldKeys';
import { boolOf, matchBoolOption, matchOption } from '../core/options';
import type { Profile } from '../core/profile';
import { type FieldValue, isFileRef, type SavedAnswer, type Settings } from '../core/types';
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

export function valueText(v: FieldValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  if (isFileRef(v)) return `[${v.fileKind}]`;
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
    status: f.required ? 'needs' : 'skipped',
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
    if (isFileRef(value)) return base;

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

  // Tiers 2–3: rules, then the answer bank.
  for (const f of fields) {
    if (f.hasValue && !settings.overwriteFilled) {
      results.set(f.id, { fieldId: f.id, source: 'none', confidence: 1, status: 'prefilled' });
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
      results.set(f.id, saved ?? unresolved(f, rule.key, `Add your ${def.title.toLowerCase()} to your profile, or answer here`));
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
