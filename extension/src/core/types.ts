/** Types shared by the content script, background and side panel. */

export type DocKind = 'resume' | 'coverLetter' | 'transcript' | 'other';

export const DOC_KIND_LABELS: Record<DocKind, string> = {
  resume: 'Resume',
  coverLetter: 'Cover letter',
  transcript: 'Transcript',
  other: 'Other',
};

export interface StoredDocument {
  id: string;
  kind: DocKind;
  name: string;
  fileName: string;
  mime: string;
  size: number;
  blob: Blob;
  /** Plain text extracted at upload time; used for "paste your resume" textareas. */
  text: string;
  isDefault: boolean;
  createdAt: number;
}

/** Document metadata without the blob, safe to send over extension messaging. */
export type DocumentMeta = Omit<StoredDocument, 'blob'>;

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'month'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'checkboxGroup'
  | 'combobox'
  | 'file'
  | 'password';

export const TEXT_KINDS: FieldKind[] = ['text', 'textarea', 'number', 'date', 'month'];
export const CHOICE_KINDS: FieldKind[] = ['select', 'radio', 'combobox', 'checkboxGroup'];

export interface FileRef {
  fileKind: DocKind;
}

/**
 * A secret the background hands over only at the moment it's typed into the
 * page (and only on allowed sites), so it never sits in reports or messages.
 */
export interface SecretRef {
  secret: 'accountPassword';
}

/** A value a field should receive: text, a yes/no, several choices, a stored document, or a secret. */
export type FieldValue = string | boolean | string[] | FileRef | SecretRef;

/** An answer as the user gives it: free text, chosen option label(s), or a checkbox state. */
export type AnswerValue = string | string[] | boolean;

export function isFileRef(v: unknown): v is FileRef {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'fileKind' in v;
}

export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'secret' in v;
}

export type AnswerScope = 'global' | string; // a hostname for company-specific answers

export interface SavedAnswer {
  id: string;
  question: string;
  normalized: string;
  fieldKind: FieldKind;
  options?: string[];
  answer: string | string[] | boolean;
  canonicalKey?: string;
  scope: AnswerScope;
  timesUsed: number;
  lastUsed: number;
  createdAt: number;
  /** Who wrote it (#21): the owner, an agent through the bridge, or an import. Missing means 'you'. */
  origin?: AnswerOrigin;
  /** An agent's or an import's answer fills as `review` until the owner approves it. Missing means approved. */
  approved?: boolean;
  /** Where an agent found it: profile sections, documents, earlier applications. */
  sourceRefs?: string[];
  /** Which agent wrote it ("answerer", "fixer"…). */
  createdBy?: string;
}

export type AnswerOrigin = 'you' | 'agent' | 'import';

export const originOf = (a: Pick<SavedAnswer, 'origin'>): AnswerOrigin => a.origin ?? 'you';
export const isApproved = (a: Pick<SavedAnswer, 'approved'>): boolean => a.approved !== false;

export interface ClassifierSettings {
  provider: 'laya' | 'jev' | 'none';
  baseUrl: string;
  apiKey: string;
  /** Laya checkpoint: english | multilingual | typed-decisions. Ignored by Jev. */
  model: string;
  /** answer_confidence at or above this fills silently. */
  autoThreshold: number;
  /** answer_confidence at or above this fills but is marked for review. */
  reviewThreshold: number;
}

/** How uploaded files are named: Jordan_Rivera_Resume.pdf, Jordan-Rivera-Resume.pdf, "Jordan Rivera - Resume.pdf", or unchanged. */
export type FileNameFormat = 'underscore' | 'dash' | 'spaced' | 'original';

export interface Settings {
  classifier: ClassifierSettings;
  /** Re-run autofill automatically when a multi-step form shows its next step. */
  autoFillNextStep: boolean;
  /** Overwrite fields that already contain a value. */
  overwriteFilled: boolean;
  /**
   * Replace values the site filled in itself (usually from reading the uploaded resume) when they
   * disagree with the profile. Fields the user typed in or clicked are never replaced.
   */
  fixSiteValues: boolean;
  showFloatingButton: boolean;
  fileNameFormat: FileNameFormat;
  /** Fill the account password on any site, not just known job-account sites (Workday, iCIMS, …). */
  passwordOnAnySite: boolean;
  /** Open "read and acknowledge the privacy notice" links and press Acknowledge. */
  acknowledgePrivacyNotices: boolean;
  /** Run to Submit stops when any answer is only a guess (status review), not just at unanswered ones. */
  runStopOnReview: boolean;
  /** Run to Submit gives up after this many pages. */
  runMaxPages: number;
  /** Take Run commands from the local bridge (bridge/, for the agent fleet) and report back to it. */
  bridgeEnabled: boolean;
  bridgeUrl: string;
  /** From ~/.ezautoapply/bridge-token, pasted once. */
  bridgeToken: string;
  /**
   * While the bridge is on (#102): the fleet's tab groups move to a window of their own, so
   * Claude's tabs don't open beside the owner's, and a finished applier's group closes.
   */
  fleetWindow: boolean;
}

export const LAYA_DEFAULT_URL = 'http://127.0.0.1:8000';

export function defaultSettings(): Settings {
  return {
    classifier: {
      provider: 'laya',
      baseUrl: LAYA_DEFAULT_URL,
      apiKey: '',
      model: 'typed-decisions',
      autoThreshold: 0.85,
      reviewThreshold: 0.55,
    },
    autoFillNextStep: false,
    overwriteFilled: false,
    fixSiteValues: true,
    showFloatingButton: true,
    fileNameFormat: 'underscore',
    passwordOnAnySite: false,
    acknowledgePrivacyNotices: true,
    runStopOnReview: true,
    runMaxPages: 15,
    bridgeEnabled: false,
    bridgeUrl: 'http://127.0.0.1:8100',
    bridgeToken: '',
    fleetWindow: true,
  };
}

export interface ApplicationRecord {
  id: string;
  url: string;
  host: string;
  title: string;
  date: number;
  resumeId?: string;
  coverLetterId?: string;
  filled: number;
  review: number;
  needs: number;
}

/** Documents chosen for the application on the current tab (defaults when unset). */
export interface DocSelection {
  resume?: string;
  coverLetter?: string;
  transcript?: string;
  other?: string;
}
