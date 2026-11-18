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

Every call except `GET /health` needs `Authorization: Bearer <token>`. Calls from a web page (an `Origin` that isn't `chrome-extension://`) and calls to any host name but `127.0.0.1` / `localhost` are refused.

## Calls

| Call | What |
|---|---|
| `GET /health` | `{ ok, stopped }` |
| `GET /queue` · `POST /queue {jobs}` | every job · add jobs (by `id`, once each) |
| `GET /queue/next?worker=w1` | claim the next job (Tier A first, then oldest), leased 20 min; 204 when none, 423 after Stop all |
| `POST /queue/:id/status {status, note?, page?, tabUrl?}` | `running`/`claimed` renew the lease, anything else ends it |
| `POST /run {jobId, urlPrefix?}` | ask the extension to Run that job's tab |
| `GET /tabs/:jobId/status` | the latest `RunState` the extension reported |
| `POST /answers {jobId, fieldId, frameId?, answer, save?}` | ask the extension to fill a field. With `save: {scope, sourceRefs?, createdBy?}` (scope `global` or a hostname) the answer is also saved as an agent's, which fills for review until the owner approves it in Answers (#21). It never replaces an answer the owner wrote. |
| `POST /incidents {…}` | write an incident to `incidents/<date>/<id>.json` |
| `GET /ready` | jobs waiting for your Submit |
| `POST /stop-all` · `POST /resume` | the kill switch: every lease released, waiting commands dropped, the extension told to stop every Run, no new claims or Runs until resumed |
| `GET /ext/commands?wait=25` | for the extension: long-poll for commands (each handed out once) |
| `POST /ext/runs {jobId, run}` | for the extension: a Run's state; a stopped Run sets the job's status (`submitReady` → `ready`, a blocker → `needsYou`, `noProgress`… → `stuck`) |

The account password never crosses the bridge.
