import { canonicalCountry, detectCountry } from './geo';
import {
  DECLINE,
  educationByRecency,
  experienceByRecency,
  type Profile,
  yearsOfExperience,
} from './profile';
import type { FieldKind, FieldValue } from './types';

/**
 * The single registry of canonical fields. The rule matcher, the classifier
 * (whose choice criteria are the descriptions below) and the fillers all read it.
 */

export type Category =
  | 'contact'
  | 'address'
  | 'links'
  | 'workAuth'
  | 'eeo'
  | 'experience'
  | 'education'
  | 'logistics'
  | 'compensation'
  | 'documents'
  | 'about'
  | 'account';

export type ValueType = 'text' | 'number' | 'date' | 'bool' | 'list' | 'file' | 'secret';

export interface ResolveContext {
  profile: Profile;
  /** For repeating keys: which entry (0 = most recent) this occurrence maps to. */
  index: number;
  label: string;
  section: string;
  kind: FieldKind;
}

/** A value the resolver isn't sure applies (e.g. a guessed country); always shown for review. */
export interface Uncertain {
  uncertain: FieldValue;
}

export type Resolved = FieldValue | Uncertain | null;

export function isUncertain(v: Resolved): v is Uncertain {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'uncertain' in v;
}

export interface FieldKeyDef {
  key: string;
  category: Category;
  title: string;
  /** Plain-English description; doubles as the classifier's criteria text. */
  description: string;
  valueType: ValueType;
  /** Patterns tested against the normalized label. */
  label?: RegExp[];
  /** Patterns tested against the normalized name/id attributes. */
  attr?: RegExp[];
  exclude?: RegExp[];
  /** Only eligible when the field's section heading matches. */
  section?: RegExp;
  /** Never eligible when the field's section heading matches. */
  notSection?: RegExp;
  /** Labels longer than this are questions, not this field (avoids "state" in long sentences). */
  maxWords?: number;
  autocomplete?: string[];
  /** Value depends on the occurrence index (experience/education entries). */
  repeat?: boolean;
  /**
   * Leave out of the classifier's candidates. Laya's confidence is only calibrated up to 10
   * options, so keys the rules handle well (or that never resolve) are not offered to it.
   */
  noClassify?: boolean;
  resolve(ctx: ResolveContext): Resolved;
  /** Equivalent phrasings to try when matching a resolved text value onto options. */
  variants?(value: string): string[];
}

export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  contact: "The applicant's name, email address, phone number or pronouns",
  address: 'Where the applicant lives: street address, city, state or province, postal code, country or current location',
  links: 'Links to online profiles: LinkedIn, GitHub, portfolio or personal website',
  workAuth: 'Legal eligibility to work, visa sponsorship needs, citizenship, minimum age or security clearance',
  eeo: 'Voluntary equal-opportunity self-identification: gender, race or ethnicity, Hispanic or Latino, veteran status or disability',
  experience: 'Past or current jobs: employer, job title, employment dates, responsibilities or total years of experience',
  education: 'Schools attended: school name, degree, major, GPA, or start and graduation dates',
  logistics: 'Availability and preferences: start date, notice period, relocation, remote or onsite work, or how the applicant heard about the job',
  compensation: 'Salary or pay expectations',
  documents: 'A file upload or pasted copy of a resume, cover letter or transcript',
  about: 'A short professional summary, a list of skills, spoken languages or certifications',
  account: 'A password for the applicant’s account on the job site',
};

export const EXPERIENCE_SECTION = /\b(experience|employment|work history|job history|employer|positions?|career history)\b/;
export const EDUCATION_SECTION = /\b(education|school|university|college|degree|academic)\b/;
const PEOPLE = /\b(reference|referr(al|er|ed)|manager|supervisor|emergency|recruiter|parent|spouse|relative|friend)\b/;

const DIAL_CODES: Record<string, string> = {
  'United States': '+1', Canada: '+1', 'United Kingdom': '+44', Ireland: '+353', Australia: '+61',
  'New Zealand': '+64', India: '+91', Germany: '+49', France: '+33', Spain: '+34', Italy: '+39',
  Netherlands: '+31', Mexico: '+52', Brazil: '+55', China: '+86', Japan: '+81', 'South Korea': '+82',
  Singapore: '+65', Philippines: '+63', Pakistan: '+92', Nigeria: '+234', Israel: '+972',
};

const text = (v: string | undefined | null): string | null => (v && v.trim() ? v.trim() : null);
const tri = (v: boolean | null): boolean | null => v;
const list = (v: string[]): string[] | null => (v.length ? v : null);

function exp(ctx: ResolveContext) {
  return experienceByRecency(ctx.profile)[ctx.index] ?? null;
}

function edu(ctx: ResolveContext) {
  return educationByRecency(ctx.profile)[ctx.index] ?? null;
}

function authorizedIn(p: Profile, country: string): boolean {
  return p.workAuth.authorizedCountries.some((c) => canonicalCountry(c) === country);
}

/** The country a work-authorization question is about: the one it names, else the user's own. */
function questionCountry(ctx: ResolveContext): { country: string | null; guessed: boolean } {
  const named = detectCountry(ctx.label);
  if (named) return { country: named, guessed: false };
  return { country: canonicalCountry(ctx.profile.personal.address.country), guessed: true };
}

const yesNoVariants = (yes: string[], no: string[]) => (v: string) => {
  const n = v.toLowerCase();
  if (n === 'yes' || yes.some((y) => y.toLowerCase() === n)) return ['Yes', ...yes];
  if (n === 'no' || no.some((x) => x.toLowerCase() === n)) return ['No', ...no];
  return [];
};

export const FIELD_KEYS: FieldKeyDef[] = [
  // ── contact ────────────────────────────────────────────────────────────
  {
    key: 'firstName', category: 'contact', title: 'First name', valueType: 'text',
    description: "The applicant's first (given) name",
    label: [/\bfirst name\b/, /\bgiven name\b/, /\bforename\b/, /^first$/],
    attr: [/\bfirst ?name\b/, /\bfname\b/, /\bgiven ?name\b/, /\bname first\b/],
    exclude: [/\b(preferred|nick)/, PEOPLE], maxWords: 6, autocomplete: ['given-name'],
    resolve: (c) => text(c.profile.personal.firstName),
  },
  {
    key: 'middleName', category: 'contact', title: 'Middle name', valueType: 'text', noClassify: true,
    description: "The applicant's middle name or initial",
    label: [/\bmiddle (name|initial)s?\b/], attr: [/\bmiddle ?name\b/], maxWords: 6,
    autocomplete: ['additional-name'],
    resolve: () => null,
  },
  {
    key: 'lastName', category: 'contact', title: 'Last name', valueType: 'text',
    description: "The applicant's last name (surname or family name)",
    label: [/\blast name\b/, /\bsurname\b/, /\bfamily name\b/, /^last$/],
    attr: [/\blast ?name\b/, /\blname\b/, /\bsurname\b/, /\bfamily ?name\b/, /\bname last\b/],
    exclude: [/\bpreferred\b/, PEOPLE], maxWords: 6, autocomplete: ['family-name'],
    resolve: (c) => text(c.profile.personal.lastName),
  },
  {
    key: 'fullName', category: 'contact', title: 'Full name', valueType: 'text',
    description: "The applicant's full name: first and last name together",
    label: [/^(your )?(full |legal |complete )?name$/, /\bfull (legal )?name\b/, /\blegal name\b/],
    attr: [/^(full ?)?name$/, /^(candidate|applicant|your) ?name$/],
    exclude: [/\b(company|school|employer|university|college|project|preferred|first|last|middle|nick)\b/, PEOPLE],
    maxWords: 6, autocomplete: ['name'],
    resolve: (c) => text([c.profile.personal.firstName, c.profile.personal.lastName].filter(Boolean).join(' ')),
  },
  {
    key: 'preferredName', category: 'contact', title: 'Preferred name', valueType: 'text',
    description: 'The name the applicant prefers to be called',
    label: [/\bpreferred (first )?name\b/, /\bnick ?name\b/, /\bgo(es)? by\b/, /\bname you (prefer|go by)\b/],
    attr: [/\bpreferred ?(first ?)?name\b/, /\bnick ?name\b/], maxWords: 10, autocomplete: ['nickname'],
    resolve: (c) => text(c.profile.personal.preferredName) ?? text(c.profile.personal.firstName),
  },
  {
    key: 'pronouns', category: 'contact', title: 'Pronouns', valueType: 'text',
    description: "The applicant's pronouns",
    label: [/\bpronouns?\b/], attr: [/\bpronoun/], maxWords: 10,
    resolve: (c) => text(c.profile.personal.pronouns),
  },
  {
    key: 'email', category: 'contact', title: 'Email', valueType: 'text',
    description: "The applicant's email address",
    label: [/\be ?mail\b/], attr: [/\be ?mail\b/],
    exclude: [PEOPLE, /\bopt (in|out)\b|\bsubscribe\b|\bnewsletter\b|\bmarketing\b|\bnotif/], maxWords: 6,
    autocomplete: ['email'],
    resolve: (c) => text(c.profile.personal.email),
  },
  {
    key: 'phone', category: 'contact', title: 'Phone', valueType: 'text',
    description: "The applicant's phone number",
    label: [/\b(phone|mobile|cell|telephone|contact number)( number| no)?\b/, /^tel$/],
    attr: [/\bphone\b/, /\bmobile\b/, /\btel(ephone)?\b/, /\bcell\b/],
    exclude: [/\b(type|device|extension|ext|country|code|text me|sms|consent)\b/, PEOPLE], maxWords: 6,
    autocomplete: ['tel', 'tel-national', 'tel-local'],
    resolve: (c) => text(c.profile.personal.phone),
  },
  {
    key: 'phoneCountry', category: 'contact', title: 'Phone country code', valueType: 'text',
    description: 'The country or international dialing code of the phone number',
    label: [/\bcountry (phone |dialing |dial )?code\b/, /\bphone (number )?country( code)?\b/, /\bdial(ing)? code\b/],
    attr: [/\bcountry ?code\b/, /\bphone ?country\b/, /\bdial ?code\b/], maxWords: 6,
    autocomplete: ['tel-country-code'],
    resolve: (c) => {
      const country = canonicalCountry(c.profile.personal.address.country);
      if (!country) return null;
      return c.kind === 'text' ? (DIAL_CODES[country] ?? null) : country;
    },
  },
  {
    key: 'phoneType', category: 'contact', title: 'Phone type', valueType: 'text',
    description: 'The kind of phone: mobile, home or work',
    label: [/\bphone (device )?type\b/, /\btype of phone\b/], attr: [/\bphone ?type\b/, /\bdevice ?type\b/],
    maxWords: 6,
    resolve: () => 'Mobile',
  },

  // ── address ────────────────────────────────────────────────────────────
  {
    key: 'addressLine1', category: 'address', title: 'Street address', valueType: 'text',
    description: 'Street address, first line',
    label: [/\baddress line 1\b/, /\bstreet address\b/, /^(home |mailing |current |street |residential )?address( 1)?$/, /^street( 1)?$/, /\baddress 1\b/],
    attr: [/\baddress ?(line ?)?1\b/, /\bstreet\b/, /\baddr ?1\b/, /^address$/],
    exclude: [/\be ?mail\b|\bweb\b|\bip address\b|\burl\b/], maxWords: 6,
    autocomplete: ['street-address', 'address-line1'],
    resolve: (c) => text(c.profile.personal.address.line1),
  },
  {
    key: 'addressLine2', category: 'address', title: 'Address line 2', valueType: 'text',
    description: 'Apartment, suite or unit (second address line)',
    label: [/\baddress line 2\b/, /\baddress 2\b/, /\b(apt|apartment|suite|unit)\b/],
    attr: [/\baddress ?(line ?)?2\b/, /\baddr ?2\b/], maxWords: 6, autocomplete: ['address-line2'],
    resolve: (c) => text(c.profile.personal.address.line2),
  },
  {
    key: 'city', category: 'address', title: 'City', valueType: 'text',
    description: 'City or town the applicant lives in',
    label: [/\bcity\b/, /\btown\b/, /\bmunicipality\b/], attr: [/\bcity\b/, /\btown\b/, /\blocality\b/],
    exclude: [/\b(state|province|country|zip|postal)\b/], maxWords: 5, notSection: EXPERIENCE_SECTION,
    autocomplete: ['address-level2'],
    resolve: (c) => text(c.profile.personal.address.city),
  },
  {
    key: 'region', category: 'address', title: 'State / province', valueType: 'text',
    description: 'State, province or region the applicant lives in',
    // "State", "State / Province", "Province or Territory", "State and Region"…
    label: [/^(home |current )?(state|province|region|county|territory|prefecture)(( \/ | or | and )(province|region|territory|state))?$/, /\bstate (\/ |or )province\b/, /\bprovince (\/ |or )state\b/],
    attr: [/\bstate\b/, /\bprovince\b/, /\bregion\b/],
    exclude: [/\b(city|country|statement)\b/], maxWords: 5, autocomplete: ['address-level1'],
    resolve: (c) => text(c.profile.personal.address.region),
  },
  {
    key: 'postalCode', category: 'address', title: 'Postal code', valueType: 'text',
    description: 'ZIP or postal code',
    label: [/\b(zip|postal|post)( ?code)?\b/, /\bpostcode\b/], attr: [/\bzip\b/, /\bpostal\b/, /\bpost ?code\b/, /\bzipcode\b/],
    maxWords: 5, autocomplete: ['postal-code'],
    resolve: (c) => text(c.profile.personal.address.postalCode),
  },
  {
    key: 'country', category: 'address', title: 'Country', valueType: 'text',
    description: 'Country the applicant lives in',
    label: [/\bcountry\b/], attr: [/\bcountry\b/],
    exclude: [/\b(code|phone|dial|citizenship|nationality|authori[sz]|eligible|work in|sponsor|other than|outside)\b/],
    maxWords: 5, autocomplete: ['country', 'country-name'],
    resolve: (c) => text(c.profile.personal.address.country),
  },
  {
    key: 'location', category: 'address', title: 'Location', valueType: 'text',
    description: 'Current location as "City, State" or "City, Country"',
    label: [/^(current |your |home )?location( city)?$/, /\bcity,? (and |\/ )?(state|province|country)\b/, /\bwhere are you (currently )?(located|based)\b/, /\bcurrent(ly)? (city|location)\b/],
    attr: [/^location$/, /\bcurrent ?location\b/, /\bcandidate ?location\b/],
    exclude: [/\b(prefer|willing|relocat|office|work from|desired)/], maxWords: 8,
    notSection: new RegExp(`${EXPERIENCE_SECTION.source}|${EDUCATION_SECTION.source}`),
    resolve: (c) => {
      const a = c.profile.personal.address;
      const tail = a.region || a.country;
      return text([a.city, tail].filter(Boolean).join(', '));
    },
  },

  // ── links ──────────────────────────────────────────────────────────────
  {
    key: 'linkedin', category: 'links', title: 'LinkedIn', valueType: 'text',
    description: 'LinkedIn profile URL',
    label: [/\blinked ?in\b/], attr: [/\blinked ?in\b/], maxWords: 8,
    resolve: (c) => text(c.profile.links.linkedin),
  },
  {
    key: 'github', category: 'links', title: 'GitHub', valueType: 'text',
    description: 'GitHub profile URL',
    label: [/\bgit ?hub\b/], attr: [/\bgit ?hub\b/], maxWords: 8,
    resolve: (c) => text(c.profile.links.github),
  },
  {
    key: 'portfolio', category: 'links', title: 'Portfolio', valueType: 'text',
    description: 'Portfolio URL showing the applicant’s work',
    label: [/\bportfolio\b/], attr: [/\bportfolio\b/], exclude: [/\blinked ?in\b|\bgit ?hub\b/], maxWords: 8,
    resolve: (c) => text(c.profile.links.portfolio) ?? text(c.profile.links.website),
  },
  {
    key: 'website', category: 'links', title: 'Website', valueType: 'text',
    description: 'Personal website or blog URL',
    label: [/\b(personal )?(web ?site|web page|homepage|home page|blog)\b/, /^(url|link|website url|other url|other link)$/],
    attr: [/\bwebsite\b/, /\burl\b/, /\bhomepage\b/],
    exclude: [/\b(linked ?in|git ?hub|portfolio|company|employer|job post|posting|twitter)\b/], maxWords: 6,
    autocomplete: ['url'],
    resolve: (c) => text(c.profile.links.website) ?? text(c.profile.links.portfolio),
  },

  // ── work authorization ────────────────────────────────────────────────
  {
    key: 'authorizedToWork', category: 'workAuth', title: 'Authorized to work', valueType: 'bool',
    description: 'Whether the applicant is legally authorized to work in the job’s country',
    label: [/\b(legally )?(authori[sz]ed|eligible|permitted|entitled|allowed) to work\b/, /\bwork authori[sz]ation\b/, /\bright to work\b/, /\bwork permit\b/, /\beligib(le|ility) (for|to) (employment|be employed)\b/, /\blegally (able|eligible) to\b/],
    attr: [/\bauthori[sz]ed\b/, /\bwork ?auth/, /\beligib/], maxWords: 40,
    // "Will you require sponsorship for work authorization?" is the sponsorship question, never this one.
    exclude: [/\b(require|need)s?\b.{0,80}\bsponsor/],
    resolve: (c) => {
      const { country, guessed } = questionCountry(c);
      if (!country || !c.profile.workAuth.authorizedCountries.length) return null;
      const ok = authorizedIn(c.profile, country);
      return guessed ? { uncertain: ok } : ok;
    },
  },
  {
    key: 'needsSponsorship', category: 'workAuth', title: 'Needs visa sponsorship', valueType: 'bool',
    description: 'Whether the applicant now or in the future requires visa sponsorship to work',
    label: [/\b(require|need)s?\b.{0,80}\bsponsor(ship|ed)?\b/, /\bsponsor(ship|ed)?\b/, /\b(visa|immigration) (support|status)\b/, /\bh ?1 ?b\b/], attr: [/\bsponsor/, /\bvisa\b/],
    maxWords: 50,
    resolve: (c) => {
      const named = detectCountry(c.label);
      if (named && c.profile.workAuth.authorizedCountries.length) {
        if (authorizedIn(c.profile, named)) return false;
      }
      return tri(c.profile.workAuth.needsSponsorship);
    },
  },
  {
    key: 'isCitizen', category: 'workAuth', title: 'Is a citizen', valueType: 'bool',
    description: 'Whether the applicant is a citizen of the named country',
    label: [/\bare you an? (.{0,30} )?citizen\b/, /\bcitizen of\b/], maxWords: 20,
    resolve: (c) => {
      const named = detectCountry(c.label);
      const own = canonicalCountry(c.profile.workAuth.citizenship);
      if (!named || !own) return null;
      return named === own;
    },
  },
  {
    key: 'citizenship', category: 'workAuth', title: 'Citizenship', valueType: 'text',
    description: 'Country of citizenship or nationality',
    label: [/\bcitizenship\b/, /\bnationality\b/], attr: [/\bcitizenship\b/, /\bnationality\b/],
    exclude: [/\b(are you|do you)\b/], maxWords: 8,
    resolve: (c) => text(c.profile.workAuth.citizenship),
  },
  {
    key: 'over18', category: 'workAuth', title: 'Over 18', valueType: 'bool',
    description: 'Whether the applicant is at least 18 years old',
    label: [/\b(18|eighteen) years( of age)?\b/, /\b(over|at least|older than) (the age of )?(18|eighteen)\b/, /\b(18|eighteen) (or|and) (older|over|above)\b/, /\blegal (working )?age\b/, /\bage of majority\b/],
    maxWords: 25,
    resolve: (c) => tri(c.profile.workAuth.over18),
  },
  {
    key: 'securityClearance', category: 'workAuth', title: 'Security clearance', valueType: 'text',
    description: 'Current government security clearance level',
    label: [/\bsecurity clearance\b/, /\bclearance (level|status)\b/, /^clearance$/], maxWords: 15,
    resolve: (c) => text(c.profile.workAuth.securityClearance),
  },

  // ── EEO (voluntary self-identification) ────────────────────────────────
  {
    key: 'gender', category: 'eeo', title: 'Gender', valueType: 'text',
    description: 'Gender identity (voluntary self-identification)',
    label: [/\bgender\b/, /^sex$/, /\bwhat is your sex\b/], attr: [/\bgender\b/],
    exclude: [/\b(transgender|orientation|pronoun)/], maxWords: 15,
    resolve: (c) => text(c.profile.eeo.gender),
  },
  {
    key: 'hispanicLatino', category: 'eeo', title: 'Hispanic or Latino', valueType: 'text',
    description: 'Whether the applicant is Hispanic or Latino (voluntary self-identification)',
    label: [/\bhispanic\b/, /\blatin[oax]\b/], attr: [/\bhispanic\b/], maxWords: 20,
    resolve: (c) => text(c.profile.eeo.hispanicLatino),
    variants: yesNoVariants(['Hispanic or Latino'], ['Not Hispanic or Latino']),
  },
  {
    key: 'race', category: 'eeo', title: 'Race / ethnicity', valueType: 'text',
    description: 'Race or ethnicity (voluntary self-identification)',
    label: [/\brace\b/, /\bethnicit(y|ies)\b/, /\bracial\b/], attr: [/\brace\b/, /\bethnicity\b/],
    exclude: [/\b(hispanic|latin[oax])\b/], maxWords: 20,
    resolve: (c) => text(c.profile.eeo.race),
  },
  {
    key: 'veteran', category: 'eeo', title: 'Veteran status', valueType: 'text',
    description: 'Protected veteran status (voluntary self-identification)',
    label: [/\bveteran\b/, /\bmilitary (service|status)\b/, /\barmed forces\b/], attr: [/\bveteran\b/], maxWords: 40,
    resolve: (c) => text(c.profile.eeo.veteran),
    variants: yesNoVariants(['I identify as a protected veteran'], ['I am not a protected veteran']),
  },
  {
    key: 'disability', category: 'eeo', title: 'Disability status', valueType: 'text',
    description: 'Disability status (voluntary self-identification)',
    label: [/\bdisabilit(y|ies)\b/, /\bdisabled\b/], attr: [/\bdisabilit/], maxWords: 40,
    resolve: (c) => text(c.profile.eeo.disability),
    variants: yesNoVariants(['Yes, I have a disability'], ['No, I do not have a disability']),
  },

  // ── experience ─────────────────────────────────────────────────────────
  {
    key: 'currentCompany', category: 'experience', title: 'Current company', valueType: 'text',
    description: 'Name of the applicant’s current or most recent employer',
    label: [/\bcurrent (company|employer|organi[sz]ation)\b/, /\bmost recent (company|employer)\b/],
    attr: [/\bcurrent ?(company|employer)\b/, /^org$/], maxWords: 6,
    resolve: (c) => text(experienceByRecency(c.profile)[0]?.company),
  },
  {
    key: 'currentTitle', category: 'experience', title: 'Current title', valueType: 'text',
    description: 'The applicant’s current or most recent job title',
    label: [/\bcurrent (job )?(title|position|role)\b/, /\bmost recent (job )?(title|position|role)\b/],
    attr: [/\bcurrent ?(job ?)?title\b/], maxWords: 6,
    resolve: (c) => text(experienceByRecency(c.profile)[0]?.title),
  },
  {
    key: 'expCompany', category: 'experience', title: 'Employer', valueType: 'text', repeat: true,
    description: 'Name of an employer in the work history',
    label: [/^(company|employer|organi[sz]ation)( name)?$/, /\b(company|employer) name\b/, /^name of (company|employer)\b/],
    attr: [/\bcompany\b/, /\bemployer\b/],
    exclude: [/\b(hear|why|referr|previous(ly)?|relative|related|know anyone|school)\b/], maxWords: 5,
    resolve: (c) => text(exp(c)?.company),
  },
  {
    key: 'expTitle', category: 'experience', title: 'Job title', valueType: 'text', repeat: true,
    description: 'Job title held at an employer in the work history',
    label: [/^(job |position |role )?title$/, /\bjob title\b/, /\bposition (title|held)\b/, /^(position|role)$/],
    attr: [/\bjob ?title\b/, /^title$/, /\bposition\b/],
    exclude: [/\b(desired|applying|interested|prefer|salutation)\b/], maxWords: 5,
    resolve: (c) => text(exp(c)?.title),
  },
  {
    key: 'expLocation', category: 'experience', title: 'Job location', valueType: 'text', repeat: true, noClassify: true,
    description: 'Location of a job in the work history',
    label: [/^(job |work |company |office )?location$/, /^city$/], section: EXPERIENCE_SECTION, maxWords: 4,
    resolve: (c) => text(exp(c)?.location),
  },
  {
    key: 'expStart', category: 'experience', title: 'Job start date', valueType: 'date', repeat: true, noClassify: true,
    description: 'Start date of a job in the work history',
    label: [/\bstart( date| month| year)?\b/, /^from$/, /\bfrom (date|month|year)\b/, /\bdate (started|from)\b/],
    attr: [/\b(start|from) ?date\b/], section: EXPERIENCE_SECTION, maxWords: 5,
    resolve: (c) => text(exp(c)?.start),
  },
  {
    key: 'expEnd', category: 'experience', title: 'Job end date', valueType: 'date', repeat: true, noClassify: true,
    description: 'End date of a job in the work history',
    label: [/\bend( date| month| year)?\b/, /^to$/, /\bto (date|month|year)\b/, /\bdate (ended|left|to)\b/],
    attr: [/\b(end|to) ?date\b/], section: EXPERIENCE_SECTION, maxWords: 5,
    resolve: (c) => {
      const e = exp(c);
      return e && !e.current ? text(e.end) : null;
    },
  },
  {
    key: 'expCurrent', category: 'experience', title: 'Currently work here', valueType: 'bool', repeat: true, noClassify: true,
    description: 'Whether a job in the work history is the applicant’s current job',
    label: [/\b(i )?(currently|still) work(ing)? here\b/, /\bcurrent(ly)? (role|position|job|employer)\b/, /^(present|current)$/, /\bthis is my current\b/],
    maxWords: 8,
    resolve: (c) => {
      const e = exp(c);
      return e ? e.current : null;
    },
  },
  {
    key: 'expDescription', category: 'experience', title: 'Job description', valueType: 'text', repeat: true,
    description: 'Description of responsibilities and accomplishments in a job',
    label: [/\b(role |job |position )?description\b/, /\bresponsibilities\b/, /\bduties\b/, /\baccomplishments\b/, /\bachievements\b/],
    section: EXPERIENCE_SECTION, maxWords: 6,
    resolve: (c) => {
      const e = exp(c);
      return e && e.bullets.length ? e.bullets.map((b) => `- ${b}`).join('\n') : null;
    },
  },
  {
    key: 'yearsExperience', category: 'experience', title: 'Years of experience', valueType: 'number',
    description: 'Total years of professional work experience',
    label: [/\b(total )?years of (professional |relevant |work |industry )?experience\b/, /\bhow many years (of )?(professional |work |relevant )?experience\b/, /^experience years$/],
    exclude: [/\b(with|using)\b/], maxWords: 15,
    resolve: (c) => (c.profile.experience.length ? String(yearsOfExperience(c.profile)) : null),
  },

  // ── education ──────────────────────────────────────────────────────────
  {
    key: 'school', category: 'education', title: 'School', valueType: 'text', repeat: true,
    description: 'Name of a school, college or university attended',
    label: [/\b(school|university|college|institution)( name)?\b/, /\bname of (school|institution|university|college)\b/, /\balma mater\b/],
    attr: [/\bschool\b/, /\buniversity\b/, /\bcollege\b/, /\binstitution\b/],
    exclude: [/\b(graduat|diploma|did you|have you|are you|attend|high school)/], maxWords: 6,
    resolve: (c) => text(edu(c)?.school),
  },
  {
    key: 'degree', category: 'education', title: 'Degree', valueType: 'text', repeat: true,
    description: 'Degree earned or pursued, such as a Bachelor’s or Master’s',
    label: [/\bdegree( type| level| name| obtained| earned)?\b/, /\b(level|type) of (degree|education)\b/, /\beducation level\b/, /\bhighest (level of )?(education|degree)\b/, /\bqualification\b/],
    attr: [/\bdegree\b/],
    exclude: [/\b(field|major|area|discipline|subject|do you|have you|are you|pursuing|years)\b/], maxWords: 8,
    resolve: (c) => text(edu(c)?.degree),
  },
  {
    key: 'fieldOfStudy', category: 'education', title: 'Field of study', valueType: 'text', repeat: true,
    description: 'Major or field of study',
    label: [/\b(field|area|subject) of study\b/, /\bmajor\b/, /\bdiscipline\b/, /\bconcentration\b/, /\bspeciali[sz]ation\b/, /\bdegree (field|subject)\b/],
    attr: [/\bmajor\b/, /\bfield ?of ?study\b/, /\bdiscipline\b/], maxWords: 6,
    resolve: (c) => text(edu(c)?.field),
  },
  {
    key: 'gpa', category: 'education', title: 'GPA', valueType: 'text', repeat: true,
    description: 'Grade point average',
    label: [/\bgpa\b/, /\bgrade point\b/, /\bcgpa\b/, /\bcumulative (grade|average)\b/], attr: [/\bgpa\b/], maxWords: 8,
    resolve: (c) => text(edu(c)?.gpa),
  },
  {
    key: 'eduStart', category: 'education', title: 'School start date', valueType: 'date', repeat: true,
    description: 'Date the applicant started at a school',
    label: [/\bstart( date| month| year)?\b/, /^from$/, /\bfrom (date|month|year)\b/, /\bdate (started|from)\b/],
    attr: [/\b(start|from) ?date\b/, /\bfirst year attended\b/], section: EDUCATION_SECTION, maxWords: 5,
    resolve: (c) => text(edu(c)?.start),
  },
  {
    key: 'eduEnd', category: 'education', title: 'School end date', valueType: 'date', repeat: true,
    description: 'Date the applicant finished or will finish at a school',
    label: [/\bend( date| month| year)?\b/, /^to$/, /\bto (date|month|year)\b/, /\bdate (ended|to)\b/],
    attr: [/\b(end|to) ?date\b/, /\blast year attended\b/], section: EDUCATION_SECTION, maxWords: 5,
    resolve: (c) => text(edu(c)?.end),
  },
  {
    key: 'graduationDate', category: 'education', title: 'Graduation date', valueType: 'date', repeat: true,
    description: 'Graduation date or expected graduation date',
    label: [/\b(expected |anticipated )?graduation( date| year| month)?\b/, /\bgrad (date|year)\b/],
    maxWords: 8,
    resolve: (c) => text(edu(c)?.end),
  },

  // ── logistics ──────────────────────────────────────────────────────────
  {
    key: 'startDate', category: 'logistics', title: 'Available start date', valueType: 'text',
    description: 'When the applicant could start the new job',
    label: [/\b(earliest |available |desired |possible |potential |anticipated |preferred )?start date\b/, /\bwhen (can|could|would) you (start|begin|join)\b/, /\bavailab(le|ility) to (start|begin|join)\b/, /\bdate available\b/, /\bavailability date\b/, /\bearliest (date|availability)\b/],
    notSection: new RegExp(`${EXPERIENCE_SECTION.source}|${EDUCATION_SECTION.source}`), maxWords: 12,
    resolve: (c) => text(c.profile.preferences.startDate),
  },
  {
    key: 'noticePeriod', category: 'logistics', title: 'Notice period', valueType: 'text',
    description: 'How much notice the applicant must give their current employer',
    label: [/\bnotice period\b/, /\b(how much|weeks of) notice\b/], maxWords: 15,
    resolve: (c) => text(c.profile.preferences.noticePeriod),
  },
  {
    key: 'willingToRelocate', category: 'logistics', title: 'Willing to relocate', valueType: 'bool',
    description: 'Whether the applicant is willing to relocate for the job',
    label: [/\brelocat(e|ion|ing)\b/], exclude: [/\b(assistance|package|reimburse|stipend)/], maxWords: 25,
    resolve: (c) => tri(c.profile.preferences.willingToRelocate),
  },
  {
    key: 'remotePreference', category: 'logistics', title: 'Work arrangement', valueType: 'text',
    description: 'Preferred work arrangement: remote, hybrid or onsite',
    label: [/\bwork(ing)? (arrangement|model|setting|style|location) preference\b/, /\bpreferred work (arrangement|model|setting|location)\b/, /\bwork arrangement\b/],
    maxWords: 12,
    resolve: (c) => {
      const map = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', any: 'Flexible', '': null } as const;
      return map[c.profile.preferences.remotePreference] ?? null;
    },
  },
  {
    key: 'howHeard', category: 'logistics', title: 'How you heard about the job', valueType: 'text',
    description: 'How the applicant heard about or found this job',
    label: [/\bhow did you (hear|find|learn|come across)\b/, /\bhear about (us|this|the)\b/, /\bwhere did you (hear|find|see|learn)\b/, /\b(referral |lead |application )?source\b/, /\bhow were you referred\b/],
    attr: [/^source$/, /\bhow ?did ?you ?hear\b/, /\breferral ?source\b/], exclude: [/\bopen source\b/], maxWords: 15,
    resolve: (c) => text(c.profile.preferences.howHeard),
  },

  // ── compensation ───────────────────────────────────────────────────────
  {
    key: 'desiredSalary', category: 'compensation', title: 'Desired salary', valueType: 'text',
    description: 'Expected or desired salary or pay',
    label: [/\b(desired|expected|target|requested) (salary|compensation|pay|base|annual salary|rate|wage)\b/, /\bsalary (expectations?|requirements?|range|requested)\b/, /\bcompensation (expectations?|requirements?)\b/, /\bpay expectations?\b/, /^salary$/, /\bwhat are your (salary|compensation)\b/],
    exclude: [/\b(current|previous|last|present)\b/], maxWords: 20,
    resolve: (c) => text(c.profile.preferences.desiredSalary),
  },

  // ── documents ──────────────────────────────────────────────────────────
  {
    key: 'resume', category: 'documents', title: 'Resume', valueType: 'file',
    description: 'Upload or paste the applicant’s resume or CV',
    label: [/\bresume\b/, /\bcv\b/, /\bcurriculum vitae\b/], attr: [/\bresume\b/, /\bcv\b/],
    exclude: [/\bcover\b/], maxWords: 25,
    resolve: () => ({ fileKind: 'resume' }),
  },
  {
    key: 'coverLetter', category: 'documents', title: 'Cover letter', valueType: 'file',
    description: 'Upload or paste a cover letter',
    label: [/\bcover ?letter\b/, /\bmotivation(al)? letter\b/, /\bletter of (interest|motivation)\b/], attr: [/\bcover ?letter\b/],
    maxWords: 25,
    resolve: () => ({ fileKind: 'coverLetter' }),
  },
  {
    key: 'transcript', category: 'documents', title: 'Transcript', valueType: 'file',
    description: 'Upload an academic transcript',
    label: [/\btranscripts?\b/, /\bacademic record\b/], attr: [/\btranscript\b/], maxWords: 25,
    resolve: () => ({ fileKind: 'transcript' }),
  },

  // ── job-site account ───────────────────────────────────────────────────
  {
    // "Password", "Verify New Password", "Confirm password": all get the same saved password.
    key: 'accountPassword', category: 'account', title: 'Account password', valueType: 'secret', noClassify: true,
    description: 'The password for the applicant’s account on this job site',
    label: [/\bpass ?(word|code|phrase)\b/], attr: [/\bpass ?(word|wd)\b/, /\bpwd\b/],
    exclude: [/\b(forgot|reset|requirements?|hint)\b/], maxWords: 8,
    autocomplete: ['new-password', 'current-password'],
    resolve: () => ({ secret: 'accountPassword' }),
  },

  // ── about ──────────────────────────────────────────────────────────────
  {
    key: 'summary', category: 'about', title: 'Summary', valueType: 'text',
    description: 'A short professional summary or bio',
    label: [/^(professional |career )?summary$/, /^(about|tell us about) (you|yourself|me)$/, /^bio(graphy)?$/, /\bprofessional summary\b/],
    maxWords: 6,
    resolve: (c) => text(c.profile.summary),
  },
  {
    key: 'skills', category: 'about', title: 'Skills', valueType: 'list',
    description: 'A list of the applicant’s skills',
    label: [/^(key |technical |relevant |core )?skills( summary)?$/, /\blist (your )?(key |technical )?skills\b/], maxWords: 6,
    resolve: (c) => list(c.profile.skills),
  },
  {
    key: 'languages', category: 'about', title: 'Languages', valueType: 'list',
    description: 'Languages the applicant speaks',
    label: [/^(spoken )?languages?( spoken)?$/, /\bwhat languages do you speak\b/, /\blanguages? (you speak|proficiency)\b/],
    exclude: [/\bprogramming\b/], maxWords: 8,
    resolve: (c) => list(c.profile.languages),
  },
  {
    key: 'certifications', category: 'about', title: 'Certifications', valueType: 'list',
    description: 'Professional certifications or licenses',
    label: [/\bcertifications?\b/, /\blicen[sc]es? (and|&) certifications?\b/], maxWords: 8,
    resolve: (c) => list(c.profile.certifications),
  },
];

export const FIELD_KEY_MAP: Record<string, FieldKeyDef> = Object.fromEntries(FIELD_KEYS.map((k) => [k.key, k]));

export function keysInCategory(category: Category): FieldKeyDef[] {
  return FIELD_KEYS.filter((k) => k.category === category);
}

/** Whether a key's value type can go into a field of this kind. */
export function kindAccepts(def: FieldKeyDef, kind: FieldKind): boolean {
  switch (def.valueType) {
    case 'file':
      return kind === 'file' || kind === 'textarea';
    case 'bool':
      return kind === 'select' || kind === 'radio' || kind === 'combobox' || kind === 'checkbox';
    case 'secret':
      return kind === 'password';
    default:
      // Text answers can also tick the matching box of a checkbox group ("Race: select all that apply").
      // Password inputs only ever get the account password.
      return kind !== 'file' && kind !== 'checkbox' && kind !== 'password';
  }
}

export { DECLINE };
