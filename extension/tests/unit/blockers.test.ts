import { beforeEach, describe, expect, it } from 'vitest';
import { findBlockers } from '../../src/fill/blockers';
import { isExternalRedirect, registrableDomain } from '../../src/core/sites';
import { BLOCKER_PAGES } from './fixtures';

beforeEach(() => {
  document.body.innerHTML = '';
});

const kinds = (html: string) => {
  document.body.innerHTML = html;
  return findBlockers(document).map((b) => b.kind);
};

describe('blockers Run to Submit stops at (#11)', () => {
  it('a visible CAPTCHA challenge (reCAPTCHA, hCaptcha, Cloudflare)', () => {
    expect(kinds(BLOCKER_PAGES.recaptchaChallenge)).toEqual(['captcha']);
    expect(kinds(BLOCKER_PAGES.hcaptcha)).toEqual(['captcha']);
    expect(kinds(BLOCKER_PAGES.cloudflare)).toEqual(['captcha']);
  });

  it('not an invisible hCaptcha that takes up no room until Submit (Lever, #75)', () => {
    // Lever's markup: a full-width .h-captcha laid out 0 px tall, its challenge frame hidden.
    document.body.innerHTML = `<form><input name="name"><div id="h-captcha" class="h-captcha"><iframe title="Widget containing checkbox for hCaptcha security challenge" src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha-enclave.html#frame=en"></iframe></div><button>Submit application</button></form>
      <div><iframe style="visibility:hidden" src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha-enclave.html#frame=en"></iframe></div>`;
    const box = (w: number, h: number) => () => ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) }) as DOMRect;
    document.documentElement.getBoundingClientRect = box(1536, 2000);
    const holder = document.querySelector('.h-captcha')!;
    holder.getBoundingClientRect = box(1461, 0);
    holder.querySelector('iframe')!.getBoundingClientRect = box(1461, 0);
    try {
      expect(findBlockers(document).map((b) => b.kind)).toEqual([]);
      // The same widget once it shows its checkbox: a CAPTCHA.
      holder.getBoundingClientRect = box(303, 78);
      holder.querySelector('iframe')!.getBoundingClientRect = box(303, 78);
      expect(findBlockers(document).map((b) => b.kind)).toEqual(['captcha']);
    } finally {
      delete (document.documentElement as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    }
  });

  it('not the invisible reCAPTCHA v3 badge on ordinary forms', () => {
    expect(kinds(BLOCKER_PAGES.invisibleRecaptcha)).toEqual([]);
  });

  it('a one-time code box, or a "check your email" step', () => {
    expect(kinds(BLOCKER_PAGES.otpBox)).toEqual(['verificationCode']);
    expect(kinds(BLOCKER_PAGES.otpAutocomplete)).toEqual(['verificationCode']);
    expect(kinds(BLOCKER_PAGES.workdayEmailCode)).toEqual(['verificationCode']);
  });

  it('an online assessment link or frame', () => {
    document.body.innerHTML = BLOCKER_PAGES.hackerrank;
    expect(findBlockers(document)).toMatchObject([{ kind: 'assessment', detail: 'a HackerRank link' }]);
    expect(kinds(BLOCKER_PAGES.codilityFrame)).toEqual(['assessment']);
  });

  it('a posting that only mentions tests and codes is not a blocker', () => {
    expect(kinds(BLOCKER_PAGES.jobPostingMentioningTests)).toEqual([]);
  });

  it('Workday sign-in vs create account', () => {
    expect(kinds(BLOCKER_PAGES.workdaySignIn)).toEqual(['signIn']);
    expect(kinds(BLOCKER_PAGES.workdayCreateAccount)).toEqual(['createAccount']);
  });

  it('a hidden blocker does not count', () => {
    expect(kinds(`<div hidden>${BLOCKER_PAGES.otpBox}</div>`)).toEqual([]);
    expect(kinds(`<div style="display:none">${BLOCKER_PAGES.hcaptcha}</div>`)).toEqual([]);
  });

  it('several at once come worst first', () => {
    expect(kinds(BLOCKER_PAGES.recaptchaChallenge + BLOCKER_PAGES.workdaySignIn)).toEqual(['captcha', 'signIn']);
  });
});

describe('external redirects', () => {
  it('the registrable domain', () => {
    expect(registrableDomain('careers.example.com')).toBe('example.com');
    expect(registrableDomain('jobs.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('localhost')).toBe('localhost');
  });

  it('moving onto an ATS is the way in; anywhere else is a stop', () => {
    expect(isExternalRedirect('https://www.linkedin.com/jobs/view/1', 'https://boards.greenhouse.io/acme/jobs/2')).toBe(false);
    expect(isExternalRedirect('https://careers.acme.com/job/3', 'https://acme.wd5.myworkdayjobs.com/en-US/x/apply')).toBe(false);
    expect(isExternalRedirect('https://acme.wd5.myworkdayjobs.com/x', 'https://acme.wd5.myworkdayjobs.com/y')).toBe(false);
    expect(isExternalRedirect('https://jobs.lever.co/acme/1', 'https://www.acme.com/thanks')).toBe(true);
    expect(isExternalRedirect('https://boards.greenhouse.io/acme/jobs/2', 'https://accounts.google.com/signin')).toBe(true);
    expect(isExternalRedirect('not a url', 'https://x.com')).toBe(false);
  });
});
