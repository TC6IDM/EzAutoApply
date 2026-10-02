import { beforeEach, describe, expect, it } from 'vitest';
import { fillField } from '../../src/fill/fillers';
import { matchRules } from '../../src/fill/match/rules';
import { resolveFields } from '../../src/fill/pipeline';
import { scanFields } from '../../src/fill/scan';
import { sampleProfile, settings } from './helpers';

/**
 * Ashby's Yes/No questions, with the structure of jobs.ashbyhq.com (October 2026): two
 * aria-pressed buttons and a hidden checkbox; the label's `for` names the checkbox's
 * `name`, and "required" is a class (the asterisk is drawn by CSS).
 */
const yesNo = (id: string, question: string) => `
  <div class="ashby-application-form-field-entry" data-field-path="${id}">
    <label class="_heading_f7cvd_52 _required_f7cvd_91 ashby-application-form-question-title" for="${id}">${question}</label>
    <div class="ashby-application-form-input-yesno">
      <button class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="yes">Yes</button>
      <button class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="no">No</button>
      <input type="checkbox" tabindex="-1" name="${id}" style="display:none">
    </div>
  </div>`;

beforeEach(() => {
  document.body.innerHTML = [
    yesNo('question_1', 'Are you legally authorized to work in Canada?'),
    yesNo('question_2', 'Do you now or will you in the future require sponsorship for work authorization in Canada?'),
    yesNo('question_3', 'Do you currently live in a commutable distance to NYC, San Francisco, or Toronto?'),
  ].join('');
  // Behave like Ashby: pressing one option un-presses the other and sets the hidden checkbox.
  for (const group of Array.from(document.querySelectorAll('.ashby-application-form-input-yesno'))) {
    const buttons = Array.from(group.querySelectorAll('button'));
    for (const b of buttons) {
      b.addEventListener('click', () => {
        buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        group.querySelector<HTMLInputElement>('input')!.checked = b.dataset.option === 'yes';
      });
    }
  }
});

describe('Ashby Yes/No buttons', () => {
  it('are found as one question each, labelled, with Yes/No options', () => {
    const fields = scanFields(document);
    expect(fields).toHaveLength(3);
    expect(fields.map((f) => [f.kind, f.label, f.required])).toEqual([
      ['radio', 'Are you legally authorized to work in Canada?', true],
      ['radio', 'Do you now or will you in the future require sponsorship for work authorization in Canada?', true],
      ['radio', 'Do you currently live in a commutable distance to NYC, San Francisco, or Toronto?', true],
    ]);
    expect(fields[0].options).toEqual([
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ]);
    expect(matchRules(fields[0])?.key).toBe('authorizedToWork');
    expect(matchRules(fields[1])?.key).toBe('needsSponsorship');
  });

  it('are answered from the profile and pressed', async () => {
    const profile = sampleProfile();
    profile.workAuth.authorizedCountries = ['Canada'];
    const fields = scanFields(document);
    const res = await resolveFields(fields, { profile, answers: [], host: 'jobs.ashbyhq.com', settings: settings({ provider: 'none' }), classifier: null });
    expect(res.map((r) => [r.status, r.value])).toEqual([
      ['filled', 'Yes'],
      ['filled', 'No'],
      ['needs', undefined],
    ]);
    const ctx = { getDocument: async () => null, getSecret: async () => null };
    for (let i = 0; i < 2; i++) expect((await fillField(fields[i], res[i], ctx)).ok).toBe(true);

    const pressed = (q: string) =>
      Array.from(document.querySelectorAll(`[data-field-path="${q}"] button`)).map((b) => b.getAttribute('aria-pressed'));
    expect(pressed('question_1')).toEqual(['true', 'false']);
    expect(pressed('question_2')).toEqual(['false', 'true']);
    expect(pressed('question_3')).toEqual(['false', 'false']);
    expect(document.querySelector<HTMLInputElement>('[name=question_1]')!.checked).toBe(true);
  });

  it('notices an answer that is already pressed', () => {
    document.querySelector<HTMLButtonElement>('[data-field-path="question_3"] [data-option="no"]')!.click();
    expect(scanFields(document)[2].hasValue).toBe(true);
  });
});
