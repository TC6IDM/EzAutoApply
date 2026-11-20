---
name: ezaa-sprint
description: "Work EzAutoApply's GitHub issues one after another, unattended, for as long as the Claude usage budget allows: picks the next issue Claude can do alone, builds and commits it, and checkpoints (push, one PR, issue notes) before the 5-hour or weekly limit runs out. Starts every loop with the Inbox. Never takes someone else's issue; 'mine' limits it to issues assigned to the person, named issues ('12 34 56', 'only 12 34') go first, a label ('only area:workday') narrows it. Use when asked to sprint, burn down the board, 'do as many issues as you can', or work until the limit; '/ezaa-sprint keep going' also waits for the reset and carries on; 'autocompact [tokens]' compacts earlier for that sprint only."
---

# EzAutoApply sprint

Claude takes issues off the board, one at a time, best first, and stops in time to

<!-- shared -->

## In this repo

**What the sprint may not do, beyond the rules above:** publish to the Chrome Web Store, submit or advance a real job application, send a message to a person, touch the owner's real profile data.

**Build and checks.** the fill pipeline stays pure and unit-tested
   (`resolveFields` over `FieldInfo`), a new field key gets a `rules.test.ts`
   case, a new widget gets a fixture imitating the real ATS markup, nothing
   presses Submit, the classifier stays optional, the password stays a secret.
   Run the checks the change touches: `npm run compile`, the vitest files
   (`npx vitest run tests/unit/<file>`), and the e2e spec when the behaviour only
   shows in a real browser (`npm run test:e2e -- -g "<name>"`; it builds first).
   Tick the issue's boxes as they land.

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

