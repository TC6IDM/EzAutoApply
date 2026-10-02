import { describe, expect, it } from 'vitest';
import { matchRules } from '../../src/fill/match/rules';
import type { FieldInfo } from '../../src/fill/types';
import { field, opts } from './helpers';

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
