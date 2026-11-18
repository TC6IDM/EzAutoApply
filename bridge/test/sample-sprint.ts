// A made-up sprint state, in the shape sprint.mjs writes.
export const LINES = { smallAt: 80, newAt: 94, stopAt: 96 };
export const sampleState = (over: Record<string, unknown> = {}) => ({
  startedAt: '2026-11-18T00:39:00Z',
  branch: 'sprint/2026-11-18-0039',
  ...LINES,
  keepGoing: true,
  done: [{ n: 32, title: 'Agents: the live incident loop', cost: 9, pr: 51 }, { n: 41, title: 'Bridge: the recruiter page', cost: 5, pr: 51 }],
  skipped: [{ n: 28, why: 'another repo' }, { n: 41, why: 'not built yet' }],
  current: { n: 50, title: 'Bridge: show a running sprint' },
  readings: [{ at: '2026-11-18T11:58:00Z' }],
  pr: 51,
  linked: { 'ai-job-search': { repo: 'TC6IDM/ai-job-search', pr: 2 } },
  ...over,
});
