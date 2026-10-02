# EzAutoApply

A browser extension that fills out job applications for you.

You give it your resume once. It parses it into a profile and keeps the original files of your resumes, cover letters and transcripts so it can upload them for you. Then it fills in the application on whatever site you're on when you click **Autofill**. Questions it can't answer are flagged. You answer them once, and from then on those answers fill automatically too.

It works on any site: Greenhouse, Lever, Ashby, Workday, LinkedIn, Indeed and one-off company forms. **It never submits anything.** You review the page and click Submit yourself.

Everything runs on your computer. Your profile and documents are stored in your browser, and the optional classifier (Laya) runs locally too.

---

## Contents

- [How it works](#how-it-works)
- [What Laya and Jev are used for](#what-laya-and-jev-are-used-for)
- [Requirements](#requirements)
- [Setup](#setup)
- [Using it](#using-it)
- [Your data](#your-data)
- [Project layout](#project-layout)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Status and roadmap](#status-and-roadmap)

---

## How it works

```
┌──────────────── Chrome / Edge / Brave extension ─────────────────────┐
│                                                                      │
│  Side panel                       Background service worker          │
│  · Apply: fill this page,   ◄───► · Database (IndexedDB): profile,   │
│    answer what's missing            documents, saved answers         │
│  · Profile, Documents,            · Talks to the classifier          │
│    Answers, Settings                         ▲                       │
│                                              │                       │
│  Content script (in every frame of the job page)                     │
│  · scans fields → decides answers → fills → outlines each field      │
└──────────────────────────────────────────────┼───────────────────────┘
                                               │ HTTP (localhost)
                                  ┌────────────▼─────────────┐
                                  │ Laya (laya-serve, local) │
                                  │ or Jev (cloud, optional) │
                                  └──────────────────────────┘
```

### 1. Your profile

Import a resume (PDF, DOCX or TXT) on the **Profile** tab. The parser:

1. Extracts the text, keeping font size, bold and bullet information (PDFs via pdf.js, Word files via mammoth).
2. Splits it into sections ("Experience", "Work History", "Technical Skills", and so on) using a list of known headings. Headings it doesn't recognize go to the classifier.
3. Breaks each section into entries using date ranges ("Jun 2021 – Present") and bullets, and pulls out titles, companies, schools, degrees, GPA, links and skills.

You can drag the file onto the import box or choose it. You then **review and save**. The parser gets most things right but not everything, so nothing is saved until you confirm it. The profile also holds what resumes don't: work authorization, sponsorship, salary expectations, start date, voluntary EEO answers (which default to "Decline to self-identify"), and the password for job-site accounts (see [Job-site accounts](#job-site-accounts)). Every field stays editable.

#### From LinkedIn

**Profile → Import from LinkedIn** takes either of the two files LinkedIn gives you:

| File | How to get it | What it has |
|---|---|---|
| **Data export** (`.zip`, or the CSV files inside it) | Me → Settings & Privacy → Data privacy → [Get a copy of your data](https://www.linkedin.com/mypreferences/d/download-my-data). Pick the files you want, including Profile. LinkedIn emails you when it's ready. | Everything: name, email, phone, location, summary, websites, every job with its description, schools with degree, field and grade, all skills, certifications, languages, projects |
| **Profile PDF** | On your profile, **More → Save to PDF** | Name, email, phone, location, LinkedIn URL, summary, jobs with descriptions, schools, certifications, languages, and only your top three skills |

The data export is read column by column, so nothing is guessed. The PDF has a fixed layout: a sidebar (contact, top skills, languages, certifications) beside the main column. EzAutoApply reads the two columns separately and tells the parts of each entry apart by font size (company, title, then the date line). A company with several roles is split into one job per role. A LinkedIn PDF dropped on the resume import box is recognized and read the same way. LinkedIn PDFs from before about 2018, which had a single column, go through the resume parser.

If your profile is empty, the import fills it in. If you already imported a resume, the import only adds: jobs, schools and projects you don't have are added, matching ones get their empty fields filled (a job's description, say), and new skills, certifications and languages are appended. Nothing you already have is changed. LinkedIn data with no place in the profile (recommendations, honors, volunteering, publications) is listed and left out. As with a resume, you review everything and then save.

### Documents

Drag resumes, cover letters and transcripts onto the **Documents** tab (or choose them). Each file is sorted by type automatically, from its name ("Cover Letter.pdf") or, failing that, its wording ("Dear Hiring Manager…"). You can change the type afterwards, or drop a file onto a specific section to choose the type yourself.

The original files are stored, and when a form asks for one, it's uploaded under a **standard name** built from your profile name, whatever the file is called on your computer:

| Type | Uploaded as |
|---|---|
| Resume | `Jordan_Rivera_Resume.pdf` |
| Cover letter | `Jordan_Rivera_Cover_Letter.pdf` |
| Transcript | `Jordan_Rivera_Transcript.pdf` |
| Other | `Jordan_Rivera_<document name>.pdf` |

**Settings → Name uploaded files** switches to `Jordan-Rivera-Resume.pdf`, `Jordan Rivera - Resume.pdf`, or the original name. Names are kept to plain ASCII ("José" becomes "Jose"), because some applicant-tracking systems mangle accents.

### 2. Autofill

When you click **Autofill**, every frame of the page is scanned. That includes embedded application iframes and open shadow DOM. Each field (text box, dropdown, radio group, checkbox, custom dropdown, date, password or file upload) gets a label, which comes from its `<label>`, ARIA attributes, the fieldset legend, the section heading, or the text just above it. Each field then goes through these steps, cheapest first:

| Step | What it does | Example |
|---|---|---|
| **Rules** | Recognizes about 60 standard fields from the label, `autocomplete` attribute, name/id and section heading | "First Name", "LinkedIn URL", "Start date" under *Education* |
| **Saved answers** | Looks up answers you gave on earlier applications, by exact or fuzzy match | "Have you worked here before?" |
| **Classifier** | Laya/Jev decides which profile field an unfamiliar question is asking for, or which option matches your answer | "Institution you graduated from" → school |
| **You** | Anything still unknown is outlined in red and listed in the side panel | "Why do you want to work here?" |

Autofill runs in **two passes**. The rules and saved answers fill everything they can immediately. Only the questions left over go to the classifier, which takes a second or so each on a laptop CPU, and those are filled as its answers arrive.

Values go in the way a person would enter them:

- **Text:** the browser's native value setter followed by real input and change events, which React, Vue and Angular forms all accept. Masked inputs that ignore a pasted value (dates like `MM/YYYY`) are typed one character at a time.
- **Choices:** made by clicking.
- **Custom dropdowns:** these are where Workday and react-select differ most. EzAutoApply opens the list (retrying with mousedown or the keyboard for lists that toggle shut on a click), picks the matching option, and confirms the page took it. If the option isn't shown, it types the value and presses **Enter**. That runs Workday's "How did you hear about us?" search, or selects the match in a long "Select One" list. A state abbreviation is typed as the full name ("TX" → "Texas").
- **Split dates:** Workday's separate month and year boxes are filled as one date.
- **Locations:** search-as-you-type boxes (Greenhouse's "Location (City)") get your city typed in, and the suggestion matching your city and province or country is picked. If none matches and there's a **Locate me** button, it's clicked, and Chrome asks you once whether the site may use your location.
- **Yes/No buttons:** pairs of toggle buttons (Ashby) are answered like any other yes/no question.
- **Privacy notices:** links like "Click to read and acknowledge the privacy notice" are opened, and the dialog's **Acknowledge** button is pressed. Each one is listed under *Check these*. Turn this off in Settings.
- **Files:** attached to the upload input. If the widget doesn't react, the file is dropped onto the drop zone instead.
- **Repeating sections:** before filling, EzAutoApply clicks **Add / Add Another** in the Work Experience and Education sections until there's one entry per job and school in your profile, then fills them most recent first. It only clicks buttons that say "Add…" inside those sections, never Save, Next, Continue or Submit.

Fields are outlined by outcome: **green** = filled, **amber** = filled but worth a check, **red dashed** = needs you, **blue** = you changed it.

### 3. Learning answers

Each red field shows up on the side panel's **Apply** tab with an input that matches it (a dropdown for a dropdown, checkboxes for checkboxes, and so on). Every unanswered dropdown, radio and checkbox question is listed, even when the page doesn't mark it required. Workday's "Select One" lists only load their options when opened, so EzAutoApply opens each one briefly to read its options, then closes it without choosing, so you can pick from the real list. **Fill & remember** fills the field and saves the answer. Saved answers are global by default or, if you choose, limited to that one site. If you type an answer directly into the page, the panel offers **Remember this answer** instead.

On later applications, that question, or a rephrasing of it, fills automatically. All saved answers can be edited on the **Answers** tab.

Click a question's title in the side panel to scroll the page to it.

If a field on some site isn't filled correctly, **Copy details** on its card copies what EzAutoApply saw: the label, the options, and the HTML around the field, with every value stripped out. Paste that into a bug report and the site can be fixed precisely.

### Job-site accounts

Workday, iCIMS, Taleo and similar sites make you create an account before applying. Set one password under **Profile → Job site accounts**. A checklist shows the usual requirements (8+ characters, upper and lower case, a number, a special character), and there's a button to generate a strong one. EzAutoApply fills it into "Password" and "Verify password" fields, both when creating an account and when signing in.

The password is handled more carefully than everything else:

- **Where it's used:** it's only handed to pages on known job-account sites (Workday, iCIMS, Taleo, SuccessFactors, Oracle, Jobvite, SmartRecruiters, ADP and others), unless you tick **Also fill it on other sites**.
- **When the page gets it:** only at the moment it's typed in. It never appears in the side panel, in reports, or in saved answers.
- **Where it's stored:** only in this browser. It's never included in backups, and importing a backup keeps the password you already have.

### 4. Multi-page forms

On Workday, LinkedIn Easy Apply and similar forms, new fields appear without a page load. EzAutoApply notices this and either fills the new step automatically or pulses the Autofill button. Which one is a setting.

---

## What Laya and Jev are used for

[**Laya**](https://github.com/NandhaKishorM/laya) is an open-weight (Apache 2.0) *decision model*: a ModernBERT encoder with about 421M parameters that runs locally on CPU. [**Jev**](https://raxxo.shop/blogs/lab/jev-vs-laya-i-tested-both-on-27-decisions) is TypeSafe's hosted model with the same API. Neither one generates text. You give them some text plus a typed question, and they return an answer with a calibrated probability:

- `choice`: pick one label from a list
- `noul`: the probability that a yes/no statement is true
- `score`: a rating on an ordered scale

That's exactly what form-filling needs, and because they never write text, they can't invent an answer. EzAutoApply only calls the classifier for what the rules and saved answers don't already cover:

| Job | How it's asked | What the model sees |
|---|---|---|
| Which group is this field in? (contact, address, links, work authorization, EEO, experience, education, availability and pay, documents and skills, or "other") | one `choice` among 10 groups, for all unknown fields in one batch | Field label, hint, options |
| Which profile field is it? | one `noul` per candidate field from the 2 likeliest groups ("This form field asks for: the applicant's phone number"), all in one request, ranked by probability | Same |
| Which option matches your answer? | `choice` among the page's options | Question, your answer, the options |
| Is this the same question as one you answered before? | `choice` among the closest saved questions | Field and the saved questions |
| A yes/no question your profile can answer ("3+ years with React?") | `noul` | A short summary of your profile. **Always shown for review, never filled silently.** |
| A resume heading the parser doesn't recognize | `choice` | Heading and first lines |

Multiple-choice questions never offer more than 10 labels, because Laya's checkpoints only calibrate their confidence up to 10 options. Picking among the ~50 profile fields uses one yes/no question per candidate instead. Measured on live Laya, that ranks the right field first far more often than one big multiple-choice question.

**Confidence thresholds** (in Settings) decide what happens. At **0.85** or above, the answer is filled. From **0.55** to 0.85, it's filled and marked for review. Below 0.55 it's left for you. A field match also has to lead the runner-up by a clear margin. The classifier is optional: if it's off or not running, the rules and saved answers still work, and everything else is left for you.

**What to expect from Laya out of the box.** On a test set of rephrased questions the rules don't recognize ("Alma mater", "Personal web presence (URL)", a sponsorship question worded as "need an employer to file a petition on your behalf"…), the zero-shot `typed-decisions` checkpoint resolved about half, filled none wrongly, and left the rest for you. Each unknown field takes 1–3 s on a laptop CPU. Answers you give are saved, so each question only needs the classifier (or you) once. Run `npm run smoke:classifier` in `extension/` to see the numbers on your machine.

**Laya vs Jev:** Laya is private (nothing leaves your machine) and free, and it takes about 1 GB of RAM. Jev is a paid cloud service and may be more accurate on unusual questions, but question text and short profile summaries are sent to TypeSafe. Laya is the default.

---

## Requirements

- **Chrome, Edge or Brave** (Chromium-based, Manifest V3)
- **Node.js 22+** to build the extension
- **Python 3.10 to 3.12** for the optional Laya classifier, with about 1.7 GB of disk space (0.8 GB for the PyTorch CPU environment, 0.8 GB for the model)

---

## Setup

### 1. Build and load the extension

```powershell
cd extension
npm install
npm run build
```

Then in Chrome go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `extension\.output\chrome-mv3`. In Edge, go to `edge://extensions` and use the same steps.

For development, `npm run dev` opens a browser with the extension loaded and reloads it whenever you change the code.

### 2. Start Laya (optional, recommended)

```powershell
.\classifier\start.ps1
```

The first run creates `classifier\.venv`, installs CPU-only PyTorch and Laya, and downloads the model (about 0.8 GB). That takes a few minutes. After that it starts in seconds. It serves on `http://127.0.0.1:8000`. Keep the window open while you apply.

Options:

```powershell
.\classifier\start.ps1 -ApiKey "pick-a-secret"   # require a bearer token (also enter it in Settings)
.\classifier\start.ps1 -Port 8001 -Threads 4     # different port / CPU thread cap
```

On macOS or Linux, use `./classifier/start.sh` instead. The script binds Laya to `127.0.0.1`. Laya's own default is `0.0.0.0`, which would expose it to your network.

In the side panel, the dot in the top right turns green when the classifier is reachable. **Settings → Classifier** has the URL, key, checkpoint and thresholds.

### Using Jev instead

In **Settings → Classifier**, choose **Jev (TypeSafe cloud)**, enter the API URL and key from your Jev account, and click **Save & test connection**.

---

## Using it

1. **Open the side panel** by clicking the EzAutoApply toolbar icon.
2. **Profile:** click **Choose resume file** (and/or import your LinkedIn data under **Import from LinkedIn**), check what was parsed, fill in work authorization and preferences, then click **Save profile**.
3. **Documents:** drag in cover letters, transcripts and extra resumes. The original files are stored, the ★ default of each type is what gets uploaded, and uploads get standard names (see [Documents](#documents)). For Workday-style sites, also set a password under **Profile → Job site accounts**.
4. **Go to a job application** and click **Autofill**. You can use the floating ⚡ button on the page, **Alt+Shift+F**, or the button on the side panel's Apply tab.
5. **Apply tab:** answer anything under *Needs your answer*, look over *Check these*, and pick a different resume or cover letter for this application if you want.
6. **Review the page and submit it yourself.**

> If you installed or reloaded the extension while a tab was already open, reload that tab once. Chrome only injects the extension into pages loaded after installation.

---

## Your data

- Everything is stored in the extension's IndexedDB in **this browser profile**. That includes your profile, saved answers, history, and the **original files** of your resumes, cover letters and transcripts, which are kept exactly as you added them, not just their text. Nothing is uploaded anywhere, unless you choose Jev.
- The **Documents** tab lists every stored file. You can open, download, rename or delete each one, or make it the default for its type.
- **Settings → Backup** exports everything (profile, documents, saved answers, history) to a JSON file and imports it again. Use this to move to another browser or computer.
- **Settings → Delete all data** wipes everything.
- Resume and LinkedIn parsing happen in the side panel. The file never leaves your computer.

---

## Project layout

```
EzAutoApply/
├─ extension/                      Chrome MV3 extension (WXT + React + TypeScript)
│  ├─ entrypoints/
│  │  ├─ background.ts             database access, classifier client, per-tab reports
│  │  ├─ content.ts                runs in every frame: Autofill button, scan → fill
│  │  └─ sidepanel/                the side panel UI
│  ├─ src/
│  │  ├─ core/                     profile types, field registry (fieldKeys.ts), option matching
│  │  ├─ fill/                     scanner, label extraction, matching pipeline, fillers
│  │  │  └─ match/                 rules, saved answers, classifier questions
│  │  ├─ classifier/systemone.ts   HTTP client for Laya/Jev (/v1/systemone)
│  │  ├─ parse/                    resume text extraction and parsing, LinkedIn imports
│  │  ├─ content/                  in-page controller, highlights, floating button
│  │  ├─ panel/                    side panel views
│  │  └─ db/                       IndexedDB (Dexie) schema, backup
│  └─ tests/
│     ├─ unit/                     Vitest + happy-dom
│     └─ e2e/                      Playwright with the built extension loaded
└─ classifier/                     Laya setup and start scripts
```

`extension/src/core/fieldKeys.ts` is the central registry. Each standard field is defined there once: its patterns, its description (which doubles as the classifier's label text) and how its value is read from your profile. To teach EzAutoApply a new standard field, add an entry there.

---

## Development

```powershell
cd extension
npm run dev        # browser with hot reload
npm test           # unit tests (Vitest)
npm run test:e2e   # builds, then runs Playwright against the real extension in Chromium
npm run compile    # TypeScript type-check
npm run build      # production build → .output/chrome-mv3
npm run zip        # zip for distribution
```

The first time you run the end-to-end tests, install Playwright's browser with `npx playwright install chromium`. The e2e tests import a resume through the side panel, then autofill a local form that has an iframe, a react-select-style dropdown, radio buttons, a select and a file upload. They also check the remember-an-answer round trip.

To check that Laya is running and see how it handles real questions:

```powershell
npm run smoke:classifier   # in extension/, with classifier\start.ps1 running
```

It sends ten unusual application questions through the same steps the extension uses, then prints each decision, its confidence, and whether it would be filled, marked for review, or left for you.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| The Autofill button doesn't appear | It only shows on pages that look like applications. Use the side panel's **Autofill this page** or **Alt+Shift+F** instead, and check **Settings → Show the Autofill button**. |
| Nothing happens on a tab | Reload the tab (see the note under [Using it](#using-it)). Pages like `chrome://` and the Chrome Web Store can't be autofilled. |
| "Classifier off" | Start `classifier\start.ps1`, then click the dot to open Settings and **Save & test connection**. If you set `-ApiKey`, enter the same key in Settings. |
| `start.ps1` says the port is in use | If it says Laya is already running, it is: nothing to do. If another program has port 8000, run `.\classifier\start.ps1 -Port 8001` and set `http://127.0.0.1:8001` in Settings. |
| A field wasn't filled or picked the wrong option | Use **Copy details** on its card in the side panel and include that in a bug report. |
| Password fields stay red | Set the password under **Profile → Job site accounts**. On a site that isn't a known job-account site, also tick **Also fill it on other sites**. |
| Autofill takes a while with Laya on | Each field the rules don't recognize costs 1–3 s of CPU time the first time. Once you answer it, it's instant from then on. Turn the classifier off in Settings if you prefer speed. |
| The first autofill after starting Laya is slow | The checkpoint loads on first use. The start script preloads it, so wait for "Application startup complete" first. |
| A dropdown wasn't filled | Some custom dropdowns load options from a server as you type. The field is marked red; pick the option on the page and click **Remember this answer**. |
| Resume parsed badly | Scanned (image-only) PDFs have no text to read. Use a text-based PDF or DOCX, and fix the rest on the review screen. |

---

## Status and roadmap

**Working now:** resume import and review; LinkedIn import from the data export or a profile PDF; drag-and-drop documents with automatic type detection and standardized upload names; profile, documents and answer-bank management; job-site account passwords; generic autofill across frames and shadow DOM (text, selects, radio buttons, checkboxes, custom dropdowns including Workday's, split and masked dates, passwords, file uploads with drop-zone fallback); clicking "Add Another" for every job and school; two-pass filling with the Laya/Jev classifier tier and confidence gating; learning answers from the panel and from edits on the page; reading dropdown options so you can answer them; multi-step form detection; per-application document choice; application history; backup and restore.

**Next:**

- Fixes for Workday screens the generic filler doesn't fully handle yet, as they're reported with **Copy details**. The Workday-style handling so far is tested against a page that imitates Workday's widgets, not Workday itself.
- Dedicated handling for LinkedIn Easy Apply, Indeed and Ashby, which use the generic filler today.
- Fine-tuning Laya on your own saved answers. Each answered question becomes a labeled example, and the Laya authors report big accuracy gains from fine-tuning.
- A Firefox build (WXT supports it).
