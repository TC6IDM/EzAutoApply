import { emptyProfile, type Profile } from '../../src/core/profile';
import { defaultSettings, type Settings } from '../../src/core/types';
import type { FieldInfo } from '../../src/fill/types';

export function sampleProfile(): Profile {
  const p = emptyProfile();
  p.personal = {
    firstName: 'Jordan',
    lastName: 'Rivera',
    preferredName: 'Jo',
    pronouns: 'they/them',
    email: 'jordan@example.com',
    phone: '(555) 123-4567',
    address: { line1: '12 Main St', line2: '', city: 'Austin', region: 'TX', postalCode: '78701', country: 'United States' },
  };
  p.links = { linkedin: 'https://linkedin.com/in/jrivera', github: 'https://github.com/jrivera', portfolio: 'https://jrivera.dev', website: '', other: [] };
  p.experience = [
    { id: 'e1', company: 'Acme Corp', title: 'Software Engineer', location: 'Austin, TX', start: '2021-06', end: '', current: true, bullets: ['Built things'] },
    { id: 'e2', company: 'Globex', title: 'Software Engineering Intern', location: 'Remote', start: '2020-05', end: '2020-08', current: false, bullets: [] },
  ];
  p.education = [
    { id: 'd1', school: 'University of Texas at Austin', degree: 'Bachelor of Science', field: 'Computer Science', gpa: '3.8', location: '', start: '2017-08', end: '2021-05' },
  ];
  p.skills = ['TypeScript', 'React', 'Python'];
  p.workAuth = { authorizedCountries: ['United States'], needsSponsorship: false, citizenship: 'United States', over18: true, securityClearance: '' };
  p.preferences = { desiredSalary: '$140,000', startDate: '2 weeks notice', noticePeriod: '2 weeks', willingToRelocate: true, remotePreference: 'hybrid', howHeard: 'LinkedIn' };
  p.eeo = {
    gender: 'Decline to self-identify',
    race: 'Decline to self-identify',
    hispanicLatino: 'No',
    veteran: 'I am not a protected veteran',
    disability: 'No, I do not have a disability',
  };
  return p;
}

export function settings(overrides: Partial<Settings['classifier']> = {}): Settings {
  const s = defaultSettings();
  s.classifier = { ...s.classifier, ...overrides };
  return s;
}

let n = 0;
export function field(partial: Partial<FieldInfo>): FieldInfo {
  return {
    id: `t${n++}`,
    kind: 'text',
    label: '',
    help: '',
    name: '',
    htmlId: '',
    placeholder: '',
    autocomplete: '',
    inputType: 'text',
    options: [],
    required: false,
    section: '',
    multiple: false,
    hasValue: false,
    ...partial,
  };
}

export const opts = (...labels: string[]) => labels.map((l) => ({ label: l, value: l }));
