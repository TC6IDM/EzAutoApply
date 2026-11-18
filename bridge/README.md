# EzAutoApply bridge

A small local server between the EzAutoApply extension and the agent fleet (docs/agent-fleet-plan.md §4.3). It listens on `127.0.0.1:8100` only. It holds the job queue, takes Run and answer commands from agents for the extension, and writes incidents to disk outside git. It is optional: the extension works without it.

```powershell
cd bridge
npm start      # node src/main.ts; prints where the token is
npm test       # node:test
npm run compile
```

No packages of its own: Node 24 runs the TypeScript directly, and `npm run compile` uses the extension's TypeScript (run `npm install` in `extension/` once).

| Setting (environment) | Default |
|---|---|
| `EZAA_HOME` | `~/.ezautoapply` (the token in `bridge-token`, incidents in `incidents/<date>/`, the fleet switches in `fleet-settings.json`) |
| `EZAA_QUEUE_FILE` | `../ai-job-search/apply_queue/queue.jsonl` beside this repo |
| `EZAA_BRIDGE_PORT` | `8100` |
| `EZAA_MAX_READY` | `6`: claims pause while this many jobs wait for your Submit (#29) |

Every call except `GET /health` and the Office page needs `Authorization: Bearer <token>`. Calls from a web page (an `Origin` that isn't `chrome-extension://` or the bridge's own address) and calls to any host name but `127.0.0.1` / `localhost` are refused.

## The Fleet Office

`npm start` prints a link, `http://127.0.0.1:8100/office#token=…`. Open it to watch the fleet live (#35). The page is `office/index.html`, built from the design in `docs/fleet-office-prototype.html`. It shows the following:

- A 3D office with a desk per applier: the first four workers to ask for a job, in that order.
- Each applier's job, its pages, the fields on the current page (labels and counts, never values) and who filled them.
- The queue in claim order.
- Your inbox: jobs ready to submit (with "Go to its tab" and "I submitted it"), jobs that need you or are stuck (go to the tab, queue it again, or skip it), and the fields agents answered.
- Today's submissions and incidents.
- Stop all and Resume.
- **Switches** (#55): every fleet switch, grouped, each saying what turning it off does. Toggling one saves it through `PUT /settings`. A desk whose part is off shows "Switched off", and the ticker says who switched what.

- **The Fixer's desk** (#32): its open tickets (incidents grouped by site, kind and question, with how many times each happened) and what it resolved lately. Each resolution also goes on the ticker. The bridge starts the Fixer itself (#69): a little after an incident opens a ticket (20 s, so a burst is one start), one headless Opus runs `/ezaa-fixer` in its own worktree `../EzAutoApply-fix` (made from `origin/main` the first time), allowed only `FIXER_TOOLS`: edits under `extension/` there, the checks, `.claude/skills/ezaa-fixer/bridge.mjs` for the bridge, and `gh issue`; never a commit or push. Tickets that came in while it worked start it again when it ends. It obeys the Fixer switch and Stop all. Its desk shows its live steps; it also counts as at work while it resolved something in the last hour.

- **The recruiter page** (#41, #58): the inbox's Recruiters tab. It lists the people ai-job-search's `/prospects` found at companies that fit, with why each one and the messages it drafted: a connection note (at most 200 characters), a follow-up, and an email only when the address is publicly listed. Each message has a copy button, and you mark what you did (Sent on LinkedIn, Sent by email, They replied, Skip), so nobody is written to twice. **Nothing here sends anything.** The people come from `~/.ezautoapply/outreach/prospects.jsonl` (`EZAA_OUTREACH_DIR`), which `/prospects` writes. It holds real names, so it stays outside both repos and is never committed.

- **Sprint** (#50): while an `/ezaa-sprint` runs, a Sprint button in the top bar shows its verdict (GO, SMALL, WRAP, STOP). Its window shows the issue it is on, what it finished and passed over, its pull requests, and the 5-hour and weekly usage. The bridge only reads the sprint's own files (`<temp>/ezaa-sprint`). The one thing the window can do is **Wind down**, which runs `sprint.mjs wind-down`: the sprint finishes the issue it is on, pushes and checkpoints.

The Scout shows as not running until its agent exists.

Each applier's window and each ready job also shows the latest screenshot of the job's tab (#37). A screenshot shows your answers. So the bridge keeps it in memory only: the latest per job, for at most 16 jobs. It never writes one to disk or puts one in an incident, and it serves them only with the token.

The token rides in the link's `#fragment`, which the browser never sends. The page keeps it in session storage and drops it from the address bar. The page itself carries no data. Its stream, `GET /office/events?token=…` (server-sent events: a `snapshot` whenever something changes, built by `src/office.ts`), takes the token in the query because EventSource can't send headers. The page's buttons call the API with the token as usual.

Without WebGL (or offline, since three.js comes from a CDN) the office falls back to the agent list and windows. With reduced motion, nothing animates.

## Calls

| Call | What |
|---|---|
| `GET /health` | `{ ok, stopped }` |
| `GET /office` · `GET /office/events?token=` | the Fleet Office page · its live stream (above) |
| `GET /office/screens/:jobId?token=` | the latest screenshot of that job's tab (#37) |
| `GET /queue` · `POST /queue {jobs}` | every job · add jobs (by `id`, once each) |
| `GET /queue/next?worker=w1` | claim the next job (Tier A first, then oldest), leased 20 min; 204 when none, 423 after Stop all, 409 `{unfinished}` while that worker holds a job that isn't ready yet (#67: claimed, running, or `needsYou` / `stuck`, which keep their worker: one application at a time), 429 `{ready, maxReadyOpen}` while that many jobs wait for your Submit (an applier waits and asks again; it leaves each ready job's tab open) |
| `POST /queue/:id/status {status, note?, page?, tabUrl?}` | `running`/`claimed` renew the lease, anything else ends it |
| `POST /run {jobId, urlPrefix?}` | ask the extension to Run that job's tab |
| `GET /tabs/:jobId/status` | the latest `RunState` the extension reported |
| `POST /answers {jobId, fieldId, frameId?, answer, save?}` | ask the extension to fill a field. With `save: {scope, sourceRefs?, createdBy?}` (scope `global` or a hostname) the answer is also saved as an agent's, which fills for review until the owner approves it in Answers (#21). It never replaces an answer the owner wrote. |
| `POST /incidents {…}` | write an incident to `incidents/<date>/<id>.json` |
| `GET /tickets[?open=1]` · `GET /tickets/:key` | for the Fixer (#32, `.claude/skills/ezaa-fixer`): incidents grouped into tickets by `(ats, kind, normalized label)`, newest first; one ticket with `details`, its incident files |
| `POST /tickets/:key/resolution {outcome, note?}` | `outcome`: `fixed`, `answered`, `cantFix` or `needsYou`. Kept in `incidents/tickets.json`. An incident filed after it opens the ticket again (the fix didn't hold). |
| `GET /outreach` · `POST /outreach/:id/status {status, channel?}` | the recruiter page's people (#41) · mark one `sent` (with `channel` `linkedin` or `email`), `replied`, `skip` or back to `found`. The same fields `tools/prospects.py mark` writes. |
| `GET /sprint` · `POST /sprint/wind-down` | a running `/ezaa-sprint` (#50), or `null` · ask it to wind down (404 when none runs) |
| `POST /fleet/reload` | tell the extension to reload after the Fixer rebuilt the fleet build (`npm run build:fleet`). Only the fleet's copy obeys (`obeysReload`); running Runs resume after it. |
| `GET /ready` | jobs waiting for your Submit, each with `agentAnswered` (the labels of the fields an agent answered, to check first) |
| `POST /ready/:id/focus` | bring that job's tab and window to the front ("go to tab") |
| `POST /queue/:id/status {status: "submitted"}` | mark a job submitted by hand; the extension also does it when the tab shows the site's confirmation page after your Submit |
| `GET /settings` · `PUT /settings {group: {switch: bool}}` | the fleet switches (#54): `parts` (scout, appliers, answerer, fixer, outreach), `sources` (linkedin, simplify, recommendations, jobbank, indeed), `apply` (external, linkedinEasy, indeedApply, tailored), `site` (createAccounts, gmailCodes). They are kept in `fleet-settings.json`. A PUT changes only what it names and refuses unknown names. Defaults: Indeed, Indeed Apply and LinkedIn Easy Apply off, the rest on. The bridge enforces what it can: with appliers off, `/queue/next` answers 423; a job whose source or way of applying is off stays queued until it's turned back on. The other switches are for the agents to obey (#56). |
| `GET /fleet` · `POST /fleet/launch {appliers, model?, jobs?}` · `POST /fleet/pause` | the Office's **Start** (#36): the bridge starts `appliers` (1–4) headless Claude Code processes (`claude -p --chrome`, haiku by default) in ai-job-search, each following its `apply-runner` skill as `w1`…`w4` with only that skill's tools (`launcher.ts › APPLIER_TOOLS`); logs in `~/.ezautoapply/fleet/`. Every agent gets a 10-minute shell limit (`AGENT_ENV`, #74): at the default 2 minutes a long `hold` or `wait` went to the background and the headless agent quit. On an **empty queue** it starts the **Scout** instead (#62): one headless Sonnet running ai-job-search's `/scout` (scrape, rank, queue, with only `SCOUT_TOOLS`), and the appliers wait, starting with the first queued job (or not at all if the Scout queues nothing). While appliers work, a claim that finds the queue empty starts the Scout again to refill it (#72), but not within 15 minutes of a Scout that queued nothing. Start first puts back in the queue any job held by an applier that isn't running any more (#77), so a new applier takes it. It refuses while stopped or with appliers switched off (423), with no Claude Code found (503, set `EZAA_CLAUDE`), or with an empty queue and the Scout switched off (409). **Pause**: no new claims (423), so each applier finishes its job and stops. Stop all also ends every applier it started. |
| `POST /stop-all` · `POST /resume` | the kill switch: every lease released, waiting commands dropped, the extension told to stop every Run, no new claims or Runs until resumed |
| `GET /ext/commands?wait=25` | for the extension: long-poll for commands (each handed out once) |
| `POST /ext/runs {jobId, run}` | for the extension: a Run's state; a stopped Run sets the job's status (`submitReady` → `ready`, or `running` "the applier is checking every field" while an applier holds the job, until its `ready` (#67); a blocker → `needsYou`, `noProgress`… → `stuck`) |
| `POST /ext/screens {jobId, image}` | for the extension: a JPEG of the job's tab (a data URL), once per page and once when the Run stops, taken only while the tab is showing in its window |

The account password never crosses the bridge.
