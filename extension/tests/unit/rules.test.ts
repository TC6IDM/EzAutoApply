import { describe, expect, it } from 'vitest';
import { FIELD_KEYS } from '../../src/core/fieldKeys';
import { matchRules } from '../../src/fill/match/rules';
import type { FieldInfo } from '../../src/fill/types';
import { field, opts, sampleProfile } from './helpers';

const keyOf = (f: Partial<FieldInfo>) => matchRules(field(f))?.key ?? null;

describe('matchRules: labels', () => {
  it.each([
    ['First Name', 'firstName'],
    ['Legal first name *', 'firstName'],
    ['Preferred First Name', 'preferredName'],
    ['Last Name', 'lastName'],
    ['Surname', 'lastName'],
    ['Full name', 'fullName'],
    ['Name', 'fullName'],
    ['Email', 'email'],
    ['Email address', 'email'],
    ['Confirm email', 'email'],
    ['Phone', 'phone'],
    ['Mobile phone number', 'phone'],
    ['Phone Device Type', 'phoneType'],
    ['Street address', 'addressLine1'],
    ['City', 'city'],
    ['State / Province', 'region'],
    ['ZIP code', 'postalCode'],
    ['Postal Code', 'postalCode'],
    ['Current location', 'location'],
    ['LinkedIn Profile', 'linkedin'],
    ['LinkedIn URL', 'linkedin'],
    ['GitHub URL', 'github'],
    ['Portfolio URL', 'portfolio'],
    ['Personal website', 'website'],
    ['Current company', 'currentCompany'],
    ['Current title', 'currentTitle'],
    ['School', 'school'],
    ['University name', 'school'],
    ['Degree', 'degree'],
    ['Field of study', 'fieldOfStudy'],
    ['Major', 'fieldOfStudy'],
    ['GPA', 'gpa'],
    ['Expected graduation date', 'graduationDate'],
    ['Desired salary', 'desiredSalary'],
    ['What are your salary expectations?', 'desiredSalary'],
    ['How did you hear about us?', 'howHeard'],
    ['When can you start?', 'startDate'],
    ['What is your notice period?', 'noticePeriod'],
    ['How much notice do you need to give your current employer?', 'noticePeriod'],
    ['Pronouns', 'pronouns'],
  ])('%s → %s', (label, key) => {
    expect(keyOf({ label })).toBe(key);
  });

  it('ignores contact fields for other people', () => {
    expect(keyOf({ label: 'Reference email' })).toBeNull();
    expect(keyOf({ label: "Manager's first name" })).toBeNull();
  });

  it('does not read "state" out of a long question', () => {
    expect(keyOf({ label: 'Please state why you are interested in this position and what you would bring' })).toBeNull();
  });

  it('does not treat a salary question about the current job as desired salary', () => {
    expect(keyOf({ label: 'What is your current salary?' })).toBeNull();
  });
});

describe('matchRules: choice questions', () => {
  const yesNo = opts('Yes', 'No');
  it.each([
    ['Are you legally authorized to work in the United States?', 'authorizedToWork'],
    ['Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?', 'needsSponsorship'],
    ['Are you at least 18 years of age?', 'over18'],
    ['Are you willing to relocate?', 'willingToRelocate'],
    ['Are you a U.S. citizen?', 'isCitizen'],
  ])('%s → %s', (label, key) => {
    expect(keyOf({ label, kind: 'radio', options: yesNo })).toBe(key);
  });

  it.each([
    ['Gender', 'gender'],
    ['Are you Hispanic/Latino?', 'hispanicLatino'],
    ['Race', 'race'],
    ['Veteran Status', 'veteran'],
    ['Disability Status', 'disability'],
  ])('EEO %s → %s', (label, key) => {
    expect(keyOf({ label, kind: 'select', options: opts('A', 'B') })).toBe(key);
  });

  it.each([
    'What is the highest level of education you have completed? *',
    'Highest Degree Obtained or Pursuing',
    'What is the highest degree you have completed or are currently pursuing? *',
  ])('"%s" → degree (Cisco, Avature)', (label) => {
    expect(keyOf({ label, kind: 'select', options: opts("Bachelor's Degree", "Master's Degree") })).toBe('degree');
  });

  it('keeps long yes/no questions about a degree away from the degree key', () => {
    const yesNo = opts('Yes', 'No');
    expect(keyOf({ label: 'Are you currently pursuing further education (e.g., post-secondary education)?', kind: 'select', options: yesNo })).not.toBe('degree');
    expect(keyOf({ label: 'Will you have completed your degree by the start of the program?', kind: 'select', options: yesNo })).not.toBe('degree');
    expect(keyOf({ label: 'Pursuing a degree?', kind: 'select', options: yesNo })).not.toBe('degree');
  });

  describe('"Have you worked at <company>?"', () => {
    const yesNo = opts('Yes', 'No');
    const def = FIELD_KEYS.find((d) => d.key === 'workedHereBefore')!;
    const answer = (label: string) => def.resolve({ profile: sampleProfile(), index: 0, label, section: '', kind: 'radio' });

    it.each([
      'Have you previously worked at Hootsuite? *',
      'Have you worked at DoorDash?*',
      'Have you previously been employed at Intuit? *',
      'Have you ever worked for Globex before?',
    ])('%s → workedHereBefore', (label) => {
      expect(keyOf({ label, kind: 'radio', options: yesNo })).toBe('workedHereBefore');
    });

    it('answers from the work history: Yes only for an employer in it', () => {
      expect(answer('Have you worked at DoorDash?*')).toBe(false);
      expect(answer('Have you previously been employed at Intuit? *')).toBe(false);
      expect(answer('Have you ever worked for Globex before?')).toBe(true);
      expect(answer('Have you previously worked at Acme?')).toBe(true);
      // "Here" names no company: left for the owner.
      expect(answer('Have you worked here before?')).toBeNull();
    });

    it('never answers whether someone they know works there', () => {
      expect(keyOf({ label: 'Do you have a relative or friend who has worked at Intuit?', kind: 'radio', options: yesNo })).not.toBe('workedHereBefore');
      expect(keyOf({ label: 'Have you worked at Intuit?', kind: 'text' })).not.toBe('workedHereBefore');
    });
  });

  it('a bool key never matches a free-text field', () => {
    expect(keyOf({ label: 'Are you willing to relocate?', kind: 'text' })).toBeNull();
  });
});

describe('matchRules: attributes and sections', () => {
  it('uses autocomplete tokens first', () => {
    expect(keyOf({ label: 'Given', autocomplete: 'given-name' })).toBe('firstName');
    expect(keyOf({ label: '', autocomplete: 'section-a shipping postal-code' })).toBe('postalCode');
  });

  it('falls back to name/id attributes when there is no label', () => {
    expect(keyOf({ name: 'first_name' })).toBe('firstName');
    expect(keyOf({ htmlId: 'lastName' })).toBe('lastName');
    expect(keyOf({ name: 'job_application[email]' })).toBe('email');
    expect(keyOf({ name: 'urls[LinkedIn]' })).toBe('linkedin');
    expect(keyOf({ name: 'org' })).toBe('currentCompany');
  });

  it('uses input type for unlabeled email/phone inputs', () => {
    expect(keyOf({ inputType: 'email' })).toBe('email');
    expect(keyOf({ inputType: 'tel' })).toBe('phone');
  });

  it('section headings disambiguate start dates', () => {
    expect(keyOf({ label: 'Start date', section: 'Work Experience 1' })).toBe('expStart');
    expect(keyOf({ label: 'Start date', section: 'Education' })).toBe('eduStart');
    expect(keyOf({ label: 'Start date', section: 'Availability' })).toBe('startDate');
    expect(keyOf({ label: 'From', section: 'Work Experience' })).toBe('expStart');
  });

  it('file inputs map to documents', () => {
    expect(keyOf({ label: 'Resume/CV', kind: 'file' })).toBe('resume');
    expect(keyOf({ label: 'Cover Letter', kind: 'file' })).toBe('coverLetter');
    expect(keyOf({ label: 'Unofficial transcript', kind: 'file' })).toBe('transcript');
  });
});

describe('matchRules: work authorization vs sponsorship', () => {
  const yesNo = [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }];
  it.each([
    ['Do you now or will you in the future require sponsorship for work authorization in Canada?', 'needsSponsorship'],
    ['Will you need sponsorship to obtain work authorization?', 'needsSponsorship'],
    ['Are you legally authorized to work in the United States without requiring sponsorship?', 'authorizedToWork'],
    ['Do you have work authorization in Canada?', 'authorizedToWork'],
  ])('%s → %s', (label, key) => {
    expect(matchRules({ ...field({ label }), kind: 'radio', options: yesNo })?.key).toBe(key);
  });
});
