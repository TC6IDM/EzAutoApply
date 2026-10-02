import { FIELD_KEY_MAP } from '../core/fieldKeys';
import { canonicalCountry, canonicalRegion } from '../core/geo';
import { cleanText, normalize } from '../core/normalize';
import { isPlaceholderOption, matchOption, type OptionLike } from '../core/options';
import { type DocKind, type FieldValue, isFileRef, isSecretRef, type SecretRef } from '../core/types';
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
  /** Fetched only when it's about to be typed in; null when not set or not allowed on this site. */
  getSecret(name: SecretRef['secret']): Promise<string | null>;
}

/** `uncertain`: filled, but the page didn't clearly confirm it, so it should be checked. */
export type FillOutcome = { ok: true; valueText: string; uncertain?: boolean } | { ok: false; reason: string };

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

/**
 * A mouse or pointer event at the element's centre. Pointer events are real PointerEvents
 * (SAP UI5 and others ignore plain MouseEvents named "pointerdown"), and `buttons` says the
 * button is held during the press.
 */
function mouse(el: Element, type: string): void {
  const view = el.ownerDocument.defaultView;
  const r = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: view as Window,
    button: 0,
    buttons: type.endsWith('down') ? 1 : 0,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
  };
  const PE = view?.PointerEvent;
  if (type.startsWith('pointer') && PE) {
    el.dispatchEvent(new PE(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  } else {
    el.dispatchEvent(new (view?.MouseEvent ?? MouseEvent)(type, init));
  }
}

const KEY_CODES: Record<string, number> = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, ' ': 32 };

/** A key press. Older widgets read keyCode/which instead of key, so those are set too. */
function key(el: Element, k: string, types: string[] = ['keydown', 'keyup']): void {
  const view = el.ownerDocument.defaultView;
  const KE = view?.KeyboardEvent ?? KeyboardEvent;
  const code = KEY_CODES[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  for (const type of types) {
    const ev = new KE(type, { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(ev, 'keyCode', { get: () => code });
    Object.defineProperty(ev, 'which', { get: () => code });
    el.dispatchEvent(ev);
  }
}

function pressEnter(el: Element): void {
  key(el, 'Enter', ['keydown', 'keypress', 'keyup']);
}

/** Type characters one by one, for lists that jump to an option as you type ("Select One" dropdowns). */
function typeKeys(el: Element, text: string): void {
  for (const ch of text) key(el, ch, ['keydown', 'keypress', 'keyup']);
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
  // No format hint: a full date stays a full (zero-padded) ISO date; a month becomes MM/YYYY.
  if (m[3]) return `${y}-${mo}-${d}`;
  return m[2] ? `${mo}/${y}` : y;
}

function textFor(field: FieldDescriptor, res: Resolution, value: FieldValue): string {
  const def = res.key ? FIELD_KEY_MAP[res.key] : undefined;
  let text = Array.isArray(value) ? value.join(', ') : valueText(value);
  // Dates are reformatted (and zero-padded: "2026-10-2" → "2026-10-02") for the box, including
  // free-text answers like an available start date that happen to be a date.
  if (def?.valueType === 'date' || field.kind === 'date' || field.kind === 'month' || /^\d{4}-\d{1,2}(-\d{1,2})?$/.test(text.trim())) {
    text = formatDate(text, field);
  }
  // Number inputs reject "$120,000" or "5 years"; keep the first number.
  if (field.kind === 'number') text = /\d+(?:\.\d+)?/.exec(text.replace(/,/g, ''))?.[0] ?? '';
  return text;
}

// ── per-kind fillers ────────────────────────────────────────────────────

const digits = (s: string) => s.replace(/\D/g, '');

/** Masked inputs reformat what's typed ("062021" → "06/2021"), so dates compare by their digits. */
function sameText(actual: string, wanted: string): boolean {
  return actual === wanted || (digits(wanted).length >= 4 && digits(actual) === digits(wanted));
}

/**
 * Type one character at a time, with key and input events for each. Masked inputs
 * (dates, phone numbers) often ignore a value that's set all at once.
 */
export function typeLikeUser(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const view = el.ownerDocument.defaultView;
  const IE = view?.InputEvent ?? InputEvent;
  el.focus();
  fire(el, 'focusin');
  setNativeValue(el, '');
  fire(el, 'input');
  for (const ch of text) {
    key(el, ch, ['keydown', 'keypress']);
    setNativeValue(el, el.value + ch);
    el.dispatchEvent(new IE('input', { bubbles: true, composed: true, data: ch, inputType: 'insertText' }));
    key(el, ch, ['keyup']);
  }
  fire(el, 'change');
  fire(el, 'blur', { bubbles: false });
  fire(el, 'focusout');
}

/** Set a value, falling back to typing it out if the page didn't take it. */
function enterText(el: HTMLInputElement | HTMLTextAreaElement, text: string): boolean {
  typeInto(el, text);
  if (sameText(el.value, text)) return true;
  typeLikeUser(el, text);
  return sameText(el.value, text);
}

/** Leave a field the way clicking elsewhere does. Some forms only accept a value on a real blur. */
function leaveField(el: HTMLElement): void {
  if (el.ownerDocument.activeElement === el) el.blur();
  if (el.ownerDocument.activeElement === el) {
    fire(el, 'blur', { bubbles: false });
    fire(el, 'focusout');
  }
}

/** The "MM" / "YYYY" overlay a person clicks to get into a Workday date box. */
function segmentDisplay(input: HTMLInputElement): HTMLElement | null {
  const id = input.getAttribute('data-automation-id')?.replace(/-input$/, '-display');
  const wrap = input.closest('[data-automation-id="dateInputWrapper"]') ?? input.parentElement;
  return id && wrap ? wrap.querySelector<HTMLElement>(`[data-automation-id="${CSS.escape(id)}"]`) : null;
}

/** Workday-style dates: separate month, day and year boxes. `iso` is "YYYY-MM" or "YYYY-MM-DD". */
async function fillSegments(field: FieldDescriptor, iso: string): Promise<FillOutcome> {
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(iso.trim());
  if (!m) return { ok: false, reason: `"${iso}" isn't a date` };
  const parts = { year: m[1], month: pad(Number(m[2] ?? 1)), day: pad(Number(m[3] ?? 1)) };
  const segs = field.segments!;
  let ok = true;
  for (const name of ['month', 'day', 'year'] as const) {
    const input = segs[name];
    if (!input) continue;
    const took = () => sameText(input.value, parts[name]) || (input.value !== '' && Number(input.value) === Number(parts[name]));
    enterText(input, parts[name]);
    leaveField(input);
    await sleep(30);
    if (!took()) {
      // Click into the box the way a person would, then type it.
      const display = segmentDisplay(input);
      if (display) realClick(display);
      typeLikeUser(input, parts[name]);
      leaveField(input);
      await sleep(30);
    }
    if (!took()) ok = false;
  }
  return ok ? { ok: true, valueText: `${parts.month}/${parts.year}` } : { ok: false, reason: 'The date boxes rejected the value' };
}

async function fillText(field: FieldDescriptor, text: string): Promise<FillOutcome> {
  if (field.segments) return fillSegments(field, text);
  const el = field.element as HTMLInputElement | HTMLTextAreaElement;
  if (enterText(el, text) || ((field.kind === 'date' || field.kind === 'month') && el.value)) return { ok: true, valueText: el.value || text };
  return { ok: false, reason: 'The page rejected the value' };
}

function chooseIndex(field: FieldDescriptor, res: Resolution, options: OptionLike[]): number | null {
  if (res.optionIndex !== undefined && options[res.optionIndex]) return res.optionIndex;
  if (res.value === undefined || isFileRef(res.value) || isSecretRef(res.value)) return null;
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

/** Checked state of a checkbox, a role="radio"/"checkbox", or a toggle button (aria-pressed). */
export function isOn(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) return el.checked;
  return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
}

function setChecked(el: HTMLElement, want: boolean): void {
  const checked = isOn(el);
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
  const transfer = () => {
    const dt = new view.DataTransfer();
    dt.items.add(new view.File([base64ToBytes(doc.base64)], doc.fileName, { type: doc.mime }));
    return dt;
  };
  const zone = dropZoneFor(input);
  // Upload widgets list the file name in or right beside the drop zone once they've taken it.
  const shown = () => !!zone && normalize(textOf(zone.parentElement ?? zone)).includes(normalize(doc.fileName));

  input.files = transfer().files;
  fire(input, 'input');
  fire(input, 'change');
  if (!zone || (await waitFor(shown, 1500))) return { ok: true, valueText: doc.fileName };

  // The widget didn't pick the file up from its input; drop it on the drop zone like a person would.
  const DE = view.DragEvent ?? DragEvent;
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const dataTransfer = transfer();
    const ev = new DE(type, { bubbles: true, cancelable: true, composed: true, dataTransfer });
    if (!ev.dataTransfer) Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
    zone.dispatchEvent(ev);
  }
  if (await waitFor(shown, 1500)) return { ok: true, valueText: doc.fileName };
  return { ok: true, valueText: doc.fileName, uncertain: true };
}

/** The visible drop area around a (usually hidden) file input, if there is one. */
function dropZoneFor(input: HTMLInputElement): HTMLElement | null {
  let el = input.parentElement;
  for (let i = 0; el && i < 5; i++, el = el.parentElement) {
    // A drop area, or a widget that shows the chosen file's name ("No file selected" until then).
    if (/\b(drop|drag|no file (selected|chosen))\b/i.test(textOf(el)) || /drop|fileupload/i.test(`${el.className} ${el.getAttribute('data-automation-id') ?? ''} ${el.getAttribute('data-fabric-component') ?? ''}`)) return el;
  }
  return null;
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

/** An option's text as a person reads it. Workday keeps it in data-automation-label. */
export function optionText(o: Element): string {
  return (
    cleanText(o.getAttribute('aria-label') ?? '') ||
    cleanText(o.getAttribute('data-automation-label') ?? '') ||
    textOf(o) ||
    cleanText(o.textContent ?? '')
  );
}

/** Popups often sit in portals that other code marks aria-hidden, so a laid-out box also counts as shown. */
function isShown(o: HTMLElement): boolean {
  if (o.getAttribute('aria-disabled') === 'true' || !optionText(o)) return false;
  if (isVisible(o)) return true;
  const r = o.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Every option showing anywhere on the page right now. */
function pageOptions(doc: Document): HTMLElement[] {
  return (Array.from(doc.querySelectorAll('[role="option"]')) as HTMLElement[]).filter(isShown);
}

/**
 * This dropdown's options: the list it points to (aria-controls), else the options
 * that appeared after it was opened. Workday mounts a fresh list for each dropdown
 * without linking it to the button, so "new since opening" is what ties them together.
 */
function optionsOf(el: HTMLElement, before: Set<Element>): HTMLElement[] {
  const own = (listboxFor(el) as HTMLElement[]).filter(isShown);
  if (own.length) return own;
  return pageOptions(el.ownerDocument).filter((o) => !before.has(o));
}

/** Close lists something else left open, then record what's still showing, so it isn't mistaken for this field's list. */
async function closeStrayLists(el: HTMLElement): Promise<Set<Element>> {
  const doc = el.ownerDocument;
  if (pageOptions(doc).length) {
    const active = doc.activeElement as HTMLElement | null;
    if (active && active !== doc.body) key(active, 'Escape');
    await sleep(100);
  }
  return new Set(pageOptions(doc));
}

const waitForOptions = (el: HTMLElement, before: Set<Element>, ms: number, skipPlaceholders = false) =>
  waitFor(() => {
    const o = optionsOf(el, before).filter((x) => !skipPlaceholders || !isPlaceholderOption({ label: optionText(x), value: '' }));
    return o.length ? o : null;
  }, ms);

/**
 * Open the list. Some widgets open on mousedown and close again on click, so if a
 * full click shows nothing, try mousedown alone, then the keyboard.
 */
async function openList(el: HTMLElement, input: HTMLInputElement | null, before: Set<Element>): Promise<HTMLElement[]> {
  const toggle = toggleButtonFor(el);
  const attempts = [
    () => {
      el.focus();
      realClick(el);
      if (input) key(input, 'ArrowDown');
    },
    // Greenhouse's dropdowns ignore synthetic events on the input but open from their arrow button.
    ...(toggle ? [() => realClick(toggle)] : []),
    () => mouse(el, 'mousedown'),
    () => {
      el.focus();
      key(el, 'ArrowDown');
    },
    () => {
      el.focus();
      key(el, ' ');
    },
  ];
  for (const attempt of attempts) {
    attempt();
    const opts = await waitForOptions(el, before, 500);
    if (opts) return opts;
  }
  return [];
}

/**
 * Close this field's list: Escape first; for buttons that ignore it, toggle the button,
 * trying a full click, a lone mousedown and a lone click, since widgets toggle on different events.
 */
async function closeList(el: HTMLElement, before: Set<Element>): Promise<void> {
  const open = () => optionsOf(el, before).length > 0;
  if (open()) {
    key(el, 'Escape');
    const active = keyTarget(el);
    if (active !== el) key(active, 'Escape');
    await sleep(100);
  }
  if (el.getAttribute('aria-haspopup')) {
    for (const toggle of [() => realClick(el), () => mouse(el, 'mousedown'), () => el.click()]) {
      if (!open()) break;
      toggle();
      await sleep(100);
    }
  }
  fire(el, 'blur', { bubbles: false });
}

/** Where typed keys go once a list is open: the focused element if it's part of the widget, else the field. */
function keyTarget(el: HTMLElement): HTMLElement {
  const active = el.ownerDocument.activeElement as HTMLElement | null;
  // Only follow focus within this widget or an open list; focus left on a previous field
  // would otherwise receive the typing (and open that field's list instead).
  if (!active || active === el.ownerDocument.body) return el;
  if (el.contains(active) || active.contains(el) || active.closest('[role="listbox"]') || active.getAttribute('role') === 'listbox') return active;
  return el;
}

/** The arrow/toggle button some dropdowns open with (Greenhouse's "Toggle flyout", react-select's indicator). */
function toggleButtonFor(el: HTMLElement): HTMLElement | null {
  // Outermost wrapper first: the input sits in its own small "input-container" without the button.
  const control =
    ['.select-shell', '[class*="__control"]', '[class*="-control"]', '[class*="combobox"]']
      .map((sel) => el.closest(sel))
      .find(Boolean) ?? el.parentElement?.parentElement?.parentElement;
  return (
    control?.querySelector<HTMLElement>(
      'button[aria-label*="toggle" i], button[aria-label*="flyout" i], button[aria-label*="open" i], [class*="indicator"] button, [class*="dropdown-indicator"], [class*="indicatorContainer"]',
    ) ?? null
  );
}

/** The "Locate me" / "Use my location" button next to a location box (Greenhouse). */
function locateMeButton(el: HTMLElement): HTMLElement | null {
  const field = el.closest('.select__container, [class*="field"], [data-automation-id^="formField"]') ?? el.parentElement?.parentElement;
  const scope = field?.parentElement ?? field;
  const buttons = Array.from(scope?.querySelectorAll<HTMLElement>('button, a, [role="button"]') ?? []);
  return buttons.find((b) => /^\s*(locate me|use (my )?(current )?location|detect (my )?location)\s*$/i.test(b.textContent ?? '') && isVisible(b)) ?? null;
}

/** Whether a dropdown now shows a chosen value (react-select's single value, a non-empty input). */
function looksFilled(el: HTMLElement): boolean {
  const container = el.closest('.select__container, .select-shell, [class*="container"]') ?? el.parentElement;
  if (container?.querySelector('[class*="single-value"], [class*="singleValue"]')) return true;
  return el instanceof HTMLInputElement && el.value.trim() !== '';
}

/** Type into a search box one character at a time, without leaving it (leaving would close the list). */
function typeSearch(input: HTMLInputElement, text: string): void {
  const view = input.ownerDocument.defaultView;
  const IE = view?.InputEvent ?? InputEvent;
  input.focus();
  setNativeValue(input, '');
  fire(input, 'input');
  for (const ch of text) {
    key(input, ch, ['keydown', 'keypress']);
    setNativeValue(input, input.value + ch);
    input.dispatchEvent(new IE('input', { bubbles: true, composed: true, data: ch, inputType: 'insertText' }));
    key(input, ch, ['keyup']);
  }
}

/** The focused element, plus the open list itself when focus is elsewhere (lists often handle keys themselves). */
function keyTargets(el: HTMLElement, seen: HTMLElement[]): HTMLElement[] {
  const list = seen[0]?.closest<HTMLElement>('[role="listbox"]');
  const targets = [keyTarget(el)];
  if (list && !list.contains(targets[0])) targets.push(list);
  return targets;
}

/** The text around a field (its own value, chosen "pills"), before anything is chosen. */
/** A search box's value, unless it's just the search text we typed ourselves (that isn't a choice). */
function ownValue(el: HTMLElement, typed: string): string {
  if (!(el instanceof HTMLInputElement)) return '';
  return typed && normalize(el.value) === normalize(typed) ? '' : el.value;
}

function fieldText(el: HTMLElement, typed = ''): string {
  // Workday shows a chosen item as a "pill" somewhere in the field's formField container.
  const field = el.closest('[data-automation-id^="formField"]') ?? el.parentElement?.parentElement ?? el;
  return normalize(`${ownValue(el, typed)} ${textOf(field)}`);
}

/** Whether an option is marked selected. On some lists that only means "highlighted", so it's compared before and after. */
function markedSelected(option: HTMLElement): boolean {
  return (
    option.getAttribute('aria-selected') === 'true' ||
    option.getAttribute('aria-checked') === 'true' ||
    !!option.querySelector('input:checked, [aria-checked="true"]')
  );
}

/**
 * Whether the page now shows `label` as the chosen value. Only text that wasn't
 * there before counts, so a question that mentions the word doesn't fool it.
 */
function looksChosen(el: HTMLElement, label: string, before: string, option?: HTMLElement, selectedBefore = false, typed = ''): boolean {
  const want = normalize(label);
  if (!want) return false;
  // Workday highlights the top search result as aria-selected before anything is chosen; only a change counts.
  if (option && !selectedBefore && markedSelected(option)) return true;
  const shown = normalize(el instanceof HTMLInputElement ? ownValue(el, typed) : textOf(el));
  if (shown.includes(want) && !before.includes(want)) return true;
  // Multi-select prompts show the choice as a "pill" in the field.
  const field = el.closest('[data-automation-id^="formField"]') ?? el.parentElement?.parentElement;
  if (field && !(option && field.contains(option)) && fieldText(el, typed).includes(want) && !before.includes(want)) return true;
  return false;
}

/**
 * Open a dropdown only to read its options, then close it without choosing, so the
 * side panel can ask the user to pick one. Search prompts are skipped: what they show
 * before a search is a menu of categories, not the answers.
 */
export async function readDropdownOptions(field: FieldDescriptor): Promise<string[]> {
  const el = field.element;
  // Workday's "Search" boxes open on a menu of categories, not answers; everything else
  // (react-select on Greenhouse, Material-UI, Workday "Select One") shows the real options.
  if (el instanceof HTMLInputElement && /^search$/i.test(el.placeholder.trim())) return [];
  const before = await closeStrayLists(el);
  const opts = await openList(el, el instanceof HTMLInputElement ? el : null, before);
  const labels = [...new Set(opts.map(optionText).filter((l) => l && !isPlaceholderOption({ label: l, value: '' })))];
  await closeList(el, before);
  return labels;
}

function searchTextFor(want: string): string {
  // Locations are searched by city: "Toronto, ON" → "toronto" finds "Toronto, Ontario, Canada".
  if (want.includes(',')) want = want.split(',')[0];
  // Lists show full names, so "TX" is searched as "texas" and "USA" as "united states".
  const full = canonicalRegion(want) ?? canonicalCountry(want) ?? want;
  // Typing a long value can filter out the right option ("Bachelor of Science in X" vs "Bachelor's"),
  // so search on the first couple of words.
  return normalize(full).split(' ').slice(0, 2).join(' ');
}

async function fillCombobox(field: FieldDescriptor, res: Resolution): Promise<FillOutcome> {
  const el = field.element;
  const value = res.value;
  if (value === undefined || isFileRef(value) || isSecretRef(value)) return { ok: false, reason: 'Nothing to choose' };
  const want = Array.isArray(value) ? value[0] : value;
  const variants = typeof want === 'string' && res.key ? (FIELD_KEY_MAP[res.key]?.variants?.(want) ?? []) : [];
  const input = el instanceof HTMLInputElement ? el : null;
  const wantText = typeof want === 'boolean' ? (want ? 'Yes' : 'No') : want;
  const before = fieldText(el);
  const known = await closeStrayLists(el);

  const pick = (opts: HTMLElement[]) => {
    const labels = opts.map((o) => ({ label: optionText(o), value: optionText(o) }));
    const m = matchOption(labels, want, variants);
    return m ? { el: opts[m.index], label: labels[m.index].label } : null;
  };

  let seen = await openList(el, input, known);
  let choice = pick(seen);

  // Not in the visible list: type it and press Enter. Workday's search boxes only search on Enter,
  // and "Select One" lists jump to what you type and select it on Enter.
  let typed = '';
  if (!choice) {
    const search = searchTextFor(wantText);
    typed = search;
    if (input) {
      // Search-as-you-type boxes (Greenhouse's location) only search on real typing.
      typeSearch(input, search);
      await sleep(300);
      // Workday's search boxes only search on Enter. Where typing already brought up a match
      // (Greenhouse), Enter isn't needed and could pick the wrong highlighted option.
      if (!pick(optionsOf(el, known))) pressEnter(input);
    } else {
      for (const target of keyTargets(el, seen)) {
        typeKeys(target, search);
        pressEnter(target);
        if (looksChosen(el, wantText, before)) break;
      }
    }
    await sleep(250);
    if (!input && looksChosen(el, wantText, before)) {
      await closeList(el, known);
      return { ok: true, valueText: textOf(el) || wantText };
    }
    const after = (await waitForOptions(el, known, 2500, true)) ?? [];
    if (after.length) seen = after;
    choice = pick(after);
  }

  if (!choice) {
    if (input) setNativeValue(input, '');
    await closeList(el, known);
    // Location boxes with a "Locate me" button: let the site look the location up instead.
    const locate = res.key === 'location' || res.key === 'city' ? locateMeButton(el) : null;
    if (locate) {
      realClick(locate);
      // Chrome asks the user to allow location for the site the first time; give them time.
      if (await waitFor(() => fieldText(el) !== before && looksFilled(el), 15_000, 250)) {
        return { ok: true, valueText: textOf(el.closest('.select__container, [class*="field"]') ?? el) || 'Located', uncertain: true };
      }
      return { ok: false, reason: 'Clicked "Locate me": allow location access when Chrome asks, or pick your city here' };
    }
    const options = seen.map(optionText).filter(Boolean).slice(0, 6);
    return {
      ok: false,
      reason: `No option matched "${valueText(want)}"${options.length ? ` (options seen: ${options.join(', ')})` : ' (the list didn’t open)'}`,
    };
  }

  const selectedBefore = markedSelected(choice.el);
  const chosen = () => looksChosen(el, choice!.label, before, choice!.el, selectedBefore, typed);
  choice.el.scrollIntoView?.({ block: 'nearest' });
  realClick(choice.el);
  await sleep(150);
  // Some lists ignore synthetic clicks but accept the keyboard.
  if (!chosen() && choice.el.isConnected && optionsOf(el, known).includes(choice.el)) {
    if (input) {
      // Search boxes (Workday's "How did you hear"): the top result is highlighted, so arrow down to
      // the match and press Enter in the box, the second Enter a person presses after searching.
      const index = optionsOf(el, known).indexOf(choice.el);
      input.focus();
      for (let i = 0; i < index; i++) key(input, 'ArrowDown');
      pressEnter(input);
    } else {
      choice.el.focus?.();
      pressEnter(choice.el);
    }
    await sleep(150);
  }
  const confirmed = chosen() || !optionsOf(el, known).includes(choice.el);
  await closeList(el, known);
  return confirmed ? { ok: true, valueText: choice.label } : { ok: true, valueText: choice.label, uncertain: true };
}

// ── entry point ─────────────────────────────────────────────────────────

export const PASSWORD_MISSING =
  'Set your job-site account password in Profile → Job site accounts (it’s only filled on job sites like Workday)';

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
    if (isSecretRef(value) || field.kind === 'password') {
      if (!isSecretRef(value) || field.kind !== 'password') return { ok: false, reason: 'Only the account password goes into password fields' };
      const secret = await ctx.getSecret(value.secret);
      if (!secret) return { ok: false, reason: PASSWORD_MISSING };
      typeInto(field.element as HTMLInputElement, secret);
      return { ok: true, valueText: '••••••••' };
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
