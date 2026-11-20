---
name: ezaa-issues
description: "Log EzAutoApply work as GitHub issues in the house format: one parent per piece of work with a sub-issue per part (extension, classifier, bridge, agents, tooling, site), the label set, milestones and the Project board. Use whenever the owner mentions a feature, change, bug, idea, task or decision (log it without being asked), when asked to go through the Inbox issue (including TikTok/Instagram/YouTube links in it, which watch-video.mjs turns into frames and captions), and whenever anyone asks to work on, pick up, finish or close an issue (assign it first, In Review when pushed, closed by the merge)."
---

# EzAutoApply's GitHub issues

GitHub issues on `TC6IDM/EzAutoApply` are the to-do list (CLAUDE.md, "Issues and
sprints"). Docs keep the why and the history and link issues by number. Every
repo-specific value (repo, Project number, milestones, labels, board fields) lives
in `config.mjs` in this folder; the scripts read it from there.

Ported 2026-11-17 from Ride The Bus's `rtb-issues`, which came from PTrainr's
`ptrainr-issues`. Fixes made there should be copied here, and the other way round.

## The repo is public

`TC6IDM/EzAutoApply` is a **public** repository. Never put in an issue, a
comment or a PR: the account password or any secret, your address or phone,
real answers from a real application, a real recruiter's or hiring manager's
name, saved page markup that hasn't been redacted, or anything copied from a
LinkedIn export. Describe the field ("Workday year-only graduation date in a
custom wrapper") and keep the evidence on disk (`~/.ezautoapply/incidents/`).

<!-- shared -->

## In this repo

**Other repos.** Work in `ai-job-search` that serves the fleet (`/queue`, a
portal CLI, the tracker, the `/fleet` and `apply-runner` skills, `/answer`) is
logged **here** with `platform:agents`, since that repo came from an upstream
project whose issues belong there. Add **`repo:ai-job-search`** when the code
lands in that repo: the sprint then builds it in its linked worktree and opens
that repo's PR (ezaa-sprint SKILL.md, "Linked repos"). Work on the portfolio
site (`TC6IDM/TC6IDM.github.io`) is logged **here** too, with `platform:site`,
under the Showcase epic: the site's CLAUDE.md keeps its issues on the source
repos' boards (Ride The Bus does the same with its epic #39), and a site commit
names the issue it serves (`… (TC6IDM/EzAutoApply#N)`).

## Labels (every issue gets one of each group that applies)

| Group | Labels |
|---|---|
| Type | `type:epic` (parent), `type:feature`, `type:bug`, `type:task`, `type:research`, `type:decision` |
| Part | `platform:extension` (`extension/`), `platform:classifier` (`classifier/`), `platform:bridge` (`bridge/`, the Fleet Office), `platform:agents` (fleet skills, ai-job-search side), `platform:tooling` (scripts, `.claude/`, CI), `platform:site` (TC6IDM.github.io). A parent carries its children's. |
| Area | `area:scan` `rules` `fillers` `run` `answers` `panel` `parse` `documents` `classifier` `workday` `ats` `privacy` `queue` `fixer` `field-report` `office` `outreach` `a11y` `store` `devx` `docs` `showcase` |
| Priority | `P0` fills something wrong or broken now · `P1` next up · `P2` soon · `P3` nice to have |
| Size | `size:S` ≈ one session · `size:M` two or three · `size:L` a week or more |
| Who | `who:you` (the owner: accounts, decisions, money, a real application) · `who:claude` · `who:together` (a live job site, the owner's accounts) |
| Status | `status:blocked` · `status:needs-decision` · `status:needs-site` (needs a live application page; save its markup into a fixture first if possible) |
| Repo | `repo:ai-job-search` when the code lands in TC6IDM/ai-job-search (`LINKED_REPOS` in `config.mjs`); none for this repo |

`inbox` is only for the pinned Inbox issue. The full list with colours and
descriptions is `LABELS` in `config.mjs`.

## Milestones

`Now: fill accuracy` · `Run to Submit` · `Agent fleet` · `Outreach` ·
`Showcase` · `Later` (in that order; `MILESTONES` in `config.mjs`). A
sub-issue can sit in a different milestone from its parent.

## Titles and bodies

Titles: plain words, the outcome, part first on a sub-issue
(`Extension: …`, `Bridge: …`, `Agents: …`, `Classifier: …`, `Tooling: …`,
`Site: …`, `Decision: …`, `Research: …`).

Parent body:

```markdown
**Source:** owner, <date> (or the doc and section it came from, e.g. docs/agent-fleet-plan.md §6).

## What
<what the person sees or can do, specific enough to build from>

## Today
<what already exists, with file names; say if part is built>

## Rules / open questions
<CLAUDE.md rules it touches (never Submit, classifier optional, the password); decisions still needed, with a recommendation>

## Done when
- [ ] sub-issues done
- [ ] tests (unit case in tests/unit, e2e fixture where the behaviour is in a real browser), CLAUDE.md / README updated
```

Sub-issue body: what this part does, then `- [ ]` steps naming the real files
and checks (`npm run compile`, the vitest file, the e2e spec, a fixture in
`tests/unit/fixtures.ts` or `tests/e2e/pages/`, a `rules.test.ts` case for a new
field key). Say **Blocked by …** at the top when it is. Decision issues list the
options and a recommendation.
