/**
 * Sites that want a longer password than the saved one (#85: Citi's Workday asks for 12, the
 * saved one is 11). The owner's rule: add "!" to the end until it is long enough. The background
 * remembers how many it added for the site (by host), so signing in there later types the same
 * password. Nothing here sees or keeps the password itself except `lengthen`.
 */

const RULE =
  /\b(?:at least|a minimum of|minimum of|minimum|min\.?|must be|must contain|must have|should be|needs to be)\s*(?:at least\s*)?(\d{1,2})\s*(?:or more\s*)?(?:characters|chars|character)\b/i;
const RANGE = /\b(\d{1,2})\s*(?:-|to)\s*\d{2,3}\s*characters\b/i;

/** The shortest password a piece of text asks for ("must be at least 12 characters"), or 0. */
export function minLengthFromText(text: string): number {
  const t = text.replace(/\s+/g, ' ');
  const n = Number(RULE.exec(t)?.[1] ?? RANGE.exec(t)?.[1] ?? 0);
  return n >= 6 && n <= 64 ? n : 0;
}

/** The shortest password this password box asks for: its `minlength`, its hint, its form's rules, then the page's. */
export function passwordMinLength(el: HTMLInputElement): number {
  const attr = Number(el.getAttribute('minlength')) || 0;
  const doc = el.ownerDocument;
  const hints = (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => doc.getElementById(id)?.textContent ?? '')
    .join(' ');
  const scopes = [hints, el.closest('form')?.textContent ?? '', doc.body?.textContent ?? ''];
  const fromText = scopes.map(minLengthFromText).find((n) => n > 0) ?? 0;
  return Math.max(attr >= 6 && attr <= 64 ? attr : 0, fromText);
}

/** How many "!" to add for a site asking for `need` characters (0 when the saved one is long enough). */
export function bangsFor(savedLength: number, need: number): number {
  return need > savedLength ? need - savedLength : 0;
}

/** The password with `bangs` "!" at the end. */
export function lengthen(saved: string, bangs: number): string {
  return saved + '!'.repeat(Math.max(0, Math.min(bangs, 32)));
}
