# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

EzAutoApply is a Chrome/Edge MV3 extension (WXT + React + TypeScript + Dexie) that parses a resume into a profile, stores the user's documents, and autofills job applications on any site. It uses an optional local classifier, **Laya**, or its hosted twin **Jev**. These are typed *decision* models (`choice` / `noul` / `score` with calibrated probabilities). They are not generative LLMs, and the user doesn't want generative text in this product. See README.md for user-facing docs.

Ground rules:
- **Never `git commit` or `git push` without the user's explicit approval for that specific commit or push.**
- The extension never submits or advances on its own. Autofill never clicks Next/Submit/Sign In. The side panel's **Advance** button (`fill/advance.ts`) presses the page's own button, and only when the user presses Advance. Filling only happens when the user acts.
- The classifier must stay optional. Rules and saved answers must work with it off or unreachable.
- The job-site account password is a secret: never put it in reports, saved answers, backups, or messages other than `getSecret`.

## Commands

All extension commands run from `extension/`:

```powershell
npm run dev                 # browser with the extension loaded + hot reload
npm run build               # → .output/chrome-mv3 (load unpacked from here)
npm run compile             # tsc --noEmit (TypeScript 7)
npm test                    # Vitest unit tests (tests/unit, happy-dom)
npx vitest run tests/unit/rules.test.ts -t "Phone"    # single file / single test
npm run test:e2e            # wxt build + Playwright (tests/e2e) with the real extension in Chromium
npx playwright test -g "side panel"                   # single e2e test (build first)
npm run smoke:classifier    # live Laya check; needs classifier running
npm run icons               # regenerate public/icon/*.png (scripts/make-icons.mjs)
```

Laya server: `classifier\start.ps1` (or `start.sh`). The first run creates `classifier/.venv` (Python 3.12, CPU-only torch, `laya[serve]`) and downloads the model. It serves `http://127.0.0.1:8000` with the `typed-decisions` checkpoint preloaded. There is no linter configured.

## Architecture

### Three contexts, one message protocol (`src/messages.ts`)
- **Content script** (`entrypoints/content.ts` → `src/content/controller.ts`) runs in *every frame* (`allFrames`). It scans and fills only its own frame. It runs in the page's origin, so it **cannot reach the extension's IndexedDB**. Profile, answers, documents (base64) and classifier calls all go through the background.
- **Background** (`entrypoints/background.ts`) owns the DB and the classifier client. It routes messages by `sender.url` (extension page vs. web page), **not** by `sender.tab`, because the side panel opened as a tab has a `tab`. Per-tab fill reports live in `storage.session`, keyed by tab and then by frame, and are written through `updateTab()` (a per-tab lock) because frames report concurrently. `tabs.sendMessage({type:'autofill'})` broadcasts to all frames and resolves when the *first* frame responds, so the others may still be running.
- **Side panel** (`entrypoints/sidepanel` → `src/panel/`) is an extension page. It uses Dexie directly (`useLiveQuery`) and gets tab state via messages and `tabStateChanged` broadcasts. All five views stay mounted (inactive ones `hidden`) so unsaved Profile edits survive tab switches; views get `active`, and Profile re-reads the DB when shown without unsaved edits. Settings save as they change through `db › updateSettings` (read-modify-write, so the Profile's `passwordOnAnySite` isn't overwritten); the account password is saved with **Save profile**. Single deletes (document, answer) happen at once with an Undo toast (`ui › useUndo`, `restoreDocument`/`restoreAnswer`). Colours are OKLCH tokens in `styles.css`; the floating button and field flash can't read them, so `src/content/palette.ts` mirrors them.

### Fill pipeline
`scan.ts` (+ `labels.ts`) turns the DOM into `FieldDescriptor`s. `labelFor` ignores widget text like "Select One Required" (Workday's button names) and checks the `formField-…` container's `<label>`; section context includes Workday container ids (`workExperience-1`) as well as headings. These include radio and checkbox *groups*, ARIA comboboxes (anything with `aria-haspopup=listbox`, e.g. Workday "Select One" buttons and Material-UI selects), toggle-button groups (sibling `aria-pressed` buttons such as Ashby's Yes/No, scanned as `radio` with their hidden backing input folded in), hidden file inputs, password inputs, split month/day/year date boxes grouped into one field with `segments` (Workday's `dateSection*-input`; a lone year box in a `dateInputWrapper` is a year-only date, labelled from its `formField` container rather than the "current value is YYYY" help text before it), and fields in open shadow roots. Workday's hidden id input next to each "Select One" button is skipped. Ids are stored in the `data-ezaa-id` attribute and stay stable across rescans. `pipeline.ts › resolveFields` is **pure logic over DOM-free `FieldInfo`**, so it's unit-testable. It runs these tiers in order:

1. already has a value → `prefilled`
2. **rules** (`match/rules.ts`)
3. **answer bank** (`match/answerBank.ts`), fuzzy match; when a classifier is available, borderline matches are confirmed by it
4. **classifier** (`match/classify.ts`): `classifyGroups` (one batched `choice` over 10 groups) → `likelyGroups` (top 2, *ignoring "other"*, which Laya over-predicts) → `rankKeys` (one `noul` per candidate key in a single request) → accept if P ≥ `reviewThreshold` and it leads the runner-up by `KEY_MARGIN`
5. derived yes/no from `profileFacts` (always `review`)
6. otherwise `needs` (if required, or if it's a choice kind: select/radio/combobox/checkboxGroup), else `skipped`

The controller (`src/content/controller.ts`) runs this in **two passes**: pass 1 with `classifier: null` fills instantly, then only pass-1 leftovers (`source === 'none'`) are re-resolved with the classifier. Before pass 1 comes a **pass 0 for file fields**: many sites read an uploaded resume and fill the form from it (often wrongly), so documents are uploaded first, `settle()` waits for the page to go quiet (no childList/text mutations for 1.5 s and no "Parsing your resume…" text, 15 s max), then the page is rescanned. Pre-filled fields carry `current` (their text) and `touched` (the user typed/clicked in them: trusted events only, tracked in `userOwned`, plus anything answered from the panel). In `resolveFields`, a pre-filled field matched by a rule in a resume-ish category whose `current` doesn't `agrees()` with the profile is replaced (status `review`, note says what the site had) when `settings.fixSiteValues` is on and it isn't `touched`. Pre-filled repeat fields still consume their entry index, and a site-added entry beyond the profile's count is flagged on its `expCompany`/`school` field. Before either pass, `fill/repeat.ts › expandRepeatingSections` clicks "Add / Add Another" in Work Experience and Education until there's one entry per profile entry (it refuses anything matching Save/Next/Continue/Submit). After filling, unanswered comboboxes are opened and closed by `readDropdownOptions` so the panel can offer their options. Fields that vanished during filling are dropped from the report. Before filling, `fill/consent.ts` opens "read and acknowledge the privacy notice" links and presses Acknowledge in a privacy/data-protection dialog (setting `acknowledgePrivacyNotices`). Section context also uses enclosing fieldset legends and `entryKind` (a 3–8 field block that asks for an employer → "experience").

`fillers.ts` then writes the values:

- **Text:** `setNativeValue` (the prototype setter, so React's value tracker notices) plus input/change events. If the value doesn't stick (masked inputs), it falls back to `typeLikeUser`, one character at a time; dates compare by digits.
- **Radios and checkboxes:** clicked.
- **Comboboxes** (`fillCombobox`): Workday mounts a fresh list per dropdown without `aria-controls`, so a field's options are `optionsOf(el, before)`: its `aria-controls` list, else options that weren't showing before it opened (`closeStrayLists` snapshots them and closes leftovers first). `openList` tries click, then mousedown, then the keyboard; `closeList` tries Escape, then click / mousedown / click toggles. Options are read with `optionText` (`aria-label`, then `data-automation-label`, then text). On no match, it types the value and presses Enter (Workday search prompts search only on Enter; type-ahead lists select on Enter). After clicking, `looksChosen` (compared against a before-snapshot) checks the selection took; otherwise it presses Enter on the option, and if it still can't confirm, returns `uncertain`, which becomes `review`.
- **Opening dropdowns** (`openList`): click, then the widget's own toggle/arrow button (`toggleButtonFor`; Greenhouse's react-select ignores synthetic events on the input but opens from "Toggle flyout"), then mousedown, then keys. Search boxes are typed with `typeSearch` (per-character `InputEvent`s; Greenhouse's location search ignores a value set at once). `keyTarget` only follows focus inside the widget or an open list.
- **Workday search prompts** (`fillPrompt`): School, Field of Study, Skills and "How did you hear" on live pages are a plain `<input data-uxi-widget-type="selectinput">` inside `[data-automation-id="multiSelectContainer"]` (no role, no automation id; `scan.ts › isSearchPrompt`). Choices show as `[data-automation-id="selectedItem"]` pills inside a `selectedItemList` listbox (`promptChoices`; these are excluded from `pageOptions`). `searchPrompt` types the full value, presses Enter and waits for *this* search's answer: a new pill (Workday picks a lone result itself), a "No Items." list, or new rows that match (non-matching rows only count once they've stopped changing for 1.2 s). It then clicks the result's inner `promptOption`, falling back to ArrowDown+Enter only while the result still shows unchosen. List values (skills) are added one by one, skipping existing pills. Close matches (score < 0.9) come back `uncertain` with a `note`. Prompts are `multiple`, and a list key still fills a prompt that already has pills.
- **Fallback answers:** a key with `fallbacks`/`anyOption` (only `howHeard`) picks "Other", then a generic source, then any option when its value isn't offered: `pipeline.plan` for selects/radios, `fillCombobox` from the list as it opened, `fillPrompt` by searching the first three fallbacks and then `browsePrompt`. Always `review`.
- **Which list is whose:** with no `aria-controls`, a dropdown's options are those that appeared after opening it. `nearestList` keeps the list nearest the field when several show, and `listOwners`/`heldByOther` stop a list read for one dropdown from being taken for another while it still shows the same options (a slow list reopening late used to give the panel the wrong options). Field ids are de-duplicated per scan, since pages that clone a block copy `data-ezaa-id`.
- **Files:** set via `DataTransfer` on the input. If the file name doesn't show up around the drop zone, a synthetic drop on the zone follows.
- **Passwords:** a `SecretRef`, fetched from the background with `getSecret` only at fill time.

### `src/core/fieldKeys.ts` is the central registry
Every canonical field (~60) has label/attr/exclude regexes, an optional `section` / `notSection` gate, `maxWords`, autocomplete tokens, a `valueType`, and a `resolve(ctx)` that returns a value, `null` (not in the profile), or `{ uncertain }` (forces review). Rule scoring is the longest match, plus a bonus when the section gate matches. `kindAccepts` controls which field kinds a key may fill. `repeat` keys (experience/education entries) pick their entry by occurrence order. `noClassify` hides keys from the classifier. `description` doubles as the classifier's criteria text. To add a field, add an entry here and a case in `tests/unit/rules.test.ts`.

Option matching (`core/options.ts`) is deterministic and runs before any model call. It handles yes/no phrasing, country/state canonicalization (`core/geo.ts`), EEO concept groups, degree levels, numeric ranges, and per-key `variants`.

### Laya specifics (verified against live laya-serve 0.3.23)
- `POST /v1/systemone`. The response is `answers[qid] = { choice, probabilities, answer_confidence }` or `{ noul }`. Gate on `answer_confidence` (see `choiceConfidence`). `/v1/systemone/batch` takes ≤64 states sharing one question set.
- The checkpoint's confidence is **uncalibrated for `choice` questions with 11 or more options**. Keep every `choice` at 10 or fewer labels; a test enforces this.
- `model: 'typed-decisions'` is sent only when the provider is `laya`. Default thresholds are 0.85 (auto) and 0.55 (review). CPU latency is ~0.3–0.6 s per request, and ~1–3 s per unknown field including key ranking.

### Resume parsing (`src/parse/`)
`extract.ts` turns PDF (pdf.js v6, with font size and bold resolved from `commonObjs`), DOCX (mammoth → HTML) or TXT into `TextLine[]`. PDF lines also carry `width` and `gap` (space above), computed by the pure `pdfItemsToLines`. `resume.ts` is heuristic. It splits sections by heading synonyms or all-caps/bold/larger lines (the first line is the name and is never a heading), splits entries by date ranges and bullets, and only splits "X at Y" when X looks like a job title. Unknown headings can go to the classifier. Results always go through the review screen in `ProfileView` before saving.

`linkedin.ts` imports LinkedIn data in two forms. The **data export** is a ZIP (read with fflate's `unzipSync`) or loose CSVs. Files are keyed by `exportFileKey` (`Email Addresses.csv` → `emailaddresses`) and columns by lowercase alphanumerics (`Started On` → `startedon`). The **Save to PDF** file is detected in `extract.ts › linkedInSplit`: a "Contact"/"Top Skills" sidebar heading, a larger Summary/Experience/Education heading to its right, and a "Page N of M" footer. Its lines are emitted main column first, then sidebar, tagged with `column`. In the real files the sidebar is at x≈22 and the main column at x≈224. Sizes are: name 26pt, main headings 15.75pt, sidebar headings 13pt, company/school 12pt, title 11.5pt, dates/descriptions 10.5pt. Sidebar wraps are about 1.2× the font size apart, versus about 1.7× between entries. Paragraph breaks come from line width. Pre-2018 single-column LinkedIn PDFs aren't detected and fall through to the resume parser. `merge.ts › mergeParsed` has `replace` / `fillEmpty` (resume import into an existing profile) / `combine` (LinkedIn into an existing profile: adds missing jobs/schools/projects matched by `sameJob`/`sameSchool`, fills empty fields of matches, unions skills).

### Storage (`src/db/index.ts`)
Dexie database `ezautoapply`. Documents keep the **original file Blob**, original `fileName` and extracted text, with one `isDefault` per kind (`changeDocumentKind` keeps that invariant). The name employers receive is derived at upload time by `core/documents.ts › uploadFileName` (profile name + `settings.fileNameFormat`, e.g. `Jordan_Rivera_Resume.pdf`); `guessDocKind` sorts dropped files. The account password lives in kv `accountPassword`: excluded from `exportAll`, preserved by `importAll`, and only returned by the background's `getSecret` to frames whose own URL passes `core/sites.ts › isAccountSite` (or when `settings.passwordOnAnySite`). A per-tab `DocSelection` (including `'none'`) overrides the default. Answers are upserted by (normalized question, scope), where scope is `'global'` or a hostname. `exportAll`/`importAll` round-trip everything, with files as base64.

## Testing notes
- `tests/unit/db.test.ts` uses `// @vitest-environment node` because happy-dom's Blob doesn't survive fake-indexeddb cloning.
- Combobox no-match tests wait out real timeouts (~3 s).
- E2E uses Playwright's bundled Chromium (`channel: 'chromium'`), because branded Chrome ignores `--load-extension`. Tests trigger autofill by calling `chrome.tabs.sendMessage` from the service worker (`worker.evaluate`), drive the side panel at `chrome-extension://<id>/sidepanel.html`, and serve fixtures from `tests/e2e/pages`. Run `npx playwright install chromium` once.
- `mountWorkdayPrompt` (fixtures) and `tests/e2e/pages/workday-experience.html` copy the live Workday "My Experience" markup (saved September 2026) for the School/Field of Study/Skills prompts and year-only dates. `tests/unit/controller.test.ts` drives the controller against a stand-in background, including a fake resume reader that overwrites fields after upload.
- `tests/unit/fixtures.ts` has DOM fixtures imitating real ATS markup (Greenhouse-like form, react-select-style combobox, React value-tracker shim, Workday search prompt and "Select One" list that toggles on mousedown+click and ignores option clicks). `tests/unit/workday.test.ts` covers the Workday behaviours; `tests/e2e/pages/workday.html` is the same in a real browser.
- E2E tests call `classifierOff()` so they don't depend on a local Laya; the last test runs only when Laya answers on port 8000.
- `tests/unit/linkedin.test.ts` builds export ZIPs with fflate's `zipSync`, and has a synthetic `PdfItem[][]` laid out with the coordinates, sizes and spacing of real LinkedIn PDFs. Don't commit real LinkedIn PDFs; they contain people's personal data.
- When editing files from the shell on this Windows setup, inline heredoc scripts can mangle backslashes (`\b` became a literal backspace). Write such scripts to a file first, or use the editor, for anything containing regexes.
