import { normalize } from '../core/normalize';
import { deepQueryAll, isOwnUi, isVisible } from '../fill/dom';
import { labelFor, textOf } from '../fill/labels';

/**
 * Content-side helpers for Run to Submit (#9): how Run tells that pressing Next moved the page
 * on, and the one checkbox it may tick by itself.
 */

const FIELDS = 'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radiogroup"], [role="checkbox"]';
const HEADINGS = 'h1, h2, h3, [role="heading"], legend';

/**
 * A short digest of what the page shows: its address, its visible headings and which fields are
 * visible (not their values, so typing doesn't change it, and not error text, so a page that
 * complained still counts as the same page).
 */
export function pageFingerprint(root: ParentNode = document, url = ''): string {
  const parts: string[] = [url.replace(/#.*$/, '')];
  for (const el of deepQueryAll<HTMLElement>(root, HEADINGS)) {
    if (!isOwnUi(el) && isVisible(el) && !el.closest('[role="alert"]')) parts.push(`h:${normalize(textOf(el)).slice(0, 80)}`);
  }
  for (const el of deepQueryAll<HTMLElement>(root, FIELDS)) {
    if (isOwnUi(el) || !isVisible(el)) continue;
    const name = el.getAttribute('name') || el.id || el.getAttribute('data-automation-id') || el.getAttribute('aria-label') || '';
    parts.push(`f:${el.tagName}:${(el as HTMLInputElement).type ?? ''}:${name}`);
  }
  return hash(parts.join('|'));
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}.${s.length}`;
}

/** "I have read and agree to the Terms and Conditions", "I accept the privacy policy". */
const TERMS =
  /\b(agree|accept|consent|acknowledge|read and understood)\b.{0,100}\b(terms|conditions|privacy|policy|notice|agreement)\b|\bterms (and|&) conditions\b|\bterms of (use|service)\b/;
/** Opt-ins that aren't terms: never ticked. */
const NOT_TERMS = /\b(newsletter|marketing|job alerts?|alerts|updates|offers|promotion(al)?|sms|text messages?|talent (community|network|pool)|future (roles|opportunities|openings))\b/;

/**
 * On an account-creation form only (#8: the owner said Run may tick the terms there), tick each
 * unticked "I accept the terms" box. Returns the scanned ids (`data-ezaa-id`) of the boxes it
 * ticked, so the Run doesn't count them as unanswered. Marketing opt-ins are left alone.
 */
export function acceptAccountTerms(root: ParentNode = document): string[] {
  const ticked: string[] = [];
  const boxes = deepQueryAll<HTMLElement>(root, 'input[type="checkbox"], [role="checkbox"]');
  for (const box of boxes) {
    if (isOwnUi(box)) continue;
    const input = box instanceof HTMLInputElement ? box : null;
    const checked = input ? input.checked : box.getAttribute('aria-checked') === 'true';
    if (checked || (input?.disabled ?? box.getAttribute('aria-disabled') === 'true')) continue;
    // A styled checkbox hides its input; the label next to it is what shows.
    const shown = isVisible(box) || (!!input?.labels?.length && Array.from(input.labels).some(isVisible));
    if (!shown) continue;
    const words = normalize(`${labelFor(box)} ${box.getAttribute('aria-label') ?? ''}`);
    const workday = box.getAttribute('data-automation-id') === 'createAccountCheckbox';
    if (!workday && (!TERMS.test(words) || NOT_TERMS.test(words))) continue;
    box.click();
    const id = box.closest('[data-ezaa-id]')?.getAttribute('data-ezaa-id') ?? box.getAttribute('data-ezaa-id');
    if (id) ticked.push(id);
  }
  return ticked;
}
