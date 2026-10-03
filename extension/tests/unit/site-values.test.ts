import { describe, expect, it } from 'vitest';
import { FIELD_KEY_MAP } from '../../src/core/fieldKeys';
import { agrees, resolveFields } from '../../src/fill/pipeline';
import type { FieldInfo } from '../../src/fill/types';
import { field, opts, sampleProfile, settings } from './helpers';

const run = (fields: FieldInfo[], profile = sampleProfile(), s = settings({ provider: 'none' })) =>
  resolveFields(fields, { profile, answers: [], host: 'jobs.example.com', settings: s, classifier: null });

/** A field the site already filled in. */
const siteFilled = (partial: Partial<FieldInfo>, current: string) => field({ ...partial, hasValue: true, current });

describe('values the site filled in from the resume', () => {
  it('replaces a wrong one with the profile’s, for review', async () => {
    const [r] = await run([siteFilled({ label: 'Phone Number' }, '555-999-0000')]);
    expect(r).toMatchObject({ key: 'phone', value: '(555) 123-4567', status: 'review' });
    expect(r.note).toContain('Replaced “555-999-0000”');
  });

  it('keeps ones that already say what the profile says, in any format', async () => {
    const res = await run([
      siteFilled({ label: 'Phone' }, '+1 555.123.4567'),
      siteFilled({ label: 'First Name' }, 'JORDAN'),
      siteFilled({ label: 'From', section: 'Work Experience 1' }, '06/2021'),
      siteFilled({ label: 'State' }, 'Texas'),
    ]);
    expect(res.map((r) => r.status)).toEqual(['prefilled', 'prefilled', 'prefilled', 'prefilled']);
  });

  it('never touches a field the user typed in, or any field with the setting off', async () => {
    const off = settings({ provider: 'none' });
    off.fixSiteValues = false;
    expect((await run([field({ label: 'Phone', hasValue: true, current: '555-999-0000', touched: true })]))[0].status).toBe('prefilled');
    expect((await run([siteFilled({ label: 'Phone' }, '555-999-0000')], sampleProfile(), off))[0].status).toBe('prefilled');
  });

  it('counts a filled-in job, so the next empty one gets the next job', async () => {
    const res = await run([
      siteFilled({ label: 'Company', section: 'Work Experience 1' }, 'Acme Corp'),
      field({ label: 'Company', section: 'Work Experience 2' }),
    ]);
    expect(res[0].status).toBe('prefilled');
    expect(res[1]).toMatchObject({ key: 'expCompany', value: 'Globex', status: 'filled' });
  });

  it('flags a job the site added that isn’t in the profile', async () => {
    const res = await run([
      siteFilled({ label: 'Company', section: 'Work Experience 1' }, 'Acme Corp'),
      siteFilled({ label: 'Company', section: 'Work Experience 2' }, 'Globex'),
      siteFilled({ label: 'Company', section: 'Work Experience 3' }, 'Initrode Summer Camp'),
    ]);
    expect(res.map((r) => r.status)).toEqual(['prefilled', 'prefilled', 'review']);
    expect(res[2].note).toContain('isn’t in your profile');
  });

  it('compares dates, phone numbers and names the way the boxes show them', () => {
    expect(agrees('2021', '2021-06')).toBe(true);
    expect(agrees('06/01/2021', '2021-06')).toBe(true);
    expect(agrees('06/2020', '2021-06')).toBe(false);
    expect(agrees('5551234567', '(555) 123-4567')).toBe(true);
    expect(agrees('Software Engineer', 'Software Engineer')).toBe(true);
    expect(agrees('Senior Software Engineer at Acme', 'Software Engineer')).toBe(false);
  });
});

describe('current company', () => {
  const ask = async (label: string, profile = sampleProfile()) => (await run([field({ label })], profile))[0].value;

  it('is the job marked current', async () => {
    expect(await ask('Current Company')).toBe('Acme Corp');
  });

  it('is N/A between jobs, not the last employer', async () => {
    const p = sampleProfile();
    p.experience = p.experience.map((e) => ({ ...e, current: false, end: e.end || '2024-01' }));
    expect(await ask('Current Company', p)).toBe('N/A');
    expect(await ask('Current Job Title', p)).toBe('N/A');
    // A question about the most recent employer still gets the last job.
    expect(await ask('Most Recent Employer', p)).toBe('Acme Corp');
  });
});

describe('"How did you hear about us?" without the saved answer among the options', () => {
  const heard = (...labels: string[]) => field({ label: 'How did you hear about us?', kind: 'select', options: opts('Select...', ...labels) });

  it('picks Other, for review', async () => {
    const [r] = await run([heard('Indeed', 'Glassdoor', 'Other')]);
    expect(r).toMatchObject({ key: 'howHeard', value: 'Other', status: 'review' });
    expect(r.note).toContain('"LinkedIn" isn\'t an option here');
  });

  it('without Other, picks a general source, else anything offered', async () => {
    expect((await run([heard('Indeed', 'Company Website', 'Glassdoor')]))[0].value).toBe('Company Website');
    expect((await run([heard('Indeed', 'Glassdoor')]))[0]).toMatchObject({ value: 'Indeed', status: 'review' });
  });

  it('still picks LinkedIn when it’s there', async () => {
    expect((await run([heard('Indeed', 'LinkedIn', 'Other')]))[0]).toMatchObject({ value: 'LinkedIn', status: 'filled' });
  });

  it('is the only question that falls back like this', () => {
    expect(Object.values(FIELD_KEY_MAP).filter((k) => k.anyOption).map((k) => k.key)).toEqual(['howHeard']);
  });
});
