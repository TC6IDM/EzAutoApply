/**
 * Nothing is drawn on the page while filling; the side panel says what was filled. The one mark
 * EzAutoApply leaves is a brief pulse on a field the user jumped to from the side panel.
 */

import { PALETTE } from './palette';

/** `oklch(L C H)` with an alpha. */
const alpha = (color: string, a: number) => color.replace(/\)$/, ` / ${a})`);

const STYLE_ID = 'ezaa-highlight-style';

// With reduced motion, the ring just shows for the same time instead of fading.
const CSS = `
[data-ezaa-flash] { animation: ezaa-flash 1.4s cubic-bezier(.2, .8, .2, 1) 1 !important; }
@keyframes ezaa-flash {
  0%, 40% { box-shadow: 0 0 0 4px ${alpha(PALETTE.accent, 0.55)}; }
  100% { box-shadow: 0 0 0 0 ${alpha(PALETTE.accent, 0)}; }
}
@media (prefers-reduced-motion: reduce) {
  [data-ezaa-flash] { animation: none !important; outline: 3px solid ${PALETTE.accent} !important; outline-offset: 2px !important; }
}
`;

function ensureStyle(root: Document | ShadowRoot): void {
  if (root.querySelector?.(`#${STYLE_ID}`)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  const isDoc = (r: Document | ShadowRoot): r is Document => r.nodeType === Node.DOCUMENT_NODE;
  (isDoc(root) ? root.head ?? root.documentElement : root).appendChild(style);
}

/** Briefly pulse a field so it's easy to spot after scrolling to it. */
export function flash(el: HTMLElement): void {
  ensureStyle(el.getRootNode() as Document | ShadowRoot);
  el.removeAttribute('data-ezaa-flash');
  void el.offsetWidth; // restart the animation
  el.setAttribute('data-ezaa-flash', '');
  setTimeout(() => el.removeAttribute('data-ezaa-flash'), 1500);
}
