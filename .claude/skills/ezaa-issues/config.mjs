// One place for everything the issue and sprint scripts need to know about this
// repo and its board. Ported 2026-11-17 from Ride The Bus's rtb-issues (itself
// ported from PTrainer's ptrainr-issues), with PTrainr's later Inbox changes.
//
// The Project number is the "EzAutoApply" board on the owner's account
// (https://github.com/users/TC6IDM/projects/<PROJECT>). If the board is ever
// re-made, change PROJECT and nothing else.

export const OWNER = 'TC6IDM';
export const REPO_NAME = 'EzAutoApply';
export const REPO = `${OWNER}/${REPO_NAME}`;
export const PROJECT = '5';
export const PROJECT_URL = `https://github.com/users/${OWNER}/projects/${PROJECT}`;

// Milestones, in the order a sprint works them. The key is what an issues file
// says after `milestone:`; the first value is the title on GitHub.
export const MILESTONES = {
  Now: ['Now: fill accuracy', 'Extension fixes and fill-accuracy work while applications are still done by hand.'],
  Run: ['Run to Submit', 'One press fills, presses Next, fills again and stops at Submit (docs/agent-fleet-plan.md §6).'],
  Fleet: ['Agent fleet', 'The bridge, the job queue, the Haiku appliers, the Opus fixer and the Fleet Office (plan §3-§9, §18).'],
  Outreach: ['Outreach', 'The recruiter page: people at companies that fit, with messages for the owner to send (plan §10).'],
  Showcase: ['Showcase', 'The public face: the TC6IDM.github.io project page, the Chrome Web Store listing, write-ups.'],
  Later: ['Later', 'Ideas and research parked until the owner says otherwise.'],
};
export const MILESTONE_ORDER = Object.values(MILESTONES).map(m => m[0]);

// The parts of the repo, standing in for PTrainr's platforms. The board's
// "Platform" field mirrors these (sync-board.mjs).
export const PLATFORM = {
  'platform:extension': 'Extension',
  'platform:classifier': 'Classifier',
  'platform:bridge': 'Bridge',
  'platform:agents': 'Agents',
  'platform:tooling': 'Tooling',
  'platform:site': 'Site',
};

export const LABELS = {
  'type:epic': ['3e4b9e', 'A group: one parent with sub-issues (usually one per part: extension, bridge, agents, ...)'],
  'type:feature': ['a2eeef', 'Something new'],
  'type:bug': ['d73a4a', 'Something is broken or fills wrong'],
  'type:task': ['c5def5', 'Work that is neither a feature nor a bug (setup, checks, accounts)'],
  'type:research': ['d4c5f9', 'Find out and recommend; no product change yet'],
  'type:decision': ['fbca04', 'The owner has to decide before work can start'],
  'platform:extension': ['1d76db', 'extension/: the WXT extension (content script, background, side panel)'],
  'platform:classifier': ['5319e7', 'classifier/: the local Laya server and its client'],
  'platform:bridge': ['0e8a16', 'bridge/: the local server between the extension and the agents, and the Fleet Office page'],
  'platform:agents': ['f9a03f', 'The agent fleet: apply-runner, the fixer, outreach, and the ai-job-search side (/queue, portals)'],
  'platform:tooling': ['6e7781', 'scripts/, .claude/ skills, agents and hooks, CI'],
  'platform:site': ['bfd4f2', 'The TC6IDM.github.io project page'],
  'P0': ['b60205', 'Fills something wrong, or broken now'],
  'P1': ['d93f0b', 'Next up'],
  'P2': ['fbca04', 'Soon'],
  'P3': ['0e8a16', 'Nice to have / later'],
  'size:S': ['bfdadc', 'About one working session'],
  'size:M': ['7fb7be', 'Two or three sessions'],
  'size:L': ['3f8f9a', 'A week or more of sessions'],
  'who:you': ['f9d0c4', 'Waits on the owner (a decision, an account, money, a real application)'],
  'who:claude': ['c2e0c6', 'Claude can do it without help'],
  'who:together': ['fef2c0', 'Needs both: a live job site, the owner\'s accounts, a real application'],
  'status:blocked': ['444444', 'Waiting on another issue or an account'],
  'status:needs-decision': ['f7c6c7', 'Cannot start until the owner decides'],
  'status:needs-site': ['e4b7f0', 'Needs a live application page to reproduce or check (saved markup first if possible)'],
  'inbox': ['ffffff', 'The pinned Inbox issue: raw ideas waiting to be turned into issues'],
  'area:scan': ['ededed', 'Finding fields and labels: scan.ts, labels.ts, shadow roots, frames'],
  'area:rules': ['ededed', 'Matching: fieldKeys.ts, rules, option matching, geo, EEO'],
  'area:fillers': ['ededed', 'Writing values: comboboxes, prompts, dates, files, React value trackers'],
  'area:run': ['ededed', 'Advance and Run to Submit: Next/Submit detection, blockers, accounts'],
  'area:answers': ['ededed', 'The answer bank, saved answers, approvals, provenance'],
  'area:panel': ['ededed', 'The side panel and the floating button'],
  'area:parse': ['ededed', 'Resume and LinkedIn import, the profile'],
  'area:documents': ['ededed', 'Resumes, cover letters, file names, uploads'],
  'area:classifier': ['ededed', 'Laya / Jev calls, thresholds, ranking keys'],
  'area:workday': ['ededed', 'Workday-specific behaviour'],
  'area:ats': ['ededed', 'Other ATS-specific behaviour: Greenhouse, Lever, Ashby, iCIMS, LinkedIn Easy Apply, ...'],
  'area:privacy': ['ededed', 'Secrets, PII, redaction, what leaves the machine'],
  'area:queue': ['ededed', 'Job search, ranking, the queue, the tracker (ai-job-search side)'],
  'area:fixer': ['ededed', 'Incidents, the fixer agent, the replay corpus'],
  'area:field-report': ['ededed', 'The owner pressed "Report a field": a field not found or answered wrong on a real page (the Reporter, #116)'],
  'area:office': ['ededed', 'The Fleet Office: the 3D view, agent windows, the inbox'],
  'area:outreach': ['ededed', 'Recruiter research and the recruiter page'],
  'area:a11y': ['ededed', 'Keyboard, screen readers, reduced motion'],
  'area:store': ['ededed', 'Chrome Web Store listing, permissions, privacy policy'],
  'area:devx': ['ededed', 'Developer tools, tests, CI, Claude skills'],
  'area:docs': ['ededed', 'CLAUDE.md, README, plans'],
  'area:showcase': ['ededed', 'The project page, demo and write-ups'],
  'repo:ai-job-search': ['c9e3f6', 'The change lands in TC6IDM/ai-job-search (the sprint builds it in its linked worktree)'],
};

// Other repos one sprint works with this one (#57). An issue stays on this board;
// its label says where the code goes. The sprint never touches `path` itself (the
// owner's own checkout, often mid-edit): it adds a worktree beside it on the
// sprint's branch, made from `remote`/`base`, and opens that repo's own PR.
export const LINKED_REPOS = {
  'ai-job-search': { path: '../ai-job-search', repo: `${OWNER}/ai-job-search`, remote: 'origin', base: 'main', label: 'repo:ai-job-search' },
};

/** The linked repo an issue's labels send it to, or null for this repo. */
export function linkedRepoOf(labels) {
  const names = labels.map(l => (typeof l === 'string' ? l : l.name));
  return Object.keys(LINKED_REPOS).find(k => names.includes(LINKED_REPOS[k].label)) ?? null;
}

// How bootstrap.mjs makes and checks the board (#47). The board is a copy of a
// template board (copyProjectV2 brings the views' grouping and sort, which the
// API can't set), then its options and filters are tuned to this repo.
export const BOARD = {
  title: REPO_NAME,
  template: { owner: OWNER, number: 2 },           // PTrainr's board
  status: ['Todo', 'In Progress', 'In Review', 'Done'],
  options: {
    Priority: ['P0', 'P1', 'P2', 'P3'],
    Size: ['S', 'M', 'L'],
    Who: Object.keys(LABELS).filter(l => l.startsWith('who:')).map(l => l.slice(4)),
    Platform: [...Object.values(PLATFORM), 'Several', 'None'],
    Kind: ['Epic', 'Feature', 'Bug', 'Task', 'Research', 'Decision'],
  },
  views: {
    Now: `milestone:"${MILESTONE_ORDER[0]}" -kind:Epic`,
    'Needs you': 'who:you,together -kind:Epic is:open',
  },
  dropViews: ['Pre-business'],                        // PTrainr-only
};

// Board fields filled from labels by sync-board.mjs.
export function boardFields(labels) {
  const platforms = labels.filter(l => PLATFORM[l]);
  const kind = labels.includes('type:epic') ? 'Epic' : labels.find(l => l.startsWith('type:'))?.slice(5);
  return {
    Priority: labels.find(l => /^P[0-3]$/.test(l)),
    Size: labels.find(l => l.startsWith('size:'))?.slice(5),
    Who: labels.find(l => l.startsWith('who:'))?.slice(4),
    Platform: platforms.length === 1 ? PLATFORM[platforms[0]] : platforms.length ? 'Several' : 'None',
    Kind: kind && kind[0].toUpperCase() + kind.slice(1),
  };
}
