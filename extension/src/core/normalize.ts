/** Text normalization and similarity helpers shared by the matcher, answer bank and parser. */

/** Split identifiers like `firstName`, `first_name`, `job[first-name]` into words. */
export function splitIdentifier(s: string): string {
  return (s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.[\]/:]+/g, ' ');
}

/**
 * Canonical form of a question or label: lowercase, no diacritics, no
 * "required"/"optional" markers, punctuation collapsed to single spaces.
 */
export function normalize(s: string): string {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\((?:required|optional)\)|\*+/g, ' ')
    .replace(/[^a-z0-9'+#%$&/ ]+/g, ' ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/'(?![a-z])|(?<![a-z])'/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collapse whitespace without changing case; used for display text pulled from the DOM. */
export function cleanText(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set(
  'a an and are as at be been by can do does for from have has i if in into is it its me my of on or our please select that the this to was we were what when where which will with you your yours'.split(
    ' ',
  ),
);

export function contentTokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
}

/** Jaccard similarity of content-word sets. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(contentTokens(a));
  const tb = new Set(contentTokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const t = normalize(s).replace(/ /g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice coefficient over character bigrams; tolerant of typos and word order. */
export function diceSimilarity(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  let total = 0;
  for (const v of ga.values()) total += v;
  for (const v of gb.values()) total += v;
  if (!total) return 0;
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / total;
}

/** Combined similarity used to compare questions: rewards both shared words and shared spelling. */
export function questionSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return Math.max(tokenSimilarity(na, nb), 0.9 * diceSimilarity(na, nb));
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
