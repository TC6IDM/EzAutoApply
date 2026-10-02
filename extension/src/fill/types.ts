import type { OptionLike } from '../core/options';
import type { AnswerValue, FieldKind, FieldValue } from '../core/types';

/** Everything the matcher needs to know about a form field, without DOM references. */
export interface FieldInfo {
  id: string;
  kind: FieldKind;
  label: string;
  help: string;
  name: string;
  htmlId: string;
  placeholder: string;
  autocomplete: string;
  inputType: string;
  options: OptionLike[];
  required: boolean;
  /** Text of the nearest heading/legend above the field, for context ("Education", "Work Experience 2"). */
  section: string;
  multiple: boolean;
  hasValue: boolean;
}

/** A field plus the live elements needed to fill it. Only exists inside the content script. */
export interface FieldDescriptor extends FieldInfo {
  element: HTMLElement;
  /** Radio/checkbox group members, aligned with `options`. */
  members: HTMLInputElement[];
  /** Date widgets split into separate month/day/year inputs (Workday's "MM/YYYY"). */
  segments?: DateSegments;
}

export interface DateSegments {
  month?: HTMLInputElement;
  day?: HTMLInputElement;
  year?: HTMLInputElement;
}

export type FillStatus = 'filled' | 'review' | 'needs' | 'skipped' | 'prefilled';

export type ResolutionSource = 'rule' | 'answerBank' | 'classifier' | 'adapter' | 'none';

export interface Resolution {
  fieldId: string;
  key?: string;
  value?: FieldValue;
  /** Index into the field's options when a choice was made up front. */
  optionIndex?: number;
  source: ResolutionSource;
  confidence: number;
  status: FillStatus;
  note?: string;
  answerId?: string;
}

/** What the side panel shows for each field after an autofill run. */
export interface FieldReport {
  id: string;
  frameId: number;
  label: string;
  kind: FieldKind;
  options: string[];
  required: boolean;
  status: FillStatus;
  key?: string;
  source: ResolutionSource;
  confidence: number;
  valueText: string;
  note?: string;
  /** The field's value right after the run, read back from the page. */
  current?: AnswerValue;
  /** What the user typed or picked on the page after the run, if anything. */
  userValue?: AnswerValue;
  /** Trimmed HTML around a field that wasn't filled (values stripped), for bug reports. */
  debug?: string;
}

export interface FrameReport {
  frameId: number;
  url: string;
  title: string;
  fields: FieldReport[];
  /** Set when the classifier failed during the run (offline, bad key, timeout). */
  classifierError?: string;
  /** Set while the classifier is still working on the leftover questions. */
  pending?: string;
  updatedAt: number;
}
