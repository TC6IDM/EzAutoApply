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
  /**
   * Run with AI (#113): ask the Answerer about these fields and wait until each is answered (it
   * fills the page) or left to the owner, or the wait runs out. What it left, with why.
   */
  askAgents?(fields: FieldReport[]): Promise<{ id: string; why: string }[]>;
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

/**
 * Blockers Run stops at. Sign-in and account-creation forms are steps it takes (#8). A CAPTCHA
 * isn't one (owner, 2026-11-19, #111): Run fills the page around it, and only says so where it
 * matters, at Submit or when Next didn't move.
 */
const STOPS_AT: BlockerKind[] = ['verificationCode', 'assessment'];

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
  const captchaOn = (page: PageCheck) => page.blockers.find((b) => b.kind === 'captcha');

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
      let reports = (await deps.reports()).filter((r) => !ticked.includes(r.id));
      // Run with AI (#113): what nothing could answer goes to the Answerer, then Run reads the page again.
      let left: { id: string; why: string }[] = [];
      let agent = 0;
      const toAsk = state.ai && deps.askAgents ? reports.filter(wantsAgent) : [];
      if (toAsk.length) {
        state.asking = toAsk.length;
        await deps.save(state);
        left = await deps.askAgents!(toAsk).finally(() => delete state.asking);
        if (deps.cancelled()) return stop({ reason: 'cancelled' });
        reports = (await deps.reports()).filter((r) => !ticked.includes(r.id));
        const before = new Set(toAsk.map((r) => r.id));
        agent = reports.filter((r) => before.has(r.id) && r.status !== 'needs').length;
      }
      const step: RunStep = {
        page: state.page,
        url: page.url,
        filled: reports.filter((r) => r.status === 'filled').length,
        review: reports.filter((r) => r.status === 'review').length,
        needs: reports.filter((r) => r.status === 'needs').length,
        ...(agent && { agent }),
      };
      state.history.push(step);
      state.updatedAt = deps.now();
      await deps.save(state);

      const needs = reports.filter((r) => r.status === 'needs' && r.required);
      if (needs.length) {
        // What the Answerer said about the ones it left, so the owner knows why.
        const why = needs.map((r) => left.find((l) => l.id === r.id)?.why).filter(Boolean);
        const detail = why.length ? `${listed(needs)} (the agent: ${[...new Set(why)].join('; ')})` : listed(needs);
        return stop({ reason: 'needsYou', detail, fieldIds: needs.map((r) => r.id) });
      }
      const review = opts.stopOnReview ? reports.filter((r) => r.status === 'review') : [];
      if (review.length) return stop({ reason: 'review', detail: listed(review), fieldIds: review.map((r) => r.id) });

      const button = await deps.findButton();
      if (!button) return stop({ reason: 'noButton' });
      if (button.kind === 'submit') {
        const said = button.why ? `"${button.label}" ${button.why}` : `"${button.label}"`;
        // A CAPTCHA here is the owner's along with Submit (a solved one may still read as one).
        const captcha = captchaOn(page);
        const byAgent = state.history.reduce((n, h) => n + (h.agent ?? 0), 0);
        const notes = [said, ...(byAgent ? [`${byAgent} answer${byAgent === 1 ? '' : 's'} written by the agent: read them first`] : []), ...(captcha ? ["if the CAPTCHA isn't done yet, do it first"] : [])];
        return stop({ reason: 'submitReady', detail: notes.join(' · ') });
      }
      if (state.page >= opts.maxPages) return stop({ reason: 'maxPages', detail: `${opts.maxPages} pages` });
      if (deps.cancelled()) return stop({ reason: 'cancelled' });

      if (!(await deps.press(button))) return stop({ reason: 'noButton', detail: `"${button.label}" went away before it could be pressed` });
      step.pressed = button.label;
      await deps.save(state);

      if (!(await deps.waitForChange(page))) {
        // Next didn't move and a CAPTCHA shows: that is what holds it.
        const captcha = captchaOn(await deps.check());
        if (captcha) return stop({ reason: 'captcha', detail: `${captcha.detail}: Next didn't move` });
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

/**
 * What Run with AI hands the Answerer (#113): a required question nothing answered, or any
 * unanswered long-answer box ("Why us?", "Anything else?"). Never a password, a file, or a
 * question the site already holds an answer for.
 */
export function wantsAgent(r: FieldReport): boolean {
  if (r.status !== 'needs' || r.kind === 'password' || r.kind === 'file') return false;
  return r.required || r.kind === 'textarea';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function newRun(tabId: number, startUrl: string, now: number, jobId?: string, ai = false): RunState {
  return { tabId, startUrl, page: 1, status: 'running', history: [], startedAt: now, updatedAt: now, ...(jobId && { jobId }), ...(ai && { ai }) };
}
