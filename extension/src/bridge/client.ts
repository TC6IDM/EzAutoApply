import type { FieldReport } from '../fill/types';
import type { RunState } from '../run/types';

/**
 * The extension's side of the local bridge (#17, bridge/README.md). Only used while
 * `settings.bridgeEnabled` is on and a token is set; with the bridge off or unreachable,
 * nothing changes (the same rule as the classifier).
 */

export const BRIDGE_DEFAULT_URL = 'http://127.0.0.1:8100';

/** What the bridge asks the extension to do (bridge/src/server.ts › Command). */
export type BridgeCommand =
  | { id: string; type: 'run'; jobId: string; urlPrefix?: string }
  | { id: string; type: 'answer'; jobId: string; fieldId: string; frameId?: number; answer: unknown; save?: unknown }
  | { id: string; type: 'stopAll' }
  /** The ready list's "go to tab" (#29): bring the job's tab and window to the front. */
  | { id: string; type: 'focus'; jobId: string };

/** A field as the bridge sees it: what an agent needs to answer it, never its value. */
export interface BridgeField {
  id: string;
  frameId: number;
  label: string;
  kind: string;
  status: string;
  required: boolean;
  options: string[];
  key?: string;
  note?: string;
  /** Where the value came from (rule, answerBank, classifier…): the Office's "who filled what" (#35). */
  source?: string;
}

export function bridgeFields(fields: FieldReport[]): BridgeField[] {
  return fields.map((f) => ({
    id: f.id,
    frameId: f.frameId,
    label: f.label,
    kind: f.kind,
    status: f.status,
    required: f.required,
    options: f.options,
    ...(f.key && { key: f.key }),
    ...(f.note && { note: f.note }),
    ...(f.source !== 'none' && { source: f.source }),
  }));
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class BridgeClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetcher: Fetch;
  constructor(base: string, token: string, fetcher: Fetch = (u, i) => fetch(u, i)) {
    this.base = (base || BRIDGE_DEFAULT_URL).replace(/\/+$/, '');
    this.token = token;
    this.fetcher = fetcher;
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetcher(this.base + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`Bridge ${method} ${path}: ${res.status}`);
    return (res.status === 204 ? null : await res.json()) as T;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.base}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Waits up to `waitS` seconds for commands. */
  commands(waitS: number, signal?: AbortSignal): Promise<BridgeCommand[]> {
    return this.call<BridgeCommand[]>('GET', `/ext/commands?wait=${waitS}`, undefined, signal);
  }

  reportRun(jobId: string, run: RunState, fields: BridgeField[]): Promise<unknown> {
    return this.call('POST', '/ext/runs', { jobId, run, fields });
  }

  /** For #18: an incident (already redacted by the caller). */
  postIncident(incident: Record<string, unknown>): Promise<{ id: string }> {
    return this.call('POST', '/incidents', incident);
  }
}

const bare = (url: string) => url.replace(/[?#].*$/, '').replace(/\/+$/, '');

/**
 * The tab a Run command means: one whose address starts with the job's (ignoring query and
 * hash, which trackers add), the active one first.
 */
export function findJobTab<T extends { id?: number; url?: string; active?: boolean }>(tabs: T[], urlPrefix: string): T | null {
  const want = bare(urlPrefix);
  if (!want) return null;
  const hits = tabs.filter((t) => t.id !== undefined && t.url && bare(t.url).startsWith(want));
  return hits.find((t) => t.active) ?? hits[0] ?? null;
}
