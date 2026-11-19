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

## Log without being asked

**Whenever the owner mentions something that should be built, changed, fixed,
decided or checked, create the issues straight away**, in the same turn, and
say which numbers were made, without asking first. That includes a passing
remark ("the floating button should show the page count too"), a screenshot of
a field that filled wrong, a decision with work behind it, and a gap you find
yourself while working.

Before creating, search so nothing is logged twice:
`gh issue list --repo TC6IDM/EzAutoApply --state all --search "<words>"`. If one
exists, add a comment with the new detail instead (and reopen it if needed).

Don't log: questions answered on the spot, work finished in the same change
(say `Fixes #N` if it had an issue), or anything the owner says not to track.

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

## The shape

- **One part:** a single issue.
- **Several parts:** a **parent** (`type:epic`) holding the spec, why, and
  "done when", and **one sub-issue per part** (Extension, Classifier, Bridge,
  Agents, Tooling, Site) holding that part's files, steps and checks.
- **Accounts, money, decisions:** no platform label; group related ones under a
  parent epic too.
- A sub-issue is made with `--parent <number>`; GitHub then shows it under the
  parent with a progress bar.

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

## Commands

```bash
R=TC6IDM/EzAutoApply
gh issue create --repo $R --title "…" --body-file body.md \
  --label type:feature --label platform:extension --label area:fillers \
  --label P2 --label size:S --label who:claude \
  --milestone "Now: fill accuracy" [--parent 12]
gh issue edit 81 --repo $R --add-label status:blocked
gh issue comment 81 --repo $R --body "…"
node .claude/skills/ezaa-issues/sync-board.mjs        # board fields from labels
```

**Many at once:** write them in the format of `create-issues.mjs` (`@@@ key`,
`parent:`, `title:`, `labels:`, `milestone:` (a key from `MILESTONES`), `---`,
body) and run `node .claude/skills/ezaa-issues/create-issues.mjs <file.txt>`.
It validates labels and parents first, creates missing labels and milestones,
makes parents before children, and is resumable (`<file>.created.json`).

## The Project board

The "EzAutoApply" Project: https://github.com/users/TC6IDM/projects/5 (`PROJECT`
in `config.mjs`). It is a copy of PTrainr's board (`copyProjectV2`), so the views'
grouping and sort came with it; only the Platform/Who options and the Now and
Needs you filters were changed. Its Priority, Size, Who, Platform and Kind fields mirror the
labels but are **not** filled automatically, so after creating issues run
`sync-board.mjs` (it also adds any open issue the board is missing, and only
fills empty fields).

Views:
- **Overview:** top-level items (sub-issues fold under their parent), grouped
  by milestone, sorted by priority, with each parent's progress bar.
- **Now:** a board (Todo / In Progress / In Review / Done) of the current
  milestone without parents.
- **Needs you:** `who:you,together -kind:Epic is:open`, by milestone.
- **By platform:** `-kind:Epic is:open`, grouped by Platform (the part of the repo).
- **My work:** `assignee:@me is:open -status:Done`, by milestone, hierarchy off.

**Setting up or checking the board:** `node .claude/skills/ezaa-issues/bootstrap.mjs [--dry]`
makes the labels, milestones, board (a copy of `BOARD.template`, retuned to
`BOARD` in `config.mjs`), the repo link, `PROJECT` and the pinned Inbox, and
changes only what differs, so a re-run on a matching board does nothing.
`--new-board` copies a fresh board even when `PROJECT` names one.

The API sets a view's name, layout, filter and columns, but not its grouping or
sort; those are set by hand in the view's menu, or come with `copyProjectV2`.
The "Auto-add to project" workflow is tied to a repo and doesn't copy: it is
turned on by hand (Workflows → Auto-add, repo EzAutoApply, `is:issue is:open`).

Status columns: **Todo → In Progress** (`work.mjs start`) **→ In Review**
(`work.mjs review`: done and pushed, the PR not merged yet) **→ Done** (the
merge closes the issue; the board's "Item closed" workflow moves the card).

## Working an issue: assign, then close

1. **Before touching code:** `gh issue view N`, then
   `node .claude/skills/ezaa-issues/work.mjs start N`. It assigns the issue to
   the person asking (`--to <login>` for someone else), moves the card to
   **In Progress**, reopens it if it was closed, and comments who started it.
   Working a parent means starting the sub-issue being done. A parent's owner
   owns its sub-issues: `work.mjs assign-down [N]` fills empty assignees from
   the nearest assigned parent (`start` on a parent and every `tidy` run it).
2. **While working:** tick the issue's `- [ ]` boxes as each lands; put
   findings and decisions in a comment; log new work found along the way as
   new issues (don't widen this one).
3. **When it's done and pushed** (built, `npm run compile` and the touched tests
   passing, CLAUDE.md updated if behaviour changed, the PR open):
   `work.mjs review N --note "…"`. The issue **stays open** and its card moves to
   **In Review**. The PR says `Fixes #N`, so the merge into `main` closes it.
   Pushing still needs the owner's yes (CLAUDE.md), except inside a sprint.
4. **Work with no PR to wait for** (an account, a decision, research):
   `work.mjs done N --note "…"` closes it, moves the card to Done, and closes the
   parent once its last sub-issue is closed.
5. **After opening a PR and after a merge:** `work.mjs tidy` moves every closed
   issue's card to Done, closes parents whose sub-issues are all closed, and
   archives done cards. The sprint runs it at its start too.
6. **Only a live-site check left?** That counts as done: close it (or let the
   merge close it) with "not yet checked on a live job site" in the note
   (`sprint.mjs finish N --needs-live`). Fixtures copied from real markup are
   the check a machine can do.
7. **Not finished?** Leave it open and assigned, with a comment saying where it
   stopped. Never close something that isn't done.

`--dry` on either command prints what it would do without changing anything.
Moving cards needs the `project` scope on `gh` (`gh auth refresh -s project,read:project`);
without it, the assign and close still happen and the script stops at the board step; say so.

## The Inbox issue

The pinned issue labelled `inbox` collects raw ideas from the phone. GitHub issue
comments cannot be threaded, so **never reply with a new comment: write what
each comment became under that comment.** `inbox.mjs` does it:

1. `node .claude/skills/ezaa-issues/inbox.mjs fold`: first, merge any stand-in
   replies left by an earlier pass.
2. `node .claude/skills/ezaa-issues/inbox.mjs pending`: the comments not yet
   logged, with their ids.
3. For each: **look for an existing issue first** (below), then create or
   update issues as above.
4. `node .claude/skills/ezaa-issues/inbox.mjs log <commentId> --text "#31 … (Bridge #32)"`
   appends `✅ Logged: …` under the comment, or `already #N (added this detail there)`.
   It refuses a comment already logged, so two passes at once can't log it twice;
   `--add` appends a later follow-up on purpose.

The SessionStart hook (`inbox.mjs count --hook`) says when something is waiting;
mention it to the owner. A sprint does the Inbox pass between issues.

### Duplicates: the Inbox repeats itself
Search open **and closed** issues with two or three wordings (the feature's
name, the site or widget it is on, the problem it solves), and read the earlier
`✅ Logged:` lines in the Inbox. If it exists: add the new detail as a comment on
that issue (reopen it if needed) and log the Inbox comment as `already #N`.

### Links to videos (TikTok, Instagram reels, YouTube Shorts)
`node .claude/skills/ezaa-issues/watch-video.mjs <url>` downloads the video into
a new temp folder and writes `summary.txt`, `contact.jpg` (a frame sheet),
`last.jpg`, `frames/` and `captions.txt` when there are captions. Read the
images with Read. It fetches yt-dlp and ffmpeg itself, checked against their
published SHA-256 sums, into a per-user tools folder outside the repo. Instagram
usually needs `--cookies-from-browser firefox`; if downloading fails, use
`--file <path>` or open the link with Claude in Chrome. In the issue, say what
the video claimed and check each claim against EzAutoApply before turning it
into work.
