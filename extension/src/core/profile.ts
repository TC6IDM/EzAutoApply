/**
 * The user's profile: everything parsed from the resume plus the extra facts
 * application forms ask for (work authorization, preferences, EEO answers).
 *
 * Dates are stored as "YYYY-MM" or "YYYY" strings ("" when unknown) so they
 * survive JSON export/import and can be reformatted for any form.
 */

export type TriState = boolean | null;

export interface Address {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface Personal {
  firstName: string;
  lastName: string;
  preferredName: string;
  pronouns: string;
  email: string;
  phone: string;
  address: Address;
}

export interface LinkEntry {
  label: string;
  url: string;
}

export interface Links {
  linkedin: string;
  github: string;
  portfolio: string;
  website: string;
  other: LinkEntry[];
}

export interface Experience {
  id: string;
  company: string;
  title: string;
  location: string;
  start: string;
  end: string;
  current: boolean;
  bullets: string[];
}

export interface Education {
  id: string;
  school: string;
  degree: string;
  field: string;
  gpa: string;
  location: string;
  start: string;
  end: string;
}

export interface Project {
  id: string;
  name: string;
  url: string;
  start: string;
  end: string;
  description: string;
  bullets: string[];
  tech: string[];
}

export interface WorkAuth {
  /** Countries the user may legally work in without sponsorship. */
  authorizedCountries: string[];
  needsSponsorship: TriState;
  citizenship: string;
  over18: TriState;
  securityClearance: string;
}

export interface Preferences {
  desiredSalary: string;
  startDate: string;
  noticePeriod: string;
  willingToRelocate: TriState;
  remotePreference: '' | 'remote' | 'hybrid' | 'onsite' | 'any';
  howHeard: string;
}

export const DECLINE = 'Decline to self-identify';

export interface Eeo {
  gender: string;
  race: string;
  hispanicLatino: string;
  veteran: string;
  disability: string;
}

export interface Profile {
  personal: Personal;
  links: Links;
  summary: string;
  experience: Experience[];
  education: Education[];
  projects: Project[];
  skills: string[];
  certifications: string[];
  languages: string[];
  workAuth: WorkAuth;
  preferences: Preferences;
  eeo: Eeo;
  updatedAt: number;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function emptyProfile(): Profile {
  return {
    personal: {
      firstName: '',
      lastName: '',
      preferredName: '',
      pronouns: '',
      email: '',
      phone: '',
      address: { line1: '', line2: '', city: '', region: '', postalCode: '', country: '' },
    },
    links: { linkedin: '', github: '', portfolio: '', website: '', other: [] },
    summary: '',
    experience: [],
    education: [],
    projects: [],
    skills: [],
    certifications: [],
    languages: [],
    workAuth: {
      authorizedCountries: [],
      needsSponsorship: null,
      citizenship: '',
      over18: null,
      securityClearance: '',
    },
    preferences: {
      desiredSalary: '',
      startDate: '',
      noticePeriod: '',
      willingToRelocate: null,
      remotePreference: '',
      howHeard: '',
    },
    eeo: {
      gender: DECLINE,
      race: DECLINE,
      hispanicLatino: DECLINE,
      veteran: DECLINE,
      disability: DECLINE,
    },
    updatedAt: Date.now(),
  };
}

export function emptyExperience(): Experience {
  return { id: newId(), company: '', title: '', location: '', start: '', end: '', current: false, bullets: [] };
}

export function emptyEducation(): Education {
  return { id: newId(), school: '', degree: '', field: '', gpa: '', location: '', start: '', end: '' };
}

export function emptyProject(): Project {
  return { id: newId(), name: '', url: '', start: '', end: '', description: '', bullets: [], tech: [] };
}

/** Deep-merge a partial (e.g. from an older export) over an empty profile so every field exists. */
export function normalizeProfile(input: Partial<Profile> | undefined | null): Profile {
  const base = emptyProfile();
  if (!input) return base;
  return {
    ...base,
    ...input,
    personal: { ...base.personal, ...input.personal, address: { ...base.personal.address, ...input.personal?.address } },
    links: { ...base.links, ...input.links, other: input.links?.other ?? [] },
    workAuth: { ...base.workAuth, ...input.workAuth },
    preferences: { ...base.preferences, ...input.preferences },
    eeo: { ...base.eeo, ...input.eeo },
    experience: (input.experience ?? []).map((e) => ({ ...emptyExperience(), ...e })),
    education: (input.education ?? []).map((e) => ({ ...emptyEducation(), ...e })),
    projects: (input.projects ?? []).map((p) => ({ ...emptyProject(), ...p })),
    skills: input.skills ?? [],
    certifications: input.certifications ?? [],
    languages: input.languages ?? [],
  };
}

export function fullName(p: Profile): string {
  return [p.personal.firstName, p.personal.lastName].filter(Boolean).join(' ');
}

/** Experience sorted most recent first (current roles, then by end/start date). */
export function experienceByRecency(p: Profile): Experience[] {
  return [...p.experience].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const ae = a.end || a.start;
    const be = b.end || b.start;
    return be.localeCompare(ae);
  });
}

export function educationByRecency(p: Profile): Education[] {
  return [...p.education].sort((a, b) => (b.end || b.start).localeCompare(a.end || a.start));
}

/** Whole years of professional experience; overlapping roles are only counted once. */
export function yearsOfExperience(p: Profile, now = new Date()): number {
  const nowIdx = now.getFullYear() * 12 + now.getMonth();
  const spans: [number, number][] = [];
  for (const e of p.experience) {
    const s = parseYm(e.start);
    if (!s) continue;
    const end = e.current || !e.end ? null : parseYm(e.end);
    const endIdx = end ? end.y * 12 + end.m - 1 : nowIdx;
    const startIdx = s.y * 12 + s.m - 1;
    if (endIdx > startIdx) spans.push([startIdx, endIdx]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let cur: [number, number] | null = null;
  for (const span of spans) {
    if (cur && span[0] <= cur[1]) {
      cur[1] = Math.max(cur[1], span[1]);
    } else {
      if (cur) months += cur[1] - cur[0];
      cur = [span[0], span[1]];
    }
  }
  if (cur) months += cur[1] - cur[0];
  return Math.floor(months / 12);
}

export function parseYm(v: string): { y: number; m: number } | null {
  const m = /^(\d{4})(?:-(\d{1,2}))?/.exec(v || '');
  if (!m) return null;
  return { y: Number(m[1]), m: m[2] ? Number(m[2]) : 1 };
}
