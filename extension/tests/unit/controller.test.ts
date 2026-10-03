import { beforeEach, describe, expect, it } from 'vitest';
import { AutofillController } from '../../src/content/controller';
import type { FrameReport } from '../../src/fill/types';
import type { ContentToBackground } from '../../src/messages';
import { sampleProfile, settings } from './helpers';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A controller talking to a stand-in background that records what it's sent. */
function setup() {
  const sent: ContentToBackground[] = [];
  const s = settings({ provider: 'none' });
  const send = async (msg: ContentToBackground) => {
    sent.push(msg);
    if (msg.type === 'getContext') return { profile: sampleProfile(), answers: [], settings: s };
    if (msg.type === 'getDocument') return { name: 'Resume', fileName: 'Jordan_Rivera_Resume.pdf', mime: 'application/pdf', base64: btoa('%PDF'), text: '' };
    return null;
  };
  const controller = new AutofillController(send, () => null);
  const lastReport = () => (sent.filter((m) => m.type === 'report').at(-1) as { report: FrameReport }).report;
  return { controller, sent, lastReport };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('answering from the side panel', () => {
  it('doesn’t then ask to remember the same answer as a change made on the page', { timeout: 10000 }, async () => {
    document.body.innerHTML = '<label for="q">What is your favorite color?</label><input id="q">';
    const { controller, sent, lastReport } = setup();
    await controller.autofill();
    const [f] = lastReport().fields;
    expect(f.status).toBe('skipped');

    expect(await controller.applyAnswer(f.id, 'Blue')).toMatchObject({ ok: true });
    await wait(1000);
    expect(sent.some((m) => m.type === 'fieldEdited')).toBe(false);
    expect(lastReport().fields[0]).toMatchObject({ status: 'filled', current: 'Blue' });

    // A real change on the page afterwards still counts.
    const input = document.querySelector('input')!;
    input.value = 'Green';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(600);
    expect(sent.filter((m) => m.type === 'fieldEdited')).toEqual([{ type: 'fieldEdited', fieldId: f.id, userValue: 'Green' }]);
  });
});

describe('sites that read the uploaded resume', () => {
  it('uploads first, waits for the site to fill the form, then corrects what it got wrong', { timeout: 20000 }, async () => {
    document.body.innerHTML = `
      <h2>Apply</h2>
      <label for="resume">Resume</label><input type="file" id="resume">
      <label for="first">First Name</label><input id="first">
      <label for="phone">Phone</label><input id="phone">
      <label for="city">City</label><input id="city">
      <p id="status"></p>`;
    const first = document.querySelector<HTMLInputElement>('#first')!;
    const phone = document.querySelector<HTMLInputElement>('#phone')!;
    const city = document.querySelector<HTMLInputElement>('#city')!;
    // The site's resume reader: a moment after the upload it fills the form, partly wrong.
    document.querySelector('#resume')!.addEventListener('change', () => {
      setTimeout(() => {
        first.value = 'Rivera';
        phone.value = '555-000-1111';
        city.value = 'Austin';
        document.querySelector('#status')!.textContent = 'We read your resume';
      }, 300);
    });

    const { controller, lastReport } = setup();
    await controller.autofill();
    expect([first.value, phone.value, city.value]).toEqual(['Jordan', '(555) 123-4567', 'Austin']);
    const byLabel = Object.fromEntries(lastReport().fields.map((f) => [f.label, f]));
    expect(byLabel['Resume']).toMatchObject({ status: 'filled', valueText: 'Jordan_Rivera_Resume.pdf' });
    expect(byLabel['First Name']).toMatchObject({ status: 'review', note: 'Replaced “Rivera”, which the site filled in, with your profile' });
    expect(byLabel['Phone']).toMatchObject({ status: 'review' });
    expect(byLabel['City']).toMatchObject({ status: 'prefilled' });
  });
});
