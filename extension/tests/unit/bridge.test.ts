import { describe, expect, it } from 'vitest';
import { BridgeClient, bridgeFields, findJobTab } from '../../src/bridge/client';
import type { FieldReport } from '../../src/fill/types';
import { newRun } from '../../src/run/loop';

/** A fetch that records each call and answers from `reply`. */
function fakeFetch(reply: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = reply(url, init);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn, calls };
}

describe('the local bridge client (#17)', () => {
  it('long-polls for commands with the token, and reports a Run with its fields but no values', async () => {
    const f = fakeFetch((url) => ({ body: url.includes('/ext/commands') ? [{ id: 'c1', type: 'run', jobId: 'j1', urlPrefix: 'https://x.test/apply' }] : { ok: true } }));
    const client = new BridgeClient('http://127.0.0.1:8100/', 'tok', f.fn);
    expect(await client.commands(25)).toEqual([{ id: 'c1', type: 'run', jobId: 'j1', urlPrefix: 'https://x.test/apply' }]);
    expect(f.calls[0].url).toBe('http://127.0.0.1:8100/ext/commands?wait=25');
    expect((f.calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tok');

    const field = { id: 'f1', frameId: 0, label: 'Phone', kind: 'text', options: [], required: true, status: 'filled', source: 'rule', confidence: 1, valueText: '555 0100', key: 'phone' } as FieldReport;
    await client.reportRun('j1', newRun(3, 'https://x.test/apply', 0, 'j1'), bridgeFields([field]));
    const sent = JSON.parse(String(f.calls[1].init?.body));
    expect(sent.fields).toEqual([{ id: 'f1', frameId: 0, label: 'Phone', kind: 'text', status: 'filled', required: true, options: [], key: 'phone' }]);
    expect(JSON.stringify(sent)).not.toContain('555 0100');
  });

  it('says the bridge is down instead of throwing, and errors on a refused call', async () => {
    const down = new BridgeClient('', 'tok', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await down.health()).toBe(false);
    const refused = new BridgeClient('', 'wrong', fakeFetch(() => ({ status: 401, body: { error: 'Missing or wrong token' } })).fn);
    await expect(refused.commands(0)).rejects.toThrow('401');
  });

  it('finds the job\'s tab by address, ignoring trackers, the active one first', () => {
    const tabs = [
      { id: 1, url: 'https://boards.greenhouse.io/acme/jobs/4567?gh_src=linkedin', active: false },
      { id: 2, url: 'https://boards.greenhouse.io/acme/jobs/4567#app', active: true },
      { id: 3, url: 'https://boards.greenhouse.io/acme/jobs/9999', active: false },
    ];
    expect(findJobTab(tabs, 'https://boards.greenhouse.io/acme/jobs/4567?utm_source=x')?.id).toBe(2);
    expect(findJobTab(tabs, 'https://jobs.lever.co/acme/1')).toBeNull();
    expect(findJobTab(tabs, '')).toBeNull();
  });
});
