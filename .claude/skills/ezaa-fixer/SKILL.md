---
name: ezaa-fixer
description: The fleet's live Fixer (#32). Takes the bridge's open tickets (incidents grouped by site, kind and question), sorts each into a data gap (answer it as an unapproved agent answer) or a code gap (fixture, failing test, fix, tests, replay, fleet build, reload), and writes a resolution on the ticket. Use when asked to run the Fixer, work the incidents or tickets, or "fix what the fleet couldn't fill"; under /loop it keeps polling.
---

# The Fixer

The appliers file an **incident** for every field the extension couldn't fill (`needs`,
"The site says…", a widget that didn't take, a page that wouldn't move). The bridge groups
them into **tickets** by `(ats, kind, normalized label)`, so the same question on ten
Greenhouse forms is one ticket. This skill works those tickets, one at a time, while the
fleet runs, so the next application on that site already fills the field. Plan:
`docs/agent-fleet-plan.md` §8.3.

**Started by the bridge (#69).** Nobody has to type `/ezaa-fixer`: a little after an incident
opens a ticket, the bridge starts one headless Opus with this skill, in the Fixer's worktree
(`../EzAutoApply-fix`, made from `origin/main` the first time), and starts it again when
tickets came in while it worked. Started that way, work every open ticket, then stop. It can
edit only `extension/` there. Run by hand, it does the same, or keeps polling under `/loop`.

**Its own PR (#101, owner 2026-11-19).** Each working fix is one commit on the worktree's
`fix/…` branch, pushed at once; the first push opens the PR. The owner may stop the fleet at
any moment and merge that PR as it stands, so **every commit must leave the extension working**.
At each start the bridge picks the branch: while the PR isn't merged it carries on there; once
main has it, a fresh `fix/<date>-fleet` from `origin/main`, with any uncommitted leftovers brought
along (or left in `git stash` when they don't apply, which the prompt says).

## Hard rules

- **Never Submit, never advance a real application, never message a person.** The Fixer
  touches code, tests, saved answers and the fleet build, nothing else.
- **Only its own branch and PR** (CLAUDE.md's standing exception, #101). Commit and push the
  worktree's `fix/…` branch and open or comment on its PR; nothing else. Never commit to or push
  `main`, never merge, never force-push, never amend or rebase a pushed commit
  (`guard.mjs` refuses those anyway). Run by hand outside the bridge, ask before committing.
- **A commit is a working version.** One fix per commit, committed only when
  `npm --prefix extension run compile`, `npm --prefix extension test` and
  `npm --prefix extension run replay` all pass with it in. Never half a fix, never a red test
  "to fix in the next commit".
- **Only the fleet build reloads.** `npm run build:fleet` → `.output/fleet-chrome-mv3`, loaded
  in the fleet's profile. The owner's own copy never changes behind their back
  (`obeysReload` in `src/bridge/client.ts` ignores the command in any other build).
- **Nothing personal leaves the machine.** Incidents are already redacted
  (`{{placeholders}}`); keep them that way. A fixture built from a `domSnippet` keeps the
  placeholders or swaps in the sample profile, never real values. An issue, branch name or
  commit message names the field and the ATS ("Lever: 'Notice period' unmatched"), never a
  company's applicant, a recruiter, an answer or the owner's details. The repo is public.
- **The classifier stays optional.** A fix must work with Laya off.
- **Attestations are never answered** (criminal record, "I certify…", e-signatures,
  non-competes, "related to an employee"): resolve as `needsYou`.
- **Obey the switch.** Read `GET /settings` before each ticket; `parts.fixer: false` means
  stop taking tickets (finish nothing half-way: leave the worktree as it is and say so).

## The bridge calls

Always through the helper, which reads the token itself (never print or read the token) and
allows only these calls:
`node .claude/skills/ezaa-fixer/bridge.mjs <METHOD> <path> ['<json>' | --file <path>]`, e.g.
`node .claude/skills/ezaa-fixer/bridge.mjs GET 'tickets?open=1'`. Write paths without the
leading slash (Git Bash rewrites `/tickets` into a Windows path; the helper undoes it anyway).

| Call | What |
|---|---|
| `GET /settings` | the fleet switches; `parts.fixer` |
| `GET /tickets?open=1` | open tickets, newest first: `key, ats, kind, label, count, first, last, incidents, jobIds, resolution, open` |
| `GET /tickets/:key` | the ticket plus `details`: its incident files (field, options, `domSnippet`, `siteMessage`, `note`) |
| `POST /tickets/:key/resolution {outcome, note}` | `outcome`: `fixed`, `answered`, `cantFix`, `needsYou`. A later incident on the same ticket opens it again (the fix didn't hold). |
| `POST /answers {jobId, fieldId, frameId?, answer, save: {scope, sourceRefs?, createdBy: 'fixer'}}` | fill the field on the job's open tab and save it as an agent's answer, unapproved |
| `POST /fleet/reload` | the fleet build reloads; running Runs resume (`resumeRuns`) |

## The loop

1. `GET /settings`; stop if `parts.fixer` is off. `GET /tickets?open=1`; nothing open → wait
   (under `/loop`, `ScheduleWakeup` 600–1200 s) and look again.
2. Take the open ticket with the most incidents (ties: newest). `GET /tickets/:key`.
3. **Triage**, from the label, kind, options, snippet and site message:
   - **Data gap**: the question is understood, the owner's records just don't answer it
     ("Willing to work weekends?"). → step 4.
   - **Code gap**: a known key wasn't recognised ("Mobile #" for `phone`), the value was right
     but no option matched, a widget didn't take the value, or Next wasn't found. → step 5.
     A `handFilled` ticket whose field status is `notScanned` is a field the scan **never
     found** (an applier filled it by hand; the extension then saved its markup, #98): a scan
     gap in `fill/scan.ts` / `fill/labels.ts`. Its snippet is the fixture; the failing test is
     that `scanFields` doesn't list it. `seen` means the scan found it but nothing filled it.
   - **Attestation, or nothing in the records supports an answer** → `needsYou`, with a note
     saying what to answer.
4. **Data gap.** Find the answer in the knowledge layer (ai-job-search's profile files and the
   answer bank); never guess. For a choice field pick an offered option exactly. If a job in
   `jobIds` still has its tab open, `POST /answers` with `save: {scope: 'global', sourceRefs,
   createdBy: 'fixer'}`: it fills there and is saved unapproved, so it fills as `review` until
   the owner approves it in Answers. Resolve `answered` with the source in the note. No open
   tab to answer on → `needsYou` with the proposed answer and its source in the note.
5. **Code gap**, in a worktree so the owner's checkout is never touched. Started by the bridge,
   you are already in it. Run by hand:
   ```bash
   git worktree add ../EzAutoApply-fix -b fix/<yyyy-mm-dd>-<slug> origin/main   # once; reuse it after
   ```
   **Every command from the worktree's root, one per call, with the Bash tool** (#89): never
   `cd`, `Set-Location`, `&&`, `;`, `|` or `$()`. A headless run refuses them and nobody is
   there to approve. No `extension/node_modules` yet → `npm ci --prefix extension --no-audit --no-fund`.
   1. **Fixture** from the redacted `domSnippet`: a DOM fixture in `tests/unit/fixtures.ts`
      (or `tests/e2e/pages/<ats>-<widget>.html` when only a real browser shows it).
   2. **Failing test first**: `tests/unit/rules.test.ts` for a missed key (CLAUDE.md: a new
      field key needs a case there), `options.test.ts` for an option mismatch, the widget's
      test file for a filler, `advance.test.ts` for navigation. Run it; see it fail.
   3. **The fix**, where CLAUDE.md's architecture says it belongs: `core/fieldKeys.ts`
      (regex / `variants`), `core/options.ts`, `fill/fillers.ts` / `scan.ts`, `fill/advance.ts`.
   4. **Checks**, each from the root through `npm --prefix extension`: one test file is
      `npm --prefix extension test -- tests/unit/<file>.test.ts -t "<name>"`; then
      `npm --prefix extension run compile`, `npm --prefix extension test`,
      `npm --prefix extension run replay` (no case may get worse; never `EZAA_REPLAY_ACCEPT=1`
      on your own), `npm --prefix extension run build:fleet`. (`npx vitest` from the root
      fetches a vitest without the extension's packages.)
   5. All green → commit and push, one plain command each:
      `git add extension`, `git commit -m "Fixer: <ATS> '<label>' <what changed> (ticket <key>)"`,
      `git push -u origin <branch>`. No PR yet (`gh pr view` says none) →
      `gh pr create --base main --head <branch> --title "Fixer: fixes from the fleet's tickets" --body "…"`;
      later fixes only push, plus `gh pr comment` with one line for the fix. Then
      `POST /fleet/reload` and resolve `fixed` with the note "commit, PR, files, test added,
      replay result". Two honest tries and still red → `git stash push -m "<ticket key>"` so the
      tree is clean for the next ticket, resolve `cantFix` with what was tried; the applier
      fills that one field itself.
6. Back to 1. The PR is the record of the fixes; no separate issue per fix. The PR body and
   comments follow the public-repo rules above.

## Budget

The Fixer shares the plan's limits with the appliers. Check `node
.claude/skills/ezaa-sprint/sprint.mjs budget` between tickets: at `WRAP` or above, take no new
code gap (data gaps are cheap and may continue until `STOP`).
