import { cleanText } from '../core/normalize';
import { byId } from './dom';

/**
 * Work out the question a form control is asking. Forms label things in many
 * ways, so this tries, in order: aria-labelledby, <label>, aria-label, a
 * fieldset legend (for groups), then the text just before the control inside
 * the smallest container that holds no other field.
 */

export const CONTROL_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [role="combobox"], [role="radio"], [role="checkbox"], [aria-haspopup="listbox"]:not(input)';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SELECT', 'OPTION', 'TEXTAREA', 'INPUT', 'BUTTON', 'TEMPLATE', 'SVG']);

const MAX_LABEL = 300;

/** Visible-ish text of a subtree, skipping controls, scripts and our own markers. */
export function textOf(node: Node, skip?: Set<Node>): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (skip?.has(n)) return;
    if (n.nodeType === Node.TEXT_NODE) {
      parts.push(n.textContent ?? '');
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    // Nested controls are skipped, but asking for a button's own text (a "Select One" dropdown) must work.
    if (n !== node && SKIP_TAGS.has(el.tagName.toUpperCase())) return;
    if (el.getAttribute('aria-hidden') === 'true' && !/^\s*\*\s*$/.test(el.textContent ?? '')) return;
    if ((el as HTMLElement).hidden) return;
    for (const c of Array.from(el.childNodes)) walk(c);
    // Block-level boundaries become spaces so "Name" + "Required" don't fuse.
    parts.push(' ');
  };
  walk(node);
  return cleanText(parts.join(''));
}

function labelledBy(el: Element): string {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return '';
  return cleanText(
    ids
      .split(/\s+/)
      .map((id) => {
        const target = byId(el, id);
        return target && target !== el ? textOf(target) : '';
      })
      .join(' '),
  );
}

function explicitLabels(el: Element): string {
  const labels = (el as HTMLInputElement).labels;
  if (labels?.length) {
    const t = cleanText(Array.from(labels).map((l) => textOf(l)).join(' '));
    if (t.replace(/[*:\s]/g, '')) return t;
  }
  const id = el.getAttribute('id');
  if (id) {
    const doc = el.getRootNode() as Document | ShadowRoot;
    const lab = doc.querySelector?.(`label[for="${CSS.escape(id)}"]`);
    if (lab) return textOf(lab);
  }
  return '';
}

/** Text that precedes `first` inside `container`, i.e. the question above the control. */
function textBefore(container: Element, first: Element, skip?: Set<Node>): string {
  const parts: string[] = [];
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(first.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING)) break;
    let p: Element | null = n.parentElement;
    let skipped = false;
    while (p && p !== container) {
      if (SKIP_TAGS.has(p.tagName.toUpperCase()) || (p as HTMLElement).hidden || skip?.has(p)) {
        skipped = true;
        break;
      }
      p = p.parentElement;
    }
    if (!skipped) parts.push(n.textContent ?? '', ' ');
  }
  const t = cleanText(parts.join(''));
  return t.length > MAX_LABEL ? t.slice(t.length - MAX_LABEL) : t;
}

/**
 * Climb from the control to the largest ancestor that still contains no other
 * field, and use the text before the control in it.
 */
export function contextLabel(el: Element, members: Element[] = [el], controlSelector = CONTROL_SELECTOR): string {
  const own = new Set<Element>(members);
  const skip = new Set<Node>();
  for (const m of members) for (const l of Array.from((m as HTMLInputElement).labels ?? [])) skip.add(l);
  let node = el.parentElement;
  let best = '';
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    if (node.tagName === 'FORM' || node.tagName === 'BODY') break;
    const foreign = Array.from(node.querySelectorAll(controlSelector)).some(
      (c) => !own.has(c) && !members.some((m) => m.contains(c) || c.contains(m)),
    );
    if (foreign) break;
    const t = textBefore(node, members[0], skip);
    if (t) {
      best = t;
      break;
    }
  }
  return best;
}

/** The label of a single control. */
/** Text a dropdown says about itself ("Select One Required") rather than the question it asks. */
const WIDGET_TEXT = /^(select( one| an option)?|choose( one)?|please (select|choose)( one)?|search|-+)?\s*(required)?\s*\*?$/i;
const TRAILING_WIDGET_TEXT = /\s*(select one|select an option|please select( one)?|choose one)(\s+required)?\s*$/i;

/** Developer names that say what the control is, not what it asks ("file-input", "text_field", "upload"). */
const GENERIC_NAME = /^(file|text|date|input|upload|attachment|field|select|dropdown|picker)([\s_-]?(input|field|upload|picker|select|box))?$/i;
/** What upload widgets say about themselves rather than about the document they want. */
const UPLOAD_TEXT = /^(no file (selected|chosen)|choose files?\*?|select files?|browse|or|attach( a)?( file)?|upload( a)? files?( \(.*\))?|drop files? here|drag (and|&) drop.*|dropbox|google drive|enter manually)$/i;

function meaningful(text: string): string {
  const t = cleanText(text);
  return t && !WIDGET_TEXT.test(t) && !GENERIC_NAME.test(t) && !UPLOAD_TEXT.test(t) ? t : '';
}

/**
 * The label above an upload widget. Widgets put their own text ("Choose File",
 * "No file selected") next to the input, so this walks outward past that text to
 * the nearest earlier text that isn't part of the widget ("Resume*").
 */
export function uploadLabel(input: Element): string {
  let node: Element | null = input;
  for (let level = 0; node && level < 6; level++, node = node.parentElement) {
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.matches(CONTROL_SELECTOR) || sib.querySelector(CONTROL_SELECTOR)) return '';
      const t = textOf(sib);
      if (t && !UPLOAD_TEXT.test(t) && !GENERIC_NAME.test(t)) return t.slice(0, 200);
    }
  }
  return '';
}

/** Workday wraps each field in a data-automation-id="formField-…" container whose <label> holds the question. */
export function fieldContainerLabel(el: Element): string {
  const container = el.closest('[data-automation-id^="formField"]');
  const label = container?.querySelector('label, legend');
  return label && !label.contains(el) ? textOf(label) : '';
}

export function labelFor(el: Element): string {
  const label =
    meaningful(labelledBy(el)) ||
    meaningful(explicitLabels(el)) ||
    meaningful(fieldContainerLabel(el)) ||
    meaningful(el.getAttribute('aria-label') ?? '') ||
    meaningful(contextLabel(el)) ||
    meaningful(el.getAttribute('title') ?? '');
  return label.replace(TRAILING_WIDGET_TEXT, '');
}

/** The question for a radio/checkbox group. */
export function groupLabel(members: Element[], container: Element | null): string {
  if (container) {
    const byAria = labelledBy(container) || cleanText(container.getAttribute('aria-label') ?? '');
    if (byAria) return byAria;
    const legend = container.tagName === 'FIELDSET' ? container.querySelector(':scope > legend') : null;
    if (legend) return textOf(legend);
  }
  const fs = members[0].closest('fieldset');
  if (fs && members.every((m) => fs.contains(m))) {
    const legend = fs.querySelector(':scope > legend');
    if (legend) return textOf(legend);
  }
  return contextLabel(members[0], members);
}

/** The text of one option in a radio/checkbox group. */
export function optionLabel(el: Element): string {
  const t = labelledBy(el) || explicitLabels(el) || cleanText(el.getAttribute('aria-label') ?? '');
  if (t) return t;
  // <input type=radio><span>Yes</span> without a <label>
  let sib = el.nextSibling;
  while (sib && !(sib.textContent ?? '').trim()) sib = sib.nextSibling;
  if (sib && !(sib instanceof Element && sib.matches(CONTROL_SELECTOR))) return cleanText(sib.textContent ?? '');
  return cleanText((el as HTMLInputElement).value ?? el.textContent ?? '');
}

export function helpText(el: Element): string {
  const ids = el.getAttribute('aria-describedby');
  if (!ids) return '';
  return cleanText(
    ids
      .split(/\s+/)
      .map((id) => {
        const t = byId(el, id);
        return t ? textOf(t) : '';
      })
      .join(' '),
  ).slice(0, 300);
}

/** Nearest heading above the element, for section context. */
export function sectionOf(el: Element, headings: Element[]): string {
  let found: Element | null = null;
  for (const h of headings) {
    if (h.contains(el)) continue;
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
    else break;
  }
  return found ? textOf(found).slice(0, 120) : '';
}
