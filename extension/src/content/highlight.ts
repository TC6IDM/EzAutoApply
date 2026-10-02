import type { FieldDescriptor, FillStatus } from '../fill/types';

/** Outline fields by outcome: green filled, amber review, red needs you, blue edited by you. */

const STATUS_ATTR = 'data-ezaa-status';
const STYLE_ID = 'ezaa-highlight-style';

const CSS = `
[${STATUS_ATTR}="filled"] { outline: 2px solid #16a34a !important; outline-offset: 2px !important; }
[${STATUS_ATTR}="review"] { outline: 2px solid #d97706 !important; outline-offset: 2px !important; }
[${STATUS_ATTR}="needs"]  { outline: 2px dashed #dc2626 !important; outline-offset: 2px !important; }
[${STATUS_ATTR}="user"]   { outline: 2px solid #2563eb !important; outline-offset: 2px !important; }
[data-ezaa-flash] { animation: ezaa-flash 1.4s ease-out 1 !important; }
@keyframes ezaa-flash { 0%, 40% { box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.55); } 100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0); } }
`;

export type HighlightStatus = FillStatus | 'user';

function ensureStyle(root: Document | ShadowRoot): void {
  if (root.querySelector?.(`#${STYLE_ID}`)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (root instanceof Document ? root.head ?? root.documentElement : root).appendChild(style);
}

/** The element to outline: hidden file inputs and radios are outlined via a visible container. */
function target(f: FieldDescriptor): HTMLElement {
  if (f.kind !== 'file') return f.element;
  let el: HTMLElement | null = f.element;
  for (let i = 0; el && i < 4; i++) {
    if (el.getClientRects().length && el.offsetWidth > 20) return el;
    el = el.parentElement;
  }
  return f.element.parentElement ?? f.element;
}

export function highlight(f: FieldDescriptor, status: HighlightStatus): void {
  const el = target(f);
  ensureStyle(el.getRootNode() as Document | ShadowRoot);
  if (status === 'skipped' || status === 'prefilled') el.removeAttribute(STATUS_ATTR);
  else el.setAttribute(STATUS_ATTR, status);
}

/** Briefly pulse a field so it's easy to spot after scrolling to it. */
export function flash(el: HTMLElement): void {
  ensureStyle(el.getRootNode() as Document | ShadowRoot);
  el.removeAttribute('data-ezaa-flash');
  void el.offsetWidth; // restart the animation
  el.setAttribute('data-ezaa-flash', '');
  setTimeout(() => el.removeAttribute('data-ezaa-flash'), 1500);
}

export function clearAllHighlights(root: ParentNode = document): void {
  for (const el of Array.from(root.querySelectorAll(`[${STATUS_ATTR}]`))) el.removeAttribute(STATUS_ATTR);
}
