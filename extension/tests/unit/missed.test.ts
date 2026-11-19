import { beforeEach, describe, expect, it } from 'vitest';
import { findMissed, formSnapshot } from '../../src/content/missed';
import type { FieldReport } from '../../src/fill/types';
import { reportBody } from '../../src/incidents/report';
import { missedIncident, redactionsFor } from '../../src/incidents/incident';
import { sampleProfile } from './helpers';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a field an applier filled by hand (#98)', () => {
  it('finds the block around its label and its control, values and picks stripped', () => {
    // A custom widget the scan doesn't know: a div "select" with no role, its label a span.
    document.body.innerHTML = `
      <section><h2>About you</h2>
        <div class="q"><span class="q-title">Preferred pronouns *</span>
          <div class="fake-select" tabindex="0"><input type="text" value="Jordan Rivera" aria-hidden="true"><ul><li data-v="a" class="picked" aria-selected="true">They/them</li><li>She/her</li></ul></div>
        </div>
        <div class="q"><label>Phone</label><input name="phone" value="(555) 123-4567"></div>
      </section>`;
    const got = findMissed(document, 'Preferred pronouns')!;
    expect(got.html).toContain('q-title');
    expect(got.html).toContain('fake-select');
    expect(got.html).not.toContain('Phone');
    expect(got.html).not.toContain('Jordan');
    expect(got.seen).toBe(false);
    expect(findMissed(document, 'Favourite colour')).toBeNull();
  });

  it('says when the scan did see a control there', () => {
    document.body.innerHTML = `<div><label for="x">Notice period</label><select id="x" data-ezaa-id="f3"><option selected>Two weeks</option><option>Now</option></select></div>`;
    const got = findMissed(document, 'Notice period:')!;
    expect(got.seen).toBe(true);
    expect(got.html).not.toContain('selected');
  });

  it('files it with no sample-profile value left, standing in for the applier’s incident', () => {
    const r = redactionsFor(sampleProfile());
    const i = missedIncident(
      { url: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123/apply?token=abc', now: Date.parse('2026-11-19T05:00:00Z'), jobId: 'j1', rand: () => 'zz' },
      { label: 'Preferred pronouns', html: '<div>Jordan Rivera, jordan@example.com, (555) 123-4567</div>', seen: false, frameId: 0, kind: 'handFilled', note: 'filled by hand', replaces: 'a1' },
      r,
    );
    const text = JSON.stringify(i);
    for (const v of ['Jordan', 'Rivera', 'jordan@example.com', '123-4567', 'token=abc']) expect(text).not.toContain(v);
    expect([i.kind, i.ats, i.replaces, i.field?.status]).toEqual(['handFilled', 'workday', 'a1', 'notScanned']);
    expect(i.note).toMatch(/never found this field/);
  });
});

describe('"Report a field" (#114)', () => {
  it('snapshots the form that holds the page’s controls, values stripped, and nothing for a frame without one', () => {
    document.body.innerHTML = `
      <header><input type="search" placeholder="Search jobs"></header>
      <form id="apply"><label>Phone</label><input name="phone" value="(555) 123-4567">
        <label>Notice period</label><div class="fake-select" tabindex="0">Two weeks</div>
        <textarea name="why">Because Jordan loves it</textarea><select><option selected>Yes</option><option>No</option></select></form>`;
    const html = formSnapshot(document)!;
    expect(html).toContain('id="apply"');
    expect(html).not.toContain('Search jobs');
    for (const v of ['555', 'Jordan', 'selected']) expect(html).not.toContain(v);
    document.body.innerHTML = '<p>Thanks for visiting</p>';
    expect(formSnapshot(document)).toBeNull();
  });

  it('sends the owner’s note, the markup and the scan’s findings with no sample-profile value left, and no address query', () => {
    const r = redactionsFor(sampleProfile());
    const field: FieldReport = {
      id: 'f2', frameId: 0, label: 'Reference for Jordan Rivera', kind: 'select', options: ['Acme Corp', 'Other'], required: true,
      status: 'review', source: 'rule', key: 'expCompany', confidence: 1, valueText: 'Acme Corp',
    };
    const body = reportBody(
      {
        url: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=abc&email=jordan@example.com',
        title: 'Jordan Rivera – Application',
        frames: [{ frameId: 0, html: '<form><label>Phone</label><div>Jordan Rivera · jordan@example.com · (555) 123-4567 · 12 Main St</div></form>' }],
        screen: 'data:image/jpeg;base64,AAAA',
      },
      '  The Employer box for Acme Corp got Globex; Jordan’s phone 555-123-4567 was not found  ',
      [field],
      r,
    );
    const text = JSON.stringify({ ...body, screen: undefined });
    for (const v of ['Jordan', 'Rivera', 'jordan@example.com', '123-4567', 'Acme Corp', 'Globex', '12 Main St', 'gh_src']) expect(text, v).not.toContain(v);
    expect(body.url).toBe('https://boards.greenhouse.io/acme/jobs/1');
    expect(body.ats).toBe('greenhouse');
    expect(body.html).toContain('<!-- frame 0 -->');
    expect(body.note.startsWith('The Employer box for {{experience.0.company}}')).toBe(true);
    expect(body.fields[0]).toEqual({
      frameId: 0, id: 'f2', label: 'Reference for {{name.full}}', kind: 'select', status: 'review', required: true, source: 'rule', key: 'expCompany',
      options: ['{{experience.0.company}}', 'Other'],
    });
    expect(body.fields[0]).not.toHaveProperty('valueText');
    expect(body.screen).toBe('data:image/jpeg;base64,AAAA');
  });
});
