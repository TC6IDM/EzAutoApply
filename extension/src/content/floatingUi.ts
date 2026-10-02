import { OWN_UI_ID } from '../fill/dom';

/**
 * The small "Autofill" button shown on application pages (top frame only).
 * Lives in a closed shadow root so page styles can't touch it.
 */

const STYLE = `
:host { all: initial; }
.wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.bar { display: flex; align-items: center; gap: 2px; background: #111827; color: #f9fafb; border-radius: 999px; padding: 4px;
  box-shadow: 0 6px 20px rgba(0,0,0,.25); }
button { all: unset; cursor: pointer; border-radius: 999px; padding: 8px 14px; font-weight: 600; color: inherit; }
button:hover { background: #374151; }
button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
.main.pulse { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { background: #1d4ed8; } }
@media (prefers-reduced-motion: reduce) { .main.pulse { animation: none; background: #1d4ed8; } }
.close { padding: 8px 10px; color: #9ca3af; font-weight: 400; }
.summary { display: flex; gap: 10px; padding: 0 8px 0 4px; font-variant-numeric: tabular-nums; }
.summary:empty { display: none; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: 0; }
.toast { max-width: 320px; background: #111827; color: #f9fafb; border-radius: 10px; padding: 10px 12px; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
.toast[hidden] { display: none; }
`;

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
          <button class="main" type="button" title="Autofill this application (Alt+Shift+F)">⚡ Autofill</button>
          <button class="close" type="button" aria-label="Hide EzAutoApply on this page">✕</button>
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

  setBusy(busy: boolean): void {
    this.main.textContent = busy ? 'Filling…' : '⚡ Autofill';
    this.main.disabled = busy;
  }

  setSummary(s: Summary): void {
    const item = (n: number, color: string, label: string) =>
      n ? `<span title="${label}"><span class="dot" style="background:${color}"></span>${n}</span>` : '';
    this.summary.innerHTML =
      item(s.filled, '#22c55e', 'filled') + item(s.review, '#f59e0b', 'to review') + item(s.needs, '#ef4444', 'need your answer');
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
