# Agent Fleet Plan: EzAutoApply × ai-job-search

Status: **idea / design draft**, written 2026-11-17. Nothing here is built yet.
Scope: link the two repos, add a "fill and continue to Submit" mode to the extension, run Claude agents that find jobs and apply, learn from fields the extension couldn't fill, and (maybe) reach out to recruiters.

---

## 0. TL;DR

The idea is sound, and most of it is closer than it looks. ai-job-search already finds, dedupes and ranks jobs (`/scrape`, `/rank`, `seen_jobs.json`) and answers single form questions from everything it knows about you (`/answer`). EzAutoApply already fills forms and presses the page's own Next button (Advance). What's missing is the glue: a job queue, a "fill → Next → fill → … stop at Submit" loop, a way for agents to drive the extension, and a way to turn failures into fixes.

The big changes I'd make to the notes:

| # | Your note | Verdict | What I'd change |
|---|---|---|---|
| 1 | Link the two repos | ✅ Works | Keep them as **separate repos** linked by data contracts (a queue file, an answers export and a local "bridge" server). Don't merge them: ai-job-search is a fork of `MadsLorentzen/ai-job-search`, and merging would make upstream syncs painful. |
| 2 | 4 Haiku agents, one per source (LinkedIn / Indeed / Simplify / AI recs) | ⚠️ Change | Split by **stage**, not by site. Searching mostly needs no browser: the CLIs and `/scrape` already do it. Applying is the same job on every site once you land on the form. So: one search step → one **queue** → N identical **applier** agents that pull from it. Start with N = 1, then 2. |
| 3 | Haiku agents apply | ⚠️ Change | Haiku should **supervise the extension, not fill fields itself.** It opens the job, presses EzAutoApply's Run, and only steps in on what the extension reports as unfilled. That's roughly 20–40× fewer model calls than driving every field by screenshot, it's far more reliable, and every application exercises (and improves) the extension. |
| 4 | Sonnet fills fields we can't fill | ✅ Works, with a twist | `/answer` already does this. Sonnet's output should become a **saved answer** (data the extension replays), flagged "agent-written, needs your OK", not live generation inside the extension. That keeps the extension non-generative, which matches your existing rule. |
| 5 | Opus figures out how to solve the field for next time | ✅ Good idea, change the timing | Don't call Opus per field in real time. Capture an **incident** (redacted DOM, field info, what happened), then run a **nightly batch** where Opus clusters incidents, writes a failing test from the captured markup, fixes the rule/filler, and leaves an uncommitted diff for you to review. Most incidents will turn out to be missing *data* (an answer bank entry), not missing *code*. |
| 6 | Always consult all info about me | ✅ Works | Build one knowledge layer from both repos. Hard rule: "best of its abilities" means **never inventing facts.** Genuine gaps (Kubernetes, Go, people management…) get answered honestly, and legal and attestation questions always stop for you. |
| 7 | One press: fill → next → fill … stop at Submit, all in the extension | ✅ Best part of the plan | Build this **first**, before any agent. It's useful on its own, needs no AI, and the agents depend on it. Needs a ground-rule update and hardened Submit detection (see §6.4: today an "Apply" button counts as *start*, which on a one-page form is really *submit*). |
| 8 | Agents do applications as well | ⚠️ Decide | Agents should **also stop at Submit** and hand you a "ready to submit" queue, at least until the fill accuracy numbers are proven. Open question Q1. |
| 9 | Sonnet agent finds recruiters on LinkedIn and cold-DMs them | ❌ Not as written | Automated LinkedIn messaging breaks LinkedIn's User Agreement. Accounts get restricted fast, and your LinkedIn is the most valuable asset in this whole search. Free accounts also get only a handful of personalized invite notes a month. Instead: the agent **researches and drafts**, targets only companies you've applied to, and **you send**: on LinkedIn by hand, or by email from Gmail drafts. |
| 10 | Indeed | ⚠️ Lowest priority | Indeed has heavy bot protection, no public search API, and its own apply flow. Do it last or treat it as "you browse, extension runs". Many Indeed listings also link out to a company ATS that EzAutoApply already handles. |
| 11 | Simplify | ✅, but use the right part | The **SimplifyJobs New-Grad-Positions GitHub list** is a free, structured, frequently updated list of new-grad roles (US and Canada) that link straight to Greenhouse/Lever/Workday, which is exactly EzAutoApply's home turf. Add it as a portal CLI in ai-job-search. Don't run Simplify's own Copilot autofill extension alongside EzAutoApply; the two will fight over the same fields. |

Recommended build order: **Run-to-Submit in the extension → incident capture + bridge → knowledge sync → one applier agent → learning loop → more appliers and sources → recruiter drafts.** Details in §14.

---

## 1. What exists today

### EzAutoApply (this repo)
- MV3 extension. Fill pipeline: rules → answer bank → optional Laya/Jev classifier → derived yes/no → `needs`.
- Two-pass fill, a file pass 0 (resume upload, then `settle()` while the site parses it), repeat-section expansion, consent dialogs, Workday comboboxes and prompts.
- **Advance** (`src/fill/advance.ts`): finds the page's start / sign-in / next / submit button and presses it, but only when you press Advance. Kinds: `start | signIn | next | submit`.
- Per-tab, per-frame fill reports in `storage.session`; live `FillProgress` aggregated in the background.
- Answer bank with `global` or hostname scope; documents with original files; account password as a secret only released by `getSecret`.
- `isApplicationSite` already includes `linkedin.com/jobs` and `indeed.com`.
- `<all_urls>` host permission, so the background can already call a localhost service (it does for Laya on :8000).

### ai-job-search (`Desktop/ai-job-search`, fork of `MadsLorentzen/ai-job-search`)
- Full candidate profile in `CLAUDE.md` + `.claude/skills/job-application-assistant/01-candidate-profile.md`, including **genuine gaps (never claim)** and deal-breakers.
- `/scrape` (`.claude/skills/job-scraper`): runs portal CLIs in `.agents/skills/*` (incl. `linkedin-search`, a guest-endpoint LinkedIn search CLI, no login), dedupes into `job_scraper/seen_jobs.json` (`status: new | …`, `fit: high | medium | low`).
- `/rank`: triage-scores scraped jobs into a shortlist.
- `/apply`: deep fit evaluation + tailored LaTeX CV and cover letter + verification.
- `/answer`: answers **one** application question truthfully and in your voice, from profile, resume, STAR stories and earlier form answers (`documents/applications/<company>_<role>/form_answers.txt`).
- `/add-portal`: the pattern for adding new job sources.
- Gmail sync, Notion sync, outcome tracking. `job_search_tracker.csv` is referenced but doesn't currently exist at the repo root.

Most of the "AI" half exists already. The plan mostly connects pieces.

---

## 2. Design principles

1. **The extension is the hands; agents are supervisors.** Anything an agent learns to do on a form should end up as extension behaviour (a rule, a saved answer, a filler fix), so the next application, by agent *or by you*, gets it for free.
2. **LLMs write data, not runtime behaviour.** Sonnet's answers become saved answers; Opus's fixes become reviewed code with tests. The extension itself stays deterministic + classifier, and works with every model and agent off.
3. **Nothing irreversible without you.** Nothing presses Submit and nothing sends a message unless you say so. Commits need your approval (existing rule).
4. **Never invent facts.** Every answer must trace to a record. Gaps are answered honestly. Attestations stop for you.
5. **Optional all the way down.** Bridge off → extension works as today. Agents off → Run-to-Submit still works. Classifier off → rules and answers still work.
6. **Secrets stay in the extension.** Agents never see the account password; the extension fills it via `getSecret` as now.
7. **PII stays local and out of git.** Incidents, screenshots and DOM snapshots live outside both repos (or in gitignored folders), redacted.

---

## 3. Target architecture

```
                         ┌──────────────────────── ai-job-search ────────────────────────┐
  Sources                │  /scrape  (portal CLIs: linkedin-search, simplify-newgrad*,   │
  (no browser)           │           jobbank, WebSearch fallback)                         │
                         │  /rank    → fit scores                                         │
                         │  /queue*  → resolve apply URL, pick tier, write queue          │
                         └───────────────────────────┬────────────────────────────────────┘
                                                     │  apply_queue.jsonl (gitignored)
                                                     ▼
                         ┌──────────────── Bridge* (127.0.0.1:8100, optional) ─────────────┐
                         │  queue API · run commands · tab status · incidents · answers    │
                         │  tracker writes · "ready to submit" list                         │
                         └──────┬──────────────────────────┬──────────────────────┬────────┘
                                │ HTTP (agents)             │ HTTP (extension bg)   │ files
                                ▼                           ▼                       ▼
   ┌──────── Applier agents (Haiku 5.5) ─────┐   ┌──── EzAutoApply ────┐   ~/.ezautoapply/
   │ Claude in Chrome, one window each       │   │ Run-to-Submit loop* │     incidents/
   │ 1 open job  2 press Run  3 watch status │──▶│ fill → next → …     │     replays/
   │ 4 on needs → ask Sonnet  5 stop at Submit│   │ stop at Submit      │
   └───────────────┬─────────────────────────┘   └─────────┬───────────┘
                   │ needs                                 │ incidents
                   ▼                                       ▼
   ┌──── Answerer (Sonnet 5.5, /answer) ─────┐   ┌──── Learner (Opus 5.5, nightly) ─────────┐
   │ answer from all records, never invent   │   │ cluster incidents → data or code fix     │
   │ → saved answer (agent-written, review)  │   │ → fixture + failing test → fix → diff    │
   └─────────────────────────────────────────┘   │ → you review; nothing auto-merged        │
                                                 └──────────────────────────────────────────┘
                              YOU: review "ready to submit" tabs → press Submit
                                   approve agent-written answers → approve learner diffs
   (* = new)
```

---

## 4. Linking the repos

### 4.1 Options

| Option | Pros | Cons |
|---|---|---|
| Merge into a monorepo | One place | Breaks clean upstream syncs of the ai-job-search fork; mixes Python/LaTeX/Bun with the WXT build |
| Git submodule | Pinned versions | Submodules are a constant footgun; no real benefit here |
| **Sibling repos + data contracts** (recommended) | Each repo stays itself; upstream merges stay easy; contracts are testable | Need a small config for "where's the other repo" |

### 4.2 How they connect

- **Path config.** A small `ezautoapply.config.json` in ai-job-search (gitignored) and an env var or config in EzAutoApply's tools pointing at each other's folders. Default: sibling folders on the Desktop.
- **Queue file:** `ai-job-search/apply_queue/queue.jsonl` (gitignored). Written by `/queue`, read and updated by the bridge. Schema in §11.1.
- **Answers export, both ways:**
  - ai-job-search → EzAutoApply: parse `documents/applications/*/form_answers.txt` and the profile into answer-bank entries and facts the extension's profile lacks (notice period, salary expectation, relocation, work authorization wording…). Import through the bridge (or a file the panel can import).
  - EzAutoApply → ai-job-search: export **approved** saved answers to `documents/applications/answer_bank.md`, so `/answer` stays consistent with what was submitted before.
- **Tracker.** The bridge appends every application outcome (`ready`, `submitted`, `abandoned`, …) to `ai-job-search/job_search_tracker.csv`, so `/scrape` and `/rank` exclude already-applied jobs (they already read this file).
- **Keep fork changes additive.** New things in ai-job-search (`/queue`, the Simplify portal, the bridge client) go in new files or skills (`/add-portal` style), not in edits to upstream files, so `check_upstream_updates.py` merges stay clean.

### 4.3 The bridge (new, optional)

A small local HTTP server, like the Laya server: `127.0.0.1:8100`, Node (fits the extension toolchain) or Python (fits ai-job-search). Recommend Node + TypeScript in a new top-level folder `bridge/` in EzAutoApply, so it can import the extension's types (`FieldDescriptor`, `FrameReport`) directly.

Why it's needed:
- The content script **can't** be driven safely from the page (a `window.postMessage` trigger would let any site start an autofill and read your data back).
- Agents in Claude in Chrome likely can't operate `chrome-extension://` pages (the side panel). To verify in the Phase 0 spike.
- Incidents and answers need to land on disk, outside the browser.

Endpoints (sketch):

```
GET  /health
GET  /queue/next?worker=w1            → claim the next queued job (lease, 20 min)
POST /queue/:id/status                {status, note, tabUrl}
POST /run                             {tabUrlPrefix | jobId}  → extension runs Run-to-Submit on that tab
GET  /tabs/:jobId/status              → RunState (see §6.3)
POST /answers                         {fieldRef, answer, source:"agent", save}  → extension applies + saves
POST /incidents                       (from extension) incident bundle → ~/.ezautoapply/incidents/…
GET  /ready                           → jobs waiting for your Submit
```

The extension background **polls or keeps a WebSocket** to the bridge only when a setting "Connect to local bridge" is on, exactly like the classifier toggle. Auth: a random token generated by the bridge on first run and pasted once into the extension's Settings; every request carries it.

---

## 5. Job sources

| Source | How to search | How to apply | Risk | Priority |
|---|---|---|---|---|
| **LinkedIn** | Existing `linkedin-search` CLI (public guest endpoints, no login). Low volume. | (a) **External apply** → resolve to the company ATS URL, apply there. (b) **Easy Apply** → modal on linkedin.com, logged in. | Searching: low (no account). Easy Apply automation: **account restriction risk**. | High (search), medium (Easy Apply) |
| **SimplifyJobs New-Grad list** (GitHub) | New portal CLI `simplify-newgrad-search`: fetch the README, parse the table (company, role, location, link, age), filter Canada/remote. | Links go straight to Greenhouse/Lever/Workday/Ashby. | Very low. Public repo. | **High.** Best fit for a May 2026 grad. |
| **simplify.jobs site** | Needs login; mostly duplicates the GitHub list. | Their Copilot autofill: **don't run it with EzAutoApply.** | Low | Skip |
| **AI recommendations** (`/scrape` + `/rank`) | Already exists | `/queue` writes ranked jobs into the queue | None | **High** |
| **Indeed** | No public API; heavy bot protection. WebSearch `site:indeed.com` fallback (already in `/scrape`). | Many listings link to a company ATS: resolve and apply there. Indeed Apply (smartapply.indeed.com): manual-assisted only. | High for automation | Low |
| **Job Bank Canada** (`jobbank-search` exists) | Already a CLI | Mostly external | Low | Medium (federal/public sector is a differentiator) |

### 5.1 `/queue` (new command in ai-job-search)
1. Take ranked jobs (`/rank` output) above a fit threshold that aren't in the tracker.
2. **Resolve the apply URL.** For LinkedIn listings, fetch the detail and pull the external apply link. If it's Easy Apply, mark `applyKind: "linkedin-easy"`. Normalize to the ATS posting URL (strip tracking params).
3. **Dedupe across sources** by canonical key: `ats-host + posting id` when known, else `normalize(company) + normalize(title) + city`.
4. **Pick a tier** (see §5.2).
5. Append to `queue.jsonl` with `status: "queued"`.

### 5.2 Tiers: quality vs volume
ai-job-search is built around *tailored* CVs per job; mass applying is the opposite. Make it explicit:

- **Tier A (hand-crafted):** high fit, target company. `/apply` makes a tailored CV + cover letter first; the applier uploads *those* documents (per-tab `DocSelection`). You review everything.
- **Tier B (standard):** good fit. Default resume, saved answers, agent-applied, stops at Submit.
- **Tier C (skip):** low fit, deal-breakers (QA-only, senior titles, French required). Never queued.

Daily caps: start at **≤ 15 applications/day**. The real bottleneck will be your review of "ready to submit" tabs, not agent speed.

---

## 6. Extension: Run to Submit (build this first)

### 6.1 Behaviour
One press of **Run** (side panel, floating button, or a bridge command) does:

```
loop (max 15 pages):
  autofill this page (all frames) and wait until FillProgress is null
  if any field is `needs` and required, or validation errors are showing → STOP(needsYou)
  if stopOnReview and any field is `review`                              → STOP(review)
  detect blockers (captcha, verification code, assessment, login wall)   → STOP(<blocker>)
  button = findAdvanceButton()  (run-mode rules, §6.4)
  if none                                                                 → STOP(noButton)
  if button.kind == submit (or "probably submit")                         → STOP(submitReady)  ← never pressed
  if button.kind == signIn and sign-in is not allowed                     → STOP(signIn)
  fingerprint = pageFingerprint()
  press button; wait for navigation or settle()
  if pageFingerprint() == fingerprint:                                    → read errors → STOP(noProgress)
```

### 6.2 Where the loop lives
In the **background**, as `runTab(tabId)`, not in a content script:
- The background already aggregates per-frame progress and reports, and owns `tabs.sendMessage`.
- Full page loads (Workday sign-in, some Taleo steps) **kill the content script**. The background survives, so it waits for the new page's content script to say `ready` and continues.
- MV3 service workers can be suspended. Keep `RunState` in `storage.session` (like fill reports) so a restarted worker resumes or cleanly reports `interrupted`.

### 6.3 Run state and stop reasons

```ts
type StopReason =
  | 'submitReady'      // the only way forward is Submit: done, waiting for you
  | 'needsYou'         // required fields unanswered (list attached)
  | 'review'           // uncertain values and stopOnReview is on
  | 'validationErrors' // pressed Next, page complained (messages mapped to fields)
  | 'noProgress'       // pressed Next, nothing changed
  | 'signIn' | 'createAccount' | 'verificationCode'
  | 'captcha' | 'assessment' | 'externalRedirect'
  | 'noButton' | 'maxPages' | 'interrupted' | 'cancelled';

interface RunState {
  tabId: number;
  jobId?: string;            // when started by an agent through the bridge
  page: number;              // 1-based step count
  status: 'running' | 'stopped';
  stop?: { reason: StopReason; detail?: string; fieldIds?: string[] };
  history: { page: number; url: string; filled: number; review: number; needs: number; pressed?: string }[];
}
```

The panel shows it as a small stepper ("Page 3 · filled 14 · 1 needs you"), and the floating button shows the stop reason.

### 6.4 Submit detection must be stricter in run mode
Today `advance.ts` treats `Apply / Apply now / Apply for this job` as **start**. On many one-page forms (Lever, Greenhouse custom themes, small company sites) the final button *is* "Apply" or "Send". A loop that presses "start" buttons could **submit an application**. Run-mode rules:

1. A `start` button that sits **inside or after a form with filled fields** counts as **submit**.
2. Add submit wording: `send`, `done`, `confirm`, `confirm and submit`, `i agree and submit`, `submit for review`, `complete`, `finish and submit`, `apply` (in a form).
3. **When in doubt, it's Submit.** An unknown "primary" button on a page whose fields are all filled → `STOP(submitReady)`. Being wrong this way costs you one click; being wrong the other way sends an application.
4. `type="submit"` on the form's last button counts as submit unless its wording is clearly `next|continue|save and continue`.
5. Review pages ("Review your application", Workday's Review step, LinkedIn's "Review" step) → the next button there is Submit.
6. Unit tests per ATS for "is this submit" (Greenhouse, Lever, Ashby, Workday last step, LinkedIn Easy Apply last step, SmartRecruiters, iCIMS), plus an e2e multi-page fixture (`tests/e2e/pages/multistep.html`) whose last button is labelled "Apply".

### 6.5 Blocker detection (stop, never solve)
- **CAPTCHA:** `iframe[src*="recaptcha"|"hcaptcha"|"challenges.cloudflare"]`, `[class*=captcha]` → `captcha`. Never attempt.
- **Verification code:** inputs labelled "verification code / one-time / OTP", "check your email" text → `verificationCode`. (Optional later: the agent reads the code from Gmail with your OK. See Q8.)
- **Assessments:** links/iframes to HackerRank, Codility, CodeSignal, TestGorilla → `assessment`.
- **Login walls:** `signIn` kind with no saved account for this host, or `createAccount`. Sign-in with the saved password is allowed only if a setting says so (`runMayUseSavedPassword`); account creation is **always** a stop (it accepts terms on your behalf).
- **External redirect:** top-frame navigated to a different registrable domain that isn't an ATS → `externalRedirect`.

### 6.6 Validation errors after Next
After pressing, if the page didn't change, read `[aria-invalid="true"]`, `[role="alert"]`, `.error`-ish elements near fields, and the form's error summary. Map messages to field ids (closest field container), mark those fields `needs` with the site's message as the note, then stop. This doubles as **incident data** (§8).

### 6.7 Ground-rule change (CLAUDE.md)
Current rule: Advance presses the page's button only when the user presses Advance. Proposed wording:

> The extension never presses Submit. With **Run** (one user press, or a bridge command after the user turned the bridge on), it may press the page's own **Next/Continue/Review** buttons repeatedly, and **Sign in** only when `runMayUseSavedPassword` is on. It stops at Submit, at anything it can't fill, and at every blocker in §6.5. Account creation, terms acceptance and Submit are always the user's press.

### 6.8 Settings added
`runStopOnReview` (default **on**), `runMayUseSavedPassword` (default off), `runMaxPages` (15), `bridgeEnabled` (off), `bridgeToken`.

---

## 7. Applier agents (Haiku 5.5)

### 7.1 What an applier does
```
loop:
  job = GET /queue/next
  open job.applyUrl in a NEW WINDOW (not just a tab; see 7.3)
  if it's a listing page: click Apply / Easy Apply (one click, no form filling)
  if documents for this job (Tier A): tell the bridge which resume/cover letter to use
  POST /run → poll /tabs/:job/status every few seconds
  on stop:
    submitReady     → screenshot the summary, mark job "ready", leave the window open, next job
    needsYou        → for each field: ask the Answerer (Sonnet) → POST /answers → POST /run again
    review          → same as needsYou, but answers are suggestions only, then continue
    validationErrors→ ask Answerer with the site's error message → retry once → else "stuck"
    signIn          → if allowed, Run continues; else mark "needs you: sign in"
    captcha | verificationCode | assessment | createAccount → mark "needs you: <reason>", next job
    noProgress | noButton | externalRedirect → file incident, mark "stuck", next job
```
Haiku's model calls are short: read a status JSON, make a decision, call a tool. It only looks at screenshots when something is weird (a listing page's Apply button, an unknown stop).

### 7.2 Why not let Haiku fill the form directly?
- Screenshot-driven filling is ~5–10 tool calls per field. A 60-field Workday flow is hundreds of calls, slow and expensive, and Haiku will make judgment errors on odd widgets.
- Every field Haiku fills by hand is a field the extension never learns.
- The extension already handles the hard widgets (Workday prompts, react-select, toggle groups, date segments).

Direct filling (via `form_input`) is the **fallback** for one stubborn field, and it always produces an incident.

### 7.3 Concurrency: what to spike first
Unknowns to settle in Phase 0, with a realistic fallback:

- **Background tabs are throttled.** Chrome throttles timers in hidden tabs and can stop rendering them. Both the extension's `settle()` waits and Claude in Chrome screenshots suffer. → **One window per agent**, each with its own active tab.
- **Several sessions sharing one Claude in Chrome connection.** Whether 2–4 Claude Code sessions (or subagents) can drive separate windows of the same Chrome at the same time without stepping on each other is unverified. Test with 2.
- **Your Chrome is busy while agents run.** Use a dedicated Chrome profile for the fleet (with EzAutoApply + Claude in Chrome installed and LinkedIn logged in), so your normal browsing isn't in the agents' windows.
- **Fallback if Claude in Chrome won't parallelize:** an Agent SDK orchestrator (`bridge/agents/`) that runs Haiku sessions against Playwright-launched Chromium with the extension loaded. The e2e setup already does this (`channel: 'chromium'`, `--load-extension`). Each worker gets its own persistent profile. Trade-off: you'd log into LinkedIn once per profile.

### 7.4 How agents are launched
Option A (start here): one Claude Code session in ai-job-search running a `/fleet` command. It spawns N background subagents (`model: haiku`) with an `apply-runner` skill, then sits idle and reports.
Option B (later): headless `claude -p --model haiku` processes, one per worker, started by a small script, with the same skill.
Option C (fallback): Agent SDK + Playwright as above.

`apply-runner` skill must contain: the loop above, the stop-reason table, "never press Submit / Create account / Accept terms", "never type the account password", "never solve CAPTCHAs", the bridge endpoints, and how to hand a field to the Answerer.

### 7.5 "Ready to submit" queue
Stopping at Submit means the filled form must **stay open** until you press Submit (Greenhouse/Lever don't save drafts; Workday does). So:
- Each ready job keeps its window open; a cap (`maxReadyOpen`, e.g. 6) pauses agents when reached.
- The panel (or a small page the bridge serves) lists ready jobs: company, role, tier, fields that were agent-answered, a "go to tab" button.
- You review, press Submit on the page, and mark it submitted (or the extension notices the confirmation page "Thank you for applying" and marks it automatically → tracker row).

---

## 8. Unknown fields: answer now (Sonnet), learn for later (Opus)

### 8.1 First responder: Sonnet 5.5 via `/answer`
Input bundle per field:
- Question label, help text, field kind, options (for choice fields), character/word limits, whether required.
- Job posting text (from the queue entry), company, role.
- The whole knowledge layer (§9).

Output (structured):
```json
{ "answer": "...", "confidence": "high|medium|low",
  "sources": ["01-candidate-profile.md#Work eligibility", "answer_bank: notice period"],
  "kind": "fact|preference|essay|attestation|unknown",
  "saveAs": { "scope": "global|host", "question": "normalized question" } }
```

Rules:
- `kind: attestation` (criminal record, non-compete, "are you related to an employee", e-signature, "I certify…") → **don't answer**. Stop for you.
- `kind: unknown` (no record supports an answer) → don't guess; stop, and ask you once. Your answer is saved globally so the question never comes back.
- Choice fields must pick an **offered option**. Laya/option matching validates it.
- Essays (cover-letter-like boxes) follow `/answer`'s voice rules, are tied to the posting, and are always `review`.
- **Saved answers carry provenance:** `origin: 'agent' | 'you'`, `approved: boolean`. An unapproved agent answer still fills, but always as `review` (orange), until you approve it once in the Answers view. Approving it in bulk is one click per answer.

Cost note: the profile + rules prefix is identical for every call, so prompt-cache it.

### 8.2 Incidents: what gets captured
Whenever a field ends `needs`, the site rejects a value, a filler returns `uncertain`, an agent fills a field directly, or Run stops on `noProgress | noButton`, the extension emits an incident:

```json
{
  "id": "2026-11-17T14-03-22Z-workday-7f3a",
  "host": "acme.wd5.myworkdayjobs.com", "ats": "workday",
  "url": "https://…/apply/…(query stripped)",
  "page": 3, "kind": "unmatched | wrongValue | widgetFailed | rejected | navigation",
  "field": { "label": "...", "kind": "combobox", "section": "...", "options": ["..."], "required": true,
             "attrs": { "name": "...", "id": "...", "automationId": "..." } },
  "pipeline": { "source": "none", "candidates": [{"key":"phone","score":0.41}], "classifier": {...} },
  "resolution": { "by": "sonnet | you | agentDirect", "value": "{{redacted or option text}}" },
  "domSnippet": "<div data-automation-id=\"formField-…\">…</div>",   // redacted, ≤ 30 KB
  "siteMessage": "Please enter a valid phone number",
  "screenshot": "field.png"                                           // optional, cropped
}
```

**Redaction:** the extension knows your profile values, so before writing it replaces each one in `domSnippet` and values with placeholders (`{{email}}`, `{{phone}}`, `{{name.first}}`…), and strips `value=` attributes of inputs not in the incident. Incidents go to `~/.ezautoapply/incidents/YYYY-MM-DD/` via the bridge, **never into git**.

### 8.3 Learner: Opus 5.5, nightly batch (`/learn` in EzAutoApply)
1. **Cluster** the day's incidents by `(ats, kind, normalized label)`. Twenty incidents are often one root cause.
2. **Classify each cluster:**
   - **Data gap**: the question is understood, there's just no answer ("Are you willing to work weekends?"). → Propose an answer-bank entry (global scope) for your approval. **No code.** Expect most clusters to be this.
   - **Missed match**: a known key wasn't recognized ("Mobile #" not matched to `phone`). → Add a label regex / `variants` entry in `core/fieldKeys.ts` + a case in `tests/unit/rules.test.ts`.
   - **Option mismatch**: the value is right but no option matched ("Bachelor's" vs "Undergraduate Degree"). → `core/options.ts` variant + test.
   - **Widget failure**: a custom dropdown/date/upload didn't take. → Build a fixture from the redacted `domSnippet` (`tests/unit/fixtures.ts` or `tests/e2e/pages/<ats>-<widget>.html`), write the **failing test first**, then fix `fill/fillers.ts` / `scan.ts`.
   - **Navigation**: Next not found or the wrong button. → `fill/advance.ts` + a test.
3. **Guardrails:** work in a git worktree on branch `learn/YYYY-MM-DD`. Must pass `npm run compile`, `npm test`, and a new **replay check** (below). Nothing is committed (your approval rule). The output is a short report: clusters → fix type → diff → tests added → replay result.
4. **Replay corpus** (`npm run replay`): every incident's `FieldInfo` + the outcome you approved is kept as a regression case. `resolveFields` is pure over `FieldInfo`, so this is cheap. Every learner change is checked against the whole corpus, so a regex that fixes one site can't silently break ten others.
5. **Budget:** cap at ~10 clusters per night, highest count first.

The real-time loop (Sonnet) keeps applications moving today. The nightly loop (Opus) makes sure the same question costs nothing tomorrow.

---

## 9. "Use everything you know about me": the knowledge layer

### 9.1 Sources, in priority order
1. **Your direct answers** (saved answers with `origin: 'you'`), most trusted.
2. EzAutoApply **profile** (structured: contact, work, education, links, EEO preferences) + `profileFacts` derived yes/no.
3. ai-job-search **profile** (`CLAUDE.md` candidate section, `01-candidate-profile.md`, `02-behavioral-profile.md`): narrative facts, deal-breakers, **genuine gaps**.
4. Master resume + tailored CVs/cover letters (`cv/`, `documents/cv/`).
5. Past form answers (`documents/applications/*/form_answers.txt`).
6. Approved agent answers.
7. LinkedIn import (already merged into the profile by `merge.ts`).

### 9.2 What "best of its abilities" means here
- **Answer from records, honestly.** "Years of Kubernetes experience?" → `0` / "No professional experience". Never round a gap up.
- **Prefer specific over generic.** A question about "a time you handled conflict" → the umpiring story, which the profile calls the strongest behavioral evidence.
- **Logistics come from settings, not guesses:** salary expectation, start date, notice period, relocation, hybrid/onsite, sponsorship. Add these as explicit profile fields (some exist) so nobody has to infer them.
- **EEO / self-ID:** your saved preferences, else "decline to answer".
- **When records conflict** (e.g. the LinkedIn graduation date vs the transcript), the verified source wins. ai-job-search already notes several of these.

### 9.3 Keeping two profiles from drifting
Two structured truths will drift. Proposal: ai-job-search's profile is the **narrative source of truth**, EzAutoApply's DB is the **form-shaped** copy. A `sync-profile` command (in ai-job-search) exports a `profile-facts.json` and diffs it against an EzAutoApply backup export (`exportAll`). It shows the differences and asks; nothing is overwritten silently.

---

## 10. Recruiter outreach (the riskiest part)

### 10.1 Why not automated DMs
- LinkedIn's User Agreement prohibits bots and automated messaging, and it detects them. Restriction or loss of your account would hurt this search more than any number of DMs could help.
- Free accounts get only a few personalized connection notes a month, and weekly invite caps.
- Mass cold DMs read as spam; reply rates on generic notes are poor.

### 10.2 What I'd build instead: "Outreach drafts"
1. **Targets:** only companies where you have a `ready` or `submitted` application (warm context), ranked by tier.
2. **Research (read-only, low volume):** find the recruiter/hiring manager via WebSearch (company team pages, LinkedIn search results surfaced by the search engine, public posts). No automated browsing of LinkedIn profiles at volume.
3. **Draft (Sonnet):** ≤ 300 characters for a LinkedIn note, or a short email. Mentions the specific role and req id, plus one true, specific reason (from the knowledge layer). Same voice rules as `/answer`.
4. **You send:** LinkedIn notes by hand (copy button), or email via **Gmail drafts** (the Gmail connector can create drafts; you press Send). Log each in the tracker so nobody is contacted twice.
5. Cap: ~5 per day.

---

## 11. Data contracts

### 11.1 Queue entry (`apply_queue/queue.jsonl`, one JSON per line)
```json
{
  "id": "gh-acme-4567890",
  "source": "linkedin-search | simplify-newgrad | jobbank | websearch | manual",
  "listingUrl": "https://ca.linkedin.com/jobs/view/...",
  "applyUrl": "https://boards.greenhouse.io/acme/jobs/4567890",
  "applyKind": "ats | linkedin-easy | indeed-apply | email | unknown",
  "ats": "greenhouse | lever | workday | ashby | … | null",
  "company": "Acme", "title": "Junior Software Developer", "location": "Toronto, ON (Hybrid)",
  "fit": { "score": 78, "band": "high", "notes": "…" },
  "tier": "A | B",
  "documents": { "resume": "default | <docId or path>", "coverLetter": "none | default | <path>" },
  "postingText": "…(trimmed, for the Answerer)",
  "status": "queued | claimed | running | ready | submitted | needsYou | stuck | skipped | expired",
  "statusNote": "captcha on page 2",
  "worker": "w1", "leaseUntil": "2026-11-17T15:00:00Z",
  "createdAt": "…", "updatedAt": "…",
  "history": [{ "at": "…", "status": "running", "page": 2 }]
}
```

### 11.2 Saved-answer additions (Dexie `answers`)
`origin: 'you' | 'agent' | 'import'`, `approved: boolean`, `sourceRefs?: string[]`, `createdBy?: 'sonnet-5.5' | …`. Migration: existing answers → `origin: 'you', approved: true`.

### 11.3 Tracker row (`job_search_tracker.csv`)
Match whatever columns `/scrape`, `/rank` and `/outcome` expect. Add `applied_via` (`ezautoapply-run | agent | manual`) and `queue_id`.

### 11.4 Incident: see §8.2.

---

## 12. Safety rules (proposed, for both CLAUDE.md files)

1. Nothing presses **Submit**, **Create account**, or **Accept terms**. Ever, in any mode.
2. Run may press Next/Continue/Review; Sign in only with `runMayUseSavedPassword`.
3. Agents never read, type or log the account password; the extension fills it.
4. Agents never solve CAPTCHAs or bypass bot checks. They stop and mark the job "needs you".
5. No automated messages to people. Outreach is drafts only.
6. Answers trace to records. Attestations and unknowns stop for you. Genuine gaps are answered honestly.
7. Incidents, screenshots and DOM snapshots are redacted, stored outside git, and deletable (`/learn --purge-older-than 30d`).
8. Learner changes are never committed or pushed without your approval (existing rule).
9. Rate limits: ≤ 15 applications/day to start; ≤ 3 per company per week; LinkedIn Easy Apply ≤ 5/day.
10. Kill switch: one bridge endpoint / panel button stops all runs and releases all leases.

---

## 13. Cost and capacity

### 13.1 Model prices (Claude API list prices, per million tokens)

| Model | Input | Output | Notes |
|---|---|---|---|
| Haiku 5.5 (`claude-haiku-5-5`) | $0.10 | $0.50 | Prompts over 100K tokens are billed at $0.50 / $2.50 |
| Sonnet 5.5 (`claude-sonnet-5-5`) | $2.00 | $10.00 | Cache reads $0.10 |
| Opus 5.5 (`claude-opus-5-5`) | $4.00 | $20.00 | Cache reads $0.20 |

If the agents run **through Claude Code on your subscription** (which is how Claude in Chrome is normally driven), you pay in plan usage and rate limits, not per token. Four parallel agents will use up limits quickly; that's another reason to start with one or two.

### 13.2 Rough per-unit estimates (to be replaced by measurements in Phase 4)

| Unit | Assumption | Estimate |
|---|---|---|
| One application, Haiku **supervising** the extension | ~25 turns × ~25K tokens context, ~10K output | **≈ $0.07** |
| One application, Haiku **driving every field** by screenshot | ~100+ turns, context past 100K (higher price band) | **≈ $1–3** |
| One Sonnet answer | ~40K context (profile + posting), 1K output; profile prefix cached | ≈ $0.02–0.09 |
| One Opus learner cluster | ~150K in, ~30K out | ≈ $1.20 |
| A day at 15 apps (B tier), ~3 unknown questions each, 5 clusters | | **≈ $2–9/day** on the API |

Supervisor mode is the difference between cheap and expensive, and it also makes the extension better every day.

### 13.3 Your machine (Win11, 16 GB, CPU-only)
- Laya: ~1–2 GB RAM when loaded.
- Each fleet window with a heavy ATS page: ~0.3–0.8 GB.
- Each Claude Code session: a few hundred MB.
- **2 appliers is comfortable, 4 is tight** alongside VS Code. CPU spikes during Laya calls (~0.3–0.6 s each) will slow fills a little when several windows classify at once.

### 13.4 Throughput
A Workday application is ~5–7 pages, about 5–10 min with settles. Greenhouse/Lever/Ashby take ~1–3 min. Two appliers → roughly 10–20 applications/hour **of agent time**, but you're the limit: reviewing a ready-to-submit form honestly takes 1–2 min each.

---

## 14. Roadmap

Each phase is usable on its own. Sizes are rough.

### Phase 0: Decisions and spikes (½–1 day)
- Answer the open questions (§17).
- **Spike A:** one Claude Code session drives **two** Chrome windows via Claude in Chrome at the same time. Do screenshots and clicks work in both? Does the fleet profile keep LinkedIn logged in?
- **Spike B:** can Claude in Chrome click EzAutoApply's floating button (trusted click) and read its state? Can it open `chrome-extension://…/sidepanel.html`?
- **Spike C:** hand-run the current extension (Autofill + Advance) on 10 real postings across Greenhouse, Lever, Ashby, Workday and LinkedIn Easy Apply. Record fill rate, the fields left, and pages. This is the **baseline**.
- Done when: a written go/no-go for Claude in Chrome vs the Agent SDK + Playwright fallback, plus baseline numbers.

### Phase 1: Run to Submit in the extension (3–5 days)
- `runTab` loop in the background, `RunState` in `storage.session`, panel stepper, floating-button state.
- Run-mode submit hardening (§6.4), blocker detection (§6.5), validation-error mapping (§6.6), page fingerprint, max pages.
- Confirmation-page detection ("Thank you for applying") → mark submitted.
- Settings (§6.8). CLAUDE.md ground-rule update (§6.7).
- Tests: unit (submit classification per ATS, blockers, fingerprint), e2e `multistep.html` (3 pages, last button "Apply"), Workday fixture walk-through.
- Done when: on the Spike C postings, Run stops at Submit every time, never presses it, and stops with a correct reason otherwise.

### Phase 2: Incidents + bridge (2–3 days)
- `bridge/` Node server with token auth, queue store, incidents writer, `/run`, `/tabs/:id/status`, `/answers`, kill switch.
- Extension: "Connect to local bridge" setting, incident emitter with redaction, bridge client in background.
- `npm run replay` over stored incidents.
- Done when: a failed field on a real site produces a redacted incident on disk, and replay runs it.

### Phase 3: Knowledge sync (1–2 days)
- Answer provenance fields + Dexie migration + Answers view approve/bulk-approve.
- Import from `form_answers.txt` and profile facts; export approved answers to ai-job-search.
- New profile fields for logistics (salary expectation, notice period, start date, relocation, sponsorship).
- Done when: a question you answered in an old `form_answers.txt` fills automatically on a new site.

### Phase 4: One applier agent (2–3 days)
- ai-job-search: `/queue` command, `simplify-newgrad-search` portal (via `/add-portal`), tracker writes.
- `apply-runner` skill (Haiku), Answerer hook (Sonnet `/answer`, structured output), ready-to-submit list.
- Run 1 agent on ~10 B-tier jobs while you watch.
- Done when: ≥ 80% of B-tier jobs reach `ready` without you touching the form, and zero submissions happened by mistake. Measure real cost per application.

### Phase 5: Learning loop (2–3 days)
- `/learn` command (Opus), clustering, worktree branch, fixture-first fixes, replay gate, nightly report.
- Done when: one week of incidents yields reviewed fixes, and the repeat-incident rate drops week over week.

### Phase 6: Scale (1–2 days + tuning)
- 2 appliers, then maybe 4. Leases, `maxReadyOpen`, per-company caps, LinkedIn Easy Apply support.
- Indeed only as "resolve to ATS" or manual-assisted.

### Phase 7: Outreach drafts (1 day)
- Targets from tracker, research, drafts, Gmail drafts, logging.

---

## 15. Metrics to track (bridge writes a daily JSON)

- **Fill rate** per ATS: filled ÷ fields, and the share by tier (rules / answers / classifier / agent / you).
- **Touch-free rate:** jobs reaching `ready` with no human or agent field input.
- **Human minutes per application** (time from ready to submitted, plus `needsYou` handling).
- **Repeat-incident rate:** incidents whose cluster was already "fixed" (should fall).
- **Wrong-value rate:** values you changed during review (the most important quality signal; feed these back as incidents).
- **Cost per application** (tokens or plan usage).
- **Outcomes:** response/interview rate by tier and source (from `/outcome`). This is what tells you whether volume or tailoring pays off.

---

## 16. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Loop presses a disguised Submit | Medium | **High** (unwanted application) | §6.4 rules, "when in doubt it's Submit", per-ATS tests, e2e "Apply" fixture |
| LinkedIn restricts your account | Medium if Easy Apply/DMs automated | **High** | Search via guest CLI; prefer external apply; Easy Apply capped; no automated DMs |
| Wrong answer to a screening question auto-disqualifies you | Medium | Medium | Agent answers stay `review` until approved; attestations stop; wrong-value metric |
| Agent invents experience | Low–Medium | **High** (integrity, interviews) | Records-only rule, genuine-gaps list, sources required in Answerer output |
| Learner fix breaks other sites | Medium | Medium | Replay corpus gate, full tests, human review, no auto-merge |
| PII leaks via incidents/screenshots | Low | High | Redaction by known profile values, outside git, purge command |
| Claude in Chrome can't run agents in parallel | Medium | Medium | Agent SDK + Playwright fallback (§7.3) |
| Hidden-tab throttling stalls fills | High if tabs | Medium | One window per agent |
| Volume over quality lowers response rate | Medium | Medium | Tiers, caps, measure outcomes by tier |
| Sites change markup | Certain | Low–Medium | That's what the learning loop is for |
| Two profiles drift | Medium | Medium | `sync-profile` diff (§9.3) |

---

## 17. Open questions for you

1. **Submit:** should agents *ever* press Submit (e.g. for B-tier jobs once accuracy is proven), or always stop and queue for you? (Recommended: always stop, revisit after a month of metrics.)
2. **Generative text:** the project's rule so far is "no generative text in the product". Is it OK for Sonnet-written answers to be **saved into the answer bank** (flagged, needing approval), as long as the extension itself never generates text at runtime?
3. **Billing:** run agents on your Claude subscription through Claude Code + Claude in Chrome, or on an API key (Agent SDK)? That changes the cost model and the parallelism limits.
4. **Volume target:** roughly how many applications per day or week do you want? And what share should be Tier A (tailored CV/cover letter via `/apply`) vs Tier B (default resume)?
5. **Repos:** OK to keep them separate and link via the bridge + queue, rather than merge?
6. **LinkedIn risk appetite:** is automated Easy Apply on your main account acceptable at low volume, or external-apply only?
7. **Recruiters:** happy with "agent drafts, you send", via LinkedIn by hand or Gmail drafts?
8. **Verification codes:** may an agent read a Workday/iCIMS email verification code from Gmail to continue an application (per-application OK, or never)?
9. **Accounts:** many Workday tenants need a new account per company. Do you want Run to stop at account creation every time (recommended), or a "create account with saved password" option you enable per site?
10. **Fleet browser:** OK with a dedicated Chrome profile for agents (logged into LinkedIn), separate from your daily one?
11. **Indeed:** worth any automation at all, or just "you browse, Run fills"?
12. **Where does the bridge live:** a `bridge/` folder in EzAutoApply (recommended, shares types) or in ai-job-search?
