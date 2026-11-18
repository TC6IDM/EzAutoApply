import { cleanText, normalize } from '../core/normalize';
import { deepQueryAll, isOwnUi, isVisible } from './dom';
import { realClick } from './fillers';
import { textOf } from './labels';

/**
 * The page's own button that moves an application on: start it, sign in, go to the next step,
 * or submit. EzAutoApply only presses it when the user presses Advance in the side panel.
 *
 * **Run mode** (`{ run: true }`, for Run to Submit, docs/agent-fleet-plan.md §6.4) is stricter
 * about Submit, because Run presses Next by itself and must never send an application. When in
 * doubt it says `submit`: being wrong that way costs the user one click; the other way sends an
 * application. Every button run mode turns into Submit says why (`why`).
 */

export type AdvanceKind = 'start' | 'signIn' | 'next' | 'submit';

export interface AdvanceButton {
  element: HTMLElement;
  label: string;
  kind: AdvanceKind;
  score: number;
  /** Run mode: why this button counts as Submit although its wording alone doesn't say so. */
  why?: string;
}

export interface FindOptions {
  /** Run to Submit: treat anything that might send the application as Submit. */
  run?: boolean;
}

/** Workday names these buttons; the names beat any wording. */
const AUTOMATION: [RegExp, AdvanceKind, number][] = [
  [/^(pageFooterNextButton|bottom-navigation-next-button)$/, 'next', 100],
  [/^(signInSubmitButton|createAccountSubmitButton)$/, 'signIn', 100],
  [/^applyManually$/, 'start', 90],
  [/^adventureButton$/, 'start', 80],
];

/** Button wording, normalized ("Save & Continue" → "save & continue"). */
const WORDING: [RegExp, AdvanceKind, number][] = [
  [/^(submit|submit( my| your)? application|submit and finish|send( my)? application|finish( application)?|complete( my)? application)$/, 'submit', 60],
  [/^(next|next step|next page|continue|save (and|&) continue|save (and|&) next|continue to next step|proceed|review|review( my| your)? application)$/, 'next', 60],
  [/^(sign in|log in|login|sign in to apply|create account|create my account)$/, 'signIn', 55],
  [/^(apply|apply now|apply for this (job|position|role)|apply manually|start( your| my)? application|begin( your)? application)$/, 'start', 50],
];

/** Buttons that look like progress but aren't, or that hand the user to another site. */
const NOT_ADVANCE = /\b(back|previous|cancel|delete|remove|add|upload|browse|withdraw|draft|later|sign out|log out|forgot|reset|with)\b/;

const CANDIDATES = 'button, input[type="submit"], input[type="button"], [role="button"], a';

/** Run mode: more ways to say Submit ("Apply" inside a filled form is handled by `filledBefore`). */
const RUN_SUBMIT =
  /^(send|send it|done|confirm|confirm (and|&) submit|(i )?agree (and|&) submit|submit for review|complete|finish|finish (and|&) submit|submit (and|&) apply)$/;
/** Run mode: wording that clearly moves to another step, so a type="submit" button saying it stays Next. */
const CLEARLY_NEXT =
  /^(next|next step|next page|continue|save (and|&) continue|save (and|&) next|continue to next step|proceed|review|review( my| your)? application)$/;
/** Run mode: main-looking buttons that aren't the application's own (a job search box, a list's sort). */
const RUN_NOT_SUBMIT = /\b(search|filter|sort|subscribe|share|save job|find jobs?)\b/;
/** A review step: the button after it submits. Workday's step bar says "current step 6 of 6 Review". */
const REVIEW_HEADING = /^(review|review (and|&) submit|review( your| my)? application|application review)$/;

const FIELDS = 'input, textarea, select';
const NOT_A_FIELD = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'search']);

function isFilled(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (NOT_A_FIELD.has(el.type)) return false;
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
    if (el.type === 'file') return (el.files?.length ?? 0) > 0;
    return el.value.trim() !== '';
  }
  if (el instanceof HTMLTextAreaElement) return el.value.trim() !== '';
  if (el instanceof HTMLSelectElement) return el.value !== '';
  return false;
}

/** Whether the user's answers sit in this button's form, or (with no form) anywhere before it. */
function filledBefore(el: HTMLElement, root: ParentNode): boolean {
  const form = el.closest('form');
  const fields = deepQueryAll<HTMLElement>(form ?? root, FIELDS).filter((f) => !f.closest('[role="search"], header, nav'));
  return fields.some(
    (f) => isFilled(f) && (form ? true : !!(f.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)),
  );
}

/** A <button> in a form submits unless it says otherwise; so do type="submit" inputs. */
function submitsForm(el: HTMLElement): boolean {
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'submit') return true;
  return el.tagName === 'BUTTON' && !type && !!el.closest('form');
}

/** The last button that submits its form (the form's main action). */
function lastSubmitOfForm(el: HTMLElement): boolean {
  const form = el.closest('form');
  if (!form) return false;
  const submits = Array.from(form.querySelectorAll<HTMLElement>('button, input[type="submit"]')).filter(
    (b) => submitsForm(b) && isVisible(b) && enabled(b),
  );
  return submits[submits.length - 1] === el;
}

function looksPrimary(el: HTMLElement): boolean {
  return submitsForm(el) || /\b(primary|cta|submit)\b/i.test(`${el.className} ${el.getAttribute('data-automation-id') ?? ''}`);
}

/** The page shows its review step ("Review your application", Workday's Review step). */
export function onReviewStep(root: ParentNode = document): boolean {
  const marks = deepQueryAll<HTMLElement>(
    root,
    'h1, h2, h3, [role="heading"], legend, [aria-current="step"], [data-automation-id="progressBarActiveStep"]',
  );
  return marks.some((m) => {
    if (!isVisible(m)) return false;
    // textOf, not textContent: Workday's "current step 6 of 6" and "Review" sit in separate elements.
    const words = normalize(textOf(m));
    if (m.matches('[data-automation-id="progressBarActiveStep"], [aria-current="step"]')) return /(^| )review( (and|&) submit)?$/.test(words);
    return REVIEW_HEADING.test(words);
  });
}

function labelOf(el: HTMLElement): string {
  const own = el instanceof HTMLInputElement ? el.value : textOf(el);
  return cleanText(own || el.getAttribute('aria-label') || el.getAttribute('title') || '');
}

function enabled(el: HTMLElement): boolean {
  return !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
}

/** Workday covers its sign-in buttons with a "click_filter" layer that takes the click instead. */
function pressTarget(el: HTMLElement): HTMLElement {
  return el.parentElement?.querySelector<HTMLElement>(':scope > [data-automation-id="click_filter"]') ?? el;
}

export function findAdvanceButton(root: ParentNode = document, opts: FindOptions = {}): AdvanceButton | null {
  const run = !!opts.run;
  let best: AdvanceButton | null = null;
  const all = deepQueryAll<HTMLElement>(root, CANDIDATES);
  const review = run && onReviewStep(root);
  all.forEach((el, i) => {
    if (isOwnUi(el) || !enabled(el) || !isVisible(el)) return;
    const label = labelOf(el);
    const words = normalize(label);
    if (!words || words.length > 40) return;
    const auto = AUTOMATION.find(([re]) => re.test(el.getAttribute('data-automation-id') ?? ''));
    let worded: [RegExp, AdvanceKind, number] | undefined = WORDING.find(([re]) => re.test(words));
    let why: string | undefined;
    const inChrome = !!el.closest('header, nav, [role="banner"], [role="navigation"]');
    if (run && !worded && !auto && RUN_SUBMIT.test(words)) worded = [RUN_SUBMIT, 'submit', 58];
    if (run && !worded && !auto && !inChrome && !NOT_ADVANCE.test(words) && !RUN_NOT_SUBMIT.test(words) && !el.closest('[role="search"]')) {
      // An unknown main button on a page the user has answered: it may well send it.
      if (looksPrimary(el) && filledBefore(el, root)) {
        worded = [/./, 'submit', 40];
        why = `"${label}" is the form's main button and its wording is unknown, so Run treats it as Submit`;
      }
    }
    if (!auto) {
      if (!worded || NOT_ADVANCE.test(words)) return;
      // Plain links only count as "Apply"; a "Next" link is usually a list's next page.
      if (el.tagName === 'A' && !el.hasAttribute('role') && worded[1] !== 'start') return;
    }
    // Workday's footer button says "Submit" on the last step.
    let kind = worded?.[1] ?? auto![1];
    const base = auto?.[2] ?? worded![2];
    if (run && !why && kind !== 'submit' && !inChrome) {
      if (kind === 'start' && filledBefore(el, root)) {
        // One-page forms (Lever, Greenhouse themes, small sites) end with "Apply".
        why = `"${label}" sits after answers the user gave, so it sends the application`;
      } else if (kind !== 'signIn' && !CLEARLY_NEXT.test(words) && submitsForm(el) && lastSubmitOfForm(el) && filledBefore(el, root)) {
        why = `"${label}" is the last button that submits this form`;
      } else if (kind === 'next' && review) {
        why = `the page is the review step, so "${label}" submits`;
      }
      if (why) kind = 'submit';
    }
    // Site headers carry "Sign in" and "Apply" links of their own; the form's buttons come first.
    const chrome = inChrome ? 30 : 0;
    const submit = el.getAttribute('type') === 'submit' ? 5 : 0;
    // The form's main action is usually its last button, so later ones win ties.
    const score = base + submit - chrome + i / (all.length + 1);
    if (!best || score > best.score) best = { element: el, label, kind, score, ...(why && { why }) };
  });
  return best;
}

/** Press the button the way a person would. */
export function pressAdvance(button: AdvanceButton): void {
  const el = pressTarget(button.element);
  el.scrollIntoView?.({ block: 'center' });
  realClick(el);
}
