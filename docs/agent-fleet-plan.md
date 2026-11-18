# Agent Fleet Plan: EzAutoApply × ai-job-search

Status: **design, decisions taken.** Written 2026-11-17; the owner answered §17 the same day, and this version records those answers (§0.1). Work is tracked as GitHub issues on the EzAutoApply board (§14 lists them). Run to Submit's detection parts (#10, #11, #12, #14) are built; the loop itself (#9) waits on the ground-rule wording (#8).
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
| 5 | Opus figures out how to solve the field for next time | ✅ Decided: live | Capture an **incident** (redacted DOM, field info, what happened) for every field the extension can't fill. **Decided 2026-11-17:** a live **Opus Fixer** handles them as they happen (Sonnet triages; data gaps become flagged saved answers, code gaps become fixture → test → fix → reload), and the applier fills by hand only what the Fixer can't fix. See §8.3. |
| 6 | Always consult all info about me | ✅ Works | Build one knowledge layer from both repos. Hard rule: "best of its abilities" means **never inventing facts.** Genuine gaps (Kubernetes, Go, people management…) get answered honestly, and legal and attestation questions always stop for you. |
| 7 | One press: fill → next → fill … stop at Submit, all in the extension | ✅ Best part of the plan | Build this **first**, before any agent. It's useful on its own, needs no AI, and the agents depend on it. Needs a ground-rule update and hardened Submit detection (see §6.4: today an "Apply" button counts as *start*, which on a one-page form is really *submit*). |
| 8 | Agents do applications as well | ⚠️ Decide | Agents should **also stop at Submit** and hand you a "ready to submit" queue, at least until the fill accuracy numbers are proven. Open question Q1. |
| 9 | Sonnet agent finds recruiters on LinkedIn and cold-DMs them | ❌ Not as written | Automated LinkedIn messaging breaks LinkedIn's User Agreement. Accounts get restricted fast, and your LinkedIn is the most valuable asset in this whole search. Free accounts also get only a handful of personalized invite notes a month. Instead: the agent **researches and drafts**, and **you send**. **Decided 2026-11-17:** a local recruiter page covering any fitting company that hires developers (§10). |
| 10 | Indeed | ⏸ Skipped for now (2026-11-17) | Indeed has heavy bot protection, no public search API, and its own apply flow. Do it last or treat it as "you browse, extension runs". Many Indeed listings also link out to a company ATS that EzAutoApply already handles. |
| 11 | Simplify | ✅, but use the right part | The **SimplifyJobs New-Grad-Positions GitHub list** is a free, structured, frequently updated list of new-grad roles (US and Canada) that link straight to Greenhouse/Lever/Workday, which is exactly EzAutoApply's home turf. Add it as a portal CLI in ai-job-search. Don't run Simplify's own Copilot autofill extension alongside EzAutoApply; the two will fight over the same fields. |

Recommended build order: **Run-to-Submit in the extension → incident capture + bridge → knowledge sync → one applier agent with the live Fixer → more appliers and sources → the Fleet Office → recruiter page.** Details in §14.

### 0.1 Decisions (owner, 2026-11-17)

These answer §17 and override anything older in this document.

| Question | Decision | Where it lands |
|---|---|---|
| Q1 Submit | **Agents always stop at Submit** and queue the job for the owner. Nothing presses Submit. | §6, §7.5, §12 |
| Q2 Generative text | Agent-written (Sonnet) answers **go into the answer bank, flagged for approval**. The extension itself never generates text at runtime. | §8.1, §11.2 |
| Q3 Billing | Agents run through **Claude Code + Claude in Chrome on the subscription**, not an API key. Costs are plan usage, shared with sprints. | §13 |
| Q4 Volume / tiers | **No caps**; runs until you stop it. The **tier rule** (§5.2): default resume when it fits well, tailored CV via `/apply` otherwise, **3 tailored a day**; past that, everything is Tier B. | §5.2 |
| Q5 Repos | Separate repos, linked by the bridge and the queue. | §4 |
| Q6 LinkedIn | **Company job sites only for the first month**; Easy Apply switched off (#53), revisit after. Search via the guest CLI. | §5 |
| Q7 Recruiters | A **local page of recruiters** at any company that fits and hires developers, with messages the owner sends. | §10 |
| Q8 Codes | Agents **may read verification codes from Gmail.** | §6.5, §12 |
| Q9 Accounts | **Run creates accounts and signs in itself** with the saved password, and ticks the terms (decision #8). | §6.5, §12 |
| Q10 Browser | A **dedicated Chrome profile** for the fleet. | §7.3 |
| Q11 Indeed | **Skipped for now.** | §5 |
| Q12 Bridge | `bridge/` in **this repo**. | §4.3 |
| (new) Learning | The nightly learner becomes the **live Opus Fixer**. | §8.3 |
| (new) UI | A **Fleet Office** page shows every agent at work. | §18 |

### 0.2 Models per part

| Part | Model | Why |
|---|---|---|
| Fleet launcher (`/fleet` session that spawns and watches agents) | **Haiku 5.5** | It mostly waits and relays status; a bigger model would spend plan usage on waiting. |
| Scout: collecting postings | **Haiku 5.5** | Search, scrape, de-duplicate: mechanical. |
| Scout: ranking fit, default resume vs tailored CV | **Sonnet 5.5** | The one judgment that decides where all the applier time goes. |
| Appliers | **Haiku 5.5** | They supervise the extension: read a status JSON, pick the next action. A step a Haiku applier can't work out escalates to Sonnet once. |
| Answerer (unknown questions) | **Sonnet 5.5** | Needs the whole profile and honest judgment; answers are flagged for approval anyway. |
| Fixer: triage | **Sonnet 5.5** | Most incidents are data gaps; Sonnet sorts data gap vs code gap and writes the flagged saved answer. |
| Fixer: code fixes | **Opus 5.5** | Only code gaps reach it: fixture, failing test, fix, replay. |
| Outreach research + drafts | **Sonnet 5.5** | ~5 a day; the quality of the message matters more than cost. |
| Sprints (issues on the board) | **Opus 5.5** | The sprint lines are tuned for it. |

All of these share one subscription with the sprints, so the fleet and an overnight sprint compete for the same weekly limit: run them on different nights at first.

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
   ┌──── Answerer (Sonnet 5.5, /answer) ─────┐   ┌──── Fixer (live: Sonnet triage, Opus) ───┐
   │ answer from all records, never invent   │   │ data gap → flagged saved answer          │
   │ → saved answer (agent-written, review)  │   │ code gap → fixture + test → fix → replay │
   └─────────────────────────────────────────┘   │ → reload fleet build; nothing committed  │
                                                 └──────────────────────────────────────────┘
                              YOU: review "ready to submit" tabs → press Submit
                                   approve agent-written answers → approve Fixer diffs
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
| **Indeed** | No public API; heavy bot protection. WebSearch `site:indeed.com` fallback (already in `/scrape`). | Many listings link to a company ATS: resolve and apply there. Indeed Apply (smartapply.indeed.com): manual-assisted only. | High for automation | **Skipped for now** (2026-11-17) |
| **Job Bank Canada** (`jobbank-search` exists) | Already a CLI | Mostly external | Low | Medium (federal/public sector is a differentiator) |

### 5.1 `/queue` (new command in ai-job-search)
1. Take ranked jobs (`/rank` output) above a fit threshold that aren't in the tracker.
2. **Resolve the apply URL.** For LinkedIn listings, fetch the detail and pull the external apply link. If it's Easy Apply, mark `applyKind: "linkedin-easy"`. Normalize to the ATS posting URL (strip tracking params).
3. **Dedupe across sources** by canonical key: `ats-host + posting id` when known, else `normalize(company) + normalize(title) + city`.
4. **Pick a tier** (see §5.2).
5. Append to `queue.jsonl` with `status: "queued"`.

### 5.2 Tiers: quality vs volume
ai-job-search is built around *tailored* CVs per job; mass applying is the opposite. Make it explicit:

- **Tier A (tailored):** `/apply` makes a tailored CV + cover letter first; the applier uploads *those* documents (per-tab `DocSelection`). You review everything.
- **Tier B (standard):** default resume, saved answers, agent-applied, stops at Submit.
- **Tier C (skip):** low fit, deal-breakers (QA-only, senior titles, French required). Never queued.

**The tier rule (decided 2026-11-17, built in `/queue`, #25):** the Scout's ranker (Sonnet) asks whether the **default resume fits this posting well**. If it does, the job is Tier B. If not, it is Tier A and gets a tailored CV via `/apply`, **up to 3 tailored CVs a day** (owner, 2026-11-17). Once those are used, every remaining job that day is Tier B. The budget is a setting in ai-job-search, so tailoring can't quietly eat the plan's weekly limit.

**No application caps** (owner, 2026-11-17): the fleet runs until you press Pause or Stop all. The real bottleneck will be your review of "ready to submit" tabs, not agent speed.

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
  | 'submitted'        // the thank-you page (you pressed Submit)
  | 'verificationCode' // (sign-in and account creation are steps, not stops: #8)
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
- **Verification code:** inputs labelled "verification code / one-time / OTP", "check your email" text → `verificationCode`. Run stops; **an applier agent may then read the code from Gmail** (decided 2026-11-17, #27): it searches for the newest message from the site's sender since the run began, types the code, and presses Run again. A code it can't find within a few minutes leaves the job "needs you".
- **Assessments:** links/iframes to HackerRank, Codility, CodeSignal, TestGorilla → `assessment`.
- **Login walls:** `signIn` and `createAccount` are **steps, not stops** (decision #8, 2026-11-17): Run fills the email and the saved password (`getSecret`), ticks "I accept the terms" on an account-creation form, and presses Sign in / Create account itself. A sign-in that fails shows up as the site's error (`validationErrors`). The agent never sees the password.

Built in #11 (`fill/blockers.ts › findBlockers`, `core/sites.ts › isExternalRedirect`).
- **External redirect:** top-frame navigated to a different registrable domain that isn't an ATS → `externalRedirect`.

### 6.6 Validation errors after Next
After pressing, if the page didn't change, read `[aria-invalid="true"]`, `[role="alert"]`, `.error`-ish elements near fields, and the form's error summary. Map messages to field ids (closest field container), mark those fields `needs` with the site's message as the note, then stop. This doubles as **incident data** (§8).

### 6.7 Ground-rule change (CLAUDE.md)
Adopted 2026-11-17 (decision #8), now in CLAUDE.md:

> The extension never presses Submit. With **Run** (one press by the owner, or a bridge command after the owner turned the bridge on), it may press the page's own Next/Continue/Review buttons repeatedly, press Sign in and Create account using the saved password, and tick "I accept the terms" on an account-creation form. It stops at Submit, at anything it can't fill, and at every blocker. Submit is always the owner's press.

Built in #9 (`src/run/loop.ts`).

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

## 8. Unknown fields: answer now (Sonnet), fix the extension live (Opus)

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

### 8.3 The live Fixer (decided 2026-11-17; #31, #32, #33)

The first draft had a nightly Opus batch. The owner chose a **live** one instead: the extension gets better *during* the run, so the second application on the same ATS already benefits.

```
applier: Run stops with a field the extension couldn't fill
   └─▶ incident (§8.2) to the bridge, applier waits on that field (other pages/jobs carry on)
Fixer triage (Sonnet 5.5): data gap or code gap?
   ├─ data gap  → flagged saved answer (origin: agent, approved: false) → applier presses Run again
   └─ code gap  → Fixer (Opus 5.5):
                   fixture from the redacted domSnippet → failing test → fix
                   → npm run compile + npm test → replay corpus
                   → fleet build (#33) → reload the extension in the fleet profile
                   → applier presses Run again
Only when the Fixer can't fix it (two honest tries, or tests won't pass):
   the Haiku applier fills that one field by hand (form_input), and the incident stays open.
```

- **The fleet build (#33)** is a separate `wxt build` output the fleet profile loads, so the Fixer can rebuild and reload it without touching the owner's own installed copy.
- **Nothing is committed.** The Fixer works on a `fix/<date>` branch in a worktree; its diffs wait for the owner's review like every other commit. The fleet runs on the uncommitted build until then.
- **One fix at a time.** Incidents queue; a cluster with the same `(ats, kind, normalized label)` is one fix.
- The checks below (classification, replay, budget) apply to every live fix.

**Classifying an incident** (same as the first draft):

1. **Cluster** incidents by `(ats, kind, normalized label)`. Twenty incidents are often one root cause.
2. **Classify each cluster:**
   - **Data gap**: the question is understood, there's just no answer ("Are you willing to work weekends?"). → Propose an answer-bank entry (global scope) for your approval. **No code.** Expect most clusters to be this.
   - **Missed match**: a known key wasn't recognized ("Mobile #" not matched to `phone`). → Add a label regex / `variants` entry in `core/fieldKeys.ts` + a case in `tests/unit/rules.test.ts`.
   - **Option mismatch**: the value is right but no option matched ("Bachelor's" vs "Undergraduate Degree"). → `core/options.ts` variant + test.
   - **Widget failure**: a custom dropdown/date/upload didn't take. → Build a fixture from the redacted `domSnippet` (`tests/unit/fixtures.ts` or `tests/e2e/pages/<ats>-<widget>.html`), write the **failing test first**, then fix `fill/fillers.ts` / `scan.ts`.
   - **Navigation**: Next not found or the wrong button. → `fill/advance.ts` + a test.
3. **Guardrails:** work in a git worktree on branch `fix/YYYY-MM-DD`. Must pass `npm run compile`, `npm test`, and the **replay check** (below) before the fleet build is reloaded. Nothing is committed (your approval rule). Each fix leaves a short report: cluster → fix type → diff → tests added → replay result.
4. **Replay corpus** (`npm run replay`, #19): every incident's `FieldInfo` + the outcome you approved is kept as a regression case. `resolveFields` is pure over `FieldInfo`, so this is cheap. Every Fixer change is checked against the whole corpus, so a regex that fixes one site can't silently break ten others.
5. **Budget:** the Fixer shares the plan's limits with the appliers; it takes code gaps by count, highest first, and leaves the rest as incidents when the 5-hour window runs low.

The Answerer (Sonnet) keeps applications moving; the Fixer (Opus) makes sure the same field costs nothing on the next application.

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

### 10.2 What gets built: a local recruiter page (decided 2026-11-17; #38–#41)
1. **Targets (#39):** **any** company that fits the profile and is hiring software developers, not only ones already applied to. The Scout's ranking decides the fit.
2. **Research (read-only, low volume, #39):** find the recruiter or hiring manager via WebSearch (company team pages, LinkedIn results surfaced by the search engine, public posts). No automated browsing of LinkedIn profiles at volume.
3. **Messages (Sonnet, #40):** for each person, a **LinkedIn connection note** (≤ 300 characters) and a **follow-up** for after they accept, both naming a specific role and one true, specific reason from the knowledge layer. An **email** only when the address is **publicly listed**; addresses are never guessed. Same voice rules as `/answer`.
4. **The page (#41):** the bridge serves a **local** page listing each company, person, role and link, with copy buttons for each message. You send everything yourself: LinkedIn by hand, email from your own mail client. Mark each as sent so nobody is contacted twice.
5. **Private:** the page and its data hold real people's names, so they live outside both repos, are **never published or committed**, and never appear in an issue or PR.
6. Cap: ~5 new people per day.

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

1. Nothing presses **Submit**. Ever, in any mode. Every application ends queued for the owner (decided 2026-11-17).
2. Run may press Next/Continue/Review, and **Run itself** signs in and creates accounts with the saved password, ticking the terms on account creation (decision #8, 2026-11-17).
3. Agents never read, type or log the account password; the extension fills it via `getSecret`.
3a. Agents may read a site's **verification code from Gmail** (decided 2026-11-17): only the newest message from that site's sender since the run began, nothing else in the mailbox, and nothing is sent, labelled or deleted.
4. Agents never solve CAPTCHAs or bypass bot checks. They stop and mark the job "needs you".
5. No automated messages to people. Outreach is drafts only.
6. Answers trace to records. Attestations and unknowns stop for you. Genuine gaps are answered honestly.
7. Incidents, screenshots and DOM snapshots are redacted, stored outside git, and deletable (a purge for anything older than 30 days).
8. Fixer changes are never committed or pushed without your approval (existing rule); the fleet runs on the uncommitted fleet build until you review them.
9. No application caps (owner, 2026-11-17): the fleet runs until the owner stops it. Only the number of filled-but-unsubmitted windows kept open is limited, for memory.
10. Kill switch: one bridge endpoint / panel button stops all runs and releases all leases.

---

## 13. Cost and capacity

### 13.1 Model prices (Claude API list prices, per million tokens)

| Model | Input | Output | Notes |
|---|---|---|---|
| Haiku 5.5 (`claude-haiku-5-5`) | $0.10 | $0.50 | Prompts over 100K tokens are billed at $0.50 / $2.50 |
| Sonnet 5.5 (`claude-sonnet-5-5`) | $2.00 | $10.00 | Cache reads $0.10 |
| Opus 5.5 (`claude-opus-5-5`) | $4.00 | $20.00 | Cache reads $0.20 |

**Decided 2026-11-17:** the agents run **through Claude Code on the subscription** (which is how Claude in Chrome is normally driven), so you pay in plan usage and rate limits, not per token; the prices above only help compare models. The fleet and the sprints share the same 5-hour and weekly limits. Four parallel agents will use up limits quickly; that's another reason to start with one or two.

### 13.2 Rough per-unit estimates (to be replaced by measurements in Phase 4)

| Unit | Assumption | Estimate |
|---|---|---|
| One application, Haiku **supervising** the extension | ~25 turns × ~25K tokens context, ~10K output | **≈ $0.07** |
| One application, Haiku **driving every field** by screenshot | ~100+ turns, context past 100K (higher price band) | **≈ $1–3** |
| One Sonnet answer | ~40K context (profile + posting), 1K output; profile prefix cached | ≈ $0.02–0.09 |
| One Opus Fixer code fix | ~150K in, ~30K out | ≈ $1.20 |
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

Each phase is usable on its own. Sizes are rough. Every phase is a parent issue on the EzAutoApply board with one sub-issue per part:

| Phase | Parent | Sub-issues | State (2026-11-17) |
|---|---|---|---|
| 0 Decisions and spikes | #3 | #4 two windows, #5 floating button and panel, #6 baseline | Decisions taken (§0.1); spikes not run |
| 1 Run to Submit | #7 | #8 ground-rule wording (decision), #9 `runTab` loop, #10 Submit detection, #11 blockers, #12 validation errors, #13 Run button and stepper, #14 confirmation page | #10 #11 #12 #14 built; #9 #13 wait on #8 |
| 2 Bridge + incidents | #15 | #16 bridge server, #17 extension ↔ bridge, #18 redacted incidents, #19 `npm run replay` | |
| 3 Knowledge sync | #20 | #21 answer provenance and approval, #22 logistics profile fields, #23 ai-job-search answers in and out | |
| 4 One applier | #24 | #25 `/queue` with the tier rule, #26 `apply-runner` skill, #27 accounts and Gmail codes, #28 Sonnet answerer, #29 ready-to-submit list, #30 two appliers with caps | |
| 5 Live Fixer | #31 | #32 the incident loop (triage, fix, reload), #33 the fleet build | |
| 6 Fleet Office (UI) | #34 | #35 serve the Office with live state, #36 Launch / Pause / Stop all for real, #37 agent pop-outs and the inbox, #50 a running sprint in the Office | Prototype done (`docs/fleet-office-prototype.html`) |
| 7 Recruiter page | #38 | #39 find companies and recruiters, #40 draft the messages, #41 the local page | |

Tooling (#44–#49, #52) and the TC6IDM.github.io showcase (#42, #43) sit beside these phases.

### Phase 0: Decisions and spikes (½–1 day)
- ~~Answer the open questions (§17).~~ Done 2026-11-17 (§0.1).
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

### Phase 5: Live Fixer (2–3 days)
- The live incident loop (§8.3): Sonnet triage, flagged saved answers for data gaps, Opus fixture-first code fixes in a worktree, replay gate, fleet build reload (#32, #33).
- Scaling to 2 appliers, then maybe 4, with leases, `maxReadyOpen` and per-company caps, is #30 in Phase 4.
- Done when: a field one applier couldn't fill is filled by the extension on the next application, and the repeat-incident rate drops week over week.

### Phase 6: Fleet Office (2–3 days)
- The Office page (§18) served by the bridge with live state; the controls work for real; pop-outs and the owner's inbox; a running sprint shown beside the agents (#35, #36, #37, #50).
- Done when: the owner runs the fleet from this page for a day without the terminal.

### Phase 7: Recruiter page (1–2 days)
- Find fitting companies and their recruiters, draft the messages, serve the local page (§10.2; #39, #40, #41).
- Indeed stays skipped.

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
| A Fixer fix breaks other sites | Medium | Medium | Replay corpus gate, full tests, human review, no auto-merge |
| PII leaks via incidents/screenshots | Low | High | Redaction by known profile values, outside git, purge command |
| Claude in Chrome can't run agents in parallel | Medium | Medium | Agent SDK + Playwright fallback (§7.3) |
| Hidden-tab throttling stalls fills | High if tabs | Medium | One window per agent |
| Volume over quality lowers response rate | Medium | Medium | Tiers, caps, measure outcomes by tier |
| Sites change markup | Certain | Low–Medium | That's what the learning loop is for |
| Two profiles drift | Medium | Medium | `sync-profile` diff (§9.3) |

---

## 17. Open questions (answered 2026-11-17)

Kept for the record; the answers are in §0.1.

1. **Submit:** should agents *ever* press Submit (e.g. for B-tier jobs once accuracy is proven), or always stop and queue for you? (Recommended: always stop, revisit after a month of metrics.)
   **Answer:** Always stop at Submit and queue the job for the owner.
2. **Generative text:** the project's rule so far is "no generative text in the product". Is it OK for Sonnet-written answers to be **saved into the answer bank** (flagged, needing approval), as long as the extension itself never generates text at runtime?
   **Answer:** Yes: saved into the answer bank, flagged for approval. The extension never generates text.
3. **Billing:** run agents on your Claude subscription through Claude Code + Claude in Chrome, or on an API key (Agent SDK)? That changes the cost model and the parallelism limits.
   **Answer:** Claude Code + Claude in Chrome on the subscription.
4. **Volume target:** roughly how many applications per day or week do you want? And what share should be Tier A (tailored CV/cover letter via `/apply`) vs Tier B (default resume)?
   **Answer:** No caps. The tier rule (§5.2): default resume when it fits well, tailored CV otherwise, 3 a day, Tier B past it.
5. **Repos:** OK to keep them separate and link via the bridge + queue, rather than merge?
   **Answer:** Yes, separate repos.
6. **LinkedIn risk appetite:** is automated Easy Apply on your main account acceptable at low volume, or external-apply only?
   **Answer:** Company job sites only for the first month; Easy Apply off (a switch, #53), revisit after.
7. **Recruiters:** happy with "agent drafts, you send", via LinkedIn by hand or Gmail drafts?
   **Answer:** A local recruiter page for any fitting company hiring developers; the owner sends (§10.2).
8. **Verification codes:** may an agent read a Workday/iCIMS email verification code from Gmail to continue an application (per-application OK, or never)?
   **Answer:** Yes: agents may read codes from Gmail.
9. **Accounts:** many Workday tenants need a new account per company. Do you want Run to stop at account creation every time (recommended), or a "create account with saved password" option you enable per site?
   **Answer:** Create the account with the saved password, always. Run does it itself and may tick the terms (decision #8).
10. **Fleet browser:** OK with a dedicated Chrome profile for agents (logged into LinkedIn), separate from your daily one?
   **Answer:** Yes, a dedicated Chrome profile.
11. **Indeed:** worth any automation at all, or just "you browse, Run fills"?
   **Answer:** Skipped for now.
12. **Where does the bridge live:** a `bridge/` folder in EzAutoApply (recommended, shares types) or in ai-job-search?
   **Answer:** `bridge/` in this repo.

---

## 18. The Fleet Office (decided 2026-11-17; #34–#37, #50)

The owner wants to start, watch and stop the fleet from one page rather than a terminal. The prototype, with sample data, is `docs/fleet-office-prototype.html`.

**What it shows**
- A small 3D office with a desk per agent: the Scout, each applier, the Fixer and Outreach. Each agent is coloured by its model (Haiku / Sonnet / Opus, §0.2) and shows what it is doing now.
- **Controls:** Launch / Pause fleet, Stop all (with a confirm), and the applier count (1–4).
- **Totals:** applied today, ready to submit, needs you, answers to approve, recruiter messages. Each total opens the matching inbox tab.
- **A pop-out window per agent:** what it is doing, its recent steps, and buttons to go to its Chrome window, pause it, or take over. "Watch the Fixer" follows a live fix (incident → test → fix → reload).
- **The owner's inbox**, in tabs:
  - **Ready to submit:** go to its window, then "I submitted it".
  - **Needs you:** CAPTCHAs, assessments and anything else Run stops on.
  - **Answers to approve:** agent-written answers, with Approve and Edit.
  - **Recruiters:** copy the note or the message, then mark it sent (§10.2).
- An **activity ticker** of the latest steps across agents, and (#50) a running sprint shown beside the agents with its issue and usage.

**How it's served**
- The bridge (§4.3) serves the page on `127.0.0.1` with live state (#35); the controls call the bridge's run and kill-switch endpoints (#36); the pop-outs and inbox read the same state (#37).
- **Local only.** Recruiter names, job data and the owner's answers never leave the machine. The page is never published and its data never goes into git.
- Stop all is the §12 kill switch: it stops every run and releases every lease.
