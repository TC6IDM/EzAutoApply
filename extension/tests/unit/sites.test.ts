import { beforeEach, describe, expect, it } from 'vitest';
import { scoreLocation } from '../../src/core/options';
import { acknowledgePrivacyNotices } from '../../src/fill/consent';
import { fillField } from '../../src/fill/fillers';
import { matchRules } from '../../src/fill/match/rules';
import { scanFields } from '../../src/fill/scan';
import type { FieldDescriptor, Resolution } from '../../src/fill/types';
import { mountWorkdaySelect } from './fixtures';

const ctx = { getDocument: async () => null, getSecret: async () => null };
const res = (f: FieldDescriptor, value: string, key?: string): Resolution => ({ fieldId: f.id, key, value, source: 'rule', confidence: 1, status: 'filled' });

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * Greenhouse's new job boards (job-boards.greenhouse.io), as observed October 2026:
 * react-select inputs that ignore synthetic mouse/keyboard events (the menu is
 * controlled by Greenhouse) but open from the "Toggle flyout" button; the location box
 * only searches on typed input.
 */
function mountGreenhouseSelect(id: string, label: string, options: string[], opts: { searchOnly?: boolean; limit?: number } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'select__container';
  wrap.innerHTML = `
    <label id="${id}-label" for="${id}" class="label select__label">${label}<span aria-hidden="true">*</span></label>
    <div class="select-shell"><div class="select__control">
      <div class="select__value-container"><div class="select__placeholder">Select...</div>
        <div class="select__input-container"><input class="select__input" id="${id}" role="combobox" aria-autocomplete="list" aria-haspopup="true" aria-labelledby="${id}-label" aria-required="true" type="text" value=""></div>
      </div>
      <div class="select__indicators">${opts.searchOnly ? '' : '<button type="button" aria-label="Toggle flyout" tabindex="-1">v</button>'}</div>
    </div></div>`;
  document.body.appendChild(wrap);
  const input = wrap.querySelector('input')!;
  const value = wrap.querySelector<HTMLElement>('.select__value-container')!;
  let menu: HTMLElement | null = null;
  const close = () => {
    menu?.remove();
    menu = null;
  };
  const open = (items: string[]) => {
    close();
    menu = document.createElement('div');
    menu.className = 'select__menu';
    menu.innerHTML = `<div role="listbox" id="react-select-${id}-listbox"></div>`;
    for (const text of items) {
      const o = document.createElement('div');
      o.setAttribute('role', 'option');
      o.textContent = text;
      o.addEventListener('click', () => {
        value.querySelector('.select__placeholder')?.remove();
        value.querySelector('.select__single-value')?.remove();
        value.insertAdjacentHTML('afterbegin', `<div class="select__single-value">${text}</div>`);
        input.value = '';
        close();
      });
      menu.firstElementChild!.appendChild(o);
    }
    wrap.appendChild(menu);
  };
  wrap.querySelector('button')?.addEventListener('click', () => (menu ? close() : open(options)));
  input.addEventListener('input', (e) => {
    // Only real typing searches.
    // Every word typed must appear in the option; the search shows at most `limit` results.
    const words = input.value.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (e instanceof InputEvent && e.inputType === 'insertText') open(options.filter((o) => words.every((w) => o.toLowerCase().includes(w))).slice(0, opts.limit ?? 50));
  });
  input.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  return { chosen: () => value.querySelector('.select__single-value')?.textContent ?? '' };
}

describe('Greenhouse dropdowns', () => {
  it('opens a dropdown through its toggle button, lists its options and selects one', async () => {
    const q = mountGreenhouseSelect('question_1', 'Are you currently living in Canada?', ['Yes', 'No']);
    const [f] = scanFields(document);
    expect(f).toMatchObject({ kind: 'combobox', label: 'Are you currently living in Canada?*', required: true });
    const { readDropdownOptions } = await import('../../src/fill/fillers');
    expect(await readDropdownOptions(f)).toEqual(['Yes', 'No']);
    expect(await fillField(f, res(f, 'No'), ctx)).toMatchObject({ ok: true, valueText: 'No' });
    expect(q.chosen()).toBe('No');
  });

  it('types the city into a location search and picks "City, Province, Country"', { timeout: 15000 }, async () => {
    const loc = mountGreenhouseSelect('candidate-location', 'Location (City)', ['Toronto, Ontario, Canada', 'Toronto, Ohio, United States', 'Austin, Texas, United States'], { searchOnly: true });
    const [f] = scanFields(document);
    expect(matchRules(f)?.key).toBe('location');
    expect(await fillField(f, res(f, 'Toronto, ON', 'location'), ctx)).toMatchObject({ ok: true, valueText: 'Toronto, Ontario, Canada' });
    expect(loc.chosen()).toBe('Toronto, Ontario, Canada');
  });

  it('searches "city region" when the city alone only shows other places with that name', { timeout: 20000 }, async () => {
    // Greenhouse shows 10 results; a common town name fills them with other countries' towns.
    const others = ['Virginia, United States', 'New Jersey, United States', 'England, United Kingdom', 'Connecticut, United States', 'California, United States', 'Tasmania, Australia', 'Maine, United States', 'Michigan, United States', 'Maryland, United States', 'Indiana, United States'];
    const loc = mountGreenhouseSelect('candidate-location', 'Location (City)', [...others.map((r) => `Springfield, ${r}`), 'Springfield, Ontario, Canada'], { searchOnly: true, limit: 10 });
    const [f] = scanFields(document);
    expect(await fillField(f, res(f, 'Springfield, Ontario', 'location'), ctx)).toMatchObject({ ok: true, valueText: 'Springfield, Ontario, Canada' });
    expect(loc.chosen()).toBe('Springfield, Ontario, Canada');
  });

  it('matches locations by city plus region or country', () => {
    expect(scoreLocation('Toronto, Ontario, Canada', 'Toronto, ON')).toBeGreaterThan(0.9);
    expect(scoreLocation('Toronto, Ohio, United States', 'Toronto, ON')).toBe(0);
    expect(scoreLocation('Austin, Texas, United States', 'Austin, TX')).toBeGreaterThan(0.9);
    expect(scoreLocation('London, England, United Kingdom', 'London, UK')).toBeGreaterThan(0.9);
  });
});

describe('typing only goes to the field being filled', () => {
  // ~5 s of real waits (the list never opens, so every way of opening it is tried): it sat
  // right on vitest's 5 s default and failed under full-suite load (#52).
  it('does not type into a previously focused dropdown', { timeout: 15000 }, async () => {
    const first = mountWorkdaySelect(document.body, 'Gender', ['Male', 'Female'], {});
    // A second dropdown whose list never opens: the type-ahead must not land in the first one.
    document.body.insertAdjacentHTML('beforeend', '<label for="dead">Ethnicity</label><div id="dead" role="combobox" tabindex="-1">Select</div>');
    first.button.focus();
    const dead = scanFields(document).find((f) => f.label === 'Ethnicity')!;
    const out = await fillField(dead, res(dead, 'Male'), ctx);
    expect(out.ok).toBe(false);
    expect(first.chosen()).toBe('');
  });
});

describe('work experience blocks without a heading (Avature)', () => {
  it('reads "Start date" next to Employer / Position title as the job start, not availability', () => {
    document.body.innerHTML = `
      <div class="block">
        <div><label for="emp">Employer *</label><input id="emp"></div>
        <div><label for="title">Position title *</label><input id="title"></div>
        <div><label for="cur">Current position?</label><select id="cur"><option>Yes</option><option>No</option></select></div>
        <div><label for="start">Start date *</label><input id="start" type="month"></div>
        <div><label for="end">End date</label><input id="end" type="month"></div>
      </div>
      <div class="other">
        <div><label for="avail">Start date</label><input id="avail" type="date"></div>
        <div><label for="sal">Desired salary</label><input id="sal"></div>
        <div><label for="hear">How did you hear about us?</label><input id="hear"></div>
      </div>`;
    const fields = scanFields(document);
    const key = (id: string) => matchRules(fields.find((f) => f.htmlId === id)!)?.key;
    expect(key('start')).toBe('expStart');
    expect(key('end')).toBe('expEnd');
    expect(key('avail')).toBe('startDate');
  });
});

describe('privacy notices', () => {
  it('opens the notice and presses Acknowledge, and nothing else', async () => {
    document.body.innerHTML = `
      <span>Privacy notice:*</span>
      <a href="#" id="link">Click to read and acknowledge the privacy notice</a>
      <button id="apply">Apply</button>`;
    let acknowledged = false;
    let applied = false;
    document.querySelector('#apply')!.addEventListener('click', () => (applied = true));
    document.querySelector('#link')!.addEventListener('click', (e) => {
      e.preventDefault();
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div role="dialog" id="dlg"><h2>Data Protection Notice and Cookie Policy</h2><p>How we process your personal data…</p>
           <button id="ack">Acknowledge</button><button id="back">Go Back</button></div>`,
      );
      document.querySelector('#ack')!.addEventListener('click', () => {
        acknowledged = true;
        document.querySelector('#dlg')!.remove();
      });
    });
    const done = await acknowledgePrivacyNotices(document);
    expect(done).toEqual([{ label: 'Click to read and acknowledge the privacy notice' }]);
    expect(acknowledged).toBe(true);
    expect(applied).toBe(false);
  });
});

/** Workable (apply.workable.com, November 2026): each role="radio" is labelled by the question and its own text. */
describe('Workable yes/no radios', () => {
  it('reads each option as its own text, not the question plus it', async () => {
    const option = (id: string, text: string) => `
      <div data-ui="option" aria-labelledby="q_label radio_label_${id}" id="wrapper_${id}" role="radio" aria-checked="false" aria-required="true" tabindex="0">
        <label><input aria-required="true" required="" id="${id}" tabindex="-1" aria-hidden="true" type="radio" name="QA_1" value="">
        <div><div><span id="radio_label_${id}">${text}</span></div></div></label>
      </div>`;
    document.body.innerHTML = `
      <div><span><span><strong>*</strong></span><span><span id="q_label"><strong>Are you legally authorized to work in Canada?</strong></span></span></span>
      <div><fieldset role="radiogroup" data-ui="QA_1" aria-labelledby="q_label">${option('a1', 'YES')}${option('a2', 'NO')}</fieldset></div></div>`;
    // Workable's React sets aria-checked on the clicked option.
    for (const r of document.querySelectorAll<HTMLElement>('[role="radio"]')) {
      r.addEventListener('click', () => {
        for (const o of document.querySelectorAll('[role="radio"]')) o.setAttribute('aria-checked', String(o === r));
      });
    }
    const field = scanFields(document).find((f) => f.kind === 'radio')!;
    expect(field.label).toBe('Are you legally authorized to work in Canada?');
    expect(field.options?.map((o) => o.label)).toEqual(['YES', 'NO']);
    const out = await fillField(field, res(field, 'Yes', 'authorizedToWork'), ctx);
    expect(out.ok).toBe(true);
    expect(document.getElementById('wrapper_a1')!.getAttribute('aria-checked')).toBe('true');
  });
});
