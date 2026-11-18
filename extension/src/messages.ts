import type { SystemOneBatchRequest, SystemOneRequest, SystemOneResponse } from './classifier/systemone';
import type { Profile } from './core/profile';
import type { AnswerValue, DocKind, DocSelection, FieldKind, SavedAnswer, Settings } from './core/types';
import type { AdvanceKind } from './fill/advance';
import type { BlockerKind } from './fill/blockers';
import type { RunState } from './run/types';
import type { DocumentPayload } from './fill/fillers';
import type { FillProgress, FrameReport } from './fill/types';

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
  /** How far this frame's run has got; null when it's done. */
  | { type: 'progress'; progress: FillProgress | null }
  | { type: 'fieldEdited'; fieldId: string; userValue: AnswerValue }
  | { type: 'answersUsed'; ids: string[] }
  | { type: 'autofillAll' }
  /** The floating button's Run / Stop (a trusted click in its closed shadow root). */
  | { type: 'runAll' }
  | { type: 'stopRun' };

/** Sent by the side panel to the background. */
export type PanelToBackground =
  | { type: 'getTabState'; tabId: number }
  | { type: 'autofillTab'; tabId: number }
  | { type: 'clearTab'; tabId: number }
  | { type: 'setDocSelection'; tabId: number; selection: DocSelection }
  | { type: 'answerField'; tabId: number; frameId: number; fieldId: string; answer: AnswerValue; save: SaveAnswerRequest | null }
  | { type: 'focusField'; tabId: number; frameId: number; fieldId: string }
  /** run: Run to Submit's stricter reading, where anything that may send the application is Submit. */
  | { type: 'findAdvance'; tabId: number; run?: boolean }
  | { type: 'advance'; tabId: number; frameId: number }
  /** The top frame says the application went through ("Thank you for applying"), or null. */
  | { type: 'confirmation'; tabId: number }
  /** Run to Submit (#9): start on this tab, stop it, or read its RunState (null: never run). */
  | { type: 'startRun'; tabId: number }
  | { type: 'cancelRun'; tabId: number }
  | { type: 'getRun'; tabId: number }
  | { type: 'classifierHealth' }
  /** Whether the local bridge answers at the saved address. */
  | { type: 'bridgeHealth' }
  /** Queue the posting this tab shows for the fleet's appliers (#79). */
  | { type: 'sendToFleet'; tabId: number }
  | { type: 'settingsChanged' };

/** What "Send to the fleet" did (#79): queued now, or the job the queue already had for it. */
export interface SendToFleetResult {
  queued: boolean;
  id: string;
  /** "Software Engineer at Acme", or the address when the page said nothing. */
  name: string;
  /** The status of the job the queue already had. */
  status?: string;
}

/** Sent by the background to content scripts. */
export type BackgroundToContent =
  | { type: 'autofill' }
  | { type: 'applyAnswer'; fieldId: string; answer: AnswerValue }
  | { type: 'clearReports' }
  | { type: 'focusField'; fieldId: string }
  | { type: 'findAdvance'; run?: boolean }
  /** run: press the run-mode button, and never one that reads as Submit. */
  | { type: 'advance'; run?: boolean }
  | { type: 'confirmation' }
  /** Run to Submit's look at this frame between steps (RunCheckResponse). */
  | { type: 'runCheck' }
  /** Wait for this frame to go quiet after the page moved on. */
  | { type: 'settle' }
  /** Tick "I accept the terms" on an account-creation form; the scanned ids ticked. */
  | { type: 'acceptTerms' }
  /** The site's validation messages, mapped to scanned fields (SiteError[]). */
  | { type: 'siteErrors' }
  | { type: 'settingsChanged'; settings: Settings }
  /** All of the tab's frames together, for the top frame's floating button; null when none is filling. */
  | { type: 'fillProgress'; progress: FillProgress | null }
  /** The tab's Run, for the top frame's floating button. */
  | { type: 'runState'; run: RunState };

/** The page button the side panel's Advance button presses: Next, Submit, Sign In, Apply. */
export interface AdvanceTarget {
  frameId: number;
  label: string;
  kind: AdvanceKind;
  score: number;
  /** Run mode: why it counts as Submit although its wording alone doesn't say so. */
  why?: string;
}

/** Broadcast by the background to extension pages (the side panel). */
export type BackgroundBroadcast =
  | { type: 'tabStateChanged'; tabId: number }
  | { type: 'autofillStarted'; tabId: number }
  | { type: 'fillProgress'; tabId: number; progress: FillProgress | null }
  | { type: 'runChanged'; tabId: number; run: RunState };

/** A frame's answer to `runCheck`. */
export interface RunCheckResponse {
  url: string;
  fingerprint: string;
  blockers: { kind: BlockerKind; detail: string }[];
  /** Top frame only: what the page said ("Thank you for applying!"), or null. */
  confirmation: string | null;
}

export interface ContentContext {
  profile: Profile;
  answers: SavedAnswer[];
  settings: Settings;
}

export interface TabState {
  reports: FrameReport[];
  selection: DocSelection;
  /** Set while any frame of the tab is filling. */
  progress: FillProgress | null;
  /** The tab's last Run to Submit, running or stopped. */
  run: RunState | null;
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
