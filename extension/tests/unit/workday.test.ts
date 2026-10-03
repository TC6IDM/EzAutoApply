import { beforeEach, describe, expect, it } from 'vitest';
import { fillField, PASSWORD_MISSING } from '../../src/fill/fillers';
import { matchRules } from '../../src/fill/match/rules';
import { resolveFields } from '../../src/fill/pipeline';
import { scanFields } from '../../src/fill/scan';
import type { FieldDescriptor, Resolution } from '../../src/fill/types';
import { mountWorkdayPrompt, mountWorkdaySearchPrompt, mountWorkdaySelect } from './fixtures';
import { field, sampleProfile, settings } from './helpers';

const noDocs = { getDocument: async () => null, getSecret: async () => null };
const filled = (f: FieldDescriptor, value: string, key?: string): Resolution => ({
  fieldId: f.id,
  key,
  value,
  source: 'rule',
  confidence: 1,
  status: 'filled',
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Workday dropdowns', () => {
  it('searches a prompt by pressing Enter, then picks the result', async () => {
    const prompt = mountWorkdaySearchPrompt(document.body, 'How Did You Hear About Us?*', ['Advertising', 'Job Board', 'Social Media'], {
      linkedin: ['LinkedIn', 'LinkedIn'],
    });
    const [f] = scanFields(document);
    expect(f.kind).toBe('combobox');
    expect(matchRules(f)?.key).toBe('howHeard');
    const out = await fillField(f, filled(f, 'LinkedIn', 'howHeard'), noDocs);
    expect(out).toMatchObject({ ok: true, valueText: 'LinkedIn' });
    expect(prompt.chosen()).toBe('LinkedIn');
  });

  it('opens a "Select One" list that a full click would close again, and selects with Enter when clicks are ignored', async () => {
    const select = mountWorkdaySelect(document.body, 'Phone Device Type*', ['Landline', 'Mobile']);
    const [f] = scanFields(document);
    expect(matchRules(f)?.key).toBe('phoneType');
    const out = await fillField(f, filled(f, 'Mobile', 'phoneType'), noDocs);
    expect(out).toMatchObject({ ok: true, valueText: 'Mobile' });
    expect(out.ok && out.uncertain).toBeFalsy();
    expect(select.chosen()).toBe('Mobile');
  });

  it('types ahead and presses Enter when the option is not rendered yet', async () => {
    const provinces = ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Nova Scotia', 'Ontario', 'Quebec'];
    const select = mountWorkdaySelect(document.body, 'Province or Territory*', provinces, { rendered: 3 });
    const [f] = scanFields(document);
    expect(matchRules(f)?.key).toBe('region');
    const out = await fillField(f, filled(f, 'Ontario', 'region'), noDocs);
    expect(out.ok).toBe(true);
    expect(select.chosen()).toBe('Ontario');
  });

  it('says which options it saw when nothing matches', async () => {
    mountWorkdaySelect(document.body, 'Phone Device Type', ['Landline', 'Mobile']);
    const [f] = scanFields(document);
    const out = await fillField(f, filled(f, 'Fax machine'), noDocs);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('options seen: Landline, Mobile');
  });
});

describe('account passwords', () => {
  const PAGE = `
    <label for="email">Email Address*</label><input id="email" type="email">
    <label for="pw">Password*</label><input id="pw" type="password" autocomplete="new-password">
    <label for="pw2">Verify New Password*</label><input id="pw2" type="password">`;

  it('finds password fields and maps them to the account password, never to saved answers', async () => {
    document.body.innerHTML = PAGE;
    const fields = scanFields(document);
    expect(fields.map((f) => f.kind)).toEqual(['text', 'password', 'password']);
    const now = Date.now();
    // Even a saved answer to the exact same question must not be typed into a password field.
    const answers = [{ id: 'a', question: 'Password*', normalized: 'password', fieldKind: 'text' as const, answer: 'hunter2', scope: 'global', timesUsed: 0, lastUsed: now, createdAt: now }];
    const res = await resolveFields(fields, { profile: sampleProfile(), answers, host: 'x.myworkdayjobs.com', settings: settings({ provider: 'none' }), classifier: null });
    expect(res[1]).toMatchObject({ key: 'accountPassword', value: { secret: 'accountPassword' }, status: 'filled' });
    expect(res[2]).toMatchObject({ key: 'accountPassword', value: { secret: 'accountPassword' } });
  });

  it('types the password only when the background hands it over', async () => {
    document.body.innerHTML = PAGE;
    const [, pw, pw2] = scanFields(document);
    const res = (f: FieldDescriptor): Resolution => ({ fieldId: f.id, key: 'accountPassword', value: { secret: 'accountPassword' }, source: 'rule', confidence: 1, status: 'filled' });

    const withSecret = { getDocument: async () => null, getSecret: async () => 'S3cure!pass' };
    expect(await fillField(pw, res(pw), withSecret)).toEqual({ ok: true, valueText: '••••••••' });
    expect(await fillField(pw2, res(pw2), withSecret)).toEqual({ ok: true, valueText: '••••••••' });
    expect((document.querySelector('#pw') as HTMLInputElement).value).toBe('S3cure!pass');
    expect((document.querySelector('#pw2') as HTMLInputElement).value).toBe('S3cure!pass');

    document.body.innerHTML = PAGE;
    const [, blocked] = scanFields(document);
    expect(await fillField(blocked, res(blocked), noDocs)).toEqual({ ok: false, reason: PASSWORD_MISSING });
  });

  it('never puts ordinary text into a password field, or the password into a text field', () => {
    expect(matchRules(field({ label: 'Password', kind: 'text' }))?.key).not.toBe('accountPassword');
    expect(matchRules(field({ label: 'Email', kind: 'password' }))).toBeNull();
    expect(matchRules(field({ label: 'Forgot your password?', kind: 'password' }))).toBeNull();
  });
});

describe('Workday work experience', () => {
  /** A Workday-style entry: split MM/YYYY date boxes whose "MM"/"YYYY" hints are text, not placeholders. */
  const entry = (n: number) => `
    <div class="entry">
      <h4>Work Experience ${n}</h4>
      <label for="title${n}">Job Title*</label><input id="title${n}" data-automation-id="jobTitle">
      <label for="company${n}">Company*</label><input id="company${n}" data-automation-id="company">
      <div data-automation-id="formField-startDate"><label>From*</label>
        <div data-automation-id="dateInputWrapper">
          <div data-automation-id="dateSectionMonth-display">MM</div><input data-automation-id="dateSectionMonth-input" aria-label="Month">
          <span>/</span>
          <div data-automation-id="dateSectionYear-display">YYYY</div><input data-automation-id="dateSectionYear-input" aria-label="Year">
        </div>
      </div>
    </div>`;

  it('treats split month/year boxes as one date field and fills both', async () => {
    document.body.innerHTML = entry(1);
    const fields = scanFields(document);
    const from = fields.find((f) => f.label === 'From*')!;
    expect(from).toMatchObject({ kind: 'month', required: true });
    expect(matchRules(from)?.key).toBe('expStart');
    const out = await fillField(from, filled(from, '2021-06', 'expStart'), noDocs);
    expect(out).toEqual({ ok: true, valueText: '06/2021' });
    expect((document.querySelector('[aria-label="Month"]') as HTMLInputElement).value).toBe('06');
    expect((document.querySelector('[aria-label="Year"]') as HTMLInputElement).value).toBe('2021');
  });

  it('types into masked inputs that ignore a value set all at once', async () => {
    document.body.innerHTML = '<h4>Work Experience 1</h4><label for="d">From</label><input id="d" placeholder="MM/YYYY">';
    const input = document.querySelector('input')!;
    input.addEventListener('input', (e) => {
      // Only real typing is accepted; anything else is wiped, like a strict input mask.
      if (!(e instanceof InputEvent) || e.inputType !== 'insertText') {
        input.value = '';
        return;
      }
      const d = input.value.replace(/\D/g, '').slice(0, 6);
      input.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    });
    const [f] = scanFields(document);
    const out = await fillField(f, filled(f, '2021-06', 'expStart'), noDocs);
    expect(out.ok).toBe(true);
    expect(input.value).toBe('06/2021');
  });

  it('clicks "Add Another" until there is one entry per job, and never clicks anything else', async () => {
    document.body.innerHTML = `
      <h2>Work Experience</h2><div id="jobs">${entry(1)}</div><button id="add-job">Add Another</button>
      <h2>Education</h2><div id="schools"></div><button id="add-school">Add</button>
      <h2>Websites</h2><button id="add-site">Add</button>
      <button id="next">Save and Continue</button>`;
    const clicks: string[] = [];
    document.body.addEventListener('click', (e) => clicks.push((e.target as HTMLElement).id));
    document.querySelector('#add-job')!.addEventListener('click', () => {
      const jobs = document.querySelector('#jobs')!;
      jobs.insertAdjacentHTML('beforeend', entry(jobs.children.length + 1));
    });
    document.querySelector('#add-school')!.addEventListener('click', () => {
      document.querySelector('#schools')!.insertAdjacentHTML('beforeend', '<label for="s">School*</label><input id="s">');
    });

    const { expandRepeatingSections } = await import('../../src/fill/repeat');
    const profile = sampleProfile(); // 2 jobs, 1 school
    expect(await expandRepeatingSections(profile, document)).toBe(2);
    expect(document.querySelectorAll('#jobs .entry')).toHaveLength(2);
    expect(document.querySelectorAll('#schools input')).toHaveLength(1);
    expect(clicks).toEqual(['add-job', 'add-school']);

    // Already enough entries: nothing more is clicked.
    expect(await expandRepeatingSections(profile, document)).toBe(0);
  });
});

describe('Workday resume upload', () => {
  it('recognizes the upload box by its section and drops the file when the input is ignored', async () => {
    document.body.innerHTML = `
      <h3>Resume/CV</h3>
      <div><p>Upload a file (5MB max)*</p>
        <div class="zone" data-automation-id="file-upload-drop-zone">
          <p>Drop files here</p><p>or <button type="button">Select files</button></p>
          <input type="file" data-automation-id="file-upload-input-ref" style="display:none">
        </div>
        <div class="uploaded"></div>
      </div>`;
    const zone = document.querySelector<HTMLElement>('.zone')!;
    zone.addEventListener('drop', (e) => {
      document.querySelector('.uploaded')!.textContent = (e as DragEvent).dataTransfer?.files[0]?.name ?? '';
    });
    const [f] = scanFields(document);
    expect(f.kind).toBe('file');
    expect(matchRules(f)?.key).toBe('resume');
    const ctx = {
      getDocument: async () => ({ name: 'Resume', fileName: 'Jordan_Rivera_Resume.pdf', mime: 'application/pdf', base64: btoa('%PDF'), text: '' }),
      getSecret: async () => null,
    };
    const out = await fillField(f, { fieldId: f.id, key: 'resume', value: { fileKind: 'resume' }, source: 'rule', confidence: 1, status: 'filled' }, ctx);
    expect(out).toEqual({ ok: true, valueText: 'Jordan_Rivera_Resume.pdf' });
    expect(document.querySelector('.uploaded')!.textContent).toBe('Jordan_Rivera_Resume.pdf');
  });
});

describe('Workday dropdowns as they appear on real pages', () => {
  it('uses the question, not the button name "Select One Required"', () => {
    mountWorkdaySelect(document.body, 'Please select your age category:*', ['Under 16 years of age', '18 years of age and Over'], { workdayNaming: true });
    const [f] = scanFields(document);
    expect(f.label).toBe('Please select your age category:*');
    expect(f.required).toBe(true);
  });

  it('reads and fills each dropdown from its own list, even with another list still open', { timeout: 15000 }, async () => {
    const age = mountWorkdaySelect(document.body, 'Please select your age category:*', ['Under 16 years of age', '16-17 years of age', '18 years of age and Over'], { workdayNaming: true });
    const optIn = mountWorkdaySelect(document.body, 'Please confirm your preference:*', ['Opt-In – you WILL receive text messages', 'Opt-Out – you will NOT receive text messages'], { workdayNaming: true });
    // Another question's list left open on screen.
    age.list.hidden = false;

    const fields = scanFields(document);
    const pref = fields.find((f) => f.label.startsWith('Please confirm'))!;
    const { readDropdownOptions } = await import('../../src/fill/fillers');
    expect(await readDropdownOptions(pref)).toEqual(['Opt-In – you WILL receive text messages', 'Opt-Out – you will NOT receive text messages']);

    age.list.hidden = false;
    const out = await fillField(pref, filled(pref, 'Opt-In – you WILL receive text messages'), noDocs);
    expect(out).toMatchObject({ ok: true, valueText: 'Opt-In – you WILL receive text messages' });
    expect(optIn.chosen()).toBe('Opt-In – you WILL receive text messages');
    expect(age.chosen()).toBe('');
  });

  it('doesn’t give one dropdown another’s options when that list pops up again late', { timeout: 15000 }, async () => {
    const age = mountWorkdaySelect(document.body, 'Please select your age category:*', ['Under 18', '18 and over'], { workdayNaming: true });
    const sms = mountWorkdaySelect(document.body, 'Text message updates:*', ['Opt-In', 'Opt-Out'], { workdayNaming: true });
    // While the second list opens, the first one shows up again, as a slow list closing late does.
    sms.button.addEventListener('mousedown', () => setTimeout(() => (age.list.hidden = false), 20));
    const fields = scanFields(document);
    const { readDropdownOptions } = await import('../../src/fill/fillers');
    // In page order, as the side panel's options are read.
    expect(await readDropdownOptions(fields[0])).toEqual(['Under 18', '18 and over']);
    expect(await readDropdownOptions(fields[1])).toEqual(['Opt-In', 'Opt-Out']);
  });

  it('recognizes work-experience dates from Workday container ids when there is no heading', async () => {
    document.body.innerHTML = `
      <div data-automation-id="workExperience-1">
        <div data-automation-id="formField-startDate"><label>From*</label>
          <div data-automation-id="dateInputWrapper">
            <div data-automation-id="dateSectionMonth-display" aria-hidden="true">MM</div>
            <input data-automation-id="dateSectionMonth-input" aria-label="Month">
            <div data-automation-id="dateSectionYear-display" aria-hidden="true">YYYY</div>
            <input data-automation-id="dateSectionYear-input" aria-label="Year">
          </div>
        </div>
      </div>`;
    const [f] = scanFields(document);
    expect(f).toMatchObject({ kind: 'month', label: 'From*', name: 'formField-startDate' });
    expect(matchRules(f)?.key).toBe('expStart');
    expect(await fillField(f, filled(f, '2020-05', 'expStart'), noDocs)).toEqual({ ok: true, valueText: '05/2020' });
  });
});

describe('Workday My Experience: education and skills, as live pages build them', () => {
  /** A year-only date ("From YYYY"), built like Workday's month/year dates. */
  const yearBox = (field: string, label: string) => `
    <div data-automation-id="formField-${field}"><fieldset><legend><label><span>${label}</span></label></legend>
      <div><div>
        <div aria-hidden="true" id="helpText-education-1--${field}">current value is YYYY</div>
        <div id="education-1--${field}" role="group" data-automation-id="dateInputWrapper"><div tabindex="-1">
          <div id="education-1--${field}-dateSectionYear">
            <div aria-hidden="true" data-automation-id="dateSectionYear-display">YYYY</div>
            <input role="spinbutton" aria-label="Year" aria-valuemax="9999" aria-valuemin="1" aria-valuetext="YYYY"
              id="education-1--${field}-dateSectionYear-input" data-automation-id="dateSectionYear-input">
          </div>
        </div><div aria-label="Calendar" data-automation-id="dateIcon" role="button" tabindex="0"></div></div>
      </div></div>
    </fieldset></div>`;
  const DEGREE = `
    <div data-automation-id="formField-degree"><label for="education-1--degree"><span>Degree<abbr aria-hidden="true">*</abbr></span></label>
      <div><div><button aria-haspopup="listbox" type="button" aria-label="Degree Select One Required" name="degree" id="education-1--degree">Select One</button><input type="text" value=""><span></span></div></div>
    </div>`;
  const SCHOOLS = ['Aalto University', 'University of York', 'York College of Pennsylvania', 'York University', 'York University - Glendon Campus', 'Yorkville University'];
  const STUDIES = ['Computer Science', 'Software Testing', 'Systems Software Engineering'];

  function mountEducation() {
    document.body.innerHTML = `
      <div role="group" aria-labelledby="Education-section"><h4 id="Education-section">Education</h4>
        <div role="group" aria-labelledby="Education-1-panel"><div><h5 id="Education-1-panel">Education 1</h5></div><div id="edu"></div></div>
      </div>`;
    const edu = document.querySelector<HTMLElement>('#edu')!;
    // Opening the School prompt lists schools alphabetically before anything is searched.
    const school = mountWorkdayPrompt(edu, 'School or University<abbr aria-hidden="true">*</abbr>', SCHOOLS, {
      field: 'school',
      delay: 400,
      focusList: ['Aalto University', 'University of York'],
    });
    edu.insertAdjacentHTML('beforeend', DEGREE);
    const study = mountWorkdayPrompt(edu, 'Field of Study', STUDIES, { field: 'fieldOfStudy' });
    edu.insertAdjacentHTML('beforeend', yearBox('firstYearAttended', 'From') + yearBox('lastYearAttended', 'To (Actual or Expected)'));
    return { school, study };
  }

  const yorkProfile = () => {
    const p = sampleProfile();
    p.education = [{ id: 'd1', school: 'York University', degree: "Bachelor's Degree", field: 'Software Engineering', gpa: '', location: '', start: '2025-09', end: '2029-04' }];
    return p;
  };

  it('finds the School and Field of Study prompts, the Degree button (not its hidden id box) and year-only dates', async () => {
    mountEducation();
    const fields = scanFields(document);
    expect(fields.map((f) => [f.label, f.kind])).toEqual([
      ['School or University*', 'combobox'],
      ['Degree*', 'combobox'],
      ['Field of Study', 'combobox'],
      ['From', 'month'],
      ['To (Actual or Expected)', 'month'],
    ]);
    expect(fields.map((f) => matchRules(f)?.key)).toEqual(['school', 'degree', 'fieldOfStudy', 'eduStart', 'eduEnd']);
    const res = await resolveFields(fields, { profile: yorkProfile(), answers: [], host: 'x.myworkdayjobs.com', settings: settings({ provider: 'none' }), classifier: null });
    expect(res.map((r) => r.value)).toEqual(['York University', "Bachelor's Degree", 'Software Engineering', '2025-09', '2029-04']);
  });

  it('types only the year into year-only date boxes', async () => {
    mountEducation();
    const fields = scanFields(document);
    const from = fields.find((f) => f.label === 'From')!;
    const to = fields.find((f) => f.label.startsWith('To'))!;
    expect(await fillField(from, filled(from, '2025-09', 'eduStart'), noDocs)).toEqual({ ok: true, valueText: '2025' });
    expect(await fillField(to, filled(to, '2029-04', 'eduEnd'), noDocs)).toEqual({ ok: true, valueText: '2029' });
    expect((document.querySelector('#education-1--firstYearAttended-dateSectionYear-input') as HTMLInputElement).value).toBe('2025');
    expect((document.querySelector('#education-1--lastYearAttended-dateSectionYear-input') as HTMLInputElement).value).toBe('2029');
  });

  it('searches the School prompt with Enter, waits for the results and picks the exact one', { timeout: 15000 }, async () => {
    const { school } = mountEducation();
    const f = scanFields(document)[0];
    const out = await fillField(f, filled(f, 'York University', 'school'), noDocs);
    expect(out).toEqual({ ok: true, valueText: 'York University' });
    expect(school.chosen()).toEqual(['York University']);
    expect(school.input.value).toBe('');
    // The prompt is reported as filled once a pill shows, and its pill isn't offered as an option.
    expect(scanFields(document)[0].hasValue).toBe(true);
  });

  it('accepts the result Workday picks by itself, and flags it when it is only close', { timeout: 15000 }, async () => {
    const { study } = mountEducation();
    const f = scanFields(document).find((x) => x.label === 'Field of Study')!;
    const out = await fillField(f, filled(f, 'Software Engineering', 'fieldOfStudy'), noDocs);
    expect(out).toMatchObject({ ok: true, valueText: 'Systems Software Engineering', uncertain: true });
    expect(out.ok && out.note).toContain('No exact match for "Software Engineering"');
    expect(study.chosen()).toEqual(['Systems Software Engineering']);
  });

  it('says what the search found when nothing matches', { timeout: 15000 }, async () => {
    const { school } = mountEducation();
    const f = scanFields(document)[0];
    const out = await fillField(f, filled(f, 'Yale University', 'school'), noDocs);
    expect(out.ok).toBe(false);
    expect(school.chosen()).toEqual([]);
  });

  it('adds each saved skill to "Type to Add Skills", keeping the ones already there', { timeout: 30000 }, async () => {
    document.body.innerHTML = '<div role="group" aria-labelledby="Skills-section"><h4 id="Skills-section">Skills</h4><div id="skills"></div></div>';
    const skills = mountWorkdayPrompt(
      document.querySelector<HTMLElement>('#skills')!,
      'Type to Add Skills',
      ['Machine Learning', 'Python', 'Python Scripting', 'React', 'React Native', 'TypeScript'],
      { field: 'skills', multi: true, pills: ['Machine Learning'] },
    );
    const [f] = scanFields(document);
    expect(f).toMatchObject({ kind: 'combobox', multiple: true, hasValue: true });
    expect(matchRules(f)?.key).toBe('skills');

    // Workday's own guesses don't stop the saved skills from being added.
    const profile = sampleProfile();
    profile.skills = ['TypeScript', 'React', 'Python', 'Machine Learning', 'Cobol'];
    const [r] = await resolveFields([f], { profile, answers: [], host: 'x.myworkdayjobs.com', settings: settings({ provider: 'none' }), classifier: null });
    expect(r).toMatchObject({ key: 'skills', status: 'filled', value: profile.skills });

    const out = await fillField(f, r, noDocs);
    expect(skills.chosen()).toEqual(['Machine Learning', 'TypeScript', 'React', 'Python']);
    expect(out).toMatchObject({ ok: true, valueText: 'Machine Learning, TypeScript, React, Python', uncertain: true, note: 'Not found: Cobol' });
  });

  it('answers "How did you hear" with Other when LinkedIn isn’t offered', { timeout: 15000 }, async () => {
    const heard = mountWorkdayPrompt(document.body, 'How Did You Hear About Us?*', ['Glassdoor', 'Indeed', 'Other'], { field: 'source' });
    const [f] = scanFields(document);
    const out = await fillField(f, filled(f, 'LinkedIn', 'howHeard'), noDocs);
    expect(out).toMatchObject({ ok: true, valueText: 'Other', uncertain: true, note: '"LinkedIn" isn\'t an option here, so "Other" was picked' });
    expect(heard.chosen()).toEqual(['Other']);
  });

  it('answers it with whatever is offered when there’s no Other either', { timeout: 20000 }, async () => {
    const heard = mountWorkdayPrompt(document.body, 'How Did You Hear About Us?*', ['Glassdoor', 'Indeed'], { field: 'source', focusList: ['Glassdoor', 'Indeed'] });
    const [f] = scanFields(document);
    const out = await fillField(f, filled(f, 'LinkedIn', 'howHeard'), noDocs);
    expect(out).toMatchObject({ ok: true, valueText: 'Glassdoor', uncertain: true });
    expect(heard.chosen()).toEqual(['Glassdoor']);
  });

  it('labels split dates by their Workday label, not the screen-reader help before the boxes', () => {
    document.body.innerHTML = `
      <div data-automation-id="formField-startDate"><fieldset><legend><label id="label13"><span>From<abbr aria-hidden="true">*</abbr></span></label></legend>
        <div><div><div aria-hidden="true" id="helpText-workExperience-9--startDate">current value is MM/YYYY</div>
          <div id="workExperience-9--startDate" role="group" data-automation-id="dateInputWrapper"><div tabindex="-1">
            <div><div aria-hidden="true" data-automation-id="dateSectionMonth-display">MM</div><input role="spinbutton" aria-label="Month" id="workExperience-9--startDate-dateSectionMonth-input" data-automation-id="dateSectionMonth-input"></div>
            <div>/</div>
            <div><div aria-hidden="true" data-automation-id="dateSectionYear-display">YYYY</div><input role="spinbutton" aria-label="Year" id="workExperience-9--startDate-dateSectionYear-input" data-automation-id="dateSectionYear-input"></div>
          </div></div>
        </div></div>
      </fieldset></div>`;
    const [f] = scanFields(document);
    expect(f).toMatchObject({ kind: 'month', label: 'From*', required: true });
  });
});

describe('Workday search prompt, behaving like the real one', () => {
  it('searches with Enter, arrows down to the match, and picks it with a second Enter', async () => {
    const prompt = mountWorkdaySearchPrompt(document.body, 'How Did You Hear About Us?*', ['Advertising', 'Job Board', 'Social Media'], {
      linkedin: ['LinkedIn Learning Partner', 'LinkedIn'],
    });
    const [f] = scanFields(document);
    const out = await fillField(f, filled(f, 'LinkedIn', 'howHeard'), noDocs);
    expect(out).toEqual({ ok: true, valueText: 'LinkedIn' });
    expect(prompt.chosen()).toBe('LinkedIn');
  });
});
