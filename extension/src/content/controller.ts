import type { SystemOneResponse } from '../classifier/systemone';
import { isPlaceholderOption } from '../core/options';
import type { Settings } from '../core/types';
import { type FillContext, fillField, isOn, readDropdownOptions } from '../fill/fillers';
import { textOf } from '../fill/labels';
import type { Classifier } from '../fill/match/classify';
import { resolveFields } from '../fill/pipeline';
import { acknowledgePrivacyNotices } from '../fill/consent';
import { expandRepeatingSections } from '../fill/repeat';
import { scanFields } from '../fill/scan';
import type { FieldDescriptor, FieldReport, FillStatus, FrameReport, Resolution } from '../fill/types';
import {
  type AnswerValue,
  call,
  type ContentContext,
  type ContentToBackground,
  type DocumentResponse,
} from '../messages';
import type { FloatingUi } from './floatingUi';
import { clearAllHighlights, flash, highlight } from './highlight';

export type Send = (msg: ContentToBackground) => Promise<unknown>;

/** Read what a field currently holds, as the user would describe it. */
export function readValue(f: FieldDescriptor): AnswerValue {
  const el = f.element;
  switch (f.kind) {
    case 'select': {
      const s = el as HTMLSelectElement;
      const picked = Array.from(s.selectedOptions)
        .map((o) => ({ label: (o.label || o.text).trim(), value: o.value }))
        .filter((o) => !isPlaceholderOption(o))
        .map((o) => o.label);
      return s.multiple ? picked : (picked[0] ?? '');
    }
    case 'radio': {
      const i = f.members.findIndex(isOn);
      return i >= 0 ? f.options[i].label : '';
    }
    case 'checkboxGroup':
      return f.members.flatMap((m, i) => (isOn(m) ? [f.options[i].label] : []));
    case 'checkbox': {
      const m = f.members[0] ?? (el as HTMLInputElement);
      return isOn(m);
    }
    case 'combobox':
      return el instanceof HTMLInputElement ? el.value : textOf(el);
    case 'file':
      return Array.from((el as HTMLInputElement).files ?? []).map((x) => x.name).join(', ');
    case 'password':
      // Never read a password back out of the page.
      return (el as HTMLInputElement).value ? '••••••••' : '';
    default:
      return (el as HTMLInputElement).value;
  }
}

/**
 * The HTML around a field, trimmed and with every value stripped, so a user can
 * send it in when a field on some site isn't filled correctly.
 */
export function debugHtml(f: FieldDescriptor): string {
  const container = f.element.closest('[data-automation-id^="formField"]') ?? f.element.parentElement?.parentElement ?? f.element;
  const clone = container.cloneNode(true) as Element;
  for (const n of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    n.removeAttribute('value');
    n.removeAttribute('style');
    if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement) n.value = '';
  }
  return clone.outerHTML.replace(/\s+/g, ' ').slice(0, 3000);
}

function shown(v: AnswerValue): string {
  return Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Checked' : 'Unchecked') : v;
}

/**
 * Runs in every frame. Scans the frame's fields, resolves them through the
 * pipeline, fills them, outlines them and reports to the background.
 */
export class AutofillController {
  private fields = new Map<string, FieldDescriptor>();
  private reports = new Map<string, FieldReport>();
  private running = false;
  private watchers = new AbortController();
  private observer?: MutationObserver;
  private observeTimer?: number;
  private classifierError?: string;
  settings: Settings | null = null;

  constructor(
    private readonly send: Send,
    private readonly ui: () => FloatingUi | null,
  ) {}

  private fillContext(): FillContext {
    return {
      getDocument: (kind) => call<DocumentResponse>(() => this.send({ type: 'getDocument', kind })),
      getSecret: (name) => call<string | null>(() => this.send({ type: 'getSecret', name })),
    };
  }

  private classifier(): Classifier {
    return {
      predict: (req) => call<SystemOneResponse>(() => this.send({ type: 'classify', op: 'predict', req })),
      predictBatch: (req) => call<SystemOneResponse[]>(() => this.send({ type: 'classify', op: 'predictBatch', req })),
    };
  }

  async autofill(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.ui()?.setBusy(true);
    try {
      let fields = scanFields(document);
      if (!fields.length) {
        // Still report, so the panel knows this frame finished (and drops any stale report).
        this.reports.clear();
        await this.publish();
        return;
      }
      const ctx = await call<ContentContext>(() => this.send({ type: 'getContext' }));
      this.settings = ctx.settings;
      this.classifierError = undefined;
      // One entry per job and school: click "Add Another" first, then fill them all.
      if (await expandRepeatingSections(ctx.profile, document)) fields = scanFields(document);

      this.watchers.abort();
      this.watchers = new AbortController();
      this.fields.clear();
      this.reports.clear();
      const used: string[] = [];
      const deps = { profile: ctx.profile, answers: ctx.answers, host: location.hostname, settings: ctx.settings };

      // Privacy notices that must be opened and acknowledged before the form submits.
      if (ctx.settings.acknowledgePrivacyNotices) {
        (await acknowledgePrivacyNotices(document)).forEach((notice, i) => {
          const id = `notice-${i}`;
          this.reports.set(id, {
            id,
            frameId: 0,
            label: notice.label,
            kind: 'checkbox',
            options: [],
            required: true,
            status: 'review',
            source: 'rule',
            confidence: 1,
            valueText: 'Acknowledged',
            note: 'EzAutoApply opened this privacy notice and pressed Acknowledge',
          });
        });
      }

      // Pass 1, instant: rules and saved answers.
      const fast = await resolveFields(fields, { ...deps, classifier: null });
      await this.fillAll(fields, fast, used);

      // Before the slow part, read the options of every unanswered dropdown and show the panel
      // everything that needs an answer.
      await this.readUnansweredDropdowns();
      this.dropVanishedFields();

      // Pass 2: only the questions pass 1 couldn't answer go to the (slower) classifier.
      const leftovers = fields.filter(
        (f, i) => this.reports.has(f.id) && fast[i].source === 'none' && (fast[i].status === 'needs' || fast[i].status === 'skipped'),
      );
      if (ctx.settings.classifier.provider !== 'none' && leftovers.length) {
        const pending = `${ctx.settings.classifier.provider === 'jev' ? 'Jev' : 'Laya'} is checking ${leftovers.length} more question${leftovers.length === 1 ? '' : 's'}…`;
        await this.publish(pending);
        this.updateUi();
        this.ui()?.setBusy(true, 'Checking…');
        const slow = await resolveFields(leftovers, {
          ...deps,
          classifier: this.classifier(),
          onClassifierError: (e) => (this.classifierError = e.message),
        });
        const answered = slow.map((r, i) => [leftovers[i], r] as const).filter(([, r]) => r.status === 'filled' || r.status === 'review');
        await this.fillAll(answered.map(([f]) => f), answered.map(([, r]) => r), used);
        // Still unanswered: keep any more specific note from the classifier ("Needs a personal answer").
        slow.forEach((r, i) => {
          const report = this.reports.get(leftovers[i].id);
          if (report && r.note && (report.status === 'needs' || report.status === 'skipped')) report.note = r.note;
        });
        this.dropVanishedFields();
      }

      await this.publish();
      if (used.length) this.send({ type: 'answersUsed', ids: used }).catch(() => {});
      this.updateUi();
      if (this.classifierError) this.ui()?.toast(`Classifier unavailable, so some questions were left for you: ${this.classifierError}`);
      this.observeNewSteps();
    } catch (e) {
      this.ui()?.toast(`EzAutoApply: ${(e as Error).message}`);
      throw e;
    } finally {
      this.running = false;
      this.ui()?.setBusy(false);
    }
  }

  /** Fill each resolved field in page order and record the outcome. */
  private async fillAll(fields: FieldDescriptor[], resolutions: Resolution[], used: string[]): Promise<void> {
    const fillCtx = this.fillContext();
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const r = resolutions[i];
      let status: FillStatus = r.status;
      let note = r.note;
      let text = r.status === 'prefilled' ? shown(readValue(f)) : '';
      if ((status === 'filled' || status === 'review') && r.value !== undefined) {
        if (!f.element.isConnected) continue;
        const out = await fillField(f, r, fillCtx);
        if (out.ok) {
          text = out.valueText;
          if (r.answerId) used.push(r.answerId);
          if (out.uncertain && status === 'filled') {
            status = 'review';
            note = note ?? 'The page didn’t clearly confirm this choice; check it';
          }
        } else {
          status = f.required ? 'needs' : 'skipped';
          note = out.reason;
        }
      }
      this.track(f, r, status, text, note);
    }
  }

  private track(f: FieldDescriptor, r: Resolution, status: FillStatus, valueText: string, note?: string): void {
    this.fields.set(f.id, f);
    this.reports.set(f.id, {
      id: f.id,
      frameId: 0,
      label: f.label || f.placeholder || f.name || '(unlabeled field)',
      kind: f.kind,
      options: f.options.filter((o) => !isPlaceholderOption(o)).map((o) => o.label),
      required: f.required,
      status,
      key: r.key,
      source: r.source,
      confidence: r.confidence,
      valueText,
      note,
      current: readValue(f),
      debug: status === 'needs' || status === 'review' ? debugHtml(f) : undefined,
    });
    highlight(f, status);
    // Passwords typed on the page are never reported or offered for "remember this answer".
    if (status !== 'filled' && status !== 'prefilled' && f.kind !== 'password') this.watch(f);
  }

  /** Notice when the user answers a flagged field on the page, so the panel can offer to remember it. */
  private watch(f: FieldDescriptor): void {
    const targets: HTMLElement[] = f.members.length ? f.members : [f.element];
    let timer: number | undefined;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const v = readValue(f);
        const report = this.reports.get(f.id);
        if (!report || (Array.isArray(v) ? !v.length : v === '')) return;
        report.userValue = v;
        highlight(f, 'user');
        this.send({ type: 'fieldEdited', fieldId: f.id, userValue: v }).catch(() => {});
      }, 400);
    };
    for (const t of targets) {
      t.addEventListener('change', onChange, { signal: this.watchers.signal });
      t.addEventListener('input', onChange, { signal: this.watchers.signal });
    }
  }

  /** Dropdowns that load their options when opened: read them, so the panel can offer them as choices. */
  private async readUnansweredDropdowns(): Promise<void> {
    for (const [id, report] of this.reports) {
      const f = this.fields.get(id);
      if (!f || f.kind !== 'combobox' || report.options.length || (report.status !== 'needs' && report.status !== 'skipped')) continue;
      const options = await readDropdownOptions(f).catch(() => []);
      if (options.length) {
        report.options = options;
        f.options = options.map((o) => ({ label: o, value: o }));
      }
    }
  }

  /** Filling can remove fields (checking "I currently work here" removes "To"); don't report those. */
  private dropVanishedFields(): void {
    for (const [id, f] of this.fields) {
      if (!f.element.isConnected) {
        this.fields.delete(id);
        this.reports.delete(id);
      }
    }
  }

  /** Send this frame's results to the panel. `pending` says the classifier is still working. */
  private async publish(pending?: string): Promise<void> {
    const report: FrameReport = {
      frameId: 0,
      url: location.href,
      title: document.title,
      fields: [...this.reports.values()],
      classifierError: this.classifierError,
      pending,
      updatedAt: Date.now(),
    };
    await this.send({ type: 'report', report });
  }

  private updateUi(): void {
    const all = [...this.reports.values()];
    this.ui()?.setSummary({
      filled: all.filter((r) => r.status === 'filled').length,
      review: all.filter((r) => r.status === 'review').length,
      needs: all.filter((r) => r.status === 'needs').length,
    });
  }

  /** Fill one field with an answer the user gave in the side panel. */
  async applyAnswer(fieldId: string, answer: AnswerValue) {
    let f = this.fields.get(fieldId);
    if (!f || !f.element.isConnected) {
      f = scanFields(document).find((x) => x.id === fieldId);
      if (!f) return { ok: false as const, reason: 'That field is no longer on the page' };
    }
    const prev = this.reports.get(fieldId);
    const res: Resolution = { fieldId, key: prev?.key, value: answer, source: 'answerBank', confidence: 1, status: 'filled' };
    const out = await fillField(f, res, this.fillContext());
    if (out.ok) {
      this.track(f, res, 'filled', out.valueText, 'Answered in the side panel');
      await this.publish();
      this.updateUi();
    }
    return out;
  }

  /** Scroll the page to a field (from the side panel), flash it and put the cursor in it. */
  focusField(fieldId: string): boolean {
    const f = this.fields.get(fieldId) ?? scanFields(document).find((x) => x.id === fieldId);
    if (!f || !f.element.isConnected) return false;
    f.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(f.element);
    const focusable = f.element.matches('input, select, textarea, button, [tabindex]')
      ? f.element
      : f.element.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, button, [tabindex]');
    focusable?.focus({ preventScroll: true });
    return true;
  }

  clearHighlights(): void {
    clearAllHighlights(document);
    this.watchers.abort();
    this.reports.clear();
    this.fields.clear();
  }

  /** On multi-step forms, new fields appear without a page load. Refill or prompt when they do. */
  private observeNewSteps(): void {
    if (this.observer || !document.body) return;
    this.observer = new MutationObserver(() => {
      window.clearTimeout(this.observeTimer);
      this.observeTimer = window.setTimeout(() => this.checkForNewFields(), 1200);
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  private checkForNewFields(): void {
    if (this.running) return;
    const fresh = scanFields(document).filter((f) => !this.fields.has(f.id) && !f.hasValue);
    if (!fresh.length) return;
    if (this.settings?.autoFillNextStep) this.autofill().catch(() => {});
    else this.ui()?.notifyNewFields();
  }
}

