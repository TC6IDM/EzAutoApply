import { describe, expect, it, vi } from 'vitest';
import {
  choiceConfidence,
  noulProbability,
  type SystemOneBatchRequest,
  SystemOneClient,
  type SystemOneRequest,
  type SystemOneResponse,
} from '../../src/classifier/systemone';
import type { Classifier } from '../../src/fill/match/classify';
import { resolveFields } from '../../src/fill/pipeline';
import { field, opts, sampleProfile, settings } from './helpers';

/** A scripted stand-in for Laya: answers each question by looking at the request. */
function fakeLaya(answer: (state: string, qid: string, q: SystemOneRequest['questions'][string]) => object): Classifier & { calls: string[] } {
  const calls: string[] = [];
  const one = (req: SystemOneRequest): SystemOneResponse => {
    const body = (req.state as { body: string }).body;
    const answers: SystemOneResponse['answers'] = {};
    for (const [qid, q] of Object.entries(req.questions)) {
      calls.push(qid);
      answers[qid] = answer(body, qid, q);
    }
    return { answers };
  };
  return {
    calls,
    predict: async (req) => one(req),
    predictBatch: async (req: SystemOneBatchRequest) => req.states.map((state) => one({ state, questions: req.questions })),
  };
}

const deps = (classifier: Classifier | null, answers = []) => ({
  profile: sampleProfile(),
  answers,
  host: 'jobs.example.com',
  settings: settings(),
  classifier,
});

/** A group answer whose probabilities put `top` first and spread the rest. */
function group(top: string, p: number) {
  const ids = ['contact', 'address', 'links', 'workAuth', 'eeo', 'experience', 'education', 'logistics', 'about', 'other'];
  const rest = (1 - p) / (ids.length - 1);
  const probabilities = Object.fromEntries(ids.map((id) => [id, id === top ? p : id === 'contact' ? rest + 0.01 : rest]));
  return { choice: top, answer_confidence: p, probabilities };
}

describe('classifier tier', () => {
  it('maps an unrecognized question to a profile field: group, then a yes/no per candidate key', async () => {
    const f = field({ label: 'Institution you graduated from', kind: 'text', required: true });
    const laya = fakeLaya((_s, qid) =>
      qid === 'group' ? group('education', 0.6) : { noul: qid === 'school' ? 0.91 : 0.3 },
    );
    const [r] = await resolveFields([f], deps(laya));
    expect(r).toMatchObject({ key: 'school', value: 'University of Texas at Austin', source: 'classifier', status: 'filled' });
    expect(laya.calls[0]).toBe('group');
    // Candidates come from the two likeliest groups that aren't "other".
    expect(laya.calls).toContain('school');
    expect(laya.calls).toContain('email');
    expect(laya.calls).not.toContain('desiredSalary');
  });

  it('marks medium-confidence answers for review', async () => {
    const f = field({ label: 'Institution you graduated from', kind: 'text' });
    const laya = fakeLaya((_s, qid) => (qid === 'group' ? group('education', 0.6) : { noul: qid === 'school' ? 0.62 : 0.3 }));
    const [r] = await resolveFields([f], deps(laya));
    expect(r).toMatchObject({ key: 'school', status: 'review' });
  });

  it('does not trust a key that barely beats the runner-up', async () => {
    const f = field({ label: 'Where do you work these days?', kind: 'text', required: true });
    const p: Record<string, number> = { currentTitle: 0.55, currentCompany: 0.53 };
    const laya = fakeLaya((_s, qid) => (qid === 'group' ? group('experience', 0.4) : { noul: p[qid] ?? 0.2 }));
    const [r] = await resolveFields([f], deps(laya));
    expect(r.status).toBe('needs');
  });

  it('leaves low-confidence and open-ended questions for the user', async () => {
    const low = field({ label: 'Something odd', required: true });
    const open = field({ label: 'Tell us about a hard problem you solved', kind: 'textarea', required: true });
    const laya = fakeLaya((s, qid) => {
      if (qid !== 'group') return { noul: 0.3 };
      return s.includes('odd') ? group('contact', 0.3) : group('other', 0.9);
    });
    const [a, b] = await resolveFields([low, open], deps(laya));
    expect(a.status).toBe('needs');
    expect(b).toMatchObject({ status: 'needs', note: 'Needs a personal answer' });
  });

  it('picks an option whose wording differs from the profile value', async () => {
    const f = field({
      label: 'What is your work authorization status?',
      kind: 'select',
      options: opts('Select...', 'Authorized to work without sponsorship', 'Will require sponsorship'),
      required: true,
    });
    const laya = fakeLaya((_s, qid, q) => {
      if (qid === 'option') {
        const labels = (q as { criteria: string[] }).criteria;
        return { choice: labels[0], answer_confidence: 0.9 };
      }
      return { choice: 'workAuth', answer_confidence: 0.95 };
    });
    // "work authorization" is caught by the rules as authorizedToWork (a yes/no), so only the option step needs the model.
    const [r] = await resolveFields([f], deps(laya));
    expect(r).toMatchObject({ key: 'authorizedToWork', optionIndex: 1, status: 'review' });
    expect(laya.calls).toEqual(['option']);
  });

  it('answers a yes/no question from profile facts, always for review', async () => {
    const f = field({ label: 'Do you have professional experience with React?', kind: 'radio', options: opts('Yes', 'No'), required: true });
    const laya = fakeLaya((s, qid) => {
      if (qid === 'group') return group('experience', 0.9);
      if (qid !== 'yes') return { noul: 0.3 }; // no profile field fits
      expect(s).toContain('Skills: TypeScript, React, Python');
      return { noul: 0.92 };
    });
    const [r] = await resolveFields([f], deps(laya));
    expect(r).toMatchObject({ value: 'Yes', status: 'review', source: 'classifier' });
    expect(r.note).toMatch(/Inferred from your profile/);
  });

  it('confirms a fuzzy saved-answer match with the classifier', async () => {
    const now = Date.now();
    const saved = [
      { id: 'a1', question: 'Have you previously worked for this company?', normalized: 'have you previously worked for this company', fieldKind: 'radio' as const, answer: 'No', scope: 'global', timesUsed: 1, lastUsed: now, createdAt: now },
    ];
    const f = field({ label: 'Have you ever been employed by this company before?', kind: 'radio', options: opts('Yes', 'No') });
    const laya = fakeLaya(() => ({ choice: 'q0', answer_confidence: 0.88 }));
    const [r] = await resolveFields([f], deps(laya, saved as never));
    expect(r).toMatchObject({ source: 'answerBank', value: 'No', answerId: 'a1' });
  });

  it('keeps working without the classifier when it fails', async () => {
    const onError = vi.fn();
    const broken: Classifier = {
      predict: () => Promise.reject(new Error('Laya is not running')),
      predictBatch: () => Promise.reject(new Error('Laya is not running')),
    };
    const fields = [field({ label: 'First name' }), field({ label: 'Mystery question', required: true })];
    const r = await resolveFields(fields, { ...deps(broken), onClassifierError: onError });
    expect(r[0]).toMatchObject({ value: 'Jordan', status: 'filled' });
    expect(r[1].status).toBe('needs');
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('SystemOneClient', () => {
  const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('posts to /v1/systemone with the bearer key and pinned checkpoint', async () => {
    const fetchMock = vi.fn(async () => okJson({ answers: { q: { choice: 'a', answer_confidence: 0.9 } } }));
    const c = new SystemOneClient({ ...settings().classifier, apiKey: 'k123' }, fetchMock as unknown as typeof fetch);
    await c.predict({ state: { body: 'x' }, questions: { q: { type: 'choice', instructions: 'i', criteria: ['a', 'b'] } } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k123');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'typed-decisions', state: { body: 'x' } });
  });

  it('falls back to single calls when the server has no batch route', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/batch') ? new Response('not found', { status: 404 }) : okJson({ answers: { q: { noul: 0.7 } } }),
    );
    const c = new SystemOneClient({ ...settings().classifier, provider: 'jev', baseUrl: 'https://jev.example' }, fetchMock as unknown as typeof fetch);
    const out = await c.predictBatch({ states: [{ body: 'a' }, { body: 'b' }], questions: { q: { type: 'noul', instructions: 'i' } } });
    expect(out).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Jev requests don't pin a Laya checkpoint.
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).model).toBeUndefined();
  });

  it('reports an unreachable server clearly', async () => {
    const c = new SystemOneClient(settings().classifier, (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    await expect(c.predict({ state: {}, questions: {} })).rejects.toThrow(/unreachable at http:\/\/127\.0\.0\.1:8000/);
    expect(await c.health()).toEqual({ ok: false, detail: 'Laya is not running at http://127.0.0.1:8000' });
  });

  it('reads confidences from either field', () => {
    expect(choiceConfidence({ choice: 'a', answer_confidence: 0.8, confidence: 0.2 })).toBe(0.8);
    expect(choiceConfidence({ choice: 'a', probabilities: { a: 0.6, b: 0.4 } })).toBe(0.6);
    expect(noulProbability({ noul: 0.3 })).toBe(0.3);
  });
});

describe('classifier question sizes', () => {
  it('keeps multiple-choice questions within the 10 options Laya calibrates', async () => {
    const { CLASSIFIER_GROUPS, candidateKeys } = await import('../../src/fill/match/classify');
    expect(Object.keys(CLASSIFIER_GROUPS).length).toBeLessThanOrEqual(10);
    // Key ranking asks one yes/no per candidate, capped so a request stays fast on CPU.
    const all = Object.keys(CLASSIFIER_GROUPS) as (keyof typeof CLASSIFIER_GROUPS)[];
    expect(candidateKeys(field({ kind: 'text' }), all).length).toBeLessThanOrEqual(20);
    expect(candidateKeys(field({ kind: 'checkbox' }), ['contact', 'eeo'])).toEqual([]);
  });
});
