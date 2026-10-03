import { cleanText, normalize } from '../core/normalize';
import { deepQueryAll, isOwnUi, isVisible } from './dom';
import { realClick } from './fillers';
import { textOf } from './labels';

/**
 * The page's own button that moves an application on: start it, sign in, go to the next step,
 * or submit. EzAutoApply only presses it when the user presses Advance in the side panel.
 */

export type AdvanceKind = 'start' | 'signIn' | 'next' | 'submit';

export interface AdvanceButton {
  element: HTMLElement;
  label: string;
  kind: AdvanceKind;
  score: number;
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

export function findAdvanceButton(root: ParentNode = document): AdvanceButton | null {
  let best: AdvanceButton | null = null;
  const all = deepQueryAll<HTMLElement>(root, CANDIDATES);
  all.forEach((el, i) => {
    if (isOwnUi(el) || !enabled(el) || !isVisible(el)) return;
    const label = labelOf(el);
    const words = normalize(label);
    if (!words || words.length > 40) return;
    const auto = AUTOMATION.find(([re]) => re.test(el.getAttribute('data-automation-id') ?? ''));
    const worded = WORDING.find(([re]) => re.test(words));
    if (!auto) {
      if (!worded || NOT_ADVANCE.test(words)) return;
      // Plain links only count as "Apply"; a "Next" link is usually a list's next page.
      if (el.tagName === 'A' && !el.hasAttribute('role') && worded[1] !== 'start') return;
    }
    // Workday's footer button says "Submit" on the last step.
    const kind = worded?.[1] ?? auto![1];
    const base = auto?.[2] ?? worded![2];
    // Site headers carry "Sign in" and "Apply" links of their own; the form's buttons come first.
    const inChrome = el.closest('header, nav, [role="banner"], [role="navigation"]') ? 30 : 0;
    const submit = el.getAttribute('type') === 'submit' ? 5 : 0;
    // The form's main action is usually its last button, so later ones win ties.
    const score = base + submit - inChrome + i / (all.length + 1);
    if (!best || score > best.score) best = { element: el, label, kind, score };
  });
  return best;
}

/** Press the button the way a person would. */
export function pressAdvance(button: AdvanceButton): void {
  const el = pressTarget(button.element);
  el.scrollIntoView?.({ block: 'center' });
  realClick(el);
}
