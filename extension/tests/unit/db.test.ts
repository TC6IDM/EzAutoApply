// @vitest-environment node
// Node's own Blob survives fake-indexeddb's structured cloning; happy-dom's doesn't.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDocument,
  approveAnswers,
  changeDocumentKind,
  db,
  deleteDocument,
  documentFor,
  exportAll,
  getProfile,
  importAll,
  importAnswers,
  isAnswersFile,
  listAnswers,
  saveAnswer,
  saveProfile,
  setDefaultDocument,
} from '../../src/db';
import { sampleProfile } from './helpers';

const pdf = (text: string) => new Blob([text], { type: 'application/pdf' });

beforeEach(async () => {
  await Promise.all([db.kv.clear(), db.documents.clear(), db.answers.clear(), db.applications.clear()]);
});

describe('documents', () => {
  it('makes the first document of a kind the default, and keeps one default per kind', async () => {
    const a = await addDocument({ kind: 'resume', file: pdf('a'), fileName: 'a.pdf' });
    const b = await addDocument({ kind: 'resume', file: pdf('b'), fileName: 'b.pdf' });
    expect(a.isDefault).toBe(true);
    expect(b.isDefault).toBe(false);
    expect((await documentFor('resume'))?.id).toBe(a.id);

    await setDefaultDocument(b.id);
    expect((await documentFor('resume'))?.id).toBe(b.id);
    // An explicit per-application choice wins over the default.
    expect((await documentFor('resume', a.id))?.id).toBe(a.id);

    await deleteDocument(b.id);
    expect((await documentFor('resume'))?.id).toBe(a.id);
    expect((await db.documents.get(a.id))?.isDefault).toBe(true);
  });

  it('moves a document to another kind and keeps one default per kind', async () => {
    const a = await addDocument({ kind: 'resume', file: pdf('a'), fileName: 'a.pdf' });
    const b = await addDocument({ kind: 'resume', file: pdf('b'), fileName: 'b.pdf' });
    // a was the default resume; moving it promotes b, and it becomes the first (default) cover letter.
    await changeDocumentKind(a.id, 'coverLetter');
    expect((await db.documents.get(a.id))).toMatchObject({ kind: 'coverLetter', isDefault: true });
    expect((await db.documents.get(b.id))?.isDefault).toBe(true);
    // A second document moved into a kind that already has a default doesn't take it over.
    const c = await addDocument({ kind: 'transcript', file: pdf('c'), fileName: 'c.pdf' });
    await changeDocumentKind(c.id, 'coverLetter');
    expect((await db.documents.get(c.id))).toMatchObject({ kind: 'coverLetter', isDefault: false });
  });

  it('returns nothing for a kind with no documents', async () => {
    expect(await documentFor('transcript')).toBeUndefined();
  });
});

describe('answers', () => {
  it('replaces the answer when the same question is answered again in the same scope', async () => {
    await saveAnswer({ question: 'Are you willing to travel?', answer: 'No', fieldKind: 'radio', scope: 'global' });
    await saveAnswer({ question: 'Are you willing to travel?', answer: 'Yes', fieldKind: 'radio', scope: 'global' });
    await saveAnswer({ question: 'Are you willing to travel?', answer: 'Sometimes', fieldKind: 'radio', scope: 'acme.com' });
    const all = await listAnswers();
    expect(all).toHaveLength(2);
    expect(all.find((a) => a.scope === 'global')?.answer).toBe('Yes');
  });

  it('keeps who wrote an answer; an agent waits for approval and never replaces the owner’s (#21)', async () => {
    const mine = await saveAnswer({ question: 'Notice period?', answer: 'Two weeks', fieldKind: 'text', scope: 'global' });
    expect(mine).toMatchObject({ origin: 'you', approved: true });
    expect(await saveAnswer({ question: 'Notice period?', answer: 'A month', fieldKind: 'text', scope: 'global', origin: 'agent' })).toMatchObject({ id: mine.id, answer: 'Two weeks' });

    const agent = await saveAnswer({ question: 'Years with React?', answer: '3', fieldKind: 'text', scope: 'global', origin: 'agent', createdBy: 'answerer', sourceRefs: ['profile.experience[0]'] });
    expect(agent).toMatchObject({ origin: 'agent', approved: false, createdBy: 'answerer', sourceRefs: ['profile.experience[0]'] });
    // A later agent answer to the same question replaces an unapproved one; the owner's answer replaces either.
    expect((await saveAnswer({ question: 'Years with React?', answer: '4', fieldKind: 'text', scope: 'global', origin: 'agent' })).answer).toBe('4');
    await approveAnswers([agent.id]);
    expect((await listAnswers()).find((a) => a.id === agent.id)).toMatchObject({ approved: true, origin: 'agent' });
    expect(await saveAnswer({ question: 'Years with React?', answer: '5', fieldKind: 'text', scope: 'global' })).toMatchObject({ id: agent.id, answer: '5', origin: 'you', approved: true });
  });
});

describe('answers files (#60)', () => {
  const file = (answers: unknown[]) => ({ app: 'EzAutoApply', kind: 'answers', version: 1, answers });

  it('adds each answer as an unapproved import, keeps the owner’s, and skips unreadable rows', async () => {
    await saveAnswer({ question: 'Notice period?', answer: 'Two weeks', fieldKind: 'text', scope: 'global' });
    const essay = 'I have wanted to build tools for small teams since my first co-op, and this role does exactly that.';
    const got = await importAnswers(
      file([
        { question: 'Notice period?', answer: 'A month' },
        { question: 'Why do you want to work here?', answer: essay, scope: 'Jobs.Example.com', sourceRefs: ['documents/applications/example/form_answers.txt Q1'], createdBy: 'ai-job-search' },
        { question: 'Open to remote?', answer: true },
        { question: 'Languages?', answer: ['Python', 'Go'] },
        { question: '', answer: 'x' },
        { question: 'Bad scope', answer: 'x', scope: 'https://example.com/jobs' },
        { question: 'Empty', answer: '  ' },
      ]),
    );
    expect(got).toEqual({ added: 3, kept: 1, skipped: 3 });
    const all = await listAnswers();
    expect(all.find((a) => a.question === 'Notice period?')).toMatchObject({ answer: 'Two weeks', origin: 'you', approved: true });
    expect(all.find((a) => a.question.startsWith('Why'))).toMatchObject({
      scope: 'jobs.example.com', fieldKind: 'textarea', origin: 'import', approved: false, createdBy: 'ai-job-search',
      sourceRefs: ['documents/applications/example/form_answers.txt Q1'],
    });
    expect(all.find((a) => a.question === 'Open to remote?')).toMatchObject({ fieldKind: 'checkbox', createdBy: 'import' });
    expect(all.find((a) => a.question === 'Languages?')?.fieldKind).toBe('checkboxGroup');
  });

  it('importing the same file again updates its own unapproved answers, not approved ones', async () => {
    await importAnswers(file([{ question: 'City?', answer: 'Exampleton' }]));
    expect(await importAnswers(file([{ question: 'City?', answer: 'Sampleville' }]))).toEqual({ added: 1, kept: 0, skipped: 0 });
    const [city] = await listAnswers();
    await approveAnswers([city.id]);
    expect(await importAnswers(file([{ question: 'City?', answer: 'Elsewhere' }]))).toEqual({ added: 0, kept: 1, skipped: 0 });
    expect((await listAnswers())[0].answer).toBe('Sampleville');
  });

  it('tells an answers file from a backup, and refuses anything else', async () => {
    expect(isAnswersFile(file([]))).toBe(true);
    expect(isAnswersFile({ app: 'EzAutoApply', version: 1, answers: [] })).toBe(false);
    await expect(importAnswers({ app: 'Other', kind: 'answers', answers: [] })).rejects.toThrow('Not an EzAutoApply answers file');
  });
});

describe('backup', () => {
  it('round-trips everything through export and import', async () => {
    await saveProfile(sampleProfile());
    await addDocument({ kind: 'coverLetter', file: pdf('hello'), fileName: 'cl.pdf', text: 'hello' });
    await saveAnswer({ question: 'Q?', answer: 'A', fieldKind: 'text', scope: 'global' });
    const dump = JSON.parse(JSON.stringify(await exportAll()));

    await Promise.all([db.kv.clear(), db.documents.clear(), db.answers.clear()]);
    await importAll(dump);

    expect((await getProfile()).personal.firstName).toBe('Jordan');
    const doc = await documentFor('coverLetter');
    expect(doc?.fileName).toBe('cl.pdf');
    expect(await doc!.blob.text()).toBe('hello');
    expect((await listAnswers())[0].answer).toBe('A');
  });

  it('round-trips who wrote each answer, and reads a backup from before #21 as the owner’s own', async () => {
    await saveAnswer({ question: 'Agent Q?', answer: 'A', fieldKind: 'text', scope: 'global', origin: 'agent', sourceRefs: ['cv'] });
    const dump = JSON.parse(JSON.stringify(await exportAll()));
    await importAll(dump);
    expect((await listAnswers())[0]).toMatchObject({ origin: 'agent', approved: false, sourceRefs: ['cv'] });

    const old = { ...dump, answers: dump.answers.map(({ origin: _o, approved: _a, sourceRefs: _s, ...rest }: Record<string, unknown>) => rest) };
    await importAll(old);
    const [a] = await listAnswers();
    expect(a.origin ?? 'you').toBe('you');
    expect(a.approved !== false).toBe(true);
  });

  it('rejects files that are not backups', async () => {
    await expect(importAll({} as never)).rejects.toThrow('Not an EzAutoApply backup file');
  });
});
