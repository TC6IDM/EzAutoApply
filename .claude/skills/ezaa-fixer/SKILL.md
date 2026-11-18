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
edit only `extension/` there, and can't commit or push. Run by hand, it does the same, or
keeps polling under `/loop`.

## Hard rules

- **Never Submit, never advance a real application, never message a person.** The Fixer
  touches code, tests, saved answers and the fleet build, nothing else.
- **Nothing is committed or pushed without the owner's yes** (CLAUDE.md). A fix lives on a
  `fix/<date>-<slug>` branch in a worktree; the fleet runs on the uncommitted fleet build
  until the owner reviews it. Never commit to `main`, never push to `main`.
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
   No `extension/node_modules` yet → `cd extension && npm ci` first.
   1. **Fixture** from the redacted `domSnippet`: a DOM fixture in `tests/unit/fixtures.ts`
      (or `tests/e2e/pages/<ats>-<widget>.html` when only a real browser shows it).
   2. **Failing test first**: `tests/unit/rules.test.ts` for a missed key (CLAUDE.md: a new
      field key needs a case there), `options.test.ts` for an option mismatch, the widget's
      test file for a filler, `advance.test.ts` for navigation. Run it; see it fail.
   3. **The fix**, where CLAUDE.md's architecture says it belongs: `core/fieldKeys.ts`
      (regex / `variants`), `core/options.ts`, `fill/fillers.ts` / `scan.ts`, `fill/advance.ts`.
   4. **Checks**, all from `extension/` (PowerShell, uppercase `C:\`): `npm run compile`,
      `npm test`, `npm run replay` (no case may get worse; never `EZAA_REPLAY_ACCEPT=1` on
      your own), `npm run build:fleet`.
   5. All green → `POST /fleet/reload`, resolve `fixed` with the note "branch, files, test
      added, replay result". Two honest tries and still red → `git stash` the attempt on the
      branch, resolve `cantFix` with what was tried; the applier fills that one field itself.
6. **Report each fix** as an issue on the board (`ezaa-issues`), redacted as above: the
   ticket's ATS, kind and label, the fix, the branch, and "waiting for the owner's review".
   Then back to 1.

## Budget

The Fixer shares the plan's limits with the appliers. Check `node
.claude/skills/ezaa-sprint/sprint.mjs budget` between tickets: at `WRAP` or above, take no new
code gap (data gaps are cheap and may continue until `STOP`).
