import { describe, expect, it } from 'vitest';
import { emptyProfile, yearsOfExperience } from '../../src/core/profile';
import { findDateRange, findSingleDate, toYm } from '../../src/parse/dates';
import { linesFromText, parseResume, sectionTypeOf } from '../../src/parse/resume';

const RESUME = `JORDAN RIVERA
Austin, TX | jordan.rivera@example.com | (555) 123-4567
linkedin.com/in/jrivera | github.com/jrivera | jrivera.dev

SUMMARY
Backend-leaning software engineer who likes boring, reliable systems.

EXPERIENCE
Software Engineer — Acme Corp    Jun 2021 – Present
Austin, TX
• Built the billing pipeline handling 2M invoices a month
• Cut p99 latency by 40% by rewriting the cache layer, which also
reduced infrastructure costs
Globex | Software Engineering Intern    May 2020 - Aug 2020
- Wrote internal tools in Python

EDUCATION
University of Texas at Austin    Aug 2017 – May 2021
B.S. in Computer Science, GPA: 3.8/4.0

PROJECTS
Ledgerly (TypeScript, React) | ledgerly.app
• Personal finance tracker with 500 users

TECHNICAL SKILLS
Languages: TypeScript, Python, Go
Tools: React, PostgreSQL, Docker

AWARDS
Dean's List 2019
`;

describe('dates', () => {
  it('parses common resume date formats', () => {
    expect(toYm('Jun 2021')).toBe('2021-06');
    expect(toYm('September 2019')).toBe('2019-09');
    expect(toYm('05/2019')).toBe('2019-05');
    expect(toYm('2018')).toBe('2018');
    expect(findDateRange('Acme   Jan. 2020 – Present')).toMatchObject({ start: '2020-01', end: '', current: true });
    expect(findDateRange('2016 - 2020')).toMatchObject({ start: '2016', end: '2020', current: false });
    expect(findSingleDate('Expected May 2026')).toMatchObject({ date: '2026-05' });
    expect(findDateRange('Built 3 apps for 1500 users')).toBeNull();
  });
});

describe('sectionTypeOf', () => {
  it('recognizes heading synonyms', () => {
    expect(sectionTypeOf('Professional Experience')).toBe('experience');
    expect(sectionTypeOf('WORK HISTORY')).toBe('experience');
    expect(sectionTypeOf('Technical Skills')).toBe('skills');
    expect(sectionTypeOf('Licenses & Certifications')).toBe('certifications');
    expect(sectionTypeOf('Honors and Awards')).toBe('other');
    expect(sectionTypeOf('Fun Facts')).toBeNull();
  });
});

describe('parseResume', () => {
  it('extracts contact info, sections and entries from a text resume', async () => {
    const { profile, unknownSections } = await parseResume(linesFromText(RESUME), emptyProfile());
    expect(profile.personal).toMatchObject({ firstName: 'Jordan', lastName: 'Rivera', email: 'jordan.rivera@example.com', phone: '(555) 123-4567' });
    expect(profile.personal.address).toMatchObject({ city: 'Austin', region: 'TX', country: 'United States' });
    expect(profile.links).toMatchObject({
      linkedin: 'https://linkedin.com/in/jrivera',
      github: 'https://github.com/jrivera',
      portfolio: 'https://jrivera.dev',
    });
    expect(profile.summary).toMatch(/^Backend-leaning/);

    expect(profile.experience).toHaveLength(2);
    expect(profile.experience[0]).toMatchObject({ title: 'Software Engineer', company: 'Acme Corp', start: '2021-06', current: true, location: 'Austin, TX' });
    expect(profile.experience[0].bullets).toEqual([
      'Built the billing pipeline handling 2M invoices a month',
      'Cut p99 latency by 40% by rewriting the cache layer, which also reduced infrastructure costs',
    ]);
    expect(profile.experience[1]).toMatchObject({ title: 'Software Engineering Intern', company: 'Globex', start: '2020-05', end: '2020-08' });

    expect(profile.education).toHaveLength(1);
    expect(profile.education[0]).toMatchObject({
      school: 'University of Texas at Austin',
      degree: 'B.S.',
      field: 'Computer Science',
      gpa: '3.8/4.0',
      start: '2017-08',
      end: '2021-05',
    });

    expect(profile.projects[0]).toMatchObject({ name: 'Ledgerly', url: 'https://ledgerly.app', tech: ['TypeScript', 'React'] });
    expect(profile.skills).toEqual(['TypeScript', 'Python', 'Go', 'React', 'PostgreSQL', 'Docker']);
    expect(unknownSections.map((s) => s.heading)).toEqual(['AWARDS']);
  });

  it('asks the classifier about headings it does not know', async () => {
    const text = 'Sam Lee\nsam@example.com\n\nWHERE I WORKED\nEngineer at Initech    2019 – 2022\n• Did things';
    const asked: string[] = [];
    const { profile } = await parseResume(linesFromText(text), emptyProfile(), async (heading) => {
      asked.push(heading);
      return 'experience';
    });
    expect(asked).toEqual(['WHERE I WORKED']);
    expect(profile.experience[0]).toMatchObject({ title: 'Engineer', company: 'Initech', start: '2019', end: '2022' });
  });
});

describe('yearsOfExperience', () => {
  it('counts overlapping jobs once', () => {
    const p = emptyProfile();
    p.experience = [
      { id: '1', company: 'A', title: 't', location: '', start: '2018-01', end: '2020-01', current: false, bullets: [] },
      { id: '2', company: 'B', title: 't', location: '', start: '2019-01', end: '2021-01', current: false, bullets: [] },
    ];
    expect(yearsOfExperience(p)).toBe(3);
  });
});
