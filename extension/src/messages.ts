import type { SystemOneBatchRequest, SystemOneRequest, SystemOneResponse } from './classifier/systemone';
import type { Profile } from './core/profile';
import type { AnswerValue, DocKind, DocSelection, FieldKind, SavedAnswer, Settings } from './core/types';
import type { DocumentPayload } from './fill/fillers';
import type { FrameReport } from './fill/types';

/**
 * Message protocol between the three extension contexts:
 *   content script (one per frame) ⇄ background worker ⇄ side panel.
 * Every request gets a response; failures come back as { error }.
 */

export type { AnswerValue };

export interface SaveAnswerRequest {
  question: string;
  fieldKind: FieldKind;
  options?: string[];
  canonicalKey?: string;
  /** 'global', or the site's hostname for an answer that only applies there. */
  scope: string;
}

/** Sent by content scripts to the background. */
export type ContentToBackground =
  | { type: 'getContext' }
  | { type: 'getSettings' }
  | { type: 'classify'; op: 'predict'; req: SystemOneRequest }
  | { type: 'classify'; op: 'predictBatch'; req: SystemOneBatchRequest }
  | { type: 'getDocument'; kind: DocKind }
  | { type: 'getSecret'; name: 'accountPassword' }
  | { type: 'report'; report: FrameReport }
  | { type: 'fieldEdited'; fieldId: string; userValue: AnswerValue }
  | { type: 'answersUsed'; ids: string[] }
  | { type: 'autofillAll' };

/** Sent by the side panel to the background. */
export type PanelToBackground =
  | { type: 'getTabState'; tabId: number }
  | { type: 'autofillTab'; tabId: number }
  | { type: 'clearTab'; tabId: number }
  | { type: 'setDocSelection'; tabId: number; selection: DocSelection }
  | { type: 'answerField'; tabId: number; frameId: number; fieldId: string; answer: AnswerValue; save: SaveAnswerRequest | null }
  | { type: 'focusField'; tabId: number; frameId: number; fieldId: string }
  | { type: 'classifierHealth' }
  | { type: 'settingsChanged' };

/** Sent by the background to content scripts. */
export type BackgroundToContent =
  | { type: 'autofill' }
  | { type: 'applyAnswer'; fieldId: string; answer: AnswerValue }
  | { type: 'clearHighlights' }
  | { type: 'focusField'; fieldId: string }
  | { type: 'settingsChanged'; settings: Settings };

/** Broadcast by the background to extension pages (the side panel). */
export type BackgroundBroadcast = { type: 'tabStateChanged'; tabId: number } | { type: 'autofillStarted'; tabId: number };

export interface ContentContext {
  profile: Profile;
  answers: SavedAnswer[];
  settings: Settings;
}

export interface TabState {
  reports: FrameReport[];
  selection: DocSelection;
}

export type ClassifyResponse = SystemOneResponse | SystemOneResponse[];

export type DocumentResponse = DocumentPayload | null;

export interface ErrorResponse {
  error: string;
}

export function isError(x: unknown): x is ErrorResponse {
  return typeof x === 'object' && x !== null && 'error' in x;
}

/** sendMessage that turns { error } responses into thrown errors. */
export async function call<T>(send: () => Promise<unknown>): Promise<T> {
  const res = await send();
  if (isError(res)) throw new Error(res.error);
  return res as T;
}
