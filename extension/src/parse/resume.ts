import { canonicalCountry, canonicalRegion } from '../core/geo';
import { cleanText, normalize } from '../core/normalize';
import {
  type Education,
  emptyEducation,
  emptyExperience,
  emptyProject,
  type Experience,
  type Links,
  type Profile,
  type Project,
} from '../core/profile';
import { findDateRange, findSingleDate } from './dates';

/**
 * Heuristic resume parser: lines (with font size/bold when known) → sections
 * → entries → profile fields. It aims to get most of the way and leaves the
 * rest to the review screen; nothing here is final until the user saves it.
 */

export interface TextLine {
  text: string;
  /** Font size in points (PDF) or a relative size (DOCX headings); 0 when unknown. */
  size: number;
  bold: boolean;
  /** Came from a list item or starts with a bullet glyph. */
  bullet: boolean;
  /** PDF only: width in points, and the space between this line and the one above it (unset at the top of a page). */
  width?: number;
  gap?: number;
  /** PDF only: the column of LinkedIn's "Save to PDF" layout (sidebar or main). */
  column?: 'side' | 'main';
}

export type SectionType =
  | 'summary'
  | 'experience'
  | 'education'
  | 'projects'
  | 'skills'
  | 'certifications'
  | 'languages'
  | 'links'
  | 'other';

export const SECTION_TYPES: SectionType[] = ['summary', 'experience', 'education', 'projects', 'skills', 'certifications', 'languages', 'links', 'other'];

const SECTION_NAMES: [SectionType, RegExp][] = [
  ['summary', /^(professional |career |executive )?(summary|profile|objective|about( me)?|overview)$/],
  ['experience', /^(professional |work |relevant |employment |career |industry )?(experience|history|employment)( history)?$|^work$|^employment$|^positions?( held)?$/],
  ['education', /^(education|academic background|academics|education (and|&) training|academic history)$/],
  ['projects', /^(personal |academic |selected |technical |side |key )?projects?$|^portfolio$/],
  ['skills', /^(technical |core |key |relevant )?(skills|competencies|technologies|tech stack|toolkit|expertise)( (and|&) (interests|tools|technologies|abilities))?$|^skills summary$/],
  ['certifications', /^(certifications?|licen[sc]es?( (and|&) certifications?)?|certifications? (and|&) licen[sc]es?|courses|training)$/],
  ['languages', /^(spoken )?languages?$/],
  ['links', /^(links|online presence|profiles|social)$/],
  ['other', /^(awards?|honou?rs?|honou?rs (and|&) awards|awards (and|&) honou?rs|achievements|publications|volunteer(ing)?( experience)?|leadership( experience)?|activities|extracurricular( activities)?|interests|hobbies|references|affiliations|memberships)$/],
];

export function sectionTypeOf(heading: string): SectionType | null {
  const n = normalize(heading).replace(/ \/ /g, ' & ').replace(/:$/, '');
  for (const [type, re] of SECTION_NAMES) if (re.test(n)) return type;
  return null;
}

const BULLET_RE = /^\s*[•●▪◦‣∙·○■□➢►▶✓✔\-–*]\s+/;
export const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)+(?:com|io|dev|me|net|org|co|ai|app|xyz|tech|site|page|ca|uk|in)(?:\/[^\s|,•]*)?/gi;
const TITLE_WORDS =
  /\b(engineer|developer|manager|intern|internship|analyst|designer|scientist|lead|director|consultant|specialist|associate|assistant|coordinator|administrator|architect|officer|technician|researcher|representative|founder|co-founder|head|vp|president|teacher|tutor|programmer|accountant|editor|writer|nurse|advisor|strategist|owner|fellow|instructor|supervisor|clerk|cashier|agent|mentor|volunteer|trainee|apprentice|sde|swe)\b/i;
const SCHOOL_WORDS = /\b(university|college|institute|school|academy|polytechnic|universit[éa]|conservatory|seminary)\b/i;
export const DEGREE_RE =
  /\b(bachelor(?:'s)?|master(?:'s)?|doctor(?:ate)?|ph\.?\s?d\.?|mba|b\.?\s?(?:sc|s|a|eng|tech|comm?)\.?|m\.?\s?(?:sc|s|a|eng|tech)\.?|associate(?:'s)?|diploma|certificate|high school|ged|a\.?a\.?s?\.?|hons?\.?|honours|honors)\b/i;

export function isBulletText(t: string): boolean {
  return BULLET_RE.test(t);
}

export function stripBullet(t: string): string {
  return cleanText(t.replace(BULLET_RE, ''));
}

function median(values: number[]): number {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

/** Split "Toronto, ON | me@x.com | (555) 123-4567" into its parts. */
function splitParts(line: string): string[] {
  return line
    .split(/\s*(?:\||•|·|♦|◆|⋄|—|\s–\s|\s-\s|\t|\s{3,})\s*/)
    .map(cleanText)
    .filter(Boolean);
}

function looksLikeHeading(line: TextLine, bodySize: number): boolean {
  const t = line.text.trim();
  if (!t || t.length > 40 || line.bullet || /[@\d]/.test(t) || /[.;]$/.test(t)) return false;
  if (t.split(/\s+/).length > 5) return false;
  if (sectionTypeOf(t)) return true;
  const letters = t.replace(/[^A-Za-z]/g, '');
  const allCaps = letters.length >= 3 && letters === letters.toUpperCase();
  const bigger = bodySize > 0 && line.size > bodySize * 1.15;
  return allCaps && (line.bold || bigger || line.size === 0);
}

export interface RawSection {
  heading: string;
  type: SectionType | null;
  lines: TextLine[];
}

export function splitSections(lines: TextLine[]): { header: TextLine[]; sections: RawSection[] } {
  const body = median(lines.filter((l) => l.text.length > 20).map((l) => l.size));
  const header: TextLine[] = [];
  const sections: RawSection[] = [];
  for (const line of lines) {
    // The first line is the applicant's name (often in capitals), never a section heading.
    const first = !header.length && !sections.length;
    if (looksLikeHeading(line, body) && (!first || sectionTypeOf(line.text))) {
      sections.push({ heading: cleanText(line.text.replace(/:$/, '')), type: sectionTypeOf(line.text), lines: [] });
    } else if (sections.length) {
      sections[sections.length - 1].lines.push(line);
    } else {
      header.push(line);
    }
  }
  return { header, sections };
}

// ── contact block ───────────────────────────────────────────────────────

export function classifyUrl(raw: string, links: Links): void {
  const url = raw.replace(/[).,;]+$/, '');
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  if (/linkedin\.com/i.test(url)) links.linkedin ||= full;
  else if (/github\.com/i.test(url)) links.github ||= full;
  else if (!links.portfolio) links.portfolio = full;
  else if (!links.website && links.portfolio !== full) links.website = full;
}

export function parseLocation(part: string): { city: string; region: string; country: string } | null {
  const m = /^([A-Za-zÀ-ÿ.' -]{2,40}),\s*([A-Za-zÀ-ÿ. ]{2,40})(?:,\s*([A-Za-zÀ-ÿ. ]{2,40}))?$/.exec(part.trim());
  if (!m) return null;
  const region = canonicalRegion(m[2]);
  const country = canonicalCountry(m[3] ?? '') ?? (region ? null : canonicalCountry(m[2]));
  if (!region && !country) return null;
  const inferred = region ? (/^(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/i.test(m[2].trim()) || /alberta|british columbia|manitoba|brunswick|newfoundland|nova scotia|ontario|quebec|saskatchewan|yukon|nunavut|prince edward/i.test(m[2]) ? 'Canada' : 'United States') : '';
  return { city: cleanText(m[1]), region: region ? m[2].trim() : '', country: country ?? inferred };
}

function looksLikeName(t: string): boolean {
  const words = t.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 4 && /^[A-Za-zÀ-ÿ.'’ -]+$/.test(t) && !sectionTypeOf(t);
}

export function parseContact(header: TextLine[], allText: string, profile: Profile): void {
  const p = profile.personal;
  // The name is usually the biggest text near the top.
  const candidates = header.slice(0, 5).filter((l) => looksLikeName(l.text));
  const nameLine = candidates.sort((a, b) => b.size - a.size)[0];
  if (nameLine) {
    const words = cleanText(nameLine.text).split(' ');
    const cap = (w: string) => (w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w);
    p.firstName = cap(words[0]);
    p.lastName = words.slice(1).map(cap).join(' ');
  }
  const email = EMAIL_RE.exec(allText);
  if (email) p.email = email[0];
  for (const line of header) {
    for (const part of splitParts(line.text)) {
      if (!p.phone && !EMAIL_RE.test(part)) {
        const ph = PHONE_RE.exec(part);
        if (ph && ph[0].replace(/\D/g, '').length >= 10) p.phone = cleanText(ph[0]);
      }
      const loc = parseLocation(part);
      if (loc && !p.address.city) {
        p.address.city = loc.city;
        p.address.region = loc.region;
        p.address.country = loc.country;
      }
    }
  }
  const textForUrls = allText.replace(EMAIL_RE, ' ');
  for (const m of textForUrls.matchAll(URL_RE)) {
    if (/linkedin|github/i.test(m[0]) || header.some((l) => l.text.includes(m[0]))) classifyUrl(m[0], profile.links);
  }
}

// ── entries (experience / education / projects) ─────────────────────────

interface Block {
  head: string[];
  bullets: string[];
}

/** Group a section's lines into entries: header lines followed by their bullets. */
export function blocksOf(lines: TextLine[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let lastWasBullet = false;
  for (const line of lines) {
    const t = cleanText(line.text);
    if (!t) continue;
    const bullet = line.bullet || isBulletText(t);
    if (bullet) {
      if (!cur) cur = { head: [], bullets: [] };
      if (!blocks.includes(cur)) blocks.push(cur);
      cur.bullets.push(stripBullet(t));
      lastWasBullet = true;
      continue;
    }
    // A non-bullet line right after a bullet is either a wrapped bullet or the next entry's header.
    const continuation =
      lastWasBullet && cur && !findDateRange(t) && (/^[a-z(]/.test(t) || (t.length > 60 && !line.bold));
    if (continuation) {
      cur!.bullets[cur!.bullets.length - 1] += ` ${t}`;
      continue;
    }
    if (!cur || lastWasBullet) {
      cur = { head: [], bullets: [] };
      blocks.push(cur);
    }
    // Header lines that run long and have no date are usually descriptions written as prose.
    if (cur.head.length >= 3 && !findDateRange(t)) cur.bullets.push(t);
    else cur.head.push(t);
    lastWasBullet = false;
  }
  return blocks.filter((b) => b.head.length || b.bullets.length);
}

/** If a section has no bullets at all, every date line starts a new entry. */
function splitByDates(lines: TextLine[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const line of lines) {
    const t = cleanText(line.text);
    if (!t) continue;
    if (!cur || (findDateRange(t) && cur.head.some((h) => findDateRange(h))) || (findDateRange(t) && cur.bullets.length)) {
      cur = { head: [], bullets: [] };
      blocks.push(cur);
    }
    if (cur.head.length < 3 && (findDateRange(t) || t.length < 70)) cur.head.push(t);
    else cur.bullets.push(t);
  }
  return blocks;
}

function entryBlocks(lines: TextLine[]): Block[] {
  const hasBullets = lines.some((l) => l.bullet || isBulletText(l.text));
  return hasBullets ? blocksOf(lines) : splitByDates(lines);
}

const LOCATION_PART = /^(remote|hybrid|on-?site)$|^[A-Za-zÀ-ÿ.' -]{2,40},\s*[A-Za-zÀ-ÿ. ]{2,40}$/i;

function headParts(head: string[]): { parts: string[]; dates: ReturnType<typeof findDateRange>; location: string } {
  let dates: ReturnType<typeof findDateRange> = null;
  let location = '';
  const parts: string[] = [];
  for (const raw of head) {
    let line = raw;
    const d = findDateRange(line);
    if (d && !dates) {
      dates = d;
      line = line.replace(d.raw, ' ');
    }
    for (let part of line.split(/\s*(?:\||•|·|—|–|\s-\s|\t|\s{3,})\s*/)) {
      part = cleanText(part.replace(/^[,;:]+|[,;:]+$/g, ''));
      if (!part) continue;
      if (!location && (LOCATION_PART.test(part) && (parseLocation(part) || /^(remote|hybrid|on-?site)$/i.test(part)))) {
        location = part;
        continue;
      }
      // "Software Engineer at Google" / "Google, Software Engineer"
      // Only when the left side is a job title, so "University of Texas at Austin" stays whole.
      const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(part);
      if (at && TITLE_WORDS.test(at[1]) && !SCHOOL_WORDS.test(part)) parts.push(at[1], at[2]);
      else if (part.includes(', ') && !SCHOOL_WORDS.test(part) && part.split(', ').length === 2 && TITLE_WORDS.test(part)) {
        parts.push(...part.split(', '));
      } else parts.push(part);
    }
  }
  return { parts, dates, location };
}

export function parseExperience(lines: TextLine[]): Experience[] {
  const out: Experience[] = [];
  for (const b of entryBlocks(lines)) {
    const { parts, dates, location } = headParts(b.head);
    if (!parts.length && !b.bullets.length) continue;
    const e = emptyExperience();
    const titleIdx = parts.findIndex((p) => TITLE_WORDS.test(p));
    if (titleIdx >= 0) {
      e.title = parts[titleIdx];
      e.company = parts.find((_, i) => i !== titleIdx) ?? '';
    } else {
      e.company = parts[0] ?? '';
      e.title = parts[1] ?? '';
    }
    e.location = location;
    if (dates) {
      e.start = dates.start;
      e.end = dates.end;
      e.current = dates.current;
    }
    e.bullets = b.bullets;
    // A block with no title, company or dates is a stray line; attach it to the previous entry.
    if (!e.company && !e.title && !dates && out.length) out[out.length - 1].bullets.push(...b.bullets, ...parts);
    else out.push(e);
  }
  return out;
}

/** "GPA: 3.8/4.0" → "3.8/4.0"; "" when the text has none. */
export function findGpa(text: string): string {
  const gpa = /\b(?:c?gpa|grade point average)\s*[:\-]?\s*(\d(?:\.\d{1,2})?)(\s*\/\s*\d(?:\.\d+)?)?/i.exec(text);
  return gpa ? gpa[1] + (gpa[2] ? gpa[2].replace(/\s/g, '') : '') : '';
}

export function parseEducation(lines: TextLine[]): Education[] {
  const out: Education[] = [];
  for (const b of entryBlocks(lines)) {
    const all = [...b.head, ...b.bullets];
    const ed = emptyEducation();
    const { parts, dates, location } = headParts(b.head);
    ed.location = location;
    if (dates) {
      ed.start = dates.start;
      ed.end = dates.current ? '' : dates.end;
    } else {
      for (const l of b.head) {
        const s = findSingleDate(l);
        if (s) {
          ed.end = s.date;
          break;
        }
      }
    }
    for (const p of parts) {
      const clean = p.replace(/\b(expected|anticipated|graduat(ed|ing|ion)?)\b.*$/i, '').trim();
      if (!ed.school && SCHOOL_WORDS.test(clean)) ed.school = clean;
      else if (!ed.degree && DEGREE_RE.test(clean)) {
        const m = /^(.*?)\s*(?:,|\bin\b|\bof\b(?=\s+[A-Z][a-z]+\s*$)|-)\s+(.+)$/i.exec(clean);
        if (m && DEGREE_RE.test(m[1]) && !DEGREE_RE.test(m[2])) {
          ed.degree = m[1].trim();
          ed.field = m[2].replace(/[,;]\s*(gpa|cgpa).*$/i, '').trim();
        } else ed.degree = clean.replace(/[,;]\s*(gpa|cgpa).*$/i, '').trim();
      }
    }
    for (const l of all) {
      if (!ed.gpa) ed.gpa = findGpa(l);
      const major = /\b(?:major|field of study|concentration)\s*[:\-]\s*([^|,;]+)/i.exec(l);
      if (major && !ed.field) ed.field = major[1].trim();
    }
    if (!ed.school && parts.length) ed.school = parts.find((p) => !DEGREE_RE.test(p)) ?? parts[0];
    if (ed.school || ed.degree) out.push(ed);
  }
  return out;
}

export function parseProjects(lines: TextLine[]): Project[] {
  const out: Project[] = [];
  for (const b of entryBlocks(lines)) {
    const pr = emptyProject();
    const { parts, dates } = headParts(b.head);
    if (dates) {
      pr.start = dates.start;
      pr.end = dates.end;
    }
    for (const p of parts) {
      const url = p.match(URL_RE)?.[0];
      if (url && !pr.url) {
        pr.url = /^https?:/i.test(url) ? url : `https://${url}`;
        const rest = cleanText(p.replace(url, ''));
        if (rest && !pr.name) pr.name = rest;
        continue;
      }
      const tech = /^(?:tech(?:nologies)?|stack|built with|tools)\s*:\s*(.+)$/i.exec(p) ?? /^\((.+)\)$/.exec(p);
      if (tech) pr.tech.push(...splitList(tech[1]));
      else if (!pr.name) {
        const paren = /^(.+?)\s*\(([^)]+)\)$/.exec(p);
        if (paren) {
          pr.name = paren[1];
          pr.tech.push(...splitList(paren[2]));
        } else pr.name = p;
      } else if (!pr.description) pr.description = p;
    }
    pr.bullets = b.bullets;
    if (pr.name || pr.bullets.length) out.push(pr);
  }
  return out;
}

export function splitList(text: string): string[] {
  return text
    .split(/\s*(?:,|;|\||•|·|\/(?=\s)|\s{2,})\s*/)
    .map((s) => cleanText(s.replace(/^and\s+/i, '').replace(/[.]$/, '')))
    .filter((s) => s && s.length <= 40);
}

export function parseSkills(lines: TextLine[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let t = stripBullet(line.text);
    // "Languages: Python, Java" → drop the category label.
    const labelled = /^([A-Za-z &/+-]{2,30}):\s*(.+)$/.exec(t);
    if (labelled) t = labelled[2];
    out.push(...splitList(t));
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── top level ───────────────────────────────────────────────────────────

export interface ParsedResume {
  profile: Pick<Profile, 'personal' | 'links' | 'summary' | 'experience' | 'education' | 'projects' | 'skills' | 'certifications' | 'languages'>;
  /** Sections whose heading wasn't recognized, for the review screen. */
  unknownSections: RawSection[];
  text: string;
}

/**
 * @param classifyHeading optional fallback (the Laya classifier) for headings
 *   the synonym list doesn't know.
 */
export async function parseResume(
  lines: TextLine[],
  base: Profile,
  classifyHeading?: (heading: string, sample: string) => Promise<SectionType | null>,
): Promise<ParsedResume> {
  const text = lines.map((l) => l.text).join('\n');
  const profile: ParsedResume['profile'] = {
    personal: structuredClone(base.personal),
    links: structuredClone(base.links),
    summary: '',
    experience: [],
    education: [],
    projects: [],
    skills: [],
    certifications: [],
    languages: [],
  };
  const { header, sections } = splitSections(lines);
  parseContact(header, text, profile as Profile);

  const unknown: RawSection[] = [];
  for (const s of sections) {
    let type = s.type;
    if (!type && classifyHeading) {
      const sample = s.lines.slice(0, 4).map((l) => l.text).join(' ');
      type = await classifyHeading(s.heading, sample).catch(() => null);
    }
    switch (type) {
      case 'summary':
        profile.summary = cleanText([profile.summary, ...s.lines.map((l) => stripBullet(l.text))].join(' '));
        break;
      case 'experience':
        profile.experience.push(...parseExperience(s.lines));
        break;
      case 'education':
        profile.education.push(...parseEducation(s.lines));
        break;
      case 'projects':
        profile.projects.push(...parseProjects(s.lines));
        break;
      case 'skills':
        profile.skills.push(...parseSkills(s.lines));
        break;
      case 'certifications':
        profile.certifications.push(...s.lines.map((l) => stripBullet(l.text)).filter(Boolean));
        break;
      case 'languages':
        profile.languages.push(...parseSkills(s.lines));
        break;
      case 'links':
        for (const l of s.lines) for (const m of l.text.matchAll(URL_RE)) classifyUrl(m[0], profile.links);
        break;
      default:
        unknown.push({ ...s, type });
    }
  }
  return { profile, unknownSections: unknown, text };
}

/** Plain text (or text without layout info) → lines. */
export function linesFromText(text: string): TextLine[] {
  return text
    .split(/\r?\n/)
    .map((t) => ({ text: t.trimEnd(), size: 0, bold: false, bullet: isBulletText(t) }))
    .filter((l) => l.text.trim());
}
