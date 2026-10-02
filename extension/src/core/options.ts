import { canonicalCountry, canonicalRegion } from './geo';
import { diceSimilarity, normalize } from './normalize';

/**
 * Deterministic matching of a desired value onto a field's options
 * (select options, radio labels, combobox entries). The classifier is only
 * consulted when this returns nothing.
 */

export interface OptionLike {
  label: string;
  value: string;
}

export interface OptionMatch {
  index: number;
  score: number;
}

const PLACEHOLDER = /^(select|choose|please (select|choose)|pick|none selected|--+|select one|select an option|make a selection)\b/;

export function isPlaceholderOption(o: OptionLike): boolean {
  const n = normalize(o.label);
  return n === '' || PLACEHOLDER.test(n) || (o.value === '' && /select|choose/.test(n));
}

const NO = /^(no|n|false|nope|i am not|im not|i'm not|i do not|i don't|i dont|i have not|i haven't|i havent|i will not|i won't|i wont|i cannot|i can't|i cant|i would not|i wouldn't|not|none|disagree|i disagree|i decline)\b/;
const YES = /^(yes|y|true|i am|im|i'm|i do|i have|i will|i can|i would|i agree|i acknowledge|i accept|i consent|i certify|i confirm|agree|accept|acknowledge|correct|confirmed)\b/;

/** Interpret an option label (or a stored answer) as yes/no, or null when it's neither. */
export function boolOf(text: string): boolean | null {
  const n = normalize(text);
  if (!n || conceptOf(n) === 'decline') return null;
  if (NO.test(n)) return false;
  if (YES.test(n)) return true;
  return null;
}

/**
 * Concept groups for answers that are phrased many ways. Order matters:
 * negative phrasings are tested before the positive phrase they contain.
 */
const CONCEPTS: [string, RegExp][] = [
  ['decline', /\b(decline|prefer not|do not wish|don't wish|dont wish|choose not|not to (say|answer|disclose|self identify|identify)|rather not|wish not to|not wish to|i don't want to|undisclosed|not declared)\b/],
  ['veteran_no', /\b(not a (protected )?veteran|am not a (protected )?veteran|not (a )?protected veteran|not identify as (a|one or more of the classifications of)( a)? protected veteran|non veteran|never served)\b/],
  ['veteran_yes', /\b(identify as (one or more of the classifications of )?(a )?protected veteran|am a (protected )?veteran|protected veteran|veteran)\b/],
  ['disability_no', /\b(do not have a disability|don't have a disability|dont have a disability|no disability|not disabled|have not had one)\b/],
  ['disability_yes', /\b(have a disability|have had a disability|disabled)\b/],
  ['nonbinary', /\b(non ?binary|genderqueer|gender non ?conforming|gender fluid|genderfluid)\b/],
  ['female', /^(female|woman|f|cis ?female|cisgender woman|women)$|\b(female|woman)\b/],
  ['male', /^(male|man|m|cis ?male|cisgender man|men)$|\b(male|man)\b/],
  ['two_or_more', /\b(two or more|multiracial|multi racial|mixed race|more than one race)\b/],
  ['hispanic', /\b(hispanic|latino|latina|latinx|latine)\b/],
  ['black', /\b(black|african american)\b/],
  ['asian', /\basian\b/],
  ['white', /\b(white|caucasian)\b/],
  ['native_american', /\b(american indian|alaska native|native american|indigenous)\b/],
  ['pacific_islander', /\b(native hawaiian|pacific islander)\b/],
  ['mobile', /\b(mobile|cell|cellular)\b/],
];

export function conceptOf(text: string): string | null {
  const n = normalize(text);
  if (!n) return null;
  for (const [id, re] of CONCEPTS) if (re.test(n)) return id;
  return null;
}

const DEGREES: [string, RegExp][] = [
  ['doctorate', /\b(doctor(ate|al)?|ph ?d|dphil|ed ?d|md|jd|d sc)\b/],
  ['mba', /\b(mba|master of business administration)\b/],
  ['master', /\b(master'?s?|m ?s|m ?sc|m ?a|m ?eng|m ?tech|meng|msc|ms|graduate degree)\b/],
  ['bachelor', /\b(bachelor'?s?|b ?s|b ?sc|b ?a|b ?eng|b ?tech|b ?comm?|bsc|bs|ba|beng|undergraduate degree|4 year degree|four year degree)\b/],
  ['associate', /\b(associate'?s?|a ?a ?s|a ?s|a ?a|2 year degree|two year degree)\b/],
  ['high_school', /\b(high school|secondary school|ged|hs diploma)\b/],
];

export function degreeLevel(text: string): string | null {
  const n = normalize(text);
  for (const [id, re] of DEGREES) if (re.test(n)) return id;
  return null;
}

interface Range {
  lo: number;
  hi: number;
}

/** Parse "1-3 years", "5+", "10 or more", "less than 1", "$80,000 - $100,000" into a numeric range. */
export function parseRange(text: string): Range | null {
  // normalize() would drop the dash in "3-5", so this keeps its own light cleanup.
  const t = text
    .toLowerCase()
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_, d) => String(Number(d) * 1000))
    .replace(/\s+/g, ' ')
    .trim();
  let m = /(\d+(?:\.\d+)?) ?(?:-|to|–) ?\$?(\d+(?:\.\d+)?)/.exec(t);
  if (m) return { lo: Number(m[1]), hi: Number(m[2]) };
  m = /(\d+(?:\.\d+)?) ?(?:\+|or more|and (?:above|over|up)|plus)/.exec(t) ?? /(?:more than|over|at least|above) \$?(\d+(?:\.\d+)?)/.exec(t);
  if (m) return { lo: Number(m[1]), hi: Infinity };
  m = /(?:less than|under|fewer than|below|up to) \$?(\d+(?:\.\d+)?)/.exec(t);
  if (m) return { lo: -Infinity, hi: Number(m[1]) };
  m = /^\$?(\d+(?:\.\d+)?)$/.exec(t.replace(/ ?years?$/, ''));
  if (m) return { lo: Number(m[1]), hi: Number(m[1]) };
  return null;
}

function numberOf(value: string): number | null {
  const m = /^\$?\s*(\d+(?:\.\d+)?)\s*(k)?/i.exec(value.trim().replace(/,/g, ''));
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

function wordContains(hay: string, needle: string): boolean {
  return needle.length > 0 && ` ${hay} `.includes(` ${needle} `);
}

/** Score how well one option label represents the desired text value (0–1). */
export function scoreOption(label: string, want: string): number {
  const a = normalize(label);
  const b = normalize(want);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const ca = canonicalCountry(label);
  if (ca && ca === canonicalCountry(want)) return 0.97;
  const ra = canonicalRegion(label);
  if (ra && ra === canonicalRegion(want)) return 0.97;

  const conceptA = conceptOf(a);
  if (conceptA && conceptA === conceptOf(b)) return 0.95;

  const da = degreeLevel(a);
  if (da && da === degreeLevel(b)) return 0.9;

  const n = numberOf(want);
  if (n !== null && /^\$?\s*[\d,.]+\s*k?\s*(years?)?$/i.test(want.trim())) {
    const r = parseRange(label);
    if (r && n >= r.lo && n <= r.hi) return 0.9;
  }

  // Countries embedded in longer labels, e.g. "United States of America (+1)".
  if (canonicalCountry(want) && ca === null) {
    const stripped = a.replace(/\+?\d+/g, '').trim();
    if (canonicalCountry(stripped) === canonicalCountry(want)) return 0.95;
  }

  if (a.startsWith(b + ' ') || b.startsWith(a + ' ')) return 0.85;
  if (wordContains(a, b) || wordContains(b, a)) return 0.8;

  const dice = diceSimilarity(a, b);
  return dice >= 0.75 ? dice * 0.9 : 0;
}

/** Best option for a text value. Placeholder options are never chosen. */
export function matchTextOption(options: OptionLike[], want: string, minScore = 0.6): OptionMatch | null {
  let best: OptionMatch | null = null;
  options.forEach((o, index) => {
    if (isPlaceholderOption(o)) return;
    const score = Math.max(scoreOption(o.label, want), o.value && o.value !== o.label ? scoreOption(o.value, want) * 0.95 : 0);
    if (score >= minScore && (!best || score > best.score)) best = { index, score };
  });
  return best;
}

export function matchBoolOption(options: OptionLike[], want: boolean): OptionMatch | null {
  const hits = options
    .map((o, index) => ({ index, b: isPlaceholderOption(o) ? null : boolOf(o.label) }))
    .filter((x) => x.b === want);
  if (!hits.length) return null;
  // Exactly one yes/no option is unambiguous; several (e.g. "Yes, citizen" / "Yes, visa") need review.
  return { index: hits[0].index, score: hits.length === 1 ? 0.97 : 0.7 };
}

/**
 * Best option for a value. Text values try each phrasing in `variants` too;
 * a value that reads as yes/no ("No, I do not have a disability") falls back
 * to the Yes/No options when no option matches its wording.
 */
export function matchOption(options: OptionLike[], want: string | boolean, variants: string[] = []): OptionMatch | null {
  if (typeof want === 'boolean') return matchBoolOption(options, want);
  let best: OptionMatch | null = null;
  for (const v of [want, ...variants]) {
    const m = matchTextOption(options, v);
    if (m && (!best || m.score > best.score)) best = m;
  }
  if (best && best.score >= 0.8) return best;
  const b = boolOf(want);
  const bool = b === null ? null : matchBoolOption(options, b);
  if (bool && (!best || bool.score > best.score)) return bool;
  return best;
}
