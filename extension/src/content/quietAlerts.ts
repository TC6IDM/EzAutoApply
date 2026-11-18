/**
 * Pages that say things with `alert()` (#83: Cisco's "You have Uploaded Resume Successfully"
 * after the resume upload) freeze until someone presses OK, which stalls Run and the fleet's
 * appliers. While the extension fills or advances a page, its alerts are closed at once and their
 * text is kept on the page instead. Only `alert`: a `confirm` asks a question, and the page goes on
 * asking it.
 *
 * The content script (isolated world) marks the busy time on the page's root element; the guard
 * runs in the page's own world (entrypoints/alerts.content.ts), since only there is `window.alert`
 * the page's.
 */

/** Until when (ms since 1970) the page's alerts are closed. */
export const QUIET_ATTR = 'data-ezaa-quiet-alerts';
/** The last alert closed this way, for the report and for a person who looks. */
export const LAST_ALERT_ATTR = 'data-ezaa-last-alert';

/** Close the page's alerts for the next `ms` (the content script's side). `ms <= 0` ends it. */
export function quietAlerts(doc: Document, ms: number, now = Date.now()): void {
  doc.documentElement?.setAttribute(QUIET_ATTR, String(now + Math.max(0, ms)));
}

/** The page's side: wrap `window.alert` so it closes itself while the page is marked busy. */
export function installAlertGuard(win: Window & typeof globalThis): void {
  const original = win.alert;
  if ((original as { ezaa?: boolean }).ezaa) return;
  const guard = function alert(message?: unknown): void {
    const root = win.document.documentElement;
    const until = Number(root?.getAttribute(QUIET_ATTR) || 0);
    if (until > Date.now()) {
      root?.setAttribute(LAST_ALERT_ATTR, String(message ?? '').slice(0, 300));
      console.info('[EzAutoApply] closed the page’s message while filling:', message);
      return;
    }
    return original.call(win, message as string);
  };
  (guard as { ezaa?: boolean }).ezaa = true;
  win.alert = guard;
}
