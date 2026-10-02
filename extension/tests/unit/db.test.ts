// @vitest-environment node
// Node's own Blob survives fake-indexeddb's structured cloning; happy-dom's doesn't.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDocument,
  db,
  deleteDocument,
  documentFor,
  exportAll,
  getProfile,
  importAll,
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

  it('rejects files that are not backups', async () => {
    await expect(importAll({} as never)).rejects.toThrow('Not an EzAutoApply backup file');
  });
});
