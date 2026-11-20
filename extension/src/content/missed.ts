/**
 * A field the scan never found (#98): an applier filled it by hand and named it by its label.
 * The content script finds that label on the page, climbs to the block that holds its control and
 * hands back the block's markup with every value stripped. The background then swaps profile
 * values for placeholders (`redactionsFor`) and files it, so the Fixer can make a fixture and teach
 * `scan.ts` / `labels.ts` to find it.
 */

/** Anything a person can answer with. */
const CONTROL =
  'input:not([type="hidden"]), select, textarea, button, [role="combobox"], [role="radio"], [role="checkbox"], [role="listbox"], [role="textbox"], [role="switch"], [contenteditable="true"]';
/** Elements whose own text can be a question. */
const TEXTUAL = 'label, legend, h1, h2, h3, h4, h5, h6, p, span, div, td, th, dt, [role="heading"]';

const norm = (s: string) => s.toLowerCase().replace(/[*:?]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The page's markup of an element: scripts, styles and icons gone, every value stripped. */
export function cleanHtml(container: Element, max: number): string {
  const clone = container.cloneNode(true) as Element;
  // Noise that says nothing about the field (and can be large): scripts, styles, icons.
  for (const n of Array.from(clone.querySelectorAll('script, style, noscript, svg, template'))) n.remove();
  for (const n of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    n.removeAttribute('value');
    n.removeAttribute('style');
    // Which choice is picked is an answer, not structure.
    n.removeAttribute('selected');
    n.removeAttribute('checked');
    if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement) n.value = '';
    // A textarea's text is its starting value, and outerHTML writes it out.
    if (n instanceof HTMLTextAreaElement) n.textContent = '';
  }
  return clone.outerHTML.replace(/\s+/g, ' ').slice(0, max);
}

/**
 * "Report a field" (#114): this frame's form, values stripped. The block with the most things to
 * answer (a `form`, else `main`, else the body); null when the frame has nothing to answer.
 */
export function formSnapshot(root: Document, max = 120_000): string | null {
  const count = (el: Element) => el.querySelectorAll(CONTROL).length;
  if (!root.body || !count(root.body)) return null;
  const forms = Array.from(root.querySelectorAll('form')).filter((f) => count(f) > 0);
  const best = forms.sort((a, b) => count(b) - count(a))[0];
  // A form holding most of the page's controls; otherwise the page's main part, or all of it.
  const container = best && count(best) * 2 >= count(root.body) ? best : (root.querySelector('main, [role="main"]') ?? root.body);
  return cleanHtml(container, max);
}

/** The element whose own text best matches the label: the shortest text that holds it. */
function labelElement(root: Document, label: string): Element | null {
  const want = norm(label);
  if (want.length < 2) return null;
  let best: Element | null = null;
  let bestLen = Infinity;
  for (const el of Array.from(root.querySelectorAll(TEXTUAL))) {
    if (el.closest('script, style, template, [data-ezaa-ui]')) continue;
    const text = norm(el.textContent ?? '');
    // Only text about as long as the label: not a whole section that happens to contain it.
    if (!text.includes(want) || text.length > want.length + 60) continue;
    if (text.length < bestLen) {
      best = el;
      bestLen = text.length;
    }
  }
  return best;
}

export interface MissedField {
  /** The block around the label and its control, values stripped. */
  html: string;
  /** Whether the scan saw a control in it (it has a `data-ezaa-id`): seen but not filled, or never found. */
  seen: boolean;
}

/** The block for this label on the page, or null when this frame doesn't show it. */
export function findMissed(root: Document, label: string, max = 8000): MissedField | null {
  const at = labelElement(root, label);
  if (!at) return null;
  // Up to the nearest block that also holds something to answer with (6 levels at most).
  let block: Element = at;
  for (let el: Element | null = at, i = 0; el && i < 6; el = el.parentElement, i++) {
    if (el.matches(CONTROL) || el.querySelector(CONTROL)) {
      block = el;
      break;
    }
    block = el;
  }
  if (block === root.body || block === root.documentElement) block = at.parentElement ?? at;
  return { html: cleanHtml(block, max), seen: !!block.querySelector('[data-ezaa-id]') || block.hasAttribute('data-ezaa-id') };
}
