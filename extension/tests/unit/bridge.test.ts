import { describe, expect, it } from 'vitest';
import { agentsAtWork, askQuestion, BridgeClient, bridgeFields, canAsk, findJobTab, obeysReload, screenMoment, tabsToClose } from '../../src/bridge/client';
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
    // Where the value came from goes too (the Office's "who filled what", #35); the value never does.
    expect(sent.fields).toEqual([{ id: 'f1', frameId: 0, label: 'Phone', kind: 'text', status: 'filled', required: true, options: [], key: 'phone', source: 'rule' }]);
    expect(bridgeFields([{ ...field, status: 'needs', source: 'none' }])[0]).not.toHaveProperty('source');
    expect(JSON.stringify(sent)).not.toContain('555 0100');
  });

  it('only the fleet build reloads for the Fixer (#32)', () => {
    expect(obeysReload('EzAutoApply (fleet)')).toBe(true);
    expect(obeysReload('EzAutoApply')).toBe(false);
  });

  it('sends one screenshot per page and one when the Run stops (#37)', () => {
    const run = newRun(3, 'https://x.test/apply', 0, 'j1');
    const moments = new Set([
      screenMoment(run),
      screenMoment({ ...run }), // the same page reported again
      screenMoment({ ...run, page: 2 }),
      screenMoment({ ...run, page: 2, status: 'stopped', stop: { reason: 'submitReady' } }),
    ]);
    expect(moments.size).toBe(3);
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

describe("the fleet's tabs (#102)", () => {
  it('an ended applier’s groups close, all but the tabs still needed, and nothing else', () => {
    const tabs = [
      { id: 1, groupId: 7 }, // the applier's leftover new tab
      { id: 2, groupId: 7 }, // a job waiting on the owner
      { id: 3, groupId: 8 }, // another applier's group
      { id: 4, groupId: -1 }, // the owner's own tab
      { groupId: 7 },
    ];
    expect(tabsToClose(tabs, new Set([7]), new Set([2]))).toEqual([1]);
    expect(tabsToClose(tabs, new Set(), new Set())).toEqual([]);
  });

  it('a new group counts as an agent’s only while an applier runs', () => {
    expect(agentsAtWork({ appliers: [{ worker: 'w1', status: 'ended' }, { worker: 'w2', status: 'running' }] })).toBe(true);
    expect(agentsAtWork({ appliers: [{ worker: 'w1', status: 'ended' }] })).toBe(false);
    expect(agentsAtWork({ appliers: [{ worker: 'fixer', status: 'running' }, { worker: 'answerer', status: 'running' }] })).toBe(false);
    expect(agentsAtWork(null)).toBe(false);
  });
});

describe('"Ask an agent" (#103)', () => {
  const field = (over: Partial<FieldReport> = {}): FieldReport =>
    ({
      id: 'f9',
      frameId: 2,
      label: 'Why do you want to work here? *',
      kind: 'textarea',
      options: [],
      required: true,
      status: 'needs',
      source: 'none',
      confidence: 0,
      valueText: 'Jordan Rivera typed this',
      current: 'what the page holds',
      userValue: 'what the owner typed',
      note: 'The site had "Woodbridge, Virginia"',
      ...over,
    }) as FieldReport;

  it('sends the question and the page, never a value or a note that could quote one', () => {
    const q = askQuestion(5, field(), { url: 'https://jobs.example.test/apply/3?token=abc#top', title: 'Engineer at Example' });
    expect(q).toEqual({
      tabId: 5,
      frameId: 2,
      fieldId: 'f9',
      label: 'Why do you want to work here? *',
      kind: 'textarea',
      options: [],
      required: true,
      url: 'https://jobs.example.test/apply/3',
      title: 'Engineer at Example',
    });
    expect(JSON.stringify(q)).not.toMatch(/Jordan|typed|holds|Virginia|token/);
    expect(askQuestion(5, field({ note: 'The site says: Enter at least 100 characters' }), { url: 'https://x.test/a' }).note).toBe('The site says: Enter at least 100 characters');
  });

  it('is offered on unanswered and guessed fields, never on a password or a file', () => {
    expect(canAsk(field())).toBe(true);
    expect(canAsk(field({ status: 'review' }))).toBe(true);
    expect(canAsk(field({ status: 'filled' }))).toBe(false);
    expect(canAsk(field({ kind: 'password' }))).toBe(false);
    expect(canAsk(field({ kind: 'file' }))).toBe(false);
  });
});
