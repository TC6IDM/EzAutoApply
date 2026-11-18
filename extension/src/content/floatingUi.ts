import { OWN_UI_ID } from '../fill/dom';
import type { FillProgress } from '../fill/types';
import { STOP_TEXT, type RunState, stepLine } from '../run/types';
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
.run { font-weight: 500; color: ${P.onInkMuted}; }
.run:hover { color: inherit; }
.run.on { color: inherit; box-shadow: inset 0 0 0 1px ${P.onInkMuted}; }
.close { display: inline-flex; padding: 8px 10px; color: ${P.onInkMuted}; }
.close svg { width: 14px; height: 14px; }
.summary { display: flex; gap: 10px; padding: 0 8px 0 4px; font-variant-numeric: tabular-nums; }
.summary:empty, .summary[hidden] { display: none; }
.progress { padding: 0 8px 0 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.progress:empty { display: none; }
.progress b { font-weight: 600; }
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
  private progressEl: HTMLElement;
  private toastEl: HTMLElement;
  private runBtn: HTMLButtonElement;
  private toastTimer?: number;
  /** The tab's Run to Submit, from the background. */
  private run: RunState | null = null;
  /** This frame's own run. */
  private busy = false;
  private busyLabel = 'Filling…';
  /** Every frame's runs together (a form in an iframe too), from the background. */
  private progress: FillProgress | null = null;

  constructor(onAutofill: () => void, onRun: (stop: boolean) => void = () => {}) {
    this.host = document.createElement('div');
    this.host.id = OWN_UI_ID;
    const root = this.host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${STYLE}</style>
      <div class="wrap">
        <div class="toast" role="status" hidden></div>
        <div class="bar">
          <span class="progress"></span>
          <span class="summary" aria-live="polite"></span>
          <button class="main" type="button" title="Autofill this application (Alt+Shift+F)">Autofill</button>
          <button class="run" type="button" title="Run to Submit: fill every page and stop before Submit">Run</button>
          <button class="close" type="button" aria-label="Hide EzAutoApply on this page">${CLOSE_ICON}</button>
        </div>
      </div>`;
    this.main = root.querySelector('.main')!;
    this.summary = root.querySelector('.summary')!;
    this.progressEl = root.querySelector('.progress')!;
    this.toastEl = root.querySelector('.toast')!;
    this.runBtn = root.querySelector('.run')!;
    this.runBtn.addEventListener('click', () => onRun(this.run?.status === 'running'));
    this.main.addEventListener('click', () => {
      this.main.classList.remove('pulse');
      onAutofill();
    });
    root.querySelector('.close')!.addEventListener('click', () => this.remove());
    document.documentElement.appendChild(this.host);
  }

  setBusy(busy: boolean, label = 'Filling…'): void {
    this.busy = busy;
    this.busyLabel = label;
    this.render();
  }

  /** "12 filled · 8 to go" while any frame is filling; the last run's summary comes back when done. */
  setProgress(progress: FillProgress | null): void {
    this.progress = progress;
    this.render();
  }

  /** Run to Submit's state: the step line while it runs, and the stop reason when it stops. */
  setRun(run: RunState): void {
    const was = this.run?.status;
    this.run = run;
    if (was === 'running' && run.status === 'stopped' && run.stop) {
      this.toast(run.stop.detail ? `${STOP_TEXT[run.stop.reason]}: ${run.stop.detail}` : STOP_TEXT[run.stop.reason], 10_000);
    }
    this.render();
  }

  private render(): void {
    const p = this.progress;
    const running = this.run?.status === 'running';
    const busy = this.busy || !!p || running;
    this.main.textContent = busy && !running ? this.busyLabel : 'Autofill';
    this.main.disabled = busy;
    this.runBtn.textContent = running ? 'Stop' : 'Run';
    this.runBtn.classList.toggle('on', running);
    this.runBtn.title = running ? 'Stop Run to Submit' : 'Run to Submit: fill every page and stop before Submit';
    // Not a live region: it changes with every field. The summary after the run is announced.
    this.progressEl.innerHTML = running
      ? `${stepLine(this.run!)}${p ? ` · <b>${p.filled}</b> filled` : ''}`
      : p
        ? `<b>${p.filled}</b> filled${p.remaining ? ` · <b>${p.remaining}</b> to go` : ''}`
        : '';
    this.summary.hidden = !!p || running;
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
