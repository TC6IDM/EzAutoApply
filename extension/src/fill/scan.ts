import { isPlaceholderOption, type OptionLike } from '../core/options';
import { cleanText, normalize, splitIdentifier } from '../core/normalize';
import type { FieldKind } from '../core/types';
import { byId, commonAncestor, deepQueryAll, isOwnUi, isVisible } from './dom';
import { CONTROL_SELECTOR, contextLabel, fieldContainerLabel, groupLabel, helpText, labelFor, optionLabel, sectionOf, textOf, uploadLabel } from './labels';
import type { DateSegments, FieldDescriptor } from './types';

/**
 * Find every fillable field on the page (including open shadow roots) and
 * describe it. Radio buttons and checkboxes that belong together become one
 * group field; custom dropdowns become `combobox` fields.
 */

const ID_ATTR = 'data-ezaa-id';
let nextId = 1;
/** Ids handed out in the current scan, to catch an id that two elements carry. */
let taken = new Map<string, Element>();

function fieldId(el: Element): string {
  let id = el.getAttribute(ID_ATTR);
  // A page that copies a block ("Add Another" cloning the first entry) copies our id with it; the
  // copy gets its own, or the two fields would share one report in the side panel.
  if (!id || (taken.get(id) ?? el) !== el) {
    do id = `f${nextId++}`;
    while (el.ownerDocument.querySelector(`[${ID_ATTR}="${id}"]`));
    el.setAttribute(ID_ATTR, id);
  }
  taken.set(id, el);
  return id;
}

export function elementForField(id: string, root: ParentNode = document): HTMLElement | null {
  return deepQueryAll<HTMLElement>(root, `[${ID_ATTR}="${id}"]`)[0] ?? null;
}

const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'search', 'range', 'color']);

const PROMPT_SELECTOR = '[data-automation-id="multiSelectContainer"], [data-uxi-widget-type="multiselect"]';

/**
 * Workday's search prompts (School, Field of Study, Skills, "How did you hear"): a plain
 * input in a multiSelectContainer that searches on Enter. Each choice becomes a pill.
 */
export function isSearchPrompt(el: Element): boolean {
  return el instanceof HTMLInputElement && (el.getAttribute('data-uxi-widget-type') === 'selectinput' || !!el.closest(PROMPT_SELECTOR));
}

function pillText(pill: Element): string {
  const labelled = pill.matches('[data-automation-label]') ? pill : pill.querySelector('[data-automation-label]');
  return cleanText(labelled?.getAttribute('data-automation-label') ?? '') || cleanText(pill.getAttribute('title') ?? '') || textOf(pill);
}

/** What a search prompt holds: the text of its pills. */
export function promptChoices(el: Element): string[] {
  const scope = el.closest('[data-automation-id^="formField"]') ?? el.closest(PROMPT_SELECTOR) ?? el.parentElement;
  return Array.from(scope?.querySelectorAll('[data-automation-id="selectedItem"]') ?? []).map(pillText).filter(Boolean);
}

/** Workday puts an unlabelled, visually hidden input after each "Select One" button to hold the choice's id. */
function isListboxValueShim(el: Element): boolean {
  return el instanceof HTMLInputElement && !el.id && !el.name && !!el.previousElementSibling?.matches('button[aria-haspopup="listbox"]');
}

function isRequired(el: Element, label: string): boolean {
  return (
    (el as HTMLInputElement).required === true ||
    el.getAttribute('aria-required') === 'true' ||
    // The asterisk isn't always last ("From* MM/YYYY"), so anywhere in the label counts.
    /\*|\(required\)/i.test(label)
  );
}

function inputKind(el: HTMLInputElement): FieldKind | null {
  const t = (el.getAttribute('type') || 'text').toLowerCase();
  if (SKIP_INPUT_TYPES.has(t)) return null;
  if (t === 'file') return 'file';
  if (t === 'password') return 'password';
  if (t === 'radio') return 'radio';
  if (t === 'checkbox') return 'checkbox';
  if (t === 'date' || t === 'datetime-local') return 'date';
  if (t === 'month') return 'month';
  if (t === 'number') return 'number';
  if (el.getAttribute('role') === 'combobox' && !el.hasAttribute('list')) return 'combobox';
  // Workday's multi-select prompts ("Disability", "How did you hear") are search boxes over a list.
  if (/searchBox|multiSelect|monikerSearch/i.test(el.getAttribute('data-automation-id') ?? '') || isSearchPrompt(el)) return 'combobox';
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
  // Text typed into a search prompt isn't a choice until it becomes a pill.
  if (isSearchPrompt(el)) return promptChoices(el).length > 0;
  if (el instanceof HTMLInputElement) return el.value.trim() !== '';
  // "–Select–", "Select One", "Please choose…" all mean empty.
  const t = textOf(el);
  return !!t && !isPlaceholderOption({ label: t, value: '' });
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
  return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
}

/** Toggle buttons (aria-pressed) that act as one choice, e.g. Ashby's Yes / No pairs. */
const TOGGLE_SELECTOR = 'button[aria-pressed], [role="button"][aria-pressed]';

interface ToggleGroup {
  container: HTMLElement;
  buttons: HTMLElement[];
  /** Inputs the widget keeps its value in (a hidden checkbox); part of the group, not fields of their own. */
  backing: HTMLInputElement[];
}

function toggleGroups(root: ParentNode): Map<Element, ToggleGroup> {
  const byParent = new Map<HTMLElement, HTMLElement[]>();
  for (const b of deepQueryAll<HTMLElement>(root, TOGGLE_SELECTOR)) {
    if (isOwnUi(b) || !b.parentElement) continue;
    const list = byParent.get(b.parentElement) ?? [];
    list.push(b);
    byParent.set(b.parentElement, list);
  }
  const out = new Map<Element, ToggleGroup>();
  for (const [container, buttons] of byParent) {
    if (buttons.length < 2 || !buttons.some(isVisible)) continue;
    const backing = Array.from(container.querySelectorAll<HTMLInputElement>('input')).filter((i) => !isVisible(i));
    const group = { container, buttons, backing };
    for (const el of [...buttons, ...backing]) out.set(el, group);
  }
  return out;
}

/** Ashby points <label for="…"> at the hidden input's name, not an id. */
function labelForName(inputs: HTMLInputElement[]): HTMLLabelElement | null {
  for (const i of inputs) {
    const name = i.getAttribute('name');
    if (!name || i.id) continue;
    const label = i.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(name)}"]`);
    if (label) return label;
  }
  return null;
}

/**
 * Section context: the nearest heading, plus Workday-style container ids
 * ("workExperience-2", "educationSection") for pages whose headings aren't real heading elements.
 */
function sectionContext(el: Element, headings: Element[]): string {
  let ids = '';
  const groups: string[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const id = p.getAttribute('data-automation-id') ?? '';
    if (!ids && /experience|employment|education|school/i.test(id)) ids = splitIdentifier(id);
    // Sections drawn as <fieldset><legend>Work experience</legend> (Avature) or labelled groups.
    if (p.tagName === 'FIELDSET') {
      const legend = p.querySelector(':scope > legend');
      if (legend) groups.push(textOf(legend));
    } else if (/^(group|region)$/.test(p.getAttribute('role') ?? '') || p.tagName === 'SECTION') {
      const name = p.getAttribute('aria-label') ?? (p.getAttribute('aria-labelledby') ? labelledByText(p) : '');
      if (name) groups.push(name);
    }
    if (groups.length >= 2) break;
  }
  return cleanText(`${sectionOf(el, headings)} ${groups.join(' ')} ${ids} ${entryKind(el)}`);
}

/**
 * Whether a field sits in a work-experience or education block, judged by its neighbours:
 * the smallest surrounding block of 3–8 fields that also asks for an employer/position
 * (or a school/degree). Catches sections whose title isn't a heading element.
 */
function entryKind(el: Element): string {
  for (let p = el.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) {
    const count = p.querySelectorAll(CONTROL_SELECTOR).length;
    if (count < 3) continue;
    if (count > 8) return '';
    const labels = normalize(Array.from(p.querySelectorAll('label, legend')).map((l) => textOf(l)).join(' | '));
    if (/\b(employer|company|position title|job title)\b/.test(labels)) return 'experience';
    if (/\b(school|university|college|degree)\b/.test(labels)) return 'education';
    return '';
  }
  return '';
}

function labelledByText(el: Element): string {
  return (el.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .map((id) => (id ? el.ownerDocument.getElementById(id) : null))
    .map((n) => (n ? textOf(n) : ''))
    .join(' ');
}

/** Workday names each date's container ("formField-startDate"); that says which date it is. */
function dateContainerId(el: Element): string {
  for (let p = el.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) {
    const id = p.getAttribute('data-automation-id') ?? '';
    if (/(start|from|end|to)Date|YearAttended/i.test(id)) return id;
  }
  return '';
}

function headingsIn(root: ParentNode): Element[] {
  return deepQueryAll(root, 'h1, h2, h3, h4, h5, h6, [role="heading"]').filter((h) => !isOwnUi(h));
}

type Segment = keyof DateSegments;

/** Which part of a split date an input is, from Workday's automation ids or its label/placeholder. */
function segmentOf(el: Element): Segment | null {
  if (!(el instanceof HTMLInputElement)) return null;
  const auto = /dateSection(Month|Day|Year)/i.exec(el.getAttribute('data-automation-id') ?? '');
  if (auto) return auto[1].toLowerCase() as Segment;
  for (const hint of [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name')?.split(/[[\]._-]/).filter(Boolean).pop()]) {
    const h = (hint ?? '').trim().toLowerCase();
    if (/^(month|mm|mo)$/.test(h)) return 'month';
    if (/^(day|dd)$/.test(h)) return 'day';
    if (/^(year|yyyy|yy)$/.test(h)) return 'year';
  }
  return null;
}

/**
 * Month/day/year inputs that sit together form one date field; returns them grouped by their container.
 * Workday wraps each date in a dateInputWrapper, and its boxes are the whole date, even a lone
 * year ("From YYYY" in Education).
 */
function dateSegmentGroups(controls: HTMLElement[]): { container: HTMLElement; segments: DateSegments; inputs: HTMLInputElement[] }[] {
  const out: { container: HTMLElement; segments: DateSegments; inputs: HTMLInputElement[] }[] = [];
  const used = new Set<Element>();
  for (const el of controls) {
    if (used.has(el) || !segmentOf(el)) continue;
    const wrapper = el.closest<HTMLElement>('[data-automation-id="dateInputWrapper"]');
    const containers: HTMLElement[] = [];
    if (wrapper) containers.push(wrapper);
    else for (let c = el.parentElement, i = 0; c && i < 4; i++, c = c.parentElement) containers.push(c);
    let grouped = false;
    for (const container of containers) {
      const inputs = Array.from(container.querySelectorAll('input')).filter((x) => segmentOf(x) && !used.has(x));
      const segments: DateSegments = {};
      for (const x of inputs) segments[segmentOf(x)!] ??= x;
      const yearOnly = wrapper && segments.year && !segments.month && !segments.day;
      if ((segments.month && segments.year) || yearOnly) {
        inputs.forEach((x) => used.add(x));
        out.push({ container, segments, inputs });
        grouped = true;
        break;
      }
    }
    // A Workday year box with no month anywhere near it.
    if (!grouped && el.parentElement && /dateSectionYear/i.test(el.getAttribute('data-automation-id') ?? '')) {
      used.add(el);
      out.push({ container: el.parentElement, segments: { year: el as HTMLInputElement }, inputs: [el as HTMLInputElement] });
    }
  }
  return out;
}

export function scanFields(root: ParentNode = document): FieldDescriptor[] {
  taken = new Map();
  const headings = headingsIn(root);
  const toggles = toggleGroups(root);
  const controls = deepQueryAll<HTMLElement>(root, `${CONTROL_SELECTOR}, ${TOGGLE_SELECTOR}`).filter((el) => !isOwnUi(el));
  const fields: FieldDescriptor[] = [];
  const groups = new Map<string, HTMLElement[]>();
  const groupOrder: { key: string; kind: 'radio' | 'checkbox'; at: number }[] = [];
  const consumed = new Set<Element>();
  const dateGroups = new Map<Element, ReturnType<typeof dateSegmentGroups>[number]>();
  for (const g of dateSegmentGroups(controls)) {
    for (const x of g.inputs) consumed.add(x);
    dateGroups.set(g.inputs[0], g);
  }

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
    section: sectionContext(el, headings),
    multiple: false,
    hasValue: false,
    element: el,
    members: [],
  });

  for (const el of controls) {
    const dateGroup = dateGroups.get(el);
    if (dateGroup) {
      // One field for the whole widget, labelled by the text before it ("From", not "Month").
      const { container, segments, inputs } = dateGroup;
      // The nearest text is often just the "MM" hint, so keep looking outward until a real label remains.
      // Workday's own label comes first: the text just before its boxes is screen-reader help
      // ("current value is MM/YYYY").
      const stripHints = (t: string) => cleanText(t.replace(/\b(MM|DD|YYYY|YY)\b|\//g, ' '));
      let raw = '';
      let label = stripHints(fieldContainerLabel(inputs[0]));
      for (let node: HTMLElement | null = inputs[0], i = 0; node && i < 4 && !label; node = node.parentElement, i++) {
        raw = contextLabel(node, inputs);
        label = stripHints(raw);
      }
      if (!label) label = stripHints((raw = labelFor(container) || labelFor(inputs[0])));
      const f = base(inputs[0], segments.day ? 'date' : 'month', label);
      f.element = container;
      f.segments = segments;
      f.name = dateContainerId(inputs[0]) || f.name;
      f.members = inputs;
      f.required = inputs.some((x) => isRequired(x, '')) || isRequired(inputs[0], label);
      f.hasValue = inputs.some((x) => x.value.trim() !== '');
      fields.push(f);
      continue;
    }
    if (consumed.has(el)) continue;
    const toggle = toggles.get(el);
    if (toggle) {
      // One choice field per toggle group, at the position of its first part on the page.
      const { container, buttons, backing } = toggle;
      [...buttons, ...backing].forEach((x) => consumed.add(x));
      const labelEl = labelForName(backing);
      const label = (labelEl ? textOf(labelEl) : '') || groupLabel([...buttons, ...backing], container);
      const f = base(buttons[0], 'radio', label);
      f.element = container;
      f.members = buttons as HTMLInputElement[];
      f.options = buttons.map((b) => {
        const text = cleanText(b.getAttribute('aria-label') ?? '') || textOf(b);
        return { label: text, value: b.getAttribute('data-option') ?? text };
      });
      // Ashby marks required questions with a class on the label and draws the asterisk in CSS.
      f.required = isRequired(buttons[0], label) || backing.some((x) => x.required) || /required/i.test(labelEl?.className ?? '');
      f.hasValue = buttons.some(isChecked);
      fields.push(f);
      continue;
    }
    if (!el.matches(CONTROL_SELECTOR)) continue;
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
        const f = base(el, 'file', labelFor(el) || uploadLabel(el) || fileZoneLabel(el));
        f.hasValue = ((el as HTMLInputElement).files?.length ?? 0) > 0;
        fields.push(f);
        continue;
      }
      if (!isVisible(el) || (el as HTMLInputElement).readOnly && kind !== 'combobox' || isListboxValueShim(el)) continue;
      const f = base(el, kind, labelFor(el));
      if (kind === 'combobox') {
        f.options = comboboxOptions(el);
        f.hasValue = comboboxHasValue(el);
        // Search prompts can hold several choices (Skills).
        f.multiple = isSearchPrompt(el);
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
