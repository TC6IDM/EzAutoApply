import { strFromU8, unzipSync } from 'fflate';
import { canonicalCountry } from '../core/geo';
import { cleanText } from '../core/normalize';
import { type Education, emptyEducation, emptyExperience, emptyProject, type Experience, type Profile } from '../core/profile';
import { findDateRange, findSingleDate, toYm } from './dates';
import type { ParsedProfile } from './merge';
import { classifyUrl, DEGREE_RE, EMAIL_RE, findGpa, isBulletText, parseLocation, stripBullet, type TextLine } from './resume';

/**
 * LinkedIn profile imports, in either of the two forms LinkedIn hands out:
 *
 * - The data export (Settings → Data privacy → Get a copy of your data): a ZIP
 *   of CSV files (Profile.csv, Positions.csv, Education.csv, Skills.csv, …)
 *   whose columns map straight onto profile fields.
 * - "Save to PDF" on a profile: a fixed layout with a sidebar (contact, top
 *   skills, languages, certifications) beside the main column (name, summary,
 *   experience, education). `extract.ts` reads the two columns apart; the parts
 *   of an entry are told apart by font size (company 12pt, title 11.5pt, dates
 *   and descriptions 10.5pt).
 *
 * Like resume parsing, everything lands on the review screen before it's saved.
 */

export interface LinkedInImport {
  profile: ParsedProfile;
  /** LinkedIn data the profile has no place for, e.g. "Recommendations (3)". */
  notImported: string[];
}

function emptyParsed(base: Profile): ParsedProfile {
  return {
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
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map(cleanText)
    .filter((v) => {
      const k = v.toLowerCase();
      if (!v || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

const withScheme = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

/** "Bachelor of Science - BS, Computer Science" → Bachelor of Science / Computer Science. */
export function splitDegree(text: string): { degree: string; field: string } {
  const t = cleanText(text);
  const comma = t.indexOf(', ');
  const head = comma >= 0 ? t.slice(0, comma) : t;
  // "Mathematics, Physics, Chemistry" names subjects, not a degree.
  if (comma >= 0 && !DEGREE_RE.test(head)) return { degree: '', field: t };
  // LinkedIn appends the abbreviation: "Master of Business Administration - MBA".
  return { degree: head.replace(/\s+-\s+[A-Z][A-Za-z.]{0,7}$/, ''), field: comma >= 0 ? t.slice(comma + 2) : '' };
}

// ── data export (ZIP / CSV) ─────────────────────────────────────────────

/** RFC 4180: quoted fields can hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows.filter((r) => r.some((f) => f.trim()));
}

type Row = Record<string, string>;

/** "Company Name" → "companyname". */
const columnKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

function records(csv: string): Row[] {
  let rows = parseCsv(csv);
  // Some files open with a "Notes:" paragraph before the header row.
  if (/^notes/i.test(rows[0]?.[0] ?? '')) rows = rows.slice(Math.max(0, rows.findIndex((r) => r.length > 1)));
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map(columnKey);
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** "Email Addresses.csv", "PhoneNumbers.csv", "Profile_12345.csv" → "emailaddresses", "phonenumbers", "profile". */
export function exportFileKey(path: string): string {
  return (path.split(/[\\/]/).pop() ?? '')
    .replace(/\.csv$/i, '')
    .replace(/_\d+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** The CSV files inside an export ZIP, keyed by `exportFileKey`. */
export function unzipExport(zip: Uint8Array): Map<string, string> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, { filter: (f) => /\.csv$/i.test(f.name) });
  } catch {
    throw new Error('That ZIP file couldn’t be opened. Drop the .zip exactly as LinkedIn sent it, or the CSV files inside it.');
  }
  const out = new Map<string, string>();
  for (const [path, bytes] of Object.entries(entries)) out.set(exportFileKey(path), strFromU8(bytes));
  return out;
}

/** Dropped files → the export's CSVs: the ZIP itself, or CSV files taken out of it. */
export async function readExportFiles(files: File[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) for (const [k, v] of unzipExport(new Uint8Array(await f.arrayBuffer()))) out.set(k, v);
    else if (/\.csv$/i.test(f.name)) out.set(exportFileKey(f.name), await f.text());
  }
  return out;
}

export function isLinkedInExport(files: Map<string, string>): boolean {
  return ['profile', 'positions', 'education', 'skills'].some((k) => files.has(k));
}

/** Export files with no place in the profile. */
const EXTRA_FILES: [string, string][] = [
  ['honors', 'Honors & awards'],
  ['volunteering', 'Volunteering'],
  ['courses', 'Courses'],
  ['publications', 'Publications'],
  ['patents', 'Patents'],
  ['testscores', 'Test scores'],
  ['organizations', 'Organizations'],
  ['recommendationsreceived', 'Recommendations'],
];

/** "Jun 2021", "2021", "2021-06-15" → "2021-06" / "2021". */
function exportDate(v = ''): string {
  const t = v.trim();
  return toYm(t) || /^(\d{4})-(\d{2})/.exec(t)?.slice(1, 3).join('-') || '';
}

/** A description typed into LinkedIn → one bullet per line. */
function descriptionLines(text = ''): string[] {
  return text
    .split(/\r?\n|\s(?=[•●▪◦‣]\s)/)
    .map(stripBullet)
    .filter(Boolean);
}

/** Profile.csv's Websites column: "[PORTFOLIO:https://jrivera.dev,OTHER:github.com/jrivera]". */
const WEBSITE_RE = /(?:([A-Z_]{3,}):)?((?:https?:\/\/)?(?:[\w-]+\.)+[A-Za-z]{2,}(?:\/[^\s,\]]*)?)/g;

export function parseLinkedInExport(files: Map<string, string>, base: Profile): LinkedInImport {
  const rows = (key: string): Row[] => {
    const csv = files.get(key);
    return csv ? records(csv) : [];
  };
  const profile = emptyParsed(base);
  const p = profile.personal;

  const me = rows('profile')[0];
  if (me) {
    if (me.firstname) p.firstName = me.firstname;
    if (me.lastname) p.lastName = me.lastname;
    if (me.zipcode) p.address.postalCode = me.zipcode;
    // Free text; only taken when it starts like a street address.
    if (/^\d+\s+\S/.test(me.address ?? '')) p.address.line1 = me.address.split(',')[0].trim();
    const loc = parseLocation(me.geolocation ?? '');
    const country = canonicalCountry(me.geolocation ?? '');
    if (loc) Object.assign(p.address, loc);
    else if (country) p.address.country = country;
    profile.summary = (me.summary ?? '').replace(/\r\n?/g, '\n').trim();
    const sites = [...(me.websites ?? '').matchAll(WEBSITE_RE)].map((m) => ({ type: m[1] ?? '', url: m[2] }));
    sites.sort((a, b) => Number(b.type === 'PORTFOLIO') - Number(a.type === 'PORTFOLIO'));
    for (const s of sites) classifyUrl(s.url, profile.links);
    if (me.publicprofileurl) profile.links.linkedin = withScheme(me.publicprofileurl);
  }

  const emails = rows('emailaddresses');
  const email = emails.find((e) => /^yes$/i.test(e.primary)) ?? emails.find((e) => /^yes$/i.test(e.confirmed)) ?? emails[0];
  if (email?.emailaddress) p.email = email.emailaddress;
  const phones = rows('phonenumbers');
  const phone = phones.find((r) => /mobile/i.test(r.type)) ?? phones[0];
  if (phone?.number) p.phone = phone.number;

  profile.experience = rows('positions')
    .map((r): Experience => ({
      ...emptyExperience(),
      company: r.companyname ?? '',
      title: r.title ?? '',
      location: r.location ?? '',
      start: exportDate(r.startedon),
      end: exportDate(r.finishedon),
      current: !!r.startedon && !r.finishedon,
      bullets: descriptionLines(r.description),
    }))
    .filter((e) => e.company || e.title);

  profile.education = rows('education')
    .map((r): Education => {
      const ed = emptyEducation();
      const { degree, field } = splitDegree(r.degreename ?? '');
      ed.school = r.schoolname ?? '';
      ed.degree = degree;
      ed.field = r.fieldofstudy || field;
      ed.start = exportDate(r.startdate);
      ed.end = exportDate(r.enddate);
      ed.gpa = /^\d(\.\d{1,2})?(\/\d(\.\d+)?)?$/.test(r.grade ?? '') ? r.grade : findGpa(`${r.notes ?? ''} ${r.activities ?? ''}`);
      return ed;
    })
    .filter((e) => e.school || e.degree);

  profile.projects = rows('projects')
    .map((r) => {
      const pr = emptyProject();
      pr.name = r.title ?? '';
      pr.url = r.url ? withScheme(r.url) : '';
      pr.start = exportDate(r.startedon);
      pr.end = exportDate(r.finishedon);
      const lines = descriptionLines(r.description);
      if (lines.length === 1) pr.description = lines[0];
      else pr.bullets = lines;
      return pr;
    })
    .filter((pr) => pr.name);

  profile.skills = dedupe(rows('skills').map((r) => r.name ?? ''));
  profile.certifications = dedupe(rows('certifications').map((r) => r.name ?? ''));
  profile.languages = dedupe(rows('languages').map((r) => r.name ?? ''));

  const notImported = EXTRA_FILES.flatMap(([key, label]) => {
    const n = rows(key).length;
    return n ? [`${label} (${n})`] : [];
  });
  return { profile, notImported };
}

// ── "Save to PDF" ───────────────────────────────────────────────────────

export function isLinkedInPdf(lines: TextLine[]): boolean {
  return lines.some((l) => l.column === 'side');
}

const FOOTER = /^Page \d+ of \d+$/;
const near = (a: number, b: number) => Math.abs(a - b) < 0.3;

interface PdfSection {
  heading: string;
  lines: TextLine[];
}

/** Split a column at its headings, which are set in the size of the first known heading. */
function columnSections(lines: TextLine[], known: RegExp): { top: TextLine[]; sections: PdfSection[] } {
  const size = lines.find((l) => known.test(l.text.trim()))?.size;
  const top: TextLine[] = [];
  const sections: PdfSection[] = [];
  for (const l of lines) {
    if (size !== undefined && near(l.size, size)) sections.push({ heading: cleanText(l.text), lines: [] });
    else if (sections.length) sections[sections.length - 1].lines.push(l);
    else top.push(l);
  }
  return { top, sections };
}

/** Sidebar entries wrap onto extra lines set closer together than the gap between entries. */
function sidebarEntries(lines: TextLine[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const t = cleanText(l.text);
    const prev = out[out.length - 1];
    const wrapped =
      prev !== undefined &&
      l.gap !== undefined &&
      l.gap < l.size * 1.45 &&
      // "5202620535 (Mobile)" then an email is two entries, however close.
      !/\)$/.test(prev) &&
      !(EMAIL_RE.test(prev) && EMAIL_RE.test(t));
    if (!wrapped) out.push(t);
    // URLs and emails break mid-word ("www.linkedin.com/in/jordan-" / "rivera"); prose breaks between words.
    else out[out.length - 1] = prev + (/\S[-/]$/.test(prev) || (!/\s/.test(prev) && /[.@]/.test(prev)) ? '' : ' ') + t;
  }
  return out;
}

function parseSidebar(lines: TextLine[], profile: ParsedProfile, notImported: string[]): void {
  const { sections } = columnSections(lines, /^(Contact|Top Skills)$/);
  for (const s of sections) {
    const entries = sidebarEntries(s.lines);
    switch (s.heading.toLowerCase()) {
      case 'contact': {
        let email = '';
        let phone = '';
        for (const e of entries) {
          const m = /^(.*?)\s*\(([^()]+)\)$/.exec(e);
          const value = (m ? m[1] : e).trim();
          const label = m?.[2] ?? '';
          if (!label && EMAIL_RE.test(value)) email ||= EMAIL_RE.exec(value)![0];
          else if (/^(mobile|home|work|phone|other)$/i.test(label) && /\d{3}/.test(value)) phone ||= value;
          else if (/linkedin/i.test(label) || /linkedin\.com\/in\//i.test(value)) profile.links.linkedin = withScheme(value.replace(/\s+/g, ''));
          else if (/\.[a-z]{2,}/i.test(value)) classifyUrl(value.replace(/\s+/g, ''), profile.links);
        }
        if (email) profile.personal.email = email;
        if (phone) profile.personal.phone = phone;
        break;
      }
      case 'top skills':
      case 'skills':
        profile.skills.push(...entries);
        break;
      case 'languages':
        // "Spanish (Professional Working)" → "Spanish"
        profile.languages.push(...entries.map((e) => e.replace(/\s*\([^()]*\)$/, '')));
        break;
      case 'certifications':
        profile.certifications.push(...entries);
        break;
      default:
        if (entries.length) notImported.push(`${s.heading.replace(/-/g, ' & ')} (${entries.length})`);
    }
  }
  profile.skills = dedupe(profile.skills);
  profile.languages = dedupe(profile.languages);
  profile.certifications = dedupe(profile.certifications);
}

/**
 * Wrapped lines → paragraphs. A paragraph ends at a bullet, or after a line that
 * stops well short of the column's width (the next word would have fit), or a
 * little short of it at the end of a sentence.
 */
function paragraphs(lines: TextLine[]): string[] {
  const full = Math.max(0, ...lines.map((l) => l.width ?? 0));
  const out: string[] = [];
  let open = false;
  for (const l of lines) {
    const t = cleanText(l.text);
    if (!t) continue;
    const bullet = l.bullet || isBulletText(t);
    if (open && !bullet) out[out.length - 1] += ` ${t}`;
    else out.push(bullet ? stripBullet(t) : t);
    const width = l.width ?? 0;
    open = full > 0 && width >= full * 0.8 && !(/[.!?]$/.test(t) && width < full * 0.9);
  }
  return out;
}

/** Consecutive lines in the same (larger) size are one wrapped line: a long company, title or school name. */
function joinWrapped(lines: TextLine[], isHead: (l: TextLine) => boolean): TextLine[] {
  const out: TextLine[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && isHead(prev) && isHead(l) && near(prev.size, l.size) && l.gap !== undefined && l.gap < l.size * 2) {
      out[out.length - 1] = { ...prev, text: `${prev.text} ${l.text}`, width: Math.max(prev.width ?? 0, l.width ?? 0) };
    } else out.push(l);
  }
  return out;
}

/** "May 2019 - Present (1 year 1 month)": a date range and nothing else. */
function dateLine(t: string) {
  const d = findDateRange(t);
  return d && !cleanText(t.replace(d.raw, '').replace(/\([^)]*\)/, '')) ? d : null;
}

/** The whole time at a company with several roles: "4 years 5 months". */
const GROUP_DURATION = /^(less than a year|\d+ years?( \d+ months?)?|\d+ months?)$/i;

function looksLikePlace(t: string): boolean {
  const s = cleanText(t.replace(/\s*[·(].*$/, ''));
  if (!s || s.length > 60 || /[.!?]$/.test(s)) return false;
  return !!parseLocation(s) || !!canonicalCountry(s) || /\b(area|region|metropolitan|remote|hybrid|on-?site)\b/i.test(s);
}

/**
 * Each role is: company (omitted for a company's later roles), title, a date line,
 * an optional location, then its description. A company with several roles has
 * its total duration between the company and the first title.
 */
function parseExperiencePdf(raw: TextLine[]): Experience[] {
  const body = raw.find((l) => dateLine(l.text))?.size;
  if (body === undefined) return [];
  const isHead = (l: TextLine) => l.size > body + 0.2;
  const lines = joinWrapped(raw, isHead);
  const dates = lines.flatMap((l, i) => (near(l.size, body) && dateLine(l.text) ? [i] : []));

  // Where each role's heading lines start, and its company.
  const starts: number[] = [];
  const companies: string[] = [];
  dates.forEach((d, k) => {
    const titleAt = d > 0 && isHead(lines[d - 1]) ? d - 1 : d;
    let j = titleAt - 1;
    if (j >= 0 && !isHead(lines[j]) && GROUP_DURATION.test(cleanText(lines[j].text))) j--;
    const hasCompany = j >= 0 && isHead(lines[j]) && j >= (k ? dates[k - 1] + 1 : 0);
    starts.push(hasCompany ? j : titleAt);
    companies.push(hasCompany ? cleanText(lines[j].text) : (companies[k - 1] ?? ''));
  });

  return dates.map((d, k) => {
    const e = emptyExperience();
    const range = dateLine(lines[d].text)!;
    e.company = companies[k];
    e.title = d > 0 && isHead(lines[d - 1]) ? cleanText(lines[d - 1].text) : '';
    e.start = range.start;
    e.end = range.end;
    e.current = range.current;
    let rest = lines.slice(d + 1, starts[k + 1] ?? lines.length);
    if (rest[0] && looksLikePlace(rest[0].text)) {
      e.location = cleanText(rest[0].text);
      rest = rest.slice(1);
    }
    e.bullets = paragraphs(rest);
    return e;
  });
}

/** Each school name (12pt) is followed by "Degree, Field · (2017 - 2021)" (10.5pt), which may wrap. */
function parseEducationPdf(raw: TextLine[]): Education[] {
  if (!raw.length) return [];
  const small = Math.min(...raw.map((l) => l.size));
  const isHead = (l: TextLine) => l.size > small + 0.2 || raw.every((r) => near(r.size, small));
  const out: { school: string; detail: string }[] = [];
  for (const l of joinWrapped(raw, isHead)) {
    if (isHead(l)) out.push({ school: cleanText(l.text), detail: '' });
    else if (out.length) out[out.length - 1].detail = cleanText(`${out[out.length - 1].detail} ${l.text}`);
  }
  return out.map(({ school, detail }) => {
    const ed = emptyEducation();
    ed.school = school;
    const dot = detail.lastIndexOf('·');
    const what = cleanText(dot >= 0 ? detail.slice(0, dot) : detail);
    const when = dot >= 0 ? detail.slice(dot + 1) : detail;
    const range = findDateRange(when);
    if (range) {
      ed.start = range.start;
      ed.end = range.current ? '' : range.end;
    } else ed.end = findSingleDate(when)?.date ?? '';
    const { degree, field } = splitDegree(dot >= 0 || !range ? what : cleanText(what.replace(range.raw, '').replace(/\(\s*\)/, '')));
    ed.degree = degree;
    ed.field = field;
    ed.gpa = findGpa(detail);
    return ed;
  });
}

function parseMain(lines: TextLine[], profile: ParsedProfile, notImported: string[]): void {
  const { top, sections } = columnSections(lines, /^(Summary|Experience|Education)$/);
  // Top of page 1: name (largest), headline, location.
  if (top.length) {
    const nameLine = top.reduce((a, b) => (b.size > a.size ? b : a));
    // "Jordan Rivera, PMP" → Jordan Rivera
    const words = cleanText(nameLine.text.split(',')[0]).split(' ');
    profile.personal.firstName = words[0];
    profile.personal.lastName = words.slice(1).join(' ');
    const last = top[top.length - 1];
    if (last !== nameLine && looksLikePlace(last.text)) {
      const loc = parseLocation(last.text);
      const country = canonicalCountry(last.text);
      if (loc) Object.assign(profile.personal.address, loc);
      else if (country) profile.personal.address.country = country;
    }
  }
  for (const s of sections) {
    switch (s.heading.toLowerCase()) {
      case 'summary':
        profile.summary = paragraphs(s.lines).join('\n');
        break;
      case 'experience':
        profile.experience.push(...parseExperiencePdf(s.lines));
        break;
      case 'education':
        profile.education.push(...parseEducationPdf(s.lines));
        break;
      default:
        if (s.lines.length) notImported.push(s.heading);
    }
  }
}

/** Lines of a LinkedIn "Save to PDF" file (see `isLinkedInPdf`) → profile fields. */
export function parseLinkedInPdf(lines: TextLine[], base: Profile): LinkedInImport {
  const profile = emptyParsed(base);
  const notImported: string[] = [];
  const keep = (column: TextLine['column']) => lines.filter((l) => l.column === column && !FOOTER.test(cleanText(l.text)));
  parseMain(keep('main'), profile, notImported);
  parseSidebar(keep('side'), profile, notImported);
  return { profile, notImported };
}
