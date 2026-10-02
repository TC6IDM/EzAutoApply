import { isPlaceholderOption, type OptionLike } from '../core/options';
import { cleanText } from '../core/normalize';
import type { FieldKind } from '../core/types';
import { byId, commonAncestor, deepQueryAll, isOwnUi, isVisible } from './dom';
import { CONTROL_SELECTOR, groupLabel, helpText, labelFor, optionLabel, sectionOf, textOf } from './labels';
import type { FieldDescriptor } from './types';

/**
 * Find every fillable field on the page (including open shadow roots) and
 * describe it. Radio buttons and checkboxes that belong together become one
 * group field; custom dropdowns become `combobox` fields.
 */

const ID_ATTR = 'data-ezaa-id';
let nextId = 1;

function fieldId(el: Element): string {
  let id = el.getAttribute(ID_ATTR);
  if (!id) {
    id = `f${nextId++}`;
    el.setAttribute(ID_ATTR, id);
  }
  return id;
}

export function elementForField(id: string, root: ParentNode = document): HTMLElement | null {
  return deepQueryAll<HTMLElement>(root, `[${ID_ATTR}="${id}"]`)[0] ?? null;
}

const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search', 'range', 'color']);

function isRequired(el: Element, label: string): boolean {
  return (
    (el as HTMLInputElement).required === true ||
    el.getAttribute('aria-required') === 'true' ||
    /\*\s*$|^\s*\*|\(required\)/i.test(label)
  );
}

function inputKind(el: HTMLInputElement): FieldKind | null {
  const t = (el.getAttribute('type') || 'text').toLowerCase();
  if (SKIP_INPUT_TYPES.has(t)) return null;
  if (t === 'file') return 'file';
  if (t === 'radio') return 'radio';
  if (t === 'checkbox') return 'checkbox';
  if (t === 'date' || t === 'datetime-local') return 'date';
  if (t === 'month') return 'month';
  if (t === 'number') return 'number';
  if (el.getAttribute('role') === 'combobox' && !el.hasAttribute('list')) return 'combobox';
  if (el.getAttribute('aria-autocomplete') === 'list' && (el.hasAttribute('aria-controls') || el.hasAttribute('aria-owns'))) {
    return 'combobox';
  }
  return 'text';
}

function selectOptions(el: HTMLSelectElement): OptionLike[] {
  return Array.from(el.options).map((o) => ({ label: cleanText(o.label || o.text), value: o.value }));
}

function selectHasValue(el: HTMLSelectElement): boolean {
  if (el.multiple) return el.selectedOptions.length > 0;
  const o = el.options[el.selectedIndex];
  return !!o && o.value !== '' && !isPlaceholderOption({ label: o.label || o.text, value: o.value });
}

/** Options already present for a combobox (some render their listbox hidden up front). */
function comboboxOptions(el: Element): OptionLike[] {
  const ids = [el.getAttribute('aria-controls'), el.getAttribute('aria-owns')].filter(Boolean).join(' ');
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const lb = byId(el, id);
    if (!lb) continue;
    const opts = Array.from(lb.querySelectorAll('[role="option"]')).map((o) => ({ label: textOf(o), value: textOf(o) }));
    if (opts.length) return opts;
  }
  if (el instanceof HTMLSelectElement) return selectOptions(el);
  return [];
}

function comboboxHasValue(el: Element): boolean {
  if (el instanceof HTMLInputElement) return el.value.trim() !== '';
  const t = textOf(el);
  return !!t && !/^(select|choose|please select|--)/i.test(t);
}

/** Radio/checkbox members grouped by name, falling back to a shared radiogroup/fieldset. */
function groupKey(el: HTMLElement): string {
  const name = el.getAttribute('name');
  const scope = el.closest('form') ?? el.getRootNode();
  if (name) return `${(scope as Node).nodeName}:${name}:${scopeIndex(scope as Node)}`;
  const container = el.closest('[role="radiogroup"], [role="group"], fieldset');
  return container ? `c:${fieldId(container)}` : `self:${fieldId(el)}`;
}

const scopeIds = new WeakMap<Node, number>();
let scopeCounter = 0;
function scopeIndex(n: Node): number {
  let i = scopeIds.get(n);
  if (i === undefined) {
    i = scopeCounter++;
    scopeIds.set(n, i);
  }
  return i;
}

function isChecked(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) return el.checked;
  return el.getAttribute('aria-checked') === 'true';
}

function headingsIn(root: ParentNode): Element[] {
  return deepQueryAll(root, 'h1, h2, h3, h4, h5, h6, [role="heading"]').filter((h) => !isOwnUi(h));
}

export function scanFields(root: ParentNode = document): FieldDescriptor[] {
  const headings = headingsIn(root);
  const controls = deepQueryAll<HTMLElement>(root, CONTROL_SELECTOR).filter((el) => !isOwnUi(el));
  const fields: FieldDescriptor[] = [];
  const groups = new Map<string, HTMLElement[]>();
  const groupOrder: { key: string; kind: 'radio' | 'checkbox'; at: number }[] = [];
  const consumed = new Set<Element>();

  const base = (el: HTMLElement, kind: FieldKind, label: string): FieldDescriptor => ({
    id: fieldId(el),
    kind,
    label,
    help: helpText(el),
    name: el.getAttribute('name') ?? '',
    htmlId: el.getAttribute('id') ?? '',
    placeholder: cleanText(el.getAttribute('placeholder') ?? ''),
    autocomplete: el.getAttribute('autocomplete') ?? '',
    inputType: (el.getAttribute('type') ?? '').toLowerCase(),
    options: [],
    required: isRequired(el, label),
    section: sectionOf(el, headings),
    multiple: false,
    hasValue: false,
    element: el,
    members: [],
  });

  for (const el of controls) {
    if (consumed.has(el)) continue;
    if ((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    // A combobox wrapper around a real input: the input is the field.
    if (el.getAttribute('role') === 'combobox' && !(el instanceof HTMLInputElement) && el.querySelector('input:not([type="hidden"])')) {
      continue;
    }

    const role = el.getAttribute('role');
    if (el instanceof HTMLInputElement || role === 'radio' || role === 'checkbox') {
      const kind = el instanceof HTMLInputElement ? inputKind(el) : (role as 'radio' | 'checkbox');
      if (!kind) continue;
      if (kind === 'radio' || kind === 'checkbox') {
        const visible = isVisible(el) || Array.from((el as HTMLInputElement).labels ?? []).some(isVisible);
        if (!visible) continue;
        const key = `${kind}|${groupKey(el)}`;
        if (!groups.has(key)) {
          groups.set(key, []);
          groupOrder.push({ key, kind, at: fields.length });
        }
        groups.get(key)!.push(el);
        continue;
      }
      if (kind === 'file') {
        // File inputs are usually visually hidden behind a styled dropzone.
        const f = base(el, 'file', labelFor(el) || fileZoneLabel(el));
        f.hasValue = ((el as HTMLInputElement).files?.length ?? 0) > 0;
        fields.push(f);
        continue;
      }
      if (!isVisible(el) || (el as HTMLInputElement).readOnly && kind !== 'combobox') continue;
      const f = base(el, kind, labelFor(el));
      if (kind === 'combobox') {
        f.options = comboboxOptions(el);
        f.hasValue = comboboxHasValue(el);
      } else {
        f.hasValue = (el as HTMLInputElement).value.trim() !== '';
      }
      fields.push(f);
      continue;
    }

    if (el instanceof HTMLSelectElement) {
      if (!isVisible(el) && !selectIsStyledProxy(el)) continue;
      const f = base(el, 'select', labelFor(el));
      f.options = selectOptions(el);
      f.multiple = el.multiple;
      f.hasValue = selectHasValue(el);
      fields.push(f);
      continue;
    }

    if (el instanceof HTMLTextAreaElement) {
      if (!isVisible(el) || el.readOnly || /recaptcha|captcha/i.test(el.name + el.id)) continue;
      const f = base(el, 'textarea', labelFor(el));
      f.hasValue = el.value.trim() !== '';
      fields.push(f);
      continue;
    }

    // role=combobox on a non-input, or a button that opens a listbox (Workday-style selects).
    if (!isVisible(el)) continue;
    const f = base(el, 'combobox', labelFor(el));
    f.options = comboboxOptions(el);
    f.hasValue = comboboxHasValue(el);
    fields.push(f);
  }

  // Turn radio/checkbox groups into fields, inserted where their first member appeared.
  const groupFields: { at: number; field: FieldDescriptor }[] = [];
  for (const { key, kind, at } of groupOrder) {
    const members = groups.get(key)!;
    const container =
      members[0].closest('[role="radiogroup"], [role="group"], fieldset') ?? commonAncestor(members);
    if (kind === 'checkbox' && members.length === 1) {
      const el = members[0];
      const f = base(el, 'checkbox', optionLabel(el) || labelFor(el));
      f.hasValue = false;
      f.members = [el as HTMLInputElement];
      groupFields.push({ at, field: f });
      continue;
    }
    const label = groupLabel(members, container);
    const f = base(members[0], kind === 'radio' ? 'radio' : 'checkboxGroup', label);
    f.element = (container as HTMLElement) ?? members[0];
    f.members = members as HTMLInputElement[];
    f.options = members.map((m) => ({ label: optionLabel(m), value: (m as HTMLInputElement).value ?? optionLabel(m) }));
    f.required = members.some((m) => isRequired(m, '')) || isRequired(members[0], label);
    f.multiple = kind === 'checkbox';
    f.hasValue = members.some(isChecked);
    groupFields.push({ at, field: f });
  }
  for (const { at, field } of groupFields.reverse()) fields.splice(at, 0, field);
  return fields;
}

/** Some sites hide the real <select> behind a styled widget but keep it in sync. */
function selectIsStyledProxy(el: HTMLSelectElement): boolean {
  const next = el.nextElementSibling;
  return !!next && isVisible(next) && /select|dropdown|chosen|choices/i.test(next.className);
}

/** Dropzones label their hidden file input with text like "Attach resume". */
function fileZoneLabel(el: Element): string {
  let node = el.parentElement;
  for (let i = 0; node && i < 4; i++, node = node.parentElement) {
    const t = textOf(node);
    if (t) return t.slice(0, 200);
  }
  return '';
}
