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
| `EZAA_HOME` | `~/.ezautoapply` (the token in `bridge-token`, incidents in `incidents/<date>/`) |
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

Scout, Fixer and Outreach show as not running until their agents exist.

The token rides in the link's `#fragment`, which the browser never sends. The page keeps it in session storage and drops it from the address bar. The page itself carries no data. Its stream, `GET /office/events?token=…` (server-sent events: a `snapshot` whenever something changes, built by `src/office.ts`), takes the token in the query because EventSource can't send headers. The page's buttons call the API with the token as usual.

Without WebGL (or offline, since three.js comes from a CDN) the office falls back to the agent list and windows. With reduced motion, nothing animates.

## Calls

| Call | What |
|---|---|
| `GET /health` | `{ ok, stopped }` |
| `GET /office` · `GET /office/events?token=` | the Fleet Office page · its live stream (above) |
| `GET /queue` · `POST /queue {jobs}` | every job · add jobs (by `id`, once each) |
| `GET /queue/next?worker=w1` | claim the next job (Tier A first, then oldest), leased 20 min; 204 when none, 423 after Stop all, 429 `{ready, maxReadyOpen}` while that many jobs wait for your Submit (an applier waits and asks again; it leaves each ready job's tab open) |
| `POST /queue/:id/status {status, note?, page?, tabUrl?}` | `running`/`claimed` renew the lease, anything else ends it |
| `POST /run {jobId, urlPrefix?}` | ask the extension to Run that job's tab |
| `GET /tabs/:jobId/status` | the latest `RunState` the extension reported |
| `POST /answers {jobId, fieldId, frameId?, answer, save?}` | ask the extension to fill a field. With `save: {scope, sourceRefs?, createdBy?}` (scope `global` or a hostname) the answer is also saved as an agent's, which fills for review until the owner approves it in Answers (#21). It never replaces an answer the owner wrote. |
| `POST /incidents {…}` | write an incident to `incidents/<date>/<id>.json` |
| `GET /ready` | jobs waiting for your Submit, each with `agentAnswered` (the labels of the fields an agent answered, to check first) |
| `POST /ready/:id/focus` | bring that job's tab and window to the front ("go to tab") |
| `POST /queue/:id/status {status: "submitted"}` | mark a job submitted by hand; the extension also does it when the tab shows the site's confirmation page after your Submit |
| `POST /stop-all` · `POST /resume` | the kill switch: every lease released, waiting commands dropped, the extension told to stop every Run, no new claims or Runs until resumed |
| `GET /ext/commands?wait=25` | for the extension: long-poll for commands (each handed out once) |
| `POST /ext/runs {jobId, run}` | for the extension: a Run's state; a stopped Run sets the job's status (`submitReady` → `ready`, a blocker → `needsYou`, `noProgress`… → `stuck`) |

The account password never crosses the bridge.
