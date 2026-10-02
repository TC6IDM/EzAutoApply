import { beforeEach, describe, expect, it } from 'vitest';
import { fillField, formatDate } from '../../src/fill/fillers';
import { matchRules } from '../../src/fill/match/rules';
import { resolveFields } from '../../src/fill/pipeline';
import { scanFields } from '../../src/fill/scan';
import { sampleProfile, settings } from './helpers';

/** Markup from a real BambooHR application (rocscience.bamboohr.com), reported with "Copy details". */
const PAGE = `
  <div class="field">
    <p>Resume*</p>
    <div data-fabric-component="FileUpload">
      <div data-fabric-component="FileUploadInput">
        <div data-fabric-component="FileUploadToggle"><div data-fabric-component="Flex">
          <button type="button" data-fabric-component="Button"><span>Choose File*</span></button>
          <div data-fabric-component="Flex"><svg aria-hidden="true"></svg><p class="file-name">No file selected</p></div>
        </div></div>
        <input type="file" aria-label="file-input" accept=".pdf,.doc,.docx,.txt" style="display:none">
      </div>
    </div>
  </div>
  <div class="field">
    <label id="province-label">Province*</label>
    <div role="button" id="province" tabindex="0" aria-haspopup="listbox" aria-labelledby="province-label province">–Select–</div>
    <input aria-hidden="true" tabindex="-1" class="MuiSelect-nativeInput" value="">
  </div>
  <div class="field">
    <label for="available">Date Available</label>
    <input id="available" placeholder="yyyy-mm-dd">
  </div>`;

/** Material-UI Select: opens on mousedown into a list rendered at the end of <body>. */
function wireMuiSelect(button: HTMLElement, options: string[]) {
  button.addEventListener('mousedown', () => {
    const list = document.createElement('ul');
    list.setAttribute('role', 'listbox');
    for (const text of options) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = text;
      li.addEventListener('click', () => {
        button.textContent = text;
        list.remove();
      });
      list.appendChild(li);
    }
    document.body.appendChild(list);
  });
}

beforeEach(() => {
  document.body.innerHTML = PAGE;
});

describe('BambooHR', () => {
  it('labels the upload box "Resume", not "file-input" or "No file selected"', () => {
    const upload = scanFields(document).find((f) => f.kind === 'file')!;
    expect(upload.label).toBe('Resume*');
    expect(matchRules(upload)?.key).toBe('resume');
  });

  it('attaches the resume and sees the widget show its name', async () => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    input.addEventListener('change', () => {
      document.querySelector('.file-name')!.textContent = input.files?.[0]?.name ?? '';
    });
    const upload = scanFields(document).find((f) => f.kind === 'file')!;
    const ctx = {
      getDocument: async () => ({ name: 'Resume', fileName: 'Jordan_Rivera_Resume.pdf', mime: 'application/pdf', base64: btoa('%PDF'), text: '' }),
      getSecret: async () => null,
    };
    const out = await fillField(upload, { fieldId: upload.id, key: 'resume', value: { fileKind: 'resume' }, source: 'rule', confidence: 1, status: 'filled' }, ctx);
    expect(out).toEqual({ ok: true, valueText: 'Jordan_Rivera_Resume.pdf' });
  });

  it('finds the Material-UI "–Select–" dropdown as an empty question and fills it', async () => {
    const button = document.querySelector<HTMLElement>('#province')!;
    wireMuiSelect(button, ['Alberta', 'British Columbia', 'Ontario', 'Quebec']);
    const fields = scanFields(document);
    const province = fields.find((f) => f.label === 'Province*')!;
    expect(province).toMatchObject({ kind: 'combobox', hasValue: false, required: true });
    // The hidden native input behind it is not a separate field.
    expect(fields.filter((f) => f.label.startsWith('Province'))).toHaveLength(1);
    expect(matchRules(province)?.key).toBe('region');

    const profile = sampleProfile();
    profile.personal.address = { ...profile.personal.address, city: 'Toronto', region: 'ON', country: 'Canada' };
    const [res] = await resolveFields([province], { profile, answers: [], host: 'x.bamboohr.com', settings: settings({ provider: 'none' }), classifier: null });
    const out = await fillField(province, res, { getDocument: async () => null, getSecret: async () => null });
    expect(out).toMatchObject({ ok: true, valueText: 'Ontario' });
    expect(button.textContent).toBe('Ontario');
  });

  it('zero-pads an available date to the box format', async () => {
    const date = scanFields(document).find((f) => f.label === 'Date Available')!;
    expect(matchRules(date)?.key).toBe('startDate');
    const out = await fillField(date, { fieldId: date.id, key: 'startDate', value: '2026-10-2', source: 'rule', confidence: 1, status: 'filled' }, { getDocument: async () => null, getSecret: async () => null });
    expect(out).toMatchObject({ ok: true });
    expect((document.querySelector('#available') as HTMLInputElement).value).toBe('2026-10-02');
    expect(formatDate('2026-10-2', { kind: 'text', placeholder: '', inputType: 'text', label: '' })).toBe('2026-10-02');
    expect(formatDate('2026-10-2', { kind: 'text', placeholder: 'mm/dd/yyyy', inputType: 'text', label: '' })).toBe('10/02/2026');
  });
});
