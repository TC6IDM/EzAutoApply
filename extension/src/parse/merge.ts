import { normalize } from '../core/normalize';
import type { Education, Experience, Profile, Project } from '../core/profile';
import type { ParsedResume } from './resume';

/** What a resume or LinkedIn import produces, before it's merged into the profile. */
export type ParsedProfile = ParsedResume['profile'];

/**
 * - `replace`: imported values win wherever the import has them.
 * - `fillEmpty`: only empty fields and empty lists are filled.
 * - `combine`: like `fillEmpty`, and jobs, schools and projects the profile doesn't
 *   have yet are added, the ones it has get their empty fields filled in, and
 *   skills, certifications and languages gain any new entries.
 */
export type MergeMode = 'replace' | 'fillEmpty' | 'combine';

const isEmpty = (v: unknown) => v === '' || (Array.isArray(v) && !v.length);

/** Same text, or one contains the other ("Acme" / "Acme Corp"). */
function sameText(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
}

/** Two dates name the same month, or the same year when either has no month. */
function sameDate(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || ((a.length === 4 || b.length === 4) && a.slice(0, 4) === b.slice(0, 4));
}

const sameJob = (a: Experience, b: Experience) => sameText(a.company, b.company) && (sameText(a.title, b.title) || sameDate(a.start, b.start));

const sameSchool = (a: Education, b: Education) =>
  sameText(a.school, b.school) && (!a.degree || !b.degree || sameText(a.degree, b.degree) || sameDate(a.end, b.end));

const sameProject = (a: Project, b: Project) => sameText(a.name, b.name);

/** Copy the source's values into the target's empty fields. */
function fillEntry<T extends { id: string }>(target: T, source: T): void {
  for (const k of Object.keys(source) as (keyof T)[]) {
    if (k !== 'id' && isEmpty(target[k]) && !isEmpty(source[k])) target[k] = source[k];
  }
}

/** Add imported entries the list doesn't have; fill in the ones it does. `adjust` can change what a match takes. */
function combineEntries<T extends { id: string }>(current: T[], imported: T[], same: (a: T, b: T) => boolean, adjust?: (target: T, source: T) => T): T[] {
  const out = current.map((e) => structuredClone(e));
  for (const entry of imported) {
    const match = out.find((e) => same(e, entry));
    if (match) fillEntry(match, adjust ? adjust(match, entry) : entry);
    else out.push(structuredClone(entry));
  }
  return out;
}

function union(a: string[], b: string[]): string[] {
  const seen = new Set(a.map(normalize));
  const out = [...a];
  for (const v of b) {
    const k = normalize(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** Merge imported data into the profile. Nothing is saved until the user saves the profile. */
export function mergeParsed(current: Profile, parsed: ParsedProfile, mode: MergeMode): Profile {
  const next = structuredClone(current);
  const pick = (a: string, b: string) => (mode === 'replace' ? b || a : a || b);
  const pp = parsed.personal;
  next.personal.firstName = pick(next.personal.firstName, pp.firstName);
  next.personal.lastName = pick(next.personal.lastName, pp.lastName);
  next.personal.email = pick(next.personal.email, pp.email);
  next.personal.phone = pick(next.personal.phone, pp.phone);
  for (const k of ['line1', 'city', 'region', 'postalCode', 'country'] as const) {
    next.personal.address[k] = pick(next.personal.address[k], pp.address[k]);
  }
  for (const k of ['linkedin', 'github', 'portfolio', 'website'] as const) next.links[k] = pick(next.links[k], parsed.links[k]);
  next.summary = pick(next.summary, parsed.summary);
  if (mode === 'combine') {
    next.experience = combineEntries(next.experience, parsed.experience, sameJob, (t, s) => {
      // A job without dates takes the imported ones, including whether it's current.
      if (!t.start && !t.end) t.current = s.current;
      // A current job never gains an end date.
      return t.current ? { ...s, end: '' } : s;
    });
    next.education = combineEntries(next.education, parsed.education, sameSchool);
    next.projects = combineEntries(next.projects, parsed.projects, sameProject);
    next.skills = union(next.skills, parsed.skills);
    next.certifications = union(next.certifications, parsed.certifications);
    next.languages = union(next.languages, parsed.languages);
    return next;
  }
  const list = <T,>(a: T[], b: T[]) => (mode === 'replace' ? (b.length ? b : a) : a.length ? a : b);
  next.experience = list(next.experience, parsed.experience);
  next.education = list(next.education, parsed.education);
  next.projects = list(next.projects, parsed.projects);
  next.skills = list(next.skills, parsed.skills);
  next.certifications = list(next.certifications, parsed.certifications);
  next.languages = list(next.languages, parsed.languages);
  return next;
}
