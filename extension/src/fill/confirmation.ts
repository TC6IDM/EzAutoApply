import { cleanText, normalize } from '../core/normalize';
import { findAdvanceButton } from './advance';
import { deepQueryAll, isOwnUi, isVisible } from './dom';
import { textOf } from './labels';

/**
 * The page that says an application went through ("Thank you for applying") (#14). The
 * panel shows it in place of the Advance button, Run (#9) ends there, and the bridge (#17)
 * marks the job submitted. Wording or the address must say so, and the page must not still
 * offer a Submit button (a form whose help text quotes the thank-you message isn't one).
 */
export interface Confirmation {
  /** What the page said, or which address it was ("Thank you for applying!"). */
  detail: string;
}

const SAID =
  /\b(thank(s| you) for (applying|your application|submitting|your interest and application)|(your )?application (has been |was )?(successfully )?(submitted|received|sent|complete)|we('ve| have) received your application|you('ve| have)( successfully)? applied|successfully (applied|submitted)|application submitted)\b/;
const WHERE = 'h1, h2, h3, h4, [role="heading"], [role="dialog"] p, [role="alert"], [role="status"], main p, [data-automation-id*="congratulations" i]';
/** Addresses ATSs send applicants to afterwards: Greenhouse /confirmation, Lever /thanks, … */
const URL_SAID = /\/(confirmation|thank-?you|thanks|application-?submitted|submitted|success)(\/|$|\?|#)/i;

export function confirmationOf(root: ParentNode = document, url = ''): Confirmation | null {
  if (findAdvanceButton(root, { run: true })?.kind === 'submit') return null;
  for (const el of deepQueryAll<HTMLElement>(root, WHERE)) {
    if (isOwnUi(el) || !isVisible(el)) continue;
    const text = cleanText(textOf(el));
    if (text.length > 240) continue;
    if (SAID.test(normalize(text))) return { detail: text };
  }
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    /* no address to go by */
  }
  return path && URL_SAID.test(path) ? { detail: `the address ends in ${path.split('/').filter(Boolean).pop()}` } : null;
}
