import type { ClassifierSettings } from '../core/types';

/**
 * Client for the `/v1/systemone` typed-decision API shared by Laya
 * (`laya-serve`, local) and Jev (TypeSafe, hosted). Neither model generates
 * text: each question is a `choice` among labels or a `noul` yes/no check,
 * answered with calibrated probabilities.
 */

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** label → description, or a plain list of labels. */
  criteria: Record<string, string> | string[];
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
}

export type Question = ChoiceQuestion | NoulQuestion;

export interface SystemOneRequest {
  state: unknown;
  questions: Record<string, Question>;
}

export interface SystemOneBatchRequest {
  states: unknown[];
  questions: Record<string, Question>;
}

export interface Answer {
  choice?: string;
  noul?: number;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  answer_confidence?: number;
}

export interface SystemOneResponse {
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export class ClassifierError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Laya caps a batch at 64 states. */
const MAX_BATCH = 64;

export class SystemOneClient {
  constructor(
    private readonly settings: ClassifierSettings,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private url(path: string): string {
    return this.settings.baseUrl.replace(/\/+$/, '') + path;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.settings.apiKey) h.authorization = `Bearer ${this.settings.apiKey}`;
    return h;
  }

  private body(extra: object): string {
    // `model` pins a Laya checkpoint; Jev ignores fields it doesn't know.
    const model = this.settings.provider === 'laya' && this.settings.model ? { model: this.settings.model } : {};
    return JSON.stringify({ ...extra, ...model });
  }

  private async post<T>(path: string, body: string, timeoutMs: number): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.url(path), { method: 'POST', headers: this.headers(), body, signal: ctrl.signal });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ClassifierError(`${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`, res.status);
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof ClassifierError) throw e;
      if ((e as Error).name === 'AbortError') throw new ClassifierError(`Classifier timed out after ${timeoutMs / 1000}s`);
      throw new ClassifierError(`Classifier unreachable at ${this.settings.baseUrl}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The first call can load a checkpoint from disk, so the timeout is generous. */
  predict(req: SystemOneRequest, timeoutMs = 90_000): Promise<SystemOneResponse> {
    return this.post('/v1/systemone', this.body(req), timeoutMs);
  }

  /** Many states, one question set. Falls back to sequential calls if the server has no batch route. */
  async predictBatch(req: SystemOneBatchRequest, timeoutMs = 90_000): Promise<SystemOneResponse[]> {
    const out: SystemOneResponse[] = [];
    for (let i = 0; i < req.states.length; i += MAX_BATCH) {
      const states = req.states.slice(i, i + MAX_BATCH);
      try {
        const res = await this.post<{ results: SystemOneResponse[] }>(
          '/v1/systemone/batch',
          this.body({ states, questions: req.questions }),
          timeoutMs,
        );
        out.push(...res.results);
      } catch (e) {
        if (!(e instanceof ClassifierError) || (e.status !== 404 && e.status !== 405)) throw e;
        for (const state of states) out.push(await this.predict({ state, questions: req.questions }, timeoutMs));
      }
    }
    return out;
  }

  /** `off` means the user turned the classifier off, as opposed to it being unreachable. */
  async health(timeoutMs = 4000): Promise<{ ok: boolean; off?: boolean; detail: string }> {
    if (this.settings.provider === 'none') return { ok: false, off: true, detail: 'Classifier disabled' };
    if (this.settings.provider === 'jev') {
      // Jev has no public health route; a tiny prediction proves the key works.
      try {
        await this.predict(
          { state: { body: 'ping' }, questions: { ok: { type: 'noul', instructions: 'Is this a test?' } } },
          timeoutMs * 3,
        );
        return { ok: true, detail: 'Jev reachable' };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.url('/health'), { headers: this.headers(), signal: ctrl.signal });
      return { ok: res.ok, detail: res.ok ? 'Laya is running' : `Laya answered ${res.status}` };
    } catch {
      return { ok: false, detail: `Laya is not running at ${this.settings.baseUrl}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Calibrated probability of the chosen label (Laya's `answer_confidence`, else the label's probability). */
export function choiceConfidence(a: Answer | undefined): number {
  if (!a?.choice) return 0;
  if (typeof a.answer_confidence === 'number') return a.answer_confidence;
  const p = a.probabilities?.[a.choice];
  if (typeof p === 'number') return p;
  return typeof a.confidence === 'number' ? a.confidence : 0;
}

/** P(true) for a noul answer, or null when the answer is malformed. */
export function noulProbability(a: Answer | undefined): number | null {
  if (!a) return null;
  if (typeof a.noul === 'number') return a.noul;
  if (typeof a.answer_confidence === 'number' && typeof a.choice === 'string') {
    return /^(true|yes)$/i.test(a.choice) ? a.answer_confidence : 1 - a.answer_confidence;
  }
  return null;
}
