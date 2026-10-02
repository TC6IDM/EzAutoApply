import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { emptyProfile, type Profile } from '../../src/core/profile';
import { type PdfItem, pdfItemsToLines } from '../../src/parse/extract';
import {
  exportFileKey,
  isLinkedInExport,
  isLinkedInPdf,
  parseCsv,
  parseLinkedInExport,
  parseLinkedInPdf,
  readExportFiles,
  splitDegree,
  unzipExport,
} from '../../src/parse/linkedin';
import { mergeParsed, type ParsedProfile } from '../../src/parse/merge';
import { sampleProfile } from './helpers';

// ── data export ─────────────────────────────────────────────────────────

const EXPORT: Record<string, string> = {
  'Profile.csv': `﻿First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers
Jordan,Rivera,,"12 Main St, Austin, TX",,Senior Software Engineer at Acme,"Backend engineer.
Likes boring systems.",Software Development,78701,"Austin, Texas, United States",,"[PORTFOLIO:https://jrivera.dev,OTHER:https://github.com/jrivera]",
`,
  'Positions.csv': `Company Name,Title,Description,Location,Started On,Finished On\r
Acme Corp,Senior Software Engineer,"- Led the billing rewrite\r
- Cut p99 latency by 40%","Austin, Texas, United States",Jan 2023,\r
Globex,Software Engineering Intern,,Remote,May 2020,Aug 2020\r
`,
  'Education.csv': `School Name,Start Date,End Date,Notes,Degree Name,Activities
University of Texas at Austin,2017,2021,GPA: 3.8/4.0,"Bachelor of Science - BS, Computer Science",ACM
`,
  'Skills.csv': `Name
TypeScript
PostgreSQL
typescript
`,
  'Certifications.csv': `Name,Url,Authority,Started On,Finished On,License Number
AWS Certified Developer – Associate,,Amazon Web Services,Jan 2024,,
`,
  'Languages.csv': `Name,Proficiency
Spanish,LIMITED_WORKING
`,
  'Projects.csv': `Title,Description,Url,Started On,Finished On
Ledgerly,Personal finance tracker,ledgerly.app,Mar 2022,
`,
  'Email Addresses.csv': `Email Address,Confirmed,Primary,Updated On
old@example.com,Yes,No,2019-01-01
jordan@example.com,Yes,Yes,2024-01-01
`,
  'PhoneNumbers.csv': `Extension,Number,Type
,555-123-4567,Mobile
`,
  'Recommendations_Received.csv': `First Name,Last Name,Company,Job Title,Text,Creation Date,Status
Sam,Lee,Acme,Manager,"Great, ""reliable"" teammate.",01/02/24,VISIBLE
`,
  'Jobs/Job Applications.csv': `Application Date,Company Name
01/02/24,Initech
`,
};

function exportZip(files = EXPORT): Uint8Array<ArrayBuffer> {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [`Basic_LinkedInDataExport_10-02-2026/${name}`, strToU8(text)])));
}

describe('parseCsv', () => {
  it('handles quoted commas, quotes, line breaks, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', ''],
    ]);
  });
});

describe('LinkedIn data export', () => {
  it('names files the same however LinkedIn spells them', () => {
    expect(exportFileKey('Basic_LinkedInDataExport_10-02-2026/Email Addresses.csv')).toBe('emailaddresses');
    expect(exportFileKey('Recommendations_Received.csv')).toBe('recommendationsreceived');
    expect(exportFileKey('Profile_12345.csv')).toBe('profile');
  });

  it('reads the CSV files out of the ZIP', () => {
    const files = unzipExport(exportZip());
    expect(isLinkedInExport(files)).toBe(true);
    expect(files.get('positions')).toContain('Acme Corp');
    expect(() => unzipExport(strToU8('not a zip'))).toThrow(/couldn’t be opened/);
  });

  it('maps the export onto the profile', () => {
    const { profile, notImported } = parseLinkedInExport(unzipExport(exportZip()), emptyProfile());
    expect(profile.personal).toMatchObject({ firstName: 'Jordan', lastName: 'Rivera', email: 'jordan@example.com', phone: '555-123-4567' });
    expect(profile.personal.address).toMatchObject({ line1: '12 Main St', city: 'Austin', region: 'Texas', postalCode: '78701' });
    expect(profile.personal.address.country).toMatch(/United States/);
    expect(profile.links).toMatchObject({ portfolio: 'https://jrivera.dev', github: 'https://github.com/jrivera' });
    expect(profile.summary).toBe('Backend engineer.\nLikes boring systems.');
    expect(profile.experience).toEqual([
      expect.objectContaining({
        company: 'Acme Corp',
        title: 'Senior Software Engineer',
        location: 'Austin, Texas, United States',
        start: '2023-01',
        end: '',
        current: true,
        bullets: ['Led the billing rewrite', 'Cut p99 latency by 40%'],
      }),
      expect.objectContaining({ company: 'Globex', start: '2020-05', end: '2020-08', current: false, location: 'Remote', bullets: [] }),
    ]);
    expect(profile.education).toEqual([
      expect.objectContaining({
        school: 'University of Texas at Austin',
        degree: 'Bachelor of Science',
        field: 'Computer Science',
        gpa: '3.8/4.0',
        start: '2017',
        end: '2021',
      }),
    ]);
    expect(profile.skills).toEqual(['TypeScript', 'PostgreSQL']);
    expect(profile.certifications).toEqual(['AWS Certified Developer – Associate']);
    expect(profile.languages).toEqual(['Spanish']);
    expect(profile.projects).toEqual([expect.objectContaining({ name: 'Ledgerly', url: 'https://ledgerly.app', description: 'Personal finance tracker', start: '2022-03' })]);
    expect(notImported).toEqual(['Recommendations (1)']);
  });

  it('accepts the ZIP or loose CSV files as dropped', async () => {
    const zip = new File([exportZip()], 'Basic_LinkedInDataExport.zip', { type: 'application/zip' });
    expect([...(await readExportFiles([zip])).keys()]).toEqual(expect.arrayContaining(['profile', 'positions', 'skills']));
    const csv = new File([EXPORT['Skills.csv']], 'Skills.csv', { type: 'text/csv' });
    const loose = await readExportFiles([csv]);
    expect(isLinkedInExport(loose)).toBe(true);
    expect(parseLinkedInExport(loose, emptyProfile()).profile.skills).toEqual(['TypeScript', 'PostgreSQL']);
    expect(isLinkedInExport(await readExportFiles([new File(['x'], 'notes.txt')]))).toBe(false);
  });

  it('splits LinkedIn degree names', () => {
    expect(splitDegree('Bachelor of Science - BS, Computer Science')).toEqual({ degree: 'Bachelor of Science', field: 'Computer Science' });
    expect(splitDegree('Master of Business Administration - MBA')).toEqual({ degree: 'Master of Business Administration', field: '' });
    expect(splitDegree('Honors Diploma')).toEqual({ degree: 'Honors Diploma', field: '' });
    expect(splitDegree('Mathematics, Physics, Chemistry')).toEqual({ degree: '', field: 'Mathematics, Physics, Chemistry' });
  });
});

// ── "Save to PDF" ───────────────────────────────────────────────────────

/** A text item as pdf.js reports it; widths approximate Arial. */
const at = (str: string, x: number, y: number, size: number): PdfItem => ({ str, x, y, size, width: str.length * size * 0.48, bold: false });
const side = (str: string, y: number, size = 10.5, x = 21.6) => at(str, x, y, size);
const main = (str: string, y: number, size = 10.5, x = 223.6) => at(str, x, y, size);
const footer = (n: number, of: number) => [at('Page', 384, 13.9, 9), at(String(n), 407.5, 13.9, 9), at('of', 415, 13.9, 9), at(String(of), 425, 13.9, 9)];

/** Laid out like LinkedIn's real export: positions, sizes and line spacing are taken from actual profile PDFs. */
const LINKEDIN_PDF: PdfItem[][] = [
  [
    side('Contact', 737.6, 13),
    side('(555) 123-4567', 718.2),
    side('(Mobile)', 718.2, 10.5, 100),
    // Wrapped entries sit 12.6pt apart; separate entries 17.6pt.
    side('jordan.rivera@example.co', 705.6),
    side('m', 693.0),
    side('www.linkedin.com/in/jordan-', 668.6, 11),
    side('rivera-dev', 654.2, 11),
    side('(LinkedIn)', 654.2, 11, 80),
    side('jrivera.dev', 636.6),
    side('(Portfolio)', 636.6, 10.5, 82),
    side('Top Skills', 601.8, 13),
    side('TypeScript', 582.4),
    side('PostgreSQL', 564.8),
    side('Distributed Systems', 547.2),
    side('Languages', 512.4, 13),
    side('English', 493.0),
    side('(Native or Bilingual)', 493.0, 10.5, 60),
    side('Spanish', 475.4),
    side('(Limited Working)', 475.4, 10.5, 62),
    side('Certifications', 440.6, 13),
    side('AWS Certified Developer –', 421.2),
    side('Associate', 408.6),
    side('Honors-Awards', 373.8, 13),
    side("Dean's List", 354.4),

    main('Jordan Rivera', 726.5, 26),
    main('Senior Software Engineer at Acme Corp', 705.3, 12),
    main('Austin, Texas, United States', 689.9, 12),
    main('Summary', 652.3, 15.8),
    main('Backend engineer who likes boring, reliable systems and the people who', 626.8, 12),
    main('run them.', 608.8, 12),
    main('Experience', 560, 15.8),
    // A company with two roles: its total time sits between the company and the first title.
    main('Acme Corp', 529.5, 12),
    main('3 years 4 months', 513.4),
    main('Senior Software Engineer', 497.3, 11.5),
    main('January 2023 - Present', 482.8),
    at('(1 year 10 months)', 340, 482.8, 10.5),
    main('Austin, Texas, United States', 468.1),
    main('- Led the billing rewrite that now handles 2M invoices a month across', 446.7),
    main('four regions', 428.7),
    main('- Cut p99 latency by 40%', 410.7),
    main('Software Engineer', 379, 11.5),
    main('June 2021 - January 2023', 364.5),
    at('(1 year 8 months)', 350, 364.5, 10.5),
    main('Globex', 330, 12),
    main('Software Engineering Intern', 314, 11.5),
    main('May 2020 - August 2020', 299.5),
    at('(4 months)', 340, 299.5, 10.5),
    main('Remote', 284.8),
    main('Education', 240, 15.8),
    main('University of Texas at Austin', 214.5, 12),
    main('Bachelor of Science - BS, Computer Science and', 196.9),
    ...footer(1, 2),
  ],
  [
    // The degree line continues at the top of the next page.
    main('Mathematics', 737.1),
    at('· (August 2017 - May 2021)', 283, 737.1, 10.5),
    main('Austin Community College', 703.7, 12),
    main('· (2015 - 2017)', 686.1),
    ...footer(2, 2),
  ],
];

describe('LinkedIn "Save to PDF"', () => {
  const lines = pdfItemsToLines(LINKEDIN_PDF);

  it('reads the main column and the sidebar apart', () => {
    expect(isLinkedInPdf(lines)).toBe(true);
    expect(lines.find((l) => l.text.startsWith('Top Skills'))?.column).toBe('side');
    expect(lines.find((l) => l.text === 'Jordan Rivera')?.column).toBe('main');
    // No line mixes sidebar and main-column text.
    expect(lines.some((l) => /TypeScript.*Acme|Acme.*TypeScript/.test(l.text))).toBe(false);
  });

  it('maps the profile PDF onto the profile', () => {
    const { profile, notImported } = parseLinkedInPdf(lines, emptyProfile());
    expect(profile.personal).toMatchObject({ firstName: 'Jordan', lastName: 'Rivera', email: 'jordan.rivera@example.com', phone: '(555) 123-4567' });
    expect(profile.personal.address).toMatchObject({ city: 'Austin', region: 'Texas' });
    expect(profile.links).toMatchObject({ linkedin: 'https://www.linkedin.com/in/jordan-rivera-dev', portfolio: 'https://jrivera.dev' });
    expect(profile.summary).toBe('Backend engineer who likes boring, reliable systems and the people who run them.');
    expect(profile.experience).toEqual([
      expect.objectContaining({
        company: 'Acme Corp',
        title: 'Senior Software Engineer',
        location: 'Austin, Texas, United States',
        start: '2023-01',
        current: true,
        bullets: ['Led the billing rewrite that now handles 2M invoices a month across four regions', 'Cut p99 latency by 40%'],
      }),
      expect.objectContaining({ company: 'Acme Corp', title: 'Software Engineer', start: '2021-06', end: '2023-01', current: false, location: '', bullets: [] }),
      expect.objectContaining({ company: 'Globex', title: 'Software Engineering Intern', start: '2020-05', end: '2020-08', location: 'Remote', bullets: [] }),
    ]);
    expect(profile.education).toEqual([
      expect.objectContaining({
        school: 'University of Texas at Austin',
        degree: 'Bachelor of Science',
        field: 'Computer Science and Mathematics',
        start: '2017-08',
        end: '2021-05',
      }),
      expect.objectContaining({ school: 'Austin Community College', degree: '', field: '', start: '2015', end: '2017' }),
    ]);
    expect(profile.skills).toEqual(['TypeScript', 'PostgreSQL', 'Distributed Systems']);
    expect(profile.languages).toEqual(['English', 'Spanish']);
    expect(profile.certifications).toEqual(['AWS Certified Developer – Associate']);
    expect(notImported).toEqual(['Honors & Awards (1)']);
  });

  it('leaves other PDFs to the resume parser, row by row', () => {
    const resume = pdfItemsToLines([[at('Jordan Rivera', 36, 740, 20), at('Experience', 36, 700, 14), at('Acme Corp', 36, 680, 11), at('2021 - Present', 150, 680, 11)]]);
    expect(isLinkedInPdf(resume)).toBe(false);
    expect(resume.map((l) => l.text)).toEqual(['Jordan Rivera', 'Experience', 'Acme Corp   2021 - Present']);
  });
});

// ── merging ─────────────────────────────────────────────────────────────

function parsed(p: Profile): ParsedProfile {
  const { personal, links, summary, experience, education, projects, skills, certifications, languages } = p;
  return { personal, links, summary, experience, education, projects, skills, certifications, languages };
}

describe('mergeParsed combine', () => {
  it('adds what the profile lacks and fills empty fields, without changing anything already there', () => {
    const current = sampleProfile();
    current.experience[0].bullets = [];
    const imported = parsed(emptyProfile());
    imported.personal = { ...current.personal, phone: '000', email: '' };
    imported.experience = [
      // The same job, written differently, with a description and an end date.
      { id: 'x1', company: 'Acme Corporation', title: 'Senior Software Engineer', location: '', start: '2021-06', end: '2024-01', current: false, bullets: ['Led the billing rewrite'] },
      { id: 'x2', company: 'Initech', title: 'Intern', location: '', start: '2019-05', end: '2019-08', current: false, bullets: [] },
    ];
    imported.education = [
      // A second degree at the same school is its own entry.
      { id: 'y1', school: 'The University of Texas at Austin', degree: 'Master of Science', field: 'Computer Science', gpa: '', location: '', start: '2021', end: '2023' },
    ];
    imported.skills = ['typescript', 'Go'];
    const next = mergeParsed(current, imported, 'combine');
    expect(next.personal.phone).toBe('(555) 123-4567');
    expect(next.experience).toHaveLength(3);
    // The matched job got its description but stays current, with no end date.
    expect(next.experience[0]).toMatchObject({ company: 'Acme Corp', title: 'Software Engineer', current: true, end: '', bullets: ['Led the billing rewrite'] });
    expect(next.experience[2]).toMatchObject({ company: 'Initech' });
    expect(next.education.map((e) => e.degree)).toEqual(['Bachelor of Science', 'Master of Science']);
    expect(next.skills).toEqual(['TypeScript', 'React', 'Python', 'Go']);
    expect(current.experience).toHaveLength(2);
  });

  it('keeps the resume behaviour for fillEmpty and replace', () => {
    const current = sampleProfile();
    const imported = parsed(emptyProfile());
    imported.skills = ['Go'];
    expect(mergeParsed(current, imported, 'fillEmpty').skills).toEqual(['TypeScript', 'React', 'Python']);
    expect(mergeParsed(current, imported, 'replace').skills).toEqual(['Go']);
  });
});
