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
  | 'file';

export const TEXT_KINDS: FieldKind[] = ['text', 'textarea', 'number', 'date', 'month'];
export const CHOICE_KINDS: FieldKind[] = ['select', 'radio', 'combobox', 'checkboxGroup'];

export interface FileRef {
  fileKind: DocKind;
}

/** A value a field should receive: text, a yes/no, several choices, or a stored document. */
export type FieldValue = string | boolean | string[] | FileRef;

/** An answer as the user gives it: free text, chosen option label(s), or a checkbox state. */
export type AnswerValue = string | string[] | boolean;

export function isFileRef(v: unknown): v is FileRef {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'fileKind' in v;
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
}

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

export interface Settings {
  classifier: ClassifierSettings;
  /** Re-run autofill automatically when a multi-step form shows its next step. */
  autoFillNextStep: boolean;
  /** Overwrite fields that already contain a value. */
  overwriteFilled: boolean;
  showFloatingButton: boolean;
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
    showFloatingButton: true,
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
