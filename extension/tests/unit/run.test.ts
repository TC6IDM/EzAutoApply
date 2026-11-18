import { beforeEach, describe, expect, it } from 'vitest';
import { isExternalRedirect } from '../../src/core/sites';
import type { SiteError } from '../../src/fill/siteErrors';
import type { FieldReport } from '../../src/fill/types';
import type { AdvanceTarget } from '../../src/messages';
import { newRun, type PageCheck, type RunDeps, runPages } from '../../src/run/loop';
import { acceptAccountTerms, pageFingerprint } from '../../src/run/page';
import type { RunState } from '../../src/run/types';

/** One page of a stand-in application, as the Run would read it. */
interface FakePage {
  url?: string;
  blockers?: PageCheck['blockers'];
  /** Blockers that only show once the page is filled. */
  blockersAfterFill?: PageCheck['blockers'];
  confirmation?: string;
  reports?: Partial<FieldReport>[];
  button?: Partial<AdvanceTarget> | null;
  /** Pressing the button doesn't move the page on. */
  stuck?: boolean;
  errors?: SiteError[];
  terms?: string[];
}

const field = (id: string, status: FieldReport['status'], required = false): Partial<FieldReport> => ({ id, label: id, status, required });
const next = (label = 'Next'): Partial<AdvanceTarget> => ({ label, kind: 'next', score: 50, frameId: 0 });

function stand(pages: FakePage[], o: { cancelAt?: number; throwAt?: number } = {}) {
  let i = 0;
  let filled = false;
  const log = { pressed: [] as string[], fills: 0, terms: 0, saves: 0 };
  const page = () => pages[Math.min(i, pages.length - 1)];
  const deps: RunDeps = {
    fill: async () => {
      if (o.throwAt === i) throw new Error('Receiving end does not exist');
      log.fills++;
      filled = true;
    },
    reports: async () => (page().reports ?? []).map((r) => ({ frameId: 0, kind: 'text', options: [], confidence: 1, source: 'rule', ...r }) as FieldReport),
    check: async () => ({
      url: page().url ?? `https://boards.greenhouse.io/acme/jobs/1?step=${i}`,
      fingerprint: `page-${i}`,
      blockers: [...(page().blockers ?? []), ...(filled ? (page().blockersAfterFill ?? []) : [])],
      confirmation: page().confirmation ?? null,
    }),
    acceptTerms: async () => {
      log.terms++;
      return page().terms ?? [];
    },
    findButton: async () => {
      const b = page().button;
      return b === null ? null : ({ frameId: 0, score: 50, label: 'Next', kind: 'next', ...b } as AdvanceTarget);
    },
    press: async (t) => {
      if (t.kind === 'submit') throw new Error('Run pressed Submit');
      log.pressed.push(t.label);
      return true;
    },
    waitForChange: async () => {
      if (page().stuck) return false;
      i++;
      filled = false;
      return true;
    },
    siteErrors: async () => page().errors ?? [],
    save: async () => {
      log.saves++;
    },
    cancelled: () => o.cancelAt !== undefined && i >= o.cancelAt,
    now: () => 0,
  };
  return { deps, log };
}

const opts = { maxPages: 15, stopOnReview: true, isExternal: isExternalRedirect };
const run = (pages: FakePage[], more: Partial<typeof opts> = {}, o = {}, state?: RunState) => {
  const s = stand(pages, o);
  return runPages(state ?? newRun(7, 'https://boards.greenhouse.io/acme/jobs/1', 0), s.deps, { ...opts, ...more }).then((r) => ({ r, log: s.log }));
};

describe('Run to Submit: the loop (#9)', () => {
  it('fills and presses Next page after page, and stops at Submit without pressing it', async () => {
    const { r, log } = await run([
      { reports: [field('first', 'filled', true)], button: next() },
      { reports: [field('years', 'filled')], button: next('Continue') },
      { reports: [field('note', 'skipped')], button: { label: 'Apply', kind: 'submit', why: 'submits this form' } },
    ]);
    expect(r).toMatchObject({ status: 'stopped', page: 3, stop: { reason: 'submitReady', detail: '"Apply" submits this form' } });
    expect(log.pressed).toEqual(['Next', 'Continue']);
    expect(r.history.map((h) => [h.page, h.pressed])).toEqual([[1, 'Next'], [2, 'Continue'], [3, undefined]]);
    expect(log.fills).toBe(3);
  });

  it('stops at required questions nothing could answer, but not at optional ones', async () => {
    const { r } = await run([
      { reports: [field('pronouns', 'needs')], button: next() },
      { reports: [field('visa', 'needs', true), field('salary', 'needs', true), field('a', 'filled')], button: next() },
    ]);
    expect(r.stop).toEqual({ reason: 'needsYou', detail: 'visa, salary', fieldIds: ['visa', 'salary'] });
    expect(r.page).toBe(2);
  });

  it('stops at guessed answers while runStopOnReview is on, and goes on when it is off', async () => {
    const pages: FakePage[] = [{ reports: [field('school', 'review')], button: next() }, { button: { label: 'Submit', kind: 'submit' } }];
    expect((await run(pages)).r.stop).toMatchObject({ reason: 'review', fieldIds: ['school'] });
    expect((await run(pages, { stopOnReview: false })).r.stop).toMatchObject({ reason: 'submitReady' });
  });

  it('stops at a CAPTCHA before filling, and at a code box that shows up after filling', async () => {
    const captcha = await run([{ blockers: [{ kind: 'captcha', detail: 'reCAPTCHA on the page' }] }]);
    expect(captcha.r.stop).toEqual({ reason: 'captcha', detail: 'reCAPTCHA on the page' });
    expect(captcha.log.fills).toBe(0);
    const code = await run([{ blockersAfterFill: [{ kind: 'verificationCode', detail: 'a one-time code box' }], button: next() }]);
    expect(code.r.stop).toMatchObject({ reason: 'verificationCode' });
    expect(code.log.pressed).toEqual([]);
  });

  it('signs in and creates the account itself, ticking the terms on account creation (#8)', async () => {
    const { r, log } = await run([
      { blockers: [{ kind: 'signIn', detail: 'a sign-in form' }], reports: [field('email', 'filled', true), field('password', 'filled', true)], button: { label: 'Sign In', kind: 'signIn' } },
      {
        blockers: [{ kind: 'createAccount', detail: 'an account-creation form' }],
        // The terms box is unanswered in the fill report until Run ticks it.
        reports: [field('password', 'filled', true), field('terms', 'needs', true)],
        terms: ['terms'],
        button: { label: 'Create Account', kind: 'signIn' },
      },
      { button: { label: 'Submit', kind: 'submit' } },
    ]);
    expect(log.pressed).toEqual(['Sign In', 'Create Account']);
    expect(log.terms).toBe(1);
    expect(r.stop?.reason).toBe('submitReady');
  });

  it('reads the site\'s errors when Next goes nowhere, else says nothing changed', async () => {
    const errors = await run([{ button: next(), stuck: true, errors: [{ fieldId: 'f2', message: 'Enter a valid phone number' }, { fieldId: null, message: 'Please fix the errors' }] }]);
    expect(errors.r.stop).toEqual({ reason: 'validationErrors', detail: 'Enter a valid phone number · Please fix the errors', fieldIds: ['f2'] });
    const stuck = await run([{ button: next('Save and Continue'), stuck: true }]);
    expect(stuck.r.stop).toEqual({ reason: 'noProgress', detail: 'pressed "Save and Continue"' });
  });

  it('stops with no button, at the page limit, on the thank-you page and on a move to another site', async () => {
    expect((await run([{ button: null }])).r.stop?.reason).toBe('noButton');
    const many = await run([{ button: next() }], { maxPages: 3 });
    expect(many.r.stop).toEqual({ reason: 'maxPages', detail: '3 pages' });
    expect(many.log.pressed).toHaveLength(2);
    expect((await run([{ confirmation: 'Thank you for applying!' }])).r.stop).toEqual({ reason: 'submitted', detail: 'Thank you for applying!' });
    expect((await run([{ url: 'https://www.example-shop.com/checkout' }])).r.stop).toEqual({ reason: 'externalRedirect', detail: 'www.example-shop.com' });
  });

  it('carries on from a saved state after the worker restarted', async () => {
    const saved: RunState = { ...newRun(7, 'https://boards.greenhouse.io/acme/jobs/1', 0), page: 2, history: [{ page: 1, url: 'x', filled: 3, review: 0, needs: 0, pressed: 'Next' }] };
    const { r } = await run([{ button: { label: 'Submit', kind: 'submit' } }], {}, {}, saved);
    expect(r.page).toBe(2);
    expect(r.history.map((h) => h.page)).toEqual([1, 2]);
    expect(r.stop?.reason).toBe('submitReady');
  });

  it('stops when cancelled, and reports interrupted when the page goes away', async () => {
    expect((await run([{ button: next() }, { button: next() }], {}, { cancelAt: 1 })).r.stop).toEqual({ reason: 'cancelled' });
    expect((await run([{ button: next() }], {}, { throwAt: 0 })).r.stop).toEqual({ reason: 'interrupted', detail: 'Receiving end does not exist' });
  });
});

describe('Run to Submit: the page side (#9)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('the fingerprint changes with the step, not with typing or an error message', () => {
    document.body.innerHTML = `
      <section id="s1"><h2>Contact</h2><label for="first">First name</label><input id="first" name="first"></section>
      <section id="s2" hidden><h2>Experience</h2><label for="years">Years</label><input id="years" name="years"></section>`;
    const one = pageFingerprint(document, 'https://x.test/apply');
    (document.getElementById('first') as HTMLInputElement).value = 'Sam';
    document.body.insertAdjacentHTML('beforeend', '<div role="alert"><h3>There is a problem</h3>First name is required</div>');
    expect(pageFingerprint(document, 'https://x.test/apply#top')).toBe(one);
    document.getElementById('s1')!.hidden = true;
    document.getElementById('s2')!.hidden = false;
    expect(pageFingerprint(document, 'https://x.test/apply')).not.toBe(one);
  });

  it('ticks the terms box on an account form, and never a marketing opt-in', () => {
    document.body.innerHTML = `
      <input type="checkbox" id="t" data-ezaa-id="f1"><label for="t">I have read and agree to the Terms and Conditions</label>
      <input type="checkbox" id="p" data-ezaa-id="f2"><label for="p">I accept the Privacy Policy</label>
      <input type="checkbox" id="m" data-ezaa-id="f3"><label for="m">I agree to receive job alerts and marketing updates</label>
      <input type="checkbox" id="w" data-automation-id="createAccountCheckbox" data-ezaa-id="f4"><label for="w">Yes, I have read and consent to the terms and conditions</label>
      <input type="checkbox" id="done" checked data-ezaa-id="f5"><label for="done">I accept the terms of use</label>`;
    expect(acceptAccountTerms(document)).toEqual(['f1', 'f2', 'f4']);
    const checked = (id: string) => (document.getElementById(id) as HTMLInputElement).checked;
    expect([checked('t'), checked('p'), checked('m'), checked('w'), checked('done')]).toEqual([true, true, false, true, true]);
  });
});
