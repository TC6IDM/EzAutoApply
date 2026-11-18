import { describe, expect, it } from 'vitest';
import { atsOf } from '../../src/core/sites';
import type { FieldReport } from '../../src/fill/types';
import { fieldIncidents, incidentKey, MAX_SNIPPET, redact, redactionsFor, runIncidents } from '../../src/incidents/incident';
import { newRun } from '../../src/run/loop';
import { sampleProfile } from './helpers';

const report = (over: Partial<FieldReport>): FieldReport => ({
  id: 'f1',
  frameId: 0,
  label: 'Phone',
  kind: 'text',
  options: [],
  required: true,
  status: 'needs',
  source: 'none',
  confidence: 0,
  valueText: '',
  ...over,
});
const ctx = { url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/apply?source=LinkedIn&token=abc#step2', now: Date.parse('2026-11-17T14:03:22Z'), rand: () => 'r4nd' };

/** Every identifying profile value, in the forms pages show them. */
const SECRETS = ['Jordan', 'Rivera', 'jordan@example.com', 'jordan%40example.com', '5551234567', '555-123-4567', '(555) 123-4567', '12 Main St', '78701', 'jrivera', 'Acme Corp', 'Globex', 'University of Texas at Austin'];

describe('incidents (#18)', () => {
  it('no profile value survives redaction, in any of the forms a page shows it', () => {
    const r = redactionsFor(sampleProfile());
    const page = `<div data-automation-id="formField-phone"><label>Phone for JORDAN RIVERA</label>
      <span class="pill">University of Texas at Austin</span> <span>Rivera, Jordan</span>
      <a href="mailto:jordan@example.com">jordan@example.com</a> <a href="https://www.linkedin.com/in/jrivera/">linkedin.com/in/jrivera</a>
      <p>Call +1 555-123-4567 or 5551234567, (555) 123-4567. 12 Main St, Austin TX 78701. Worked at Acme Corp &amp; Globex.</p>
      <p>Mail jordan%40example.com · github.com/jrivera · https://jrivera.dev</p>
      <div class="file-name">Jordan_Rivera_Resume.pdf</div><div>jordan-rivera-cover.docx</div></div>`;
    const fields = [
      report({ debug: page, note: 'The site had "Jordan Rivera"' }),
      report({ id: 'f2', label: 'Employer', status: 'review', source: 'rule', key: 'expCompany', valueText: 'Acme Corp', uncertain: true, debug: page }),
      report({ id: 'f3', label: 'Mobile', note: 'The site says: 555 123 4567 is not a valid number', debug: page }),
    ];
    const incidents = fieldIncidents(fields, ctx, r);
    expect(incidents).toHaveLength(3);
    const text = JSON.stringify(incidents).toLowerCase();
    for (const s of SECRETS) expect(text, s).not.toContain(s.toLowerCase());
    expect(text.replace(/[^\d]/g, ' ')).not.toMatch(/555\s*123\s*4567/);
    expect(incidents[0].domSnippet).toContain('{{phone}}');
    expect(incidents[0].domSnippet).toContain('{{education.0.school}}');
    expect(incidents[0].note).toBe('The site had "{{name.full}}"');
    expect(incidents[1].value).toBe('{{experience.0.company}}');
  });

  it('leaves site wording alone: skills, degree, country and words that only contain a name', () => {
    const r = redactionsFor(sampleProfile());
    expect(redact('Jobs in the United States for TypeScript, Bachelor of Science; Jordanian? Joint.', r)).toBe('Jobs in the United States for TypeScript, Bachelor of Science; Jordanian? Joint.');
    expect(redact('Jo will start', r)).toBe('{{name.preferred}} will start');
  });

  it('files needs as unmatched, a filler that wasn\'t sure as widgetFailed, a site rejection as rejected, and nothing for filled fields', () => {
    const r = redactionsFor(sampleProfile());
    const kinds = fieldIncidents(
      [
        report({ id: 'a' }),
        report({ id: 'b', status: 'review', uncertain: true, source: 'rule' }),
        report({ id: 'c', status: 'review', note: 'The page didn’t clearly confirm this choice; check it', source: 'answerBank' }),
        report({ id: 'd', status: 'needs', note: 'The site says: Required' }),
        report({ id: 'e', status: 'filled', source: 'rule' }),
        report({ id: 'f', status: 'review', source: 'classifier', note: 'Guessed' }),
        report({ id: 'g', status: 'skipped' }),
      ],
      ctx,
      r,
    ).map((i) => [i.field?.id, i.kind, i.siteMessage]);
    expect(kinds).toEqual([['a', 'unmatched', undefined], ['b', 'widgetFailed', undefined], ['c', 'widgetFailed', undefined], ['d', 'rejected', 'Required']]);
  });

  it('strips the query and hash, names the ATS and keeps a snippet within 30 KB', () => {
    const [i] = fieldIncidents([report({ debug: `<div>${'x'.repeat(MAX_SNIPPET * 2)}</div>` })], ctx, []);
    expect(i.url).toBe('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/apply');
    expect(i).toMatchObject({ host: 'acme.wd5.myworkdayjobs.com', ats: 'workday', id: '2026-11-17T14-03-22-000Z-workday-r4nd', kind: 'unmatched' });
    expect(i.domSnippet!.length).toBe(MAX_SNIPPET);
    expect(atsOf('https://boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
    expect(atsOf('https://careers.example.com/apply')).toBe('other');
  });

  it('files a Run that stopped on the site\'s errors, no progress or no button; not one that reached Submit', () => {
    const r = redactionsFor(sampleProfile());
    const run = (stop: NonNullable<ReturnType<typeof newRun>['stop']>) => ({ ...newRun(3, ctx.url, 0, 'job-1'), page: 2, status: 'stopped' as const, stop });
    const fields = [report({ id: 'f1', label: 'Phone' }), report({ id: 'f2', label: 'Email', status: 'filled' })];
    const rejected = runIncidents(run({ reason: 'validationErrors', detail: 'Enter a valid phone, not 555-123-4567', fieldIds: ['f1'] }), fields, ctx, r);
    expect(rejected.map((i) => [i.kind, i.field?.id, i.page, i.jobId])).toEqual([['rejected', 'f1', 2, 'job-1']]);
    expect(rejected[0].siteMessage).toBe('Enter a valid phone, not {{phone}}');
    expect(runIncidents(run({ reason: 'noProgress', detail: 'pressed "Next"' }), fields, ctx, r).map((i) => [i.kind, i.stop?.reason])).toEqual([['navigation', 'noProgress']]);
    expect(runIncidents(run({ reason: 'noButton' }), fields, ctx, r)).toHaveLength(1);
    expect(runIncidents(run({ reason: 'submitReady', detail: '"Submit"' }), fields, ctx, r)).toEqual([]);
    expect(runIncidents({ ...run({ reason: 'noButton' }), status: 'running' }, fields, ctx, r)).toEqual([]);
  });

  it('gives the same problem on the same page one key, whenever it is re-sent', () => {
    const a = fieldIncidents([report({})], ctx, [])[0];
    const b = fieldIncidents([report({ note: 'later' })], { ...ctx, now: ctx.now + 5000, url: `${ctx.url}&again=1` }, [])[0];
    expect(incidentKey(a)).toBe(incidentKey(b));
    expect(incidentKey(a)).not.toBe(incidentKey(fieldIncidents([report({ id: 'f9' })], ctx, [])[0]));
  });
});

describe('the field snippet the content script sends (#18)', () => {
  it('drops scripts, styles and icons, and writes no values, typed or default', async () => {
    const { debugHtml } = await import('../../src/content/controller');
    document.body.innerHTML = `<div><div class="wrap"><label for="c">Cover note</label><textarea id="c">My default text</textarea>
      <input id="p" value="secret-value"><svg><path d="M0 0"/></svg><script>var token = 1</script><style>.x{}</style></div></div>`;
    (document.getElementById('c') as HTMLTextAreaElement).value = 'typed by the user';
    const html = debugHtml({ element: document.getElementById('c') } as never);
    expect(html).toContain('Cover note');
    for (const gone of ['My default text', 'typed by the user', 'secret-value', '<svg', '<script', 'token', '<style']) expect(html).not.toContain(gone);
  });
});
