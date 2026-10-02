import { describe, expect, it } from 'vitest';
import { guessDocKind, uploadFileName } from '../../src/core/documents';
import type { DocKind } from '../../src/core/types';

const jordan = { firstName: 'Jordan', lastName: 'Rivera' };
const doc = (kind: DocKind, fileName: string, name = fileName.replace(/\.\w+$/, ''), mime = 'application/pdf') => ({ kind, name, fileName, mime });

describe('uploadFileName', () => {
  it('names each kind of document consistently', () => {
    expect(uploadFileName(doc('resume', 'my resume v3 FINAL (2).pdf'), jordan, 'underscore')).toBe('Jordan_Rivera_Resume.pdf');
    expect(uploadFileName(doc('coverLetter', 'cl-acme.docx'), jordan, 'underscore')).toBe('Jordan_Rivera_Cover_Letter.docx');
    expect(uploadFileName(doc('transcript', 'unofficial.PDF'), jordan, 'underscore')).toBe('Jordan_Rivera_Transcript.pdf');
  });

  it('supports each format', () => {
    const d = doc('coverLetter', 'x.pdf');
    expect(uploadFileName(d, jordan, 'dash')).toBe('Jordan-Rivera-Cover-Letter.pdf');
    expect(uploadFileName(d, jordan, 'spaced')).toBe('Jordan Rivera - Cover Letter.pdf');
    expect(uploadFileName(d, jordan, 'original')).toBe('x.pdf');
  });

  it('describes "other" documents by their own name, without repeating the person', () => {
    expect(uploadFileName(doc('other', 'refs.pdf', 'References'), jordan, 'underscore')).toBe('Jordan_Rivera_References.pdf');
    expect(uploadFileName(doc('other', 'p.pdf', 'Jordan Rivera portfolio'), jordan, 'underscore')).toBe('Jordan_Rivera_Portfolio.pdf');
    expect(uploadFileName(doc('other', 'p.pdf', '---'), jordan, 'underscore')).toBe('Jordan_Rivera_Document.pdf');
  });

  it('keeps names ASCII and tidy', () => {
    expect(uploadFileName(doc('resume', 'cv.pdf'), { firstName: 'José María', lastName: "O'Brien-Núñez" }, 'underscore')).toBe(
      'Jose_Maria_O_Brien_Nunez_Resume.pdf',
    );
    expect(uploadFileName(doc('resume', 'cv.pdf'), { firstName: 'jordan', lastName: 'rivera' }, 'underscore')).toBe('Jordan_Rivera_Resume.pdf');
    expect(uploadFileName(doc('resume', 'cv.pdf'), { firstName: 'Jordan', lastName: 'McDonald' }, 'underscore')).toBe('Jordan_McDonald_Resume.pdf');
  });

  it('falls back to the MIME type for the extension, and to the original name without a profile name', () => {
    expect(uploadFileName(doc('resume', 'resume', 'resume', 'application/pdf'), jordan, 'underscore')).toBe('Jordan_Rivera_Resume.pdf');
    expect(uploadFileName(doc('resume', 'mine.pdf'), { firstName: '', lastName: '' }, 'underscore')).toBe('mine.pdf');
  });
});

describe('guessDocKind', () => {
  it('trusts the file name when it says what the file is', () => {
    expect(guessDocKind('Cover Letter - Acme.pdf', '')).toBe('coverLetter');
    expect(guessDocKind('JR_CV.pdf', '')).toBe('resume');
    expect(guessDocKind('Résumé 2026.docx', '')).toBe('resume');
    expect(guessDocKind('unofficial_transcript.pdf', '')).toBe('transcript');
  });

  it('reads the text when the file name is uninformative', () => {
    expect(guessDocKind('doc1.pdf', 'Dear Hiring Manager, I am writing to apply... Sincerely, Jordan')).toBe('coverLetter');
    expect(guessDocKind('scan.pdf', 'Official Transcript\nFall Term 2019\nCourse Code Course Title Credits Earned\nCumulative GPA 3.8')).toBe('transcript');
    expect(guessDocKind('jordan.pdf', 'Jordan Rivera\nEXPERIENCE\nAcme 2021 - Present\nEDUCATION\nUT Austin\nSKILLS\nTypeScript')).toBe('resume');
  });

  it('says "other" when there is not enough to go on', () => {
    expect(guessDocKind('photo.png', '')).toBe('other');
    expect(guessDocKind('notes.txt', 'Groceries: eggs, milk')).toBe('other');
  });
});
