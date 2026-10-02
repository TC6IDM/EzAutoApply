import { FIELD_KEY_MAP } from '../core/fieldKeys';
import { normalize } from '../core/normalize';
import { isPlaceholderOption, matchOption, type OptionLike } from '../core/options';
import { type DocKind, type FieldValue, isFileRef } from '../core/types';
import { byId, isVisible, sleep, waitFor } from './dom';
import { textOf } from './labels';
import { valueText } from './pipeline';
import type { FieldDescriptor, Resolution } from './types';

/**
 * Put values into the page. Frameworks like React track input values
 * internally, so values go through the native setter followed by real
 * input/change events; choices are made by clicking, like a person would.
 */

export interface DocumentPayload {
  name: string;
  fileName: string;
  mime: string;
  base64: string;
  text: string;
}

export interface FillContext {
  getDocument(kind: DocKind): Promise<DocumentPayload | null>;
}

export type FillOutcome = { ok: true; valueText: string } | { ok: false; reason: string };

type ValueElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function setNativeValue(el: ValueElement, value: string): void {
  let proto: object | null = Object.getPrototypeOf(el);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) {
      desc.set.call(el, value);
      return;
    }
    proto = Object.getPrototypeOf(proto);
  }
  el.value = value;
}

function fire(el: Element, type: string, init: EventInit = {}): void {
  el.dispatchEvent(new Event(type, { bubbles: true, composed: true, ...init }));
}

function mouse(el: Element, type: string): void {
  const view = el.ownerDocument.defaultView;
  el.dispatchEvent(new (view?.MouseEvent ?? MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, view: view as Window }));
}

function key(el: Element, k: string): void {
  const view = el.ownerDocument.defaultView;
  const KE = view?.KeyboardEvent ?? KeyboardEvent;
  el.dispatchEvent(new KE('keydown', { key: k, bubbles: true, cancelable: true, composed: true }));
  el.dispatchEvent(new KE('keyup', { key: k, bubbles: true, cancelable: true, composed: true }));
}

/** Click the way a user does; some widgets act on mousedown, others on click. */
export function realClick(el: HTMLElement): void {
  mouse(el, 'pointerdown');
  mouse(el, 'mousedown');
  mouse(el, 'pointerup');
  mouse(el, 'mouseup');
  el.click();
}

export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus();
  fire(el, 'focusin');
  setNativeValue(el, value);
  fire(el, 'input');
  fire(el, 'change');
  fire(el, 'blur', { bubbles: false });
  fire(el, 'focusout');
}

// ── dates ───────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** Reformat a stored "YYYY-MM"/"YYYY" date for this input; other text passes through. */
export function formatDate(value: string, field: Pick<FieldDescriptor, 'kind' | 'placeholder' | 'inputType' | 'label'>): string {
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(value.trim());
  if (!m) return value;
  const y = m[1];
  const mo = pad(Number(m[2] ?? 1));
  const d = pad(Number(m[3] ?? 1));
  if (field.kind === 'date') return `${y}-${mo}-${d}`;
  if (field.kind === 'month') return `${y}-${mo}`;
  const hint = `${field.placeholder} ${field.label}`.toLowerCase();
  if (/yyyy-mm-dd/.test(hint)) return `${y}-${mo}-${d}`;
  if (/dd\s*\/\s*mm\s*\/\s*yyyy/.test(hint)) return `${d}/${mo}/${y}`;
  if (/mm\s*\/\s*dd\s*\/\s*yyyy/.test(hint)) return `${mo}/${d}/${y}`;
  if (/mm\s*\/\s*yy(?!yy)\b/.test(hint)) return `${mo}/${y.slice(2)}`;
  if (/yyyy-mm/.test(hint)) return `${y}-${mo}`;
  if (/^\s*yyyy\s*$/.test(field.placeholder.toLowerCase()) || /\byear\b/.test(hint) && !/\bmonth\b/.test(hint)) return y;
  if (/\bmonth\b/.test(hint) && !/\byear\b/.test(hint)) return mo;
  return m[2] ? `${mo}/${y}` : y;
}

function textFor(field: FieldDescriptor, res: Resolution, value: FieldValue): string {
  const def = res.key ? FIELD_KEY_MAP[res.key] : undefined;
  let text = Array.isArray(value) ? value.join(', ') : valueText(value);
  if (def?.valueType === 'date' || field.kind === 'date' || field.kind === 'month') text = formatDate(text, field);
  // Number inputs reject "$120,000" or "5 years"; keep the first number.
  if (field.kind === 'number') text = /\d+(?:\.\d+)?/.exec(text.replace(/,/g, ''))?.[0] ?? '';
  return text;
}

// ── per-kind fillers ────────────────────────────────────────────────────

function fillText(field: FieldDescriptor, text: string): FillOutcome {
  const el = field.element as HTMLInputElement | HTMLTextAreaElement;
  typeInto(el, text);
  return el.value === text || field.kind === 'date' || field.kind === 'month'
    ? { ok: true, valueText: text }
    : { ok: false, reason: 'The page rejected the value' };
}

function chooseIndex(field: FieldDescriptor, res: Resolution, options: OptionLike[]): number | null {
  if (res.optionIndex !== undefined && options[res.optionIndex]) return res.optionIndex;
  if (res.value === undefined || isFileRef(res.value)) return null;
  const want = Array.isArray(res.value) ? res.value[0] : res.value;
  const variants = typeof want === 'string' && res.key ? (FIELD_KEY_MAP[res.key]?.variants?.(want) ?? []) : [];
  return matchOption(options, want, variants)?.index ?? null;
}

function fillSelect(field: FieldDescriptor, res: Resolution): FillOutcome {
  const el = field.element as HTMLSelectElement;
  const options = Array.from(el.options).map((o) => ({ label: o.label || o.text, value: o.value }));
  if (el.multiple && Array.isArray(res.value)) {
    const picks = res.value.map((v) => matchOption(options, v)?.index).filter((i): i is number => i !== undefined);
    if (!picks.length) return { ok: false, reason: 'No option matched' };
    for (const i of picks) el.options[i].selected = true;
    fire(el, 'input');
    fire(el, 'change');
    return { ok: true, valueText: picks.map((i) => options[i].label).join(', ') };
  }
  const i = chooseIndex(field, res, options);
  if (i === null) return { ok: false, reason: 'No option matched' };
  el.focus();
  setNativeValue(el, el.options[i].value);
  el.options[i].selected = true;
  fire(el, 'input');
  fire(el, 'change');
  fire(el, 'blur', { bubbles: false });
  return { ok: true, valueText: options[i].label };
}

function setChecked(el: HTMLElement, want: boolean): void {
  const checked = el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
  if (checked === want) return;
  realClick(el);
  if (el instanceof HTMLInputElement && el.checked !== want) {
    // Some widgets swallow the click; set it directly as a fallback.
    el.checked = want;
    fire(el, 'input');
    fire(el, 'change');
  }
}

function fillRadio(field: FieldDescriptor, res: Resolution): FillOutcome {
  const i = chooseIndex(field, res, field.options);
  if (i === null) return { ok: false, reason: 'No option matched' };
  setChecked(field.members[i], true);
  return { ok: true, valueText: field.options[i].label };
}

function fillCheckbox(field: FieldDescriptor, value: FieldValue): FillOutcome {
  if (typeof value !== 'boolean') return { ok: false, reason: 'Not a yes/no answer' };
  setChecked(field.members[0] ?? field.element, value);
  return { ok: true, valueText: value ? 'Checked' : 'Unchecked' };
}

function fillCheckboxGroup(field: FieldDescriptor, value: FieldValue): FillOutcome {
  const wants = Array.isArray(value) ? value : [valueText(value)];
  const picked: string[] = [];
  for (const w of wants) {
    const m = matchOption(field.options, w);
    if (!m) continue;
    setChecked(field.members[m.index], true);
    picked.push(field.options[m.index].label);
  }
  return picked.length ? { ok: true, valueText: picked.join(', ') } : { ok: false, reason: 'No option matched' };
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function fillFile(field: FieldDescriptor, kind: DocKind, ctx: FillContext): Promise<FillOutcome> {
  const doc = await ctx.getDocument(kind);
  if (!doc) return { ok: false, reason: `No ${kind === 'coverLetter' ? 'cover letter' : kind} uploaded yet` };
  const input = field.element as HTMLInputElement;
  const view = input.ownerDocument.defaultView ?? window;
  const file = new view.File([base64ToBytes(doc.base64)], doc.fileName, { type: doc.mime });
  const dt = new view.DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  fire(input, 'input');
  fire(input, 'change');
  return { ok: true, valueText: doc.fileName };
}

// ── comboboxes (react-select, Workday, Greenhouse, LinkedIn) ─────────────

function listboxFor(el: Element): Element[] {
  const ids = [el.getAttribute('aria-controls'), el.getAttribute('aria-owns')].filter(Boolean).join(' ').split(/\s+/);
  const found: Element[] = [];
  for (const id of ids) {
    if (!id) continue;
    const lb = byId(el, id);
    if (lb) found.push(...Array.from(lb.querySelectorAll('[role="option"]')));
  }
  return found;
}

function visibleOptions(el: Element): HTMLElement[] {
  let opts = listboxFor(el);
  if (!opts.length) opts = Array.from(el.ownerDocument.querySelectorAll('[role="listbox"] [role="option"], [role="option"]'));
  return (opts as HTMLElement[]).filter((o) => isVisible(o) && o.getAttribute('aria-disabled') !== 'true');
}

function closeCombobox(el: HTMLElement): void {
  key(el, 'Escape');
  fire(el, 'blur', { bubbles: false });
}

function searchTextFor(want: string): string {
  // Typing a long value can filter out the right option ("Bachelor of Science in X" vs "Bachelor's"),
  // so search on the first couple of words.
  return normalize(want).split(' ').slice(0, 2).join(' ');
}

async function fillCombobox(field: FieldDescriptor, res: Resolution): Promise<FillOutcome> {
  const el = field.element;
  const value = res.value;
  if (value === undefined || isFileRef(value)) return { ok: false, reason: 'Nothing to choose' };
  const want = Array.isArray(value) ? value[0] : value;
  const variants = typeof want === 'string' && res.key ? (FIELD_KEY_MAP[res.key]?.variants?.(want) ?? []) : [];
  const input = el instanceof HTMLInputElement ? el : null;

  const pick = (opts: HTMLElement[]) => {
    const labels = opts.map((o) => ({ label: textOf(o), value: textOf(o) }));
    const m = matchOption(labels, want, variants);
    return m ? { el: opts[m.index], label: labels[m.index].label, score: m.score } : null;
  };

  el.focus();
  realClick(el);
  if (input) key(input, 'ArrowDown');
  let opts = (await waitFor(() => {
    const o = visibleOptions(el);
    return o.length ? o : null;
  }, 800)) ?? [];
  let choice = opts.length ? pick(opts) : null;

  // Long or remote lists only show matches after typing.
  if (!choice && input && typeof want === 'string') {
    typeInto(input, searchTextFor(want));
    input.focus();
    await sleep(150);
    opts = (await waitFor(() => {
      const o = visibleOptions(el).filter((x) => !isPlaceholderOption({ label: textOf(x), value: '' }));
      return o.length ? o : null;
    }, 2500)) ?? [];
    choice = opts.length ? pick(opts) : null;
  }

  if (!choice) {
    if (input) setNativeValue(input, '');
    closeCombobox(el);
    return { ok: false, reason: `No option matched "${valueText(want)}"` };
  }
  choice.el.scrollIntoView?.({ block: 'nearest' });
  realClick(choice.el);
  await sleep(60);
  closeCombobox(el);
  return { ok: true, valueText: choice.label };
}

// ── entry point ─────────────────────────────────────────────────────────

export async function fillField(field: FieldDescriptor, res: Resolution, ctx: FillContext): Promise<FillOutcome> {
  const value = res.value;
  if (value === undefined) return { ok: false, reason: 'No value' };
  try {
    if (isFileRef(value)) {
      if (field.kind === 'file') return await fillFile(field, value.fileKind, ctx);
      if (field.kind === 'textarea' || field.kind === 'text') {
        const doc = await ctx.getDocument(value.fileKind);
        if (!doc?.text) return { ok: false, reason: 'No text available for that document' };
        return fillText(field, doc.text);
      }
      return { ok: false, reason: 'Documents can only go into upload fields' };
    }
    switch (field.kind) {
      case 'text':
      case 'textarea':
      case 'number':
      case 'date':
      case 'month':
        return fillText(field, textFor(field, res, value));
      case 'select':
        return fillSelect(field, res);
      case 'radio':
        return fillRadio(field, res);
      case 'checkbox':
        return fillCheckbox(field, value);
      case 'checkboxGroup':
        return fillCheckboxGroup(field, value);
      case 'combobox':
        return await fillCombobox(field, res);
      case 'file':
        return { ok: false, reason: 'Upload fields need a document' };
    }
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
