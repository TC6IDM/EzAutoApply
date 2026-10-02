/** Small DOM helpers that understand open shadow roots. */

export const OWN_UI_ID = 'ezaa-root';

/** querySelectorAll that also descends into open shadow roots, in document order. */
export function deepQueryAll<T extends Element = Element>(root: ParentNode, selector: string): T[] {
  const out: T[] = [];
  const visit = (node: ParentNode) => {
    for (const el of Array.from(node.querySelectorAll('*'))) {
      if (el.matches(selector)) out.push(el as T);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(root);
  return out;
}

export function rootOf(el: Element): Document | ShadowRoot {
  const r = el.getRootNode();
  return r instanceof ShadowRoot ? r : el.ownerDocument;
}

export function byId(el: Element, id: string): HTMLElement | null {
  return rootOf(el).getElementById(id) ?? el.ownerDocument.getElementById(id);
}

export function isOwnUi(el: Element): boolean {
  return !!el.closest(`#${OWN_UI_ID}`);
}

/** Visible to the user: rendered, not hidden by a modal backdrop or `hidden`. */
export function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  if (he.hidden || el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const view = el.ownerDocument.defaultView;
  if (!view) return true;
  const style = view.getComputedStyle(he);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  // checkVisibility also catches display:none and content-visibility on ancestors.
  if (typeof he.checkVisibility === 'function') return he.checkVisibility({ visibilityProperty: true });
  let p: HTMLElement | null = he.parentElement;
  while (p) {
    if (view.getComputedStyle(p).display === 'none') return false;
    p = p.parentElement;
  }
  return true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `fn` returns something truthy, or give up after `timeoutMs`. */
export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 1500, intervalMs = 50): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}

/** Smallest ancestor containing every element in the list. */
export function commonAncestor(els: Element[]): HTMLElement | null {
  if (!els.length) return null;
  let node: HTMLElement | null = els[0].parentElement;
  while (node && !els.every((e) => node!.contains(e))) node = node.parentElement;
  return node;
}
