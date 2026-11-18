import type { BlockerKind } from '../fill/blockers';
import type { SiteError } from '../fill/siteErrors';
import type { FieldReport } from '../fill/types';
import type { AdvanceTarget } from '../messages';
import type { RunState, RunStep, RunStop } from './types';

/** What the Run reads from the page between steps, from every frame together. */
export interface PageCheck {
  /** The top frame's address. */
  url: string;
  /** Changes when the page moves on (pageFingerprint of every frame). */
  fingerprint: string;
  blockers: { kind: BlockerKind; detail: string }[];
  /** "Thank you for applying" wording, or null. */
  confirmation: string | null;
}

/**
 * The browser side of a Run, injected so the loop itself is plain logic (tests drive it with a
 * stand-in page; the background passes real tab messages).
 */
export interface RunDeps {
  /** Autofill every frame and wait until all of them are done. */
  fill(): Promise<void>;
  /** The tab's current fill report, every frame. */
  reports(): Promise<FieldReport[]>;
  check(): Promise<PageCheck>;
  /** Tick "I accept the terms" on an account-creation form (#8); the ids of the boxes it ticked. */
  acceptTerms(): Promise<string[]>;
  /** The page's button, read in run mode (anything that may send the application is Submit). */
  findButton(): Promise<AdvanceTarget | null>;
  /** Press it; false when it is no longer there. Never called for Submit. */
  press(target: AdvanceTarget): Promise<boolean>;
  /** Wait for the page to move on from `before`; false when it didn't. */
  waitForChange(before: PageCheck): Promise<boolean>;
  siteErrors(): Promise<SiteError[]>;
  save(state: RunState): Promise<void>;
  cancelled(): boolean;
  now(): number;
}

export interface RunOptions {
  maxPages: number;
  stopOnReview: boolean;
  /** core/sites.ts › isExternalRedirect. */
  isExternal(from: string, to: string): boolean;
}

/** Blockers Run stops at. Sign-in and account-creation forms are steps it takes (#8). */
const STOPS_AT: BlockerKind[] = ['captcha', 'verificationCode', 'assessment'];

const listed = (rs: FieldReport[]) => {
  const labels = rs.map((r) => r.label || 'a field');
  return labels.length > 3 ? `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more` : labels.join(', ');
};

/**
 * Fill → check → press → wait, page after page, until a stop. Carries on from `state`, so a
 * worker that restarted mid-Run resumes on the page it was on. Never presses Submit.
 */
export async function runPages(state: RunState, deps: RunDeps, opts: RunOptions): Promise<RunState> {
  const stop = async (s: RunStop): Promise<RunState> => {
    state.status = 'stopped';
    state.stop = s;
    state.updatedAt = deps.now();
    await deps.save(state);
    return state;
  };
  const blocked = (page: PageCheck) => page.blockers.find((b) => STOPS_AT.includes(b.kind));

  try {
    for (;;) {
      if (deps.cancelled()) return stop({ reason: 'cancelled' });
      let page = await deps.check();
      if (page.confirmation) return stop({ reason: 'submitted', detail: page.confirmation });
      if (opts.isExternal(state.startUrl, page.url)) return stop({ reason: 'externalRedirect', detail: hostOf(page.url) });
      let hard = blocked(page);
      if (hard) return stop({ reason: hard.kind as RunStop['reason'], detail: hard.detail });

      await deps.fill();
      if (deps.cancelled()) return stop({ reason: 'cancelled' });
      // Filling can bring up a CAPTCHA or a code box (a site reacting to the uploaded resume).
      page = await deps.check();
      hard = blocked(page);
      if (hard) return stop({ reason: hard.kind as RunStop['reason'], detail: hard.detail });

      const ticked = page.blockers.some((b) => b.kind === 'createAccount') ? await deps.acceptTerms() : [];
      const reports = (await deps.reports()).filter((r) => !ticked.includes(r.id));
      const step: RunStep = {
        page: state.page,
        url: page.url,
        filled: reports.filter((r) => r.status === 'filled').length,
        review: reports.filter((r) => r.status === 'review').length,
        needs: reports.filter((r) => r.status === 'needs').length,
      };
      state.history.push(step);
      state.updatedAt = deps.now();
      await deps.save(state);

      const needs = reports.filter((r) => r.status === 'needs' && r.required);
      if (needs.length) return stop({ reason: 'needsYou', detail: listed(needs), fieldIds: needs.map((r) => r.id) });
      const review = opts.stopOnReview ? reports.filter((r) => r.status === 'review') : [];
      if (review.length) return stop({ reason: 'review', detail: listed(review), fieldIds: review.map((r) => r.id) });

      const button = await deps.findButton();
      if (!button) return stop({ reason: 'noButton' });
      if (button.kind === 'submit') return stop({ reason: 'submitReady', detail: button.why ? `"${button.label}" ${button.why}` : `"${button.label}"` });
      if (state.page >= opts.maxPages) return stop({ reason: 'maxPages', detail: `${opts.maxPages} pages` });
      if (deps.cancelled()) return stop({ reason: 'cancelled' });

      if (!(await deps.press(button))) return stop({ reason: 'noButton', detail: `"${button.label}" went away before it could be pressed` });
      step.pressed = button.label;
      await deps.save(state);

      if (!(await deps.waitForChange(page))) {
        const errors = await deps.siteErrors();
        if (errors.length) {
          const ids = [...new Set(errors.map((e) => e.fieldId).filter((id): id is string => !!id))];
          return stop({ reason: 'validationErrors', detail: errors.map((e) => e.message).join(' · '), ...(ids.length && { fieldIds: ids }) });
        }
        return stop({ reason: 'noProgress', detail: `pressed "${button.label}"` });
      }
      state.page++;
      state.updatedAt = deps.now();
      await deps.save(state);
    }
  } catch (e) {
    return stop({ reason: 'interrupted', detail: (e as Error).message || String(e) });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function newRun(tabId: number, startUrl: string, now: number, jobId?: string): RunState {
  return { tabId, startUrl, page: 1, status: 'running', history: [], startedAt: now, updatedAt: now, ...(jobId && { jobId }) };
}
