import { OWN_UI_ID } from '../fill/dom';
import { PALETTE as P } from './palette';

/**
 * The small "Autofill" button shown on application pages (top frame only).
 * Lives in a closed shadow root so page styles can't touch it.
 */

const STYLE = `
:host { all: initial; }
.wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.bar { display: flex; align-items: center; gap: 2px; background: ${P.ink}; color: ${P.onInk}; border-radius: 999px; padding: 4px;
  box-shadow: 0 4px 14px oklch(0% 0 0 / .22); }
button { all: unset; cursor: pointer; border-radius: 999px; padding: 8px 14px; font-weight: 600; color: inherit;
  transition: background-color 140ms cubic-bezier(.2, .8, .2, 1); }
button:hover { background: ${P.inkHover}; }
button:focus-visible { outline: 2px solid ${P.accentOnInk}; outline-offset: 2px; }
button:disabled { cursor: default; color: ${P.onInkMuted}; }
.main { position: relative; isolation: isolate; }
/* A new step appeared: the button glows three times, then keeps a ring until clicked. */
.main.pulse { box-shadow: inset 0 0 0 2px ${P.accentOnInk}; }
.main.pulse::after { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: ${P.accent};
  opacity: 0; animation: glow 1.6s ease-in-out 3; }
@keyframes glow { 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } .main.pulse::after { animation: none; } }
.close { display: inline-flex; padding: 8px 10px; color: ${P.onInkMuted}; }
.close svg { width: 14px; height: 14px; }
.summary { display: flex; gap: 10px; padding: 0 8px 0 4px; font-variant-numeric: tabular-nums; }
.summary:empty { display: none; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: 0; }
.dot.filled { background: ${P.onInkMuted}; }
.dot.review { background: ${P.warnOnInk}; }
.dot.needs { background: ${P.accentOnInk}; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.toast { max-width: 320px; background: ${P.ink}; color: ${P.onInk}; border-radius: 10px; padding: 10px 12px;
  box-shadow: 0 4px 14px oklch(0% 0 0 / .22); }
.toast[hidden] { display: none; }
`;

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

export interface Summary {
  filled: number;
  review: number;
  needs: number;
}

export class FloatingUi {
  private host: HTMLElement;
  private main: HTMLButtonElement;
  private summary: HTMLElement;
  private toastEl: HTMLElement;
  private toastTimer?: number;

  constructor(onAutofill: () => void) {
    this.host = document.createElement('div');
    this.host.id = OWN_UI_ID;
    const root = this.host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${STYLE}</style>
      <div class="wrap">
        <div class="toast" role="status" hidden></div>
        <div class="bar">
          <span class="summary" aria-live="polite"></span>
          <button class="main" type="button" title="Autofill this application (Alt+Shift+F)">Autofill</button>
          <button class="close" type="button" aria-label="Hide EzAutoApply on this page">${CLOSE_ICON}</button>
        </div>
      </div>`;
    this.main = root.querySelector('.main')!;
    this.summary = root.querySelector('.summary')!;
    this.toastEl = root.querySelector('.toast')!;
    this.main.addEventListener('click', () => {
      this.main.classList.remove('pulse');
      onAutofill();
    });
    root.querySelector('.close')!.addEventListener('click', () => this.remove());
    document.documentElement.appendChild(this.host);
  }

  setBusy(busy: boolean, label = 'Filling…'): void {
    this.main.textContent = busy ? label : 'Autofill';
    this.main.disabled = busy;
  }

  setSummary(s: Summary): void {
    const item = (n: number, kind: string, label: string) =>
      n ? `<span title="${n} ${label}"><span class="dot ${kind}" aria-hidden="true"></span>${n}<span class="sr"> ${label}</span></span>` : '';
    this.summary.innerHTML =
      item(s.filled, 'filled', 'filled') + item(s.review, 'review', 'to check') + item(s.needs, 'needs', s.needs === 1 ? 'needs you' : 'need you');
  }

  /** A multi-step form showed new fields. */
  notifyNewFields(): void {
    this.main.classList.add('pulse');
    this.main.title = 'New fields on this step: click to autofill them';
  }

  toast(message: string, ms = 6000): void {
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.hidden = true), ms);
  }

  remove(): void {
    this.host.remove();
  }

  get attached(): boolean {
    return this.host.isConnected;
  }
}
