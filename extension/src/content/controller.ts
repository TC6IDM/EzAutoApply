import type { SystemOneResponse } from '../classifier/systemone';
import { isPlaceholderOption } from '../core/options';
import type { Settings } from '../core/types';
import { type FillContext, fillField } from '../fill/fillers';
import { textOf } from '../fill/labels';
import type { Classifier } from '../fill/match/classify';
import { resolveFields } from '../fill/pipeline';
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
import { clearAllHighlights, highlight } from './highlight';

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
      const i = f.members.findIndex((m) => m.checked || m.getAttribute('aria-checked') === 'true');
      return i >= 0 ? f.options[i].label : '';
    }
    case 'checkboxGroup':
      return f.members.flatMap((m, i) => (m.checked || m.getAttribute('aria-checked') === 'true' ? [f.options[i].label] : []));
    case 'checkbox': {
      const m = f.members[0] ?? (el as HTMLInputElement);
      return m.checked ?? m.getAttribute('aria-checked') === 'true';
    }
    case 'combobox':
      return el instanceof HTMLInputElement ? el.value : textOf(el);
    case 'file':
      return Array.from((el as HTMLInputElement).files ?? []).map((x) => x.name).join(', ');
    default:
      return (el as HTMLInputElement).value;
  }
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
    return { getDocument: (kind) => call<DocumentResponse>(() => this.send({ type: 'getDocument', kind })) };
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
      const fields = scanFields(document);
      if (!fields.length) {
        // Still report, so the panel knows this frame finished (and drops any stale report).
        this.reports.clear();
        await this.publish();
        return;
      }
      const ctx = await call<ContentContext>(() => this.send({ type: 'getContext' }));
      this.settings = ctx.settings;
      this.classifierError = undefined;
      const resolutions = await resolveFields(fields, {
        profile: ctx.profile,
        answers: ctx.answers,
        host: location.hostname,
        settings: ctx.settings,
        classifier: ctx.settings.classifier.provider === 'none' ? null : this.classifier(),
        onClassifierError: (e) => (this.classifierError = e.message),
      });

      this.watchers.abort();
      this.watchers = new AbortController();
      this.fields.clear();
      this.reports.clear();
      const used: string[] = [];
      const fillCtx = this.fillContext();

      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const r = resolutions[i];
        let status: FillStatus = r.status;
        let note = r.note;
        let text = r.status === 'prefilled' ? shown(readValue(f)) : '';
        if ((status === 'filled' || status === 'review') && r.value !== undefined) {
          const out = await fillField(f, r, fillCtx);
          if (out.ok) {
            text = out.valueText;
            if (r.answerId) used.push(r.answerId);
          } else {
            status = f.required ? 'needs' : 'skipped';
            note = out.reason;
          }
        }
        this.track(f, r, status, text, note);
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
    });
    highlight(f, status);
    if (status !== 'filled' && status !== 'prefilled') this.watch(f);
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

  private async publish(): Promise<void> {
    const report: FrameReport = {
      frameId: 0,
      url: location.href,
      title: document.title,
      fields: [...this.reports.values()],
      classifierError: this.classifierError,
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

