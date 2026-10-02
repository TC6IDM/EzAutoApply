import { beforeEach, describe, expect, it } from 'vitest';
import { type DocumentPayload, fillField, formatDate, setNativeValue } from '../../src/fill/fillers';
import { resolveFields } from '../../src/fill/pipeline';
import { scanFields } from '../../src/fill/scan';
import type { FieldDescriptor } from '../../src/fill/types';
import { GREENHOUSE_LIKE, makeReactLike, mountCombobox } from './fixtures';
import { sampleProfile, settings } from './helpers';

const byLabel = (fields: FieldDescriptor[], text: string) => {
  const f = fields.find((x) => x.label.includes(text));
  if (!f) throw new Error(`no field labelled "${text}" in: ${fields.map((x) => x.label).join(' | ')}`);
  return f;
};

const RESUME: DocumentPayload = { name: 'Resume', fileName: 'resume.pdf', mime: 'application/pdf', base64: btoa('%PDF-1.4 test'), text: 'Jordan Rivera\nEngineer' };
const fillCtx = { getDocument: async (kind: string) => (kind === 'resume' ? RESUME : null) };

beforeEach(() => {
  document.body.innerHTML = GREENHOUSE_LIKE;
});

describe('scanFields', () => {
  it('finds visible fields with the right labels and kinds', () => {
    const fields = scanFields(document);
    const labels = fields.map((f) => `${f.kind}:${f.label}`);
    expect(labels).toContain('text:First Name *');
    expect(labels).toContain('text:Email');
    expect(labels).toContain('text:Phone');
    expect(labels).toContain('text:Location (City)');
    expect(labels).toContain('file:Resume/CV');
    expect(labels).toContain('radio:Are you legally authorized to work in the United States? *');
    expect(labels).toContain('radio:Will you now or in the future require sponsorship for employment visa status?');
    expect(labels).toContain('select:Highest degree completed');
    expect(labels).toContain('checkbox:I agree to the privacy policy');
    expect(labels).toContain('checkboxGroup:Race (select all that apply)');
    expect(labels.some((l) => l.includes('Hidden'))).toBe(false);
    expect(fields.some((f) => f.name === 'token')).toBe(false);
  });

  it('keeps fields in page order, with groups where their first option is', () => {
    const fields = scanFields(document);
    const i = (t: string) => fields.indexOf(byLabel(fields, t));
    expect(i('First Name')).toBeLessThan(i('Last Name'));
    expect(i('LinkedIn')).toBeLessThan(i('legally authorized'));
    expect(i('legally authorized')).toBeLessThan(i('sponsorship'));
    expect(i('sponsorship')).toBeLessThan(i('Highest degree'));
    expect(i('Veteran')).toBeLessThan(i('Race'));
  });

  it('collects group options and required flags', () => {
    const fields = scanFields(document);
    const auth = byLabel(fields, 'legally authorized');
    expect(auth.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(auth.required).toBe(true);
    expect(byLabel(fields, 'Race').options.map((o) => o.label)).toEqual(['Asian', 'White', 'Decline to self-identify']);
    expect(byLabel(fields, 'First Name').section).toBe('Personal information');
    expect(byLabel(fields, 'Veteran').section).toBe('Voluntary Self-Identification');
  });

  it('assigns stable ids across rescans', () => {
    const a = scanFields(document).map((f) => f.id);
    const b = scanFields(document).map((f) => f.id);
    expect(b).toEqual(a);
  });

  it('sees inputs inside open shadow roots', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<label for="gpa">GPA</label><input id="gpa">';
    expect(scanFields(document).some((f) => f.label === 'GPA')).toBe(true);
  });
});

describe('end to end: scan → resolve → fill', () => {
  it('fills a typical form from the profile and leaves open questions for the user', async () => {
    const fields = scanFields(document);
    const res = await resolveFields(fields, { profile: sampleProfile(), answers: [], host: 'boards.example.com', settings: settings({ provider: 'none' }), classifier: null });
    for (let i = 0; i < fields.length; i++) {
      if (res[i].status === 'filled' || res[i].status === 'review') await fillField(fields[i], res[i], fillCtx);
    }
    const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
    expect($<HTMLInputElement>('#first_name').value).toBe('Jordan');
    expect($<HTMLInputElement>('#last_name').value).toBe('Rivera');
    expect($<HTMLInputElement>('[name=email]').value).toBe('jordan@example.com');
    expect($<HTMLInputElement>('[name=phone]').value).toBe('(555) 123-4567');
    expect($<HTMLInputElement>('[name=location]').value).toBe('Austin, TX');
    expect($<HTMLInputElement>('#li').value).toBe('https://linkedin.com/in/jrivera');
    expect($<HTMLInputElement>('#resume').files?.[0]?.name).toBe('resume.pdf');
    expect($<HTMLInputElement>('[name=q_auth][value="1"]').checked).toBe(true);
    expect($<HTMLInputElement>('[name=q_sponsor][value="n"]').checked).toBe(true);
    expect($<HTMLSelectElement>('#degree').value).toBe('ba');
    expect($<HTMLSelectElement>('#veteran').value).toBe('I am not a protected veteran');
    expect($<HTMLInputElement>('[name=race][value=decline]').checked).toBe(true);

    const status = (t: string) => res[fields.indexOf(byLabel(fields, t))].status;
    expect(status('Why do you want')).toBe('needs');
    expect(status('favorite color')).toBe('skipped');
    expect(status('privacy policy')).toBe('skipped');
    expect($<HTMLTextAreaElement>('#why').value).toBe('');
  });

  it('uses saved answers for questions it has seen before', async () => {
    const fields = scanFields(document);
    const now = Date.now();
    const answers = [
      { id: 'a1', question: 'Why do you want to work at Initech?', normalized: 'why do you want to work at initech?', fieldKind: 'textarea' as const, answer: 'I love TPS reports.', scope: 'global', timesUsed: 0, lastUsed: now, createdAt: now },
      { id: 'a2', question: 'I agree to the privacy policy', normalized: 'i agree to the privacy policy', fieldKind: 'checkbox' as const, answer: true, scope: 'global', timesUsed: 0, lastUsed: now, createdAt: now },
    ];
    answers[0].normalized = 'why do you want to work at initech';
    const res = await resolveFields(fields, { profile: sampleProfile(), answers, host: 'x', settings: settings({ provider: 'none' }), classifier: null });
    const why = fields.indexOf(byLabel(fields, 'Why do you want'));
    const consent = fields.indexOf(byLabel(fields, 'privacy policy'));
    expect(res[why]).toMatchObject({ status: 'filled', source: 'answerBank', value: 'I love TPS reports.', answerId: 'a1' });
    expect(res[consent]).toMatchObject({ status: 'filled', value: true });
    await fillField(fields[consent], res[consent], fillCtx);
    expect((document.querySelector('[name=consent]') as HTMLInputElement).checked).toBe(true);
  });

  it('leaves fields that already have a value alone', async () => {
    (document.querySelector('#first_name') as HTMLInputElement).value = 'Jo';
    const fields = scanFields(document);
    const res = await resolveFields(fields, { profile: sampleProfile(), answers: [], host: 'x', settings: settings({ provider: 'none' }), classifier: null });
    expect(res[fields.indexOf(byLabel(fields, 'First Name'))].status).toBe('prefilled');
  });
});

describe('fillers', () => {
  it('sets values through React-style value trackers', () => {
    document.body.innerHTML = '<label for="n">Name</label><input id="n">';
    const input = document.querySelector('input')!;
    const react = makeReactLike(input);
    input.value = 'ignored';
    expect(input.value).toBe('');
    setNativeValue(input, 'Jordan Rivera');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.value).toBe('Jordan Rivera');
    expect(react.committed()).toBe('Jordan Rivera');
  });

  it('opens a combobox, finds the option and clicks it', async () => {
    document.body.innerHTML = '';
    const input = mountCombobox(document.body, 'Country', ['Canada', 'United States of America', 'Mexico']);
    const [f] = scanFields(document);
    expect(f.kind).toBe('combobox');
    expect(f.label).toBe('Country');
    const out = await fillField(f, { fieldId: f.id, key: 'country', value: 'United States', source: 'rule', confidence: 1, status: 'filled' }, fillCtx);
    expect(out).toEqual({ ok: true, valueText: 'United States of America' });
    expect(input.dataset.selected).toBe('United States of America');
  });

  it('reports when no combobox option matches', async () => {
    document.body.innerHTML = '';
    mountCombobox(document.body, 'Country', ['Canada', 'Mexico']);
    const [f] = scanFields(document);
    const out = await fillField(f, { fieldId: f.id, value: 'Japan', source: 'rule', confidence: 1, status: 'filled' }, fillCtx);
    expect(out.ok).toBe(false);
  });

  it('formats dates for the input', () => {
    const base = { kind: 'text' as const, placeholder: '', inputType: 'text', label: '' };
    expect(formatDate('2021-06', { ...base, placeholder: 'MM/YYYY' })).toBe('06/2021');
    expect(formatDate('2021-06', { ...base, kind: 'date' })).toBe('2021-06-01');
    expect(formatDate('2021-06', { ...base, kind: 'month' })).toBe('2021-06');
    expect(formatDate('2021-06', { ...base, placeholder: 'YYYY' })).toBe('2021');
    expect(formatDate('2021-06', { ...base, placeholder: 'MM/DD/YYYY' })).toBe('06/01/2021');
    expect(formatDate('2 weeks', base)).toBe('2 weeks');
  });
});
