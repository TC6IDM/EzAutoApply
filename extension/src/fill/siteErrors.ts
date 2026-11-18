import { cleanText, normalize } from '../core/normalize';
import { byId, deepQueryAll, isOwnUi, isVisible } from './dom';
import { labelFor, textOf } from './labels';
import type { FieldReport } from './types';

/**
 * The site's own validation messages after Next (#12, docs/agent-fleet-plan.md §6.6),
 * mapped to the scanned fields (`data-ezaa-id`). When Run presses Next and the page
 * doesn't move on, it reads these, marks each field `needs` with the site's words, and
 * stops (`validationErrors`). The messages also feed incidents.
 */
export interface SiteError {
  /** The scanned field it belongs to, or null for a page-level message. */
  fieldId: string | null;
  message: string;
}

const ID_ATTR = 'data-ezaa-id';
const MAX_MESSAGE = 200;
/** Where sites put field errors: ARIA alerts, Workday's error ids, and the usual class names. */
const ERROR_SELECTOR = [
  '[role="alert"]',
  '[data-automation-id="errorMessage"]',
  '[data-automation-id="inputError"]',
  '[data-automation-id="errorItem"]',
  '.error-message',
  '.field-error',
  '.invalid-feedback',
  '.helper-text.error',
  '.error',
  '[class*="error" i]',
].join(', ');
/** Error-ish words, so a "Required" hint or a heading in an alert box doesn't count by itself. */
const ERROR_WORDS = /\b(required|invalid|must|please|enter|select|choose|error|missing|too (long|short)|not (valid|allowed)|can'?t be blank|is blank|match)\b/;

const message = (el: Element) => cleanText(textOf(el)).replace(/^error:?\s*/i, '');

function fieldOf(el: Element): string | null {
  return el.closest(`[${ID_ATTR}]`)?.getAttribute(ID_ATTR) ?? el.querySelector(`[${ID_ATTR}]`)?.getAttribute(ID_ATTR) ?? null;
}

/** The one scanned field in the error's nearest container (a field wrapper or Workday formField). */
function nearestField(el: Element): string | null {
  let node: Element | null = el.parentElement;
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    const ids = new Set(Array.from(node.querySelectorAll(`[${ID_ATTR}]`)).map((f) => f.getAttribute(ID_ATTR)));
    if (ids.size === 1) return [...ids][0];
    if (ids.size > 1) return null;
  }
  return null;
}

/** A summary or banner message names its field ("The field Phone Number is required"). */
function fieldNamedIn(text: string, fields: { id: string; label: string }[]): string | null {
  const words = ` ${normalize(text)} `;
  const named = fields.filter((f) => f.label.length >= 3 && words.includes(` ${f.label} `));
  named.sort((a, b) => b.label.length - a.label.length);
  return named[0]?.id ?? null;
}

export function readSiteErrors(root: ParentNode = document): SiteError[] {
  const fields = deepQueryAll<HTMLElement>(root, `[${ID_ATTR}]`).map((el) => ({
    id: el.getAttribute(ID_ATTR)!,
    el,
    label: normalize(labelFor(el)),
  }));
  const out: SiteError[] = [];
  const seen = new Set<string>();
  const add = (fieldId: string | null, text: string) => {
    const m = text.slice(0, MAX_MESSAGE);
    if (!m) return;
    const key = `${fieldId}|${m}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ fieldId, message: m });
  };
  const used = new Set<Element>();
  const silent: string[] = []; // marked invalid, pointing at no message

  // 1. Fields the site marked invalid, with the message they point at.
  for (const f of fields) {
    const invalid = f.el.getAttribute('aria-invalid') === 'true' || !!f.el.querySelector('[aria-invalid="true"]');
    if (!invalid || !isVisible(f.el)) continue;
    const control = f.el.getAttribute('aria-invalid') === 'true' ? f.el : f.el.querySelector('[aria-invalid="true"]')!;
    const refs = `${control.getAttribute('aria-errormessage') ?? ''} ${control.getAttribute('aria-describedby') ?? ''}`.split(/\s+/).filter(Boolean);
    const said = refs.map((r) => byId(control, r)).filter((e): e is HTMLElement => !!e && isVisible(e) && ERROR_WORDS.test(normalize(textOf(e))));
    said.forEach((e) => used.add(e));
    if (said.length) add(f.id, said.map(message).join(' '));
    else silent.push(f.id);
  }

  // 2. Error messages on the page: by container, by a summary link to the field, or by naming it.
  for (const el of deepQueryAll<HTMLElement>(root, ERROR_SELECTOR)) {
    if (used.has(el) || isOwnUi(el) || !isVisible(el)) continue;
    // The innermost match only: a wrapper with class "has-error" around a field holds its message.
    if (el.querySelector(ERROR_SELECTOR) && !el.matches('[role="alert"]')) continue;
    if (el.querySelector(`[${ID_ATTR}]`)) continue;
    const text = message(el);
    if (!text || text.length > MAX_MESSAGE * 2 || !ERROR_WORDS.test(normalize(text))) continue;
    const link = el.closest('a[href^="#"]') ?? el.querySelector('a[href^="#"]');
    const target = link ? byId(el, decodeURIComponent(link.getAttribute('href')!.slice(1))) : null;
    const fieldId = (target && fieldOf(target)) ?? nearestField(el) ?? fieldNamedIn(text, fields);
    // An alert listing several messages: one per item.
    const items = el.matches('[role="alert"]') ? Array.from(el.querySelectorAll('li')) : [];
    if (items.length) {
      for (const li of items) {
        const t = message(li);
        const a = li.querySelector('a[href^="#"]');
        const to = a ? byId(li, decodeURIComponent(a.getAttribute('href')!.slice(1))) : null;
        add((to && fieldOf(to)) ?? fieldNamedIn(t, fields), t);
      }
      continue;
    }
    add(fieldId, text);
  }
  // Marked invalid with no message anywhere on the page: say so.
  for (const id of silent) if (!out.some((e) => e.fieldId === id)) add(id, 'The site marked this field as not valid.');
  // A message already given for a field doesn't also count as a page-level one.
  const placed = new Set(out.filter((e) => e.fieldId).map((e) => e.message));
  return out.filter((e) => e.fieldId || !placed.has(e.message));
}

/**
 * The fill report with the site's complaints applied: each field it named becomes `needs`
 * with the site's words as the note. Messages that name no field come back in `unplaced`.
 */
export function applySiteErrors(reports: FieldReport[], errors: SiteError[]): { reports: FieldReport[]; unplaced: string[] } {
  const byField = new Map<string, string[]>();
  const unplaced: string[] = [];
  for (const e of errors) {
    if (e.fieldId && reports.some((r) => r.id === e.fieldId)) byField.set(e.fieldId, [...(byField.get(e.fieldId) ?? []), e.message]);
    else unplaced.push(e.message);
  }
  return {
    reports: reports.map((r) => {
      const said = byField.get(r.id);
      return said ? { ...r, status: 'needs' as const, note: `The site says: ${said.join(' ')}` } : r;
    }),
    unplaced,
  };
}
