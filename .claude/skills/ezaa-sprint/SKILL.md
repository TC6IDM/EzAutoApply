---
name: ezaa-sprint
description: "Work EzAutoApply's GitHub issues one after another, unattended, for as long as the Claude usage budget allows: picks the next issue Claude can do alone, builds and commits it, and checkpoints (push, one PR, issue notes) before the 5-hour or weekly limit runs out. Starts every loop with the Inbox. Never takes someone else's issue; 'mine' limits it to issues assigned to the person, named issues ('12 34 56', 'only 12 34') go first, a label ('only area:workday') narrows it. Use when asked to sprint, burn down the board, 'do as many issues as you can', or work until the limit; '/ezaa-sprint keep going' also waits for the reset and carries on; 'autocompact [tokens]' compacts earlier for that sprint only."
---

# EzAutoApply sprint

Claude takes issues off the board, one at a time, best first, and stops in time to
leave everything pushed and reviewable. `sprint.mjs` (this folder) reads the same
usage figures as `/usage` (5-hour window and weekly limit) and decides:

| Verdict | Meaning (default lines, either limit) | Do |
|---|---|---|
| `GO` | under 80% | may start a new issue that fits the room left |
| `SMALL` | 80–94% | carry on; then only `size:S` issues, one by one |
| `WRAP` | 94–96% | start nothing new; finish the current issue only if a step or two away, else checkpoint |
| `STOP` | 96% or more | **checkpoint now** |
| `UNKNOWN` | usage can't be read | finish the current issue, then checkpoint |

On Fable the lines are 70 / 82 / 88, chosen by `start` from the model the status
line reports (the waiting wakes cost more there). Named `--small-at`, `--new-at`,
`--stop-at` win; `sprint.mjs lines` shows them without starting anything.

A `PostToolUse` hook (`.claude/settings.json`, `sprint.mjs budget --hook`)
re-checks every couple of minutes while a sprint is on and puts WRAP/STOP into
Claude's context. Without a running sprint the hook says nothing.

Ported 2026-11-17 from Ride The Bus's `rtb-sprint` (PTrainr's `ptrainr-sprint`
before it). All repo values come from `../ezaa-issues/config.mjs`.

## What invoking this skill allows (CLAUDE.md, "Issues and sprints")

Invoking `/ezaa-sprint` is the owner's yes, **for that sprint only**, to: commit
on the sprint's own `sprint/<date-time>` branch (one commit per issue) and on
`wip/issue-<N>` branches, push those branches, open the sprint's PR into `main`
at its first finished issue and keep it up to date, comment on and tick the
worked issues, and move each finished one to **In Review** (`sprint.mjs finish`).
`.claude/hooks/guard.mjs` allows exactly that while the sprint's state file is
live and the checkout is its branch. **Never:** commit on or push to `main`,
merge, close an issue, force-push, publish to the Chrome Web Store, submit or
advance a real job application, send a message to a person, or touch the
owner's real profile data.

## 1. Start

```bash
node .claude/skills/ezaa-sprint/sprint.mjs start [--issues 12,34,56 [--only]] [--label <name>] [--avoid 19] [--mine] [--autocompact [tokens]] [--small-at 80] [--new-at 94] [--stop-at 96] [--keep-going]
```

- **Named issues first** ("do #12, #34 and #56 first" → `--issues 12,34,56`;
  "only those" adds `--only`). A named parent becomes its open sub-issues. Named
  issues skip the `who:claude` and `status:` filters but Claude still skips one
  it can't do alone (2.2).
- **`--label <name>`** ("only the area:workday ones"): only issues that also
  carry that label. Named issues still go first.
- **`--avoid 19,39`**: those issues and everything under them are left out.
  Anything assigned to someone else, or under a parent assigned to someone else,
  is never a candidate. `--mine`: issues assigned to the person first; alone it
  claims nothing unassigned; with `--keep-going` it moves on to unassigned ones
  after.
- It refuses a dirty working tree (ask the person: commit it with them, or stash
  it; never discard it), refuses without room in the budget, then makes the
  branch from `origin/main`. `--here` carries on an earlier sprint's branch.
- Put `--keep-going` when the person said "keep going". Pass `--autocompact`
  only when they said so. Run the session in auto mode or with the needed tools
  allowed: a permission prompt while nobody watches stalls the sprint.

## 2. The loop: one issue at a time

0. **The Inbox first, on every loop.** `sprint.mjs budget` and `next` print an
   `Inbox:` line. When something is waiting, do the Inbox pass (`ezaa-issues`
   SKILL.md, "The Inbox issue") before taking an issue. Never during an issue's
   build, only between issues; at `STOP`, leave it for the first wake under the line.
1. `sprint.mjs next`: the budget line, the room left, the average cost of an
   issue so far, and the candidates (named first, then: open, `who:claude`, not
   an epic or decision, no `status:` label, yours or unassigned; by milestone,
   priority, then size). `SMALL` lists only `size:S`. `WRAP`/`STOP`, or nothing
   left → **Checkpoint**.
2. **Choose** the first one that fits. Skip it (`sprint.mjs skip N --why "…"`)
   when it needs:
   - a **live application** on a real job site (`status:needs-site`, or a fix
     that can only be judged on the live page and has no saved markup yet).
     A fix that has a fixture copied from the real markup is fine;
   - the owner's accounts, money, a decision the issue doesn't settle, or a
     message to a real person;
   - the owner's real profile, documents or answers (tests use fixtures and the
     sample profile, never `exportAll` output);
   - a running Laya server, when the change can't be tested with the
     classifier off (the classifier is optional: most can);
   - **work in another repo** other than a linked one (below; e.g.
     `TC6IDM/TC6IDM.github.io`): unless the owner asked for exactly that work, then start with
     `--external <that checkout>` (this repo's branch gets no commits; the work
     follows that repo's own CLAUDE.md; `finish N --note … --pr <url>`). The
     guard still asks on every commit there, so an unattended external sprint
     leaves its work uncommitted and says so;
   - more room than is left (`size:M` only with ≥ 2× the average cost free;
     `size:L` only as below). One issue = one part's sub-issue, never a parent.

   **A `size:L` issue** starts only in a keep-going sprint with a fresh window
   (5-hour at most 20%, weekly under 92%), unless asked for now
   (`begin N --asked`). Write its steps as boxes on the issue first and tick
   them as they land. Stuck after two honest tries: `wip/issue-N`, a comment
   saying where it stopped, `skip`.
3. **Begin:** `gh issue view N`, then `sprint.mjs begin N` (exit 4: someone else
   has it now; back to 1), then `node .claude/skills/ezaa-issues/work.mjs start N`.
4. **Build** it as CLAUDE.md asks: the fill pipeline stays pure and unit-tested
   (`resolveFields` over `FieldInfo`), a new field key gets a `rules.test.ts`
   case, a new widget gets a fixture imitating the real ATS markup, nothing
   presses Submit, the classifier stays optional, the password stays a secret.
   Run the checks the change touches: `npm run compile`, the vitest files
   (`npx vitest run tests/unit/<file>`), and the e2e spec when the behaviour only
   shows in a real browser (`npm run test:e2e -- -g "<name>"`; it builds first).
   Tick the issue's boxes as they land.
5. **Commit** when its checks pass, **one commit per issue**: never two issues
   in one commit, never one issue over several. Tooling fixes found on the way
   are their own commit. `git add -A`, look at what is staged (stop and `ask` if
   anything looks like a secret, a real profile, a LinkedIn export or real page
   markup), then
   `git commit -m "<issue title> (#N)" -m "<what changed>" -m "Co-Authored-By: …"`
   and `sprint.mjs finish N --note "<what changed, where>"` (add `--needs-live`
   when only a live job site can show the rest). `finish`:
   - refuses if anything is uncommitted or the last commit doesn't name `#N`;
   - pushes the branch;
   - opens the sprint's PR on the first finished issue, or updates it;
   - rewrites the PR body: Fixes lines, in progress, passed over, and the
     **5-hour and weekly usage**;
   - runs `work.mjs review N`, so the card moves to **In Review** at once;
   - writes what the issue used ("about 4% of the 5-hour window, 1% of the
     week") into that note, and the 5-hour figure into the board's **Usage %**
     field (made on first use). `next` shows each candidate's expected cost
     from those figures (a size's own average once 5 of that size are
     measured, a guess before), and `sprint.mjs sizes` lists the averages and
     any issue whose size label looks wrong.

   Never write or edit the PR body by hand: `sprint.mjs` owns it; Claude's own
   description goes in through `checkpoint --intro-file`. While the sprint works,
   the PR carries `sprint: running` and CI skips it; `checkpoint` takes the label
   off, and that one event runs CI.
6. **Stuck** (checks failing after two honest tries, or it needs a decision):
   move its changes to `wip/issue-N`, comment what was tried and what's left,
   `sprint.mjs skip N --why "…"`, carry on. **Can't land until another issue
   does:** comment which one it rides with, `skip N --why "lands with #M"`, and
   do it in #M's commit, naming both.
7. Back to 1. Run `sprint.mjs budget` after each big step of a long issue too;
   obey the hook the moment it speaks.

### Linked repos: ai-job-search (#57)

One sprint also works `TC6IDM/ai-job-search` (`LINKED_REPOS` in
`../ezaa-issues/config.mjs`). Its issues stay on this board, labelled
`repo:ai-job-search`.
- `start` (or `sprint.mjs link` for a sprint already running) adds a **git
  worktree** at `<Desktop>/ai-job-search-sprint` on a branch named like the
  sprint's (`sprint/<stamp>`), made from that repo's `origin/main`. The owner's
  own checkout (`Desktop/ai-job-search`, often mid-edit on a branch of its own)
  is never switched, committed to, stashed or cleaned.
- `begin N` on a labelled issue says where to work. Build it in the worktree,
  under **that repo's CLAUDE.md**. Its resume and profile content is personal,
  so it never goes into this public repo's issues or PRs, and tests there use
  made-up data.
- Commit there with `git -C "<worktree>" commit -m "<title> (TC6IDM/EzAutoApply#N)" …`.
  The guard allows commits and pushes in that worktree on that branch only.
  It never allows them in the owner's checkout, on its main or to `upstream`,
  and never a force-push.
- `finish N --note …` checks the worktree (clean, last commit names `#N`) and
  pushes it. It opens or updates ai-job-search's own PR (`Fixes TC6IDM/EzAutoApply#N`
  lines), lists the issue under "In ai-job-search" on this repo's PR (never as a
  Fixes line here), and moves the card to In Review.
- `checkpoint` merges that repo's `origin/main` into the worktree. If the merge
  needs judgment it aborts and says so; `ask` about it. Then it updates that PR.
  `end` removes the worktree when it is clean and keeps the branch.

### Winding down (the person asks to stop)

A sprint is never cut off mid-issue; it **winds down**: no new issue, the one in
progress finished properly, then the Checkpoint. "wind down", "wrap up",
`/ezaa-sprint wind down`, or `node .claude/skills/ezaa-sprint/sprint.mjs wind-down`
in any terminal (the hook passes it on), or the Wind down button in the Fleet Office's
Sprint window (#50, which runs the same command and otherwise only reads the state file);
`wind-down --undo` takes it back. An
issue begun but not yet worked on is put back (`skip`, card to Todo, a comment).

## 3. Checkpoint (WRAP after the current issue, STOP at once)

A checkpoint is a pause, not an end. In this order:

1. **Unfinished issue:** back it up:
   `git switch -c wip/issue-N && git add -A && git commit -m "WIP #N: <where it stopped>" && git push -u origin wip/issue-N && git switch <sprint branch>`.
   With keep-going, bring it straight back
   (`git restore --source wip/issue-N --staged --worktree :/ && git reset -q`).
2. **Bring in main:** `git fetch origin main && git merge origin/main`. A
   conflict that needs judgment: `git merge --abort`, `sprint.mjs ask` about it,
   carry on.
3. **The PR:** write what the issues add up to in `<scratchpad>/intro.md`, then
   `sprint.mjs checkpoint --title "<what they add up to>" --intro-file <scratchpad>/intro.md`.
   Nothing finished → no PR, and it says so.
4. **Issues:** finished ones are In Review already. One being given up gets a
   comment with a **Next** section and stays In Progress. Then `work.mjs tidy`.
5. **Pausing (keep-going):** one line to the person (a push notification if the
   tool is there: "paused at 94%, 3 done, PR #P, resuming ~04:50"), no questions,
   then section 4. When the reset is over an hour away, add "a good moment to
   type `/compact`".
6. **Ending** (wound down, or no keep-going): the summary (done, skipped and why,
   the PR, usage at start and end), **then every question collected**
   (`sprint.mjs status`), then `sprint.mjs end`.

## 4. Keep going (only with `--keep-going`)

Under `/loop` (dynamic) a keep-going sprint never ends by itself; only a
wind-down or closing the session ends it.
- **Out of budget:** `ScheduleWakeup` with `delaySeconds = min(3300, resumeInSeconds)`
  from `sprint.mjs budget`, the same prompt, again on each wake until `GO` or
  `SMALL`. Each wake is one `budget` call (plus the Inbox pass when its line says
  so and the verdict isn't `STOP`). **3300 s, not 3600:** the prompt cache lives
  an hour, so a wake at 55 minutes reads the context at a tenth of the price.
- **Nothing left to take:** `ScheduleWakeup` 3300 s, `noop: true`; each wake is
  one `next`.
- Not under `/loop`: it can't wait, so step 3.6, saying when it could resume.

Wakes need the session open and the computer awake. Start an overnight run as
`/loop /ezaa-sprint keep going` on a machine set never to sleep while plugged in.

## Questions wait for the end

Never stop to ask (`AskUserQuestion` or "should I…?") during a sprint: it stalls
for hours. Take the conventional default and note it in the In Review note, or
skip the issue. Collect every question with `sprint.mjs ask "…"`; the end asks
them all. A staged secret or a judgment-call merge conflict: park the issue on
`wip/issue-N`, `ask`, carry on. A permission prompt or refusal: `ask` about the
command so it can be allowed in `.claude/settings.json`.

## Compaction

- **`PreCompact` hook** (`sprint.mjs precompact`) tells the summary what to keep;
  **`SessionStart` (compact)** (`sprint.mjs aftercompact`) tells Claude to re-read
  this file, run `status`, `budget`, `git status`, `git diff --stat` and
  `gh issue view` the current issue before carrying on. Do exactly that.
- `autocompact` only when asked: ask the person to type `/autocompact 200000`
  (Claude can't), and `start --autocompact` sets it for later sessions in
  `.claude/settings.local.json`; `end` puts it back.
- Nothing important lives only in the conversation: commits, ticked boxes and
  the state file hold it.

## Where the usage figures come from

1. **The status line** (first choice): `.claude/settings.json` runs
   `sprint.mjs statusline`; Claude Code hands it `rate_limits.five_hour` /
   `seven_day` on every refresh, it saves them and shows
   "5h 12% · week 4% · sprint #67 · 3 done".
2. **The usage endpoint** (fallback, what `/usage` reads), cached and backed off
   because it rate-limits. Past 20 minutes stale: UNKNOWN, and the sprint
   checkpoints. If `budget` says `stale` while a session is open, the status
   line isn't running.

## Files

- `sprint.mjs`: the commands above; state in `<temp>/ezaa-sprint/state.json`
  (ignored 14 hours after its last step, 8 days with keep-going; deleted by `end`).
- The usage token is this machine's own Claude login, sent only to
  `api.anthropic.com`, never printed or stored.
- Test the whole flow with a fake low line: `start --new-at 12 --stop-at 15`.
