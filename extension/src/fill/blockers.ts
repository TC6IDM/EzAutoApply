import { normalize } from '../core/normalize';
import { deepQueryAll, isOwnUi, isVisible } from './dom';
import { labelFor, textOf } from './labels';

/**
 * Things on a page that Run to Submit must stop at and never try to get past (#11,
 * docs/agent-fleet-plan.md §6.5): a CAPTCHA, a one-time code, an online assessment, a
 * sign-in or account-creation wall. Run (#9) decides what to do with each; whether it may
 * sign in or create an account with the saved password is the owner's call (#8). This
 * module only says what is there, and never touches it.
 */
export type BlockerKind = 'captcha' | 'verificationCode' | 'assessment' | 'signIn' | 'createAccount';

export interface Blocker {
  kind: BlockerKind;
  /** What was seen, for the stop reason ("reCAPTCHA challenge", "HackerRank link"). */
  detail: string;
  element?: Element;
}

/** Challenge frames. Invisible reCAPTCHA v3 badges sit on many ATS forms and block nothing. */
const CAPTCHA_FRAME: [RegExp, string][] = [
  [/recaptcha\/(api2|enterprise)\/(anchor|bframe)/, 'reCAPTCHA'],
  [/hcaptcha\.com/, 'hCaptcha'],
  [/challenges\.cloudflare\.com/, 'Cloudflare challenge'],
  [/arkoselabs\.com|funcaptcha\.com/, 'Arkose challenge'],
];
const CAPTCHA_TEXT = /^(i'?m not a robot|verify (that )?you are (a )?human|are you a robot|please verify you are a human|complete the security check)\b/;

const CODE_LABEL = /\b(verification code|one[ -]time (pass ?code|password|code)|otp|security code|confirmation code|passcode|enter (the )?code|\d-digit code)\b/;
const CODE_TEXT = /\b(we (have )?(sent|emailed|texted) (you )?(a|an|the) (code|verification|email|link)|check your (email|inbox) (for|to)|verify your email( address)?)\b/;

const ASSESSMENTS: [RegExp, string][] = [
  [/hackerrank\.com/, 'HackerRank'],
  [/codility\.com/, 'Codility'],
  [/codesignal\.com/, 'CodeSignal'],
  [/testgorilla\.com/, 'TestGorilla'],
  [/hirevue\.com/, 'HireVue'],
  [/criteriacorp\.com/, 'Criteria'],
  [/shl\.com|shlonline\.com/, 'SHL'],
  [/pymetrics\.(com|ai)/, 'pymetrics'],
];

const CONFIRM_PASSWORD = /\b(confirm|verify|re-?enter|repeat|again)\b/;
const CREATE_ACCOUNT = /^(create (an |your |my )?account|sign up|register|create account and continue)$/;

const shown = (el: Element) => !isOwnUi(el) && isVisible(el);
const words = (el: Element) => normalize(textOf(el));

/**
 * A CAPTCHA box that takes up no room isn't one the owner can see (#75): Lever keeps an
 * invisible hCaptcha in a full-width `.h-captcha` 0 px tall until Submit. Only on a laid-out page
 * (unit tests have no layout: every box is 0 × 0 there).
 */
function hasRoom(el: Element): boolean {
  const page = el.ownerDocument.documentElement.getBoundingClientRect();
  if (page.width === 0 && page.height === 0) return true;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}
const shownCaptcha = (el: Element) => shown(el) && hasRoom(el);

function captcha(root: ParentNode): Blocker | null {
  for (const frame of deepQueryAll<HTMLIFrameElement>(root, 'iframe')) {
    const src = frame.getAttribute('src') ?? '';
    if (/size=invisible/.test(src) || frame.closest('.grecaptcha-badge') || !shownCaptcha(frame)) continue;
    const hit = CAPTCHA_FRAME.find(([re]) => re.test(src));
    if (hit) return { kind: 'captcha', detail: `${hit[1]} on the page`, element: frame };
  }
  for (const el of deepQueryAll<HTMLElement>(root, '.g-recaptcha, .h-captcha, .cf-turnstile, [class*="captcha" i]')) {
    if (el.closest('.grecaptcha-badge') || el.getAttribute('data-size') === 'invisible' || !shownCaptcha(el)) continue;
    return { kind: 'captcha', detail: 'a CAPTCHA box on the page', element: el };
  }
  for (const el of deepQueryAll<HTMLElement>(root, 'label, h1, h2, h3, p, span, div[role="heading"]')) {
    if (el.children.length > 2 || !shown(el)) continue;
    if (CAPTCHA_TEXT.test(words(el))) return { kind: 'captcha', detail: `"${textOf(el).trim()}"`, element: el };
  }
  return null;
}

function verificationCode(root: ParentNode): Blocker | null {
  for (const input of deepQueryAll<HTMLInputElement>(root, 'input')) {
    if (!shown(input) || ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(input.type)) continue;
    if (input.autocomplete === 'one-time-code') return { kind: 'verificationCode', detail: 'a one-time code box', element: input };
    const said = normalize(
      [labelFor(input), input.name, input.id, input.placeholder, input.getAttribute('aria-label') ?? ''].join(' ').replace(/[_-]/g, ' '),
    );
    if (CODE_LABEL.test(said)) return { kind: 'verificationCode', detail: `a "${labelFor(input) || input.placeholder || 'code'}" box`, element: input };
  }
  for (const el of deepQueryAll<HTMLElement>(root, 'h1, h2, h3, p, [role="alert"], [role="status"]')) {
    if (!shown(el)) continue;
    if (CODE_TEXT.test(words(el))) return { kind: 'verificationCode', detail: `"${textOf(el).trim().slice(0, 80)}"`, element: el };
  }
  return null;
}

function assessment(root: ParentNode): Blocker | null {
  for (const el of deepQueryAll<HTMLElement>(root, 'a[href], iframe[src]')) {
    const url = el.getAttribute('href') ?? el.getAttribute('src') ?? '';
    const hit = ASSESSMENTS.find(([re]) => re.test(url));
    if (hit && shown(el)) return { kind: 'assessment', detail: `a ${hit[1]} ${el.tagName === 'IFRAME' ? 'test on the page' : 'link'}`, element: el };
  }
  return null;
}

const SIGN_IN = /^(sign in|log in|login|sign in to apply)$/;
const buttonWords = (b: HTMLElement) => normalize(b instanceof HTMLInputElement ? b.value : textOf(b));

/**
 * A visible password box means a login wall. It is account creation when it asks for the
 * password twice, Workday's create button is there, or a "Create account" button is the
 * only way on (a sign-in page usually offers "Create account" next to "Sign in").
 */
function accountWall(root: ParentNode): Blocker | null {
  const passwords = deepQueryAll<HTMLInputElement>(root, 'input[type="password"]').filter(shown);
  if (!passwords.length) return null;
  const buttons = deepQueryAll<HTMLElement>(root, 'button, input[type="submit"], [role="button"]').filter(shown);
  const auto = (id: string) => buttons.some((b) => b.getAttribute('data-automation-id') === id);
  const askedTwice =
    passwords.length > 1 ||
    passwords.some((p) => CONFIRM_PASSWORD.test(normalize(`${labelFor(p)} ${p.name} ${p.id} ${p.getAttribute('aria-label') ?? ''}`)));
  const createOnly =
    buttons.some((b) => CREATE_ACCOUNT.test(buttonWords(b))) && !buttons.some((b) => SIGN_IN.test(buttonWords(b))) && !auto('signInSubmitButton');
  if (askedTwice || auto('createAccountSubmitButton') || createOnly) {
    return { kind: 'createAccount', detail: 'an account-creation form', element: passwords[0] };
  }
  return { kind: 'signIn', detail: 'a sign-in form', element: passwords[0] };
}

/** Every blocker on the page, worst first (a CAPTCHA before a code before an assessment before a login). */
export function findBlockers(root: ParentNode = document): Blocker[] {
  return [captcha(root), verificationCode(root), assessment(root), accountWall(root)].filter((b): b is Blocker => !!b);
}
