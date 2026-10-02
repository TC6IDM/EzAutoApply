import { normalize } from './normalize';
import type { DocKind, FileNameFormat } from './types';

/**
 * Standardized file names for uploads ("Jordan_Rivera_Resume.pdf"), and a
 * guess at what kind of document a dropped file is. The stored file keeps its
 * original name; the standardized one is worked out whenever it's uploaded or
 * downloaded, so it always matches the current profile name.
 */

export const FILE_NAME_FORMATS: { value: FileNameFormat; label: string }[] = [
  { value: 'underscore', label: 'Jordan_Rivera_Resume.pdf' },
  { value: 'dash', label: 'Jordan-Rivera-Resume.pdf' },
  { value: 'spaced', label: 'Jordan Rivera - Resume.pdf' },
  { value: 'original', label: 'Keep the original file name' },
];

const KIND_WORDS: Record<DocKind, string[] | null> = {
  resume: ['Resume'],
  coverLetter: ['Cover', 'Letter'],
  transcript: ['Transcript'],
  other: null,
};

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/rtf': '.rtf',
  'application/vnd.oasis.opendocument.text': '.odt',
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

/** ASCII words only: some applicant tracking systems mangle accents and symbols in file names. */
function words(s: string): string[] {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w));
}

function extensionOf(fileName: string, mime: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(fileName);
  return m ? `.${m[1].toLowerCase()}` : (EXT_BY_MIME[mime] ?? '');
}

export interface NamedDocument {
  kind: DocKind;
  /** The display name, used to describe documents of kind "other". */
  name: string;
  fileName: string;
  mime: string;
}

export interface PersonName {
  firstName: string;
  lastName: string;
}

/** The file name an employer receives, e.g. "Jordan_Rivera_Cover_Letter.pdf". */
export function uploadFileName(doc: NamedDocument, person: PersonName, format: FileNameFormat): string {
  const nameWords = [...words(person.firstName), ...words(person.lastName)];
  if (format === 'original' || !nameWords.length) return doc.fileName;

  let kindWords = KIND_WORDS[doc.kind];
  if (!kindWords) {
    // "Other" documents are described by their own name, minus the person's name if it's repeated there.
    const own = new Set(nameWords.map((w) => w.toLowerCase()));
    kindWords = words(doc.name.replace(/\.[A-Za-z0-9]{1,5}$/, ''))
      .filter((w) => !own.has(w.toLowerCase()))
      .slice(0, 6);
    if (!kindWords.length) kindWords = ['Document'];
  }

  const ext = extensionOf(doc.fileName, doc.mime);
  if (format === 'dash') return `${[...nameWords, ...kindWords].join('-')}${ext}`;
  if (format === 'spaced') return `${nameWords.join(' ')} - ${kindWords.join(' ')}${ext}`;
  return `${[...nameWords, ...kindWords].join('_')}${ext}`;
}

const SIGNALS: Record<Exclude<DocKind, 'other'>, { name: RegExp; text: RegExp[] }> = {
  coverLetter: {
    name: /\b(cover|letter|motivation|cl)\b/,
    text: [/\bdear\b/, /\bsincerely\b/, /\bhiring (manager|team|committee)\b/, /\bi am writing\b/, /\bto whom it may concern\b/, /\b(best|kind|warm) regards\b/, /\bthank you for (your|considering)\b/],
  },
  transcript: {
    name: /\b(transcripts?|grades?|marks|grade report|academic record)\b/,
    text: [/\btranscript\b/, /\bcumulative gpa\b/, /\bterm gpa\b/, /\bcredits? (earned|attempted|hours)\b/, /\bcourse (code|title|number)\b/, /\b(fall|winter|spring|summer) (term|semester|quarter)\b/, /\bregistrar\b/],
  },
  resume: {
    name: /\b(resume|cv|curriculum vitae)\b/,
    text: [/\bexperience\b/, /\beducation\b/, /\bskills\b/, /\bprojects\b/, /\blinkedin\b/, /\b(present|current)\b/],
  },
};

/**
 * Guess a dropped file's kind: the file name decides when it says so
 * ("Cover Letter.pdf"), otherwise the wording of its text does.
 */
export function guessDocKind(fileName: string, text: string): DocKind {
  const n = normalize(fileName.replace(/\.[A-Za-z0-9]{1,5}$/, ''));
  for (const kind of ['coverLetter', 'transcript', 'resume'] as const) {
    if (SIGNALS[kind].name.test(n)) return kind;
  }
  const t = normalize(text.slice(0, 5000));
  if (!t) return 'other';
  let best: DocKind = 'other';
  let bestScore = 1; // at least two signals before trusting the text
  for (const kind of ['coverLetter', 'transcript', 'resume'] as const) {
    const score = SIGNALS[kind].text.filter((re) => re.test(t)).length;
    if (score > bestScore) {
      best = kind;
      bestScore = score;
    }
  }
  return best;
}
