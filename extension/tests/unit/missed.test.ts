import { beforeEach, describe, expect, it } from 'vitest';
import { findMissed } from '../../src/content/missed';
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
