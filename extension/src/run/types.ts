/**
 * Run to Submit (#9, docs/agent-fleet-plan.md §6.3): one press fills every page, presses the
 * page's own Next / Continue / Sign in / Create account, and stops at Submit, which it never
 * presses, or at the first thing it can't get past.
 */
export type StopReason =
  /** The only way on is Submit: done, waiting for the owner. */
  | 'submitReady'
  /** The page says the application went through (the owner pressed Submit). */
  | 'submitted'
  /** Required fields nothing could answer (fieldIds). */
  | 'needsYou'
  /** Uncertain values and runStopOnReview is on (fieldIds). */
  | 'review'
  /** Pressed Next and the site complained (messages mapped to fieldIds). */
  | 'validationErrors'
  /** Pressed Next and nothing changed. */
  | 'noProgress'
  | 'verificationCode'
  | 'captcha'
  | 'assessment'
  /** The top frame moved to another site that isn't an ATS. */
  | 'externalRedirect'
  | 'noButton'
  | 'maxPages'
  /** The page or the extension went away mid-step and the Run couldn't carry on. */
  | 'interrupted'
  | 'cancelled';

export interface RunStop {
  reason: StopReason;
  detail?: string;
  fieldIds?: string[];
}

export interface RunStep {
  page: number;
  url: string;
  filled: number;
  review: number;
  needs: number;
  /** The button Run pressed on this page ("Next"), when it pressed one. */
  pressed?: string;
}

export interface RunState {
  tabId: number;
  /** Set when an agent started the Run through the bridge. */
  jobId?: string;
  /** The address the Run started on, for the external-redirect check. */
  startUrl: string;
  /** 1-based page count. */
  page: number;
  status: 'running' | 'stopped';
  stop?: RunStop;
  history: RunStep[];
  startedAt: number;
  updatedAt: number;
}

/** Plain words for each stop, for the panel, the floating button and the bridge. */
export const STOP_TEXT: Record<StopReason, string> = {
  submitReady: 'Ready to submit: check the answers and press Submit',
  submitted: 'Application sent',
  needsYou: 'Some required questions need you',
  review: 'Some answers need checking',
  validationErrors: 'The site says something needs fixing',
  noProgress: 'Pressed the button but the page didn’t move on',
  verificationCode: 'The site wants a verification code',
  captcha: 'A CAPTCHA needs you',
  assessment: 'This step is an assessment',
  externalRedirect: 'The application moved to another site',
  noButton: 'No Next or Submit button found',
  maxPages: 'Stopped after the page limit',
  interrupted: 'Interrupted',
  cancelled: 'Stopped',
};

/** What to do next after each stop. */
export const NEXT_STEP: Record<StopReason, string> = {
  submitReady: 'Check the answers on the page, then press its Submit button yourself.',
  submitted: 'Nothing left to do on this page.',
  needsYou: 'Answer them below or on the page, then press Run again.',
  review: 'Check them below, then press Run again. (Settings can let Run go on past these.)',
  validationErrors: 'Fix what the site points out, then press Run again.',
  noProgress: 'Look at the page for anything missing, then press Run again.',
  verificationCode: 'Enter the code the site sent you, then press Run again.',
  captcha: 'Solve it on the page, then press Run again.',
  assessment: 'It’s a test to take yourself; Run doesn’t do these.',
  externalRedirect: 'If this is still the application, press Run again.',
  noButton: 'Go on by hand, then press Run again.',
  maxPages: 'Press Run again to carry on.',
  interrupted: 'Press Run again to carry on.',
  cancelled: 'Press Run again to carry on.',
};

/** "Page 3 · filled 14 · 1 needs you": the stepper line, from the latest page. */
export function stepLine(run: RunState): string {
  const last = run.history[run.history.length - 1];
  const parts = [`Page ${run.page}`];
  if (last?.page === run.page) {
    parts.push(`filled ${last.filled}`);
    if (last.review) parts.push(`${last.review} to check`);
    if (last.needs) parts.push(`${last.needs} ${last.needs === 1 ? 'needs' : 'need'} you`);
  }
  return parts.join(' · ');
}
