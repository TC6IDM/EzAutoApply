import { useEffect, useRef, useState } from 'react';
import {
  DECLINE,
  type Education,
  emptyEducation,
  emptyExperience,
  emptyProject,
  type Experience,
  type Profile,
  type Project,
} from '../../core/profile';
import { addDocument, getAccountPassword, getDocument, getProfile, getSettings, hasProfile, saveAccountPassword, saveProfile, updateSettings } from '../../db';
import { extractLines, fileKindOf } from '../../parse/extract';
import { isLinkedInExport, isLinkedInPdf, type LinkedInImport, parseLinkedInExport, parseLinkedInPdf, readExportFiles } from '../../parse/linkedin';
import { mergeParsed, type ParsedProfile } from '../../parse/merge';
import { parseResume, type RawSection } from '../../parse/resume';
import type { GotoOptions } from '../App';
import { classifyHeading } from '../api';
import { CheckIcon, CircleIcon, PlusIcon } from '../icons';
import { Banner, Button, DropZone, Empty, ListInput, Saved, Section, SelectInput, TextInput, TriInput } from '../ui';

const GENDERS = ['Male', 'Female', 'Non-binary', DECLINE];
const RACES = [
  'American Indian or Alaska Native',
  'Asian',
  'Black or African American',
  'Hispanic or Latino',
  'Native Hawaiian or Other Pacific Islander',
  'White',
  'Two or More Races',
  DECLINE,
];
const HISPANIC = ['Yes', 'No', DECLINE];
const VETERAN = ['I am not a protected veteran', 'I identify as a protected veteran', DECLINE];
const DISABILITY = ['No, I do not have a disability', 'Yes, I have a disability', DECLINE];
const REMOTE: [Profile['preferences']['remotePreference'], string][] = [
  ['', 'Not set'],
  ['remote', 'Remote'],
  ['hybrid', 'Hybrid'],
  ['onsite', 'On-site'],
  ['any', 'Flexible'],
];

/** "3 jobs, 2 schools, 12 skills" */
function foundSummary(p: ParsedProfile): string {
  const counts: [number, string][] = [
    [p.experience.length, 'job'],
    [p.education.length, 'school'],
    [p.projects.length, 'project'],
    [p.skills.length, 'skill'],
    [p.certifications.length, 'certification'],
    [p.languages.length, 'language'],
  ];
  return counts
    .filter(([n]) => n)
    .map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`)
    .join(', ');
}

/**
 * Merge a LinkedIn import into the profile and describe it. LinkedIn usually adds
 * to what a resume gave, so jobs, schools and skills the profile lacks are added.
 */
async function mergeLinkedIn(result: LinkedInImport, source: string, current: Profile): Promise<{ profile: Profile; note: string }> {
  const empty = !(await hasProfile());
  const profile = mergeParsed(current, result.profile, empty ? 'replace' : 'combine');
  const note = [
    `Imported ${source}: ${foundSummary(result.profile) || 'no jobs, schools or skills'}.`,
    empty
      ? 'Review everything below, then save.'
      : 'Jobs, schools and skills you didn’t have were added and empty fields filled in; nothing you already had was changed. Review, then save.',
  ];
  if (result.notImported.length) note.push(`Not part of the profile, so not imported: ${result.notImported.join(', ')}.`);
  if (!profile.links.linkedin) note.push('Add your LinkedIn URL under Links; this file doesn’t include it.');
  return { profile, note: note.join(' ') };
}

function ImportCard(props: { profile: Profile; nav: GotoOptions; onParsed(p: Profile, note: string, unknown: RawSection[]): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [keepFile, setKeepFile] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  /** The navigation that asked for a parse, so each "Parse into profile" click parses once. */
  const started = useRef<GotoOptions | null>(null);

  const run = async (file: File, saveAsDocument: boolean) => {
    setBusy(true);
    setError('');
    try {
      const lines = await extractLines(file);
      if (!lines.length) throw new Error('No text found. Scanned (image-only) PDFs aren’t supported; try a DOCX or a text-based PDF.');
      const keep = async () => {
        if (saveAsDocument) await addDocument({ kind: 'resume', file, fileName: file.name, text: lines.map((l) => l.text).join('\n') });
      };
      // A LinkedIn profile saved as PDF has a fixed layout with its own parser.
      if (isLinkedInPdf(lines)) {
        const result = parseLinkedInPdf(lines, props.profile);
        await keep();
        const { profile, note } = await mergeLinkedIn(result, `${file.name} (a LinkedIn profile PDF)`, props.profile);
        props.onParsed(profile, note, []);
        return;
      }
      const parsed = await parseResume(lines, props.profile, classifyHeading);
      await keep();
      const empty = !(await hasProfile());
      props.onParsed(
        mergeParsed(props.profile, parsed.profile, empty ? 'replace' : 'fillEmpty'),
        `Parsed ${file.name}. ${empty ? 'Review everything below' : 'Empty fields were filled in; nothing you already had was changed'}, then save.`,
        parsed.unknownSections,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Parse a stored document when opened from the Documents view.
  useEffect(() => {
    const id = props.nav.importDocId;
    if (!id || started.current === props.nav) return;
    started.current = props.nav;
    getDocument(id).then((d) => {
      if (d) run(new File([d.blob], d.fileName, { type: d.mime }), false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nav]);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!fileKindOf(f)) return setError('Unsupported file type. Use PDF, DOCX or TXT.');
    run(f, keepFile);
  };

  return (
    <DropZone className="import-card" disabled={busy} onFiles={(files) => pick(files[0])}>
      <h2>Import from a resume</h2>
      <p>Drop a PDF, DOCX or TXT here, or choose one. The text is parsed on your computer; nothing is uploaded.</p>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx,.txt,.md,application/pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          pick(f);
        }}
      />
      <label className="inline">
        <input type="checkbox" checked={keepFile} onChange={(e) => setKeepFile(e.target.checked)} />
        Keep the file in Documents (used for uploads)
      </label>
      <Button kind="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? 'Parsing…' : 'Choose resume file'}
      </Button>
      {error && <p className="error-text">{error}</p>}
    </DropZone>
  );
}

/** LinkedIn's data export (the ZIP, or CSV files from it) or a profile saved with "Save to PDF". */
function LinkedInSection(props: { profile: Profile; onParsed(p: Profile, note: string): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (files: File[]) => {
    setBusy(true);
    setError('');
    try {
      const pdf = files.find((f) => fileKindOf(f) === 'pdf');
      let result: LinkedInImport;
      let source: string;
      if (pdf) {
        const lines = await extractLines(pdf);
        if (!isLinkedInPdf(lines)) {
          throw new Error('That PDF isn’t a LinkedIn profile saved with “Save to PDF”. To read it as a resume, use “Import from a resume” above.');
        }
        result = parseLinkedInPdf(lines, props.profile);
        source = pdf.name;
      } else {
        const csvs = await readExportFiles(files);
        if (!isLinkedInExport(csvs)) {
          throw new Error('No LinkedIn profile data found. Drop the .zip from LinkedIn’s data export, the CSV files inside it, or a profile saved as PDF.');
        }
        result = parseLinkedInExport(csvs, props.profile);
        source = 'your LinkedIn data export';
      }
      const { profile, note } = await mergeLinkedIn(result, source, props.profile);
      props.onParsed(profile, note);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropZone className="linkedin-import" disabled={busy} onFiles={run}>
      <Section title="Import from LinkedIn" defaultOpen={false}>
        <p className="hint">Drop either of these here, or choose it. It’s read on your computer; nothing is uploaded.</p>
        <ul className="source-list">
          <li>
            <strong>Data export</strong> (most complete): on LinkedIn, Me → Settings &amp; Privacy → Data privacy →{' '}
            <a href="https://www.linkedin.com/mypreferences/d/download-my-data" target="_blank" rel="noreferrer">
              Get a copy of your data
            </a>
            . Pick the files you want, including Profile, and request the archive. LinkedIn emails you when the .zip is ready, usually within
            minutes.
          </li>
          <li>
            <strong>Profile PDF</strong> (instant): on your profile, More → Save to PDF. It lists only your top three skills and no projects.
          </li>
        </ul>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.csv,.pdf"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) run(files);
          }}
        />
        <div className="row">
          <Button kind="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Reading…' : 'Choose LinkedIn file'}
          </Button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </Section>
    </DropZone>
  );
}

function ExperienceEditor(props: { items: Experience[]; onChange(items: Experience[]): void }) {
  const set = (i: number, patch: Partial<Experience>) => props.onChange(props.items.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <>
      {props.items.length === 0 ? (
        <Empty>No jobs yet.</Empty>
      ) : (
        <div className="rows">
          {props.items.map((e, i) => (
            <div className="entry" key={e.id}>
              <div className="grid">
                <TextInput label="Job title" value={e.title} onChange={(v) => set(i, { title: v })} />
                <TextInput label="Company" value={e.company} onChange={(v) => set(i, { company: v })} />
                <TextInput label="Location" value={e.location} onChange={(v) => set(i, { location: v })} />
                <TextInput label="Start" placeholder="YYYY-MM" value={e.start} onChange={(v) => set(i, { start: v })} />
                {!e.current && <TextInput label="End" placeholder="YYYY-MM" value={e.end} onChange={(v) => set(i, { end: v })} />}
                <label className="inline">
                  <input type="checkbox" checked={e.current} onChange={(ev) => set(i, { current: ev.target.checked })} />I work here now
                </label>
              </div>
              <TextInput
                label="Highlights"
                hint="One per line"
                multiline
                value={e.bullets.join('\n')}
                onChange={(v) => set(i, { bullets: v.split('\n') })}
              />
              <Button kind="danger" small onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}>
                Remove job
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button small onClick={() => props.onChange([...props.items, emptyExperience()])}>
        <PlusIcon />
        Add job
      </Button>
    </>
  );
}

function EducationEditor(props: { items: Education[]; onChange(items: Education[]): void }) {
  const set = (i: number, patch: Partial<Education>) => props.onChange(props.items.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <>
      {props.items.length === 0 ? (
        <Empty>No schools yet.</Empty>
      ) : (
        <div className="rows">
          {props.items.map((e, i) => (
            <div className="entry" key={e.id}>
              <div className="grid">
                <TextInput label="School" value={e.school} onChange={(v) => set(i, { school: v })} wide />
                <TextInput label="Degree" placeholder="Bachelor of Science" value={e.degree} onChange={(v) => set(i, { degree: v })} />
                <TextInput label="Field of study" value={e.field} onChange={(v) => set(i, { field: v })} />
                <TextInput label="GPA" value={e.gpa} onChange={(v) => set(i, { gpa: v })} />
                <TextInput label="Location" value={e.location} onChange={(v) => set(i, { location: v })} />
                <TextInput label="Start" placeholder="YYYY-MM" value={e.start} onChange={(v) => set(i, { start: v })} />
                <TextInput label="End / graduation" placeholder="YYYY-MM" value={e.end} onChange={(v) => set(i, { end: v })} />
              </div>
              <Button kind="danger" small onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}>
                Remove school
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button small onClick={() => props.onChange([...props.items, emptyEducation()])}>
        <PlusIcon />
        Add school
      </Button>
    </>
  );
}

function ProjectEditor(props: { items: Project[]; onChange(items: Project[]): void }) {
  const set = (i: number, patch: Partial<Project>) => props.onChange(props.items.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <>
      {props.items.length === 0 ? (
        <Empty>No projects yet.</Empty>
      ) : (
        <div className="rows">
          {props.items.map((p, i) => (
            <div className="entry" key={p.id}>
              <div className="grid">
                <TextInput label="Name" value={p.name} onChange={(v) => set(i, { name: v })} />
                <TextInput label="Link" type="url" spellCheck={false} value={p.url} onChange={(v) => set(i, { url: v })} />
              </div>
              <ListInput label="Technologies" value={p.tech} onChange={(v) => set(i, { tech: v })} />
              <TextInput label="Highlights" hint="One per line" multiline value={p.bullets.join('\n')} onChange={(v) => set(i, { bullets: v.split('\n') })} />
              <Button kind="danger" small onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}>
                Remove project
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button small onClick={() => props.onChange([...props.items, emptyProject()])}>
        <PlusIcon />
        Add project
      </Button>
    </>
  );
}

/** Common job-site password rules (Workday's, among others). */
const PASSWORD_RULES: [string, (p: string) => boolean][] = [
  ['8+ characters', (p) => p.length >= 8],
  ['a letter', (p) => /[A-Za-z]/.test(p)],
  ['a number', (p) => /\d/.test(p)],
  ['a lowercase letter', (p) => /[a-z]/.test(p)],
  ['an uppercase letter', (p) => /[A-Z]/.test(p)],
  ['a special character', (p) => /[^A-Za-z0-9]/.test(p)],
];

/** A random 16-character password that meets every rule above. */
function generatePassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?-_'];
  const all = sets.join('');
  const rand = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const chars = sets.map((s) => s[rand(s.length)]);
  while (chars.length < 16) chars.push(all[rand(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** The job-site account password and whether it may go to any site. Saved with the profile, stored apart from it. */
interface Account {
  password: string;
  anySite: boolean;
}

/**
 * The password used to create and sign in to accounts on job sites like Workday.
 * Stored on its own (not in the profile), never exported in backups.
 */
function AccountSection(props: { account: Account; onChange(a: Account): void }) {
  const { password, anySite } = props.account;
  const [show, setShow] = useState(false);
  const set = (patch: Partial<Account>) => props.onChange({ ...props.account, ...patch });

  return (
    <Section id="section-account" title="Job site accounts" defaultOpen={false}>
      <p className="hint">
        Workday, iCIMS, Taleo and similar sites make you create an account to apply. This password goes into their “Password” and “Verify
        password” fields when you create an account or sign in. It stays in this browser and is never included in backups.
      </p>
      <div className="field wide">
        <label htmlFor="account-password">Password</label>
        <div className="row nowrap">
          <input
            id="account-password"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            spellCheck={false}
            value={password}
            onChange={(e) => set({ password: e.target.value })}
          />
          <Button small kind="ghost" onClick={() => setShow((v) => !v)}>
            {show ? 'Hide' : 'Show'}
          </Button>
        </div>
      </div>
      <ul className="rules" aria-label="Password requirements">
        {PASSWORD_RULES.map(([label, ok]) => (
          <li key={label} className={ok(password) ? 'ok' : ''}>
            {ok(password) ? <CheckIcon /> : <CircleIcon />}
            {label}
            <span className="sr-only">{ok(password) ? ' (met)' : ' (not met)'}</span>
          </li>
        ))}
      </ul>
      <label className="inline">
        <input type="checkbox" checked={anySite} onChange={(e) => set({ anySite: e.target.checked })} />
        Also fill it on sites that aren’t known job-account sites
      </label>
      {anySite && <Banner tone="warn">Only autofill pages you trust: with this on, any page you autofill can receive the password.</Banner>}
      <div className="row">
        <Button
          small
          onClick={() => {
            set({ password: generatePassword() });
            setShow(true);
          }}
        >
          Generate a strong password
        </Button>
      </div>
    </Section>
  );
}

export function ProfileView(props: { active: boolean; nav: GotoOptions }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<Account>({ password: '', anySite: false });
  const [dirty, setDirtyState] = useState(false);
  const [note, setNote] = useState('');
  const [unknown, setUnknown] = useState<RawSection[]>([]);
  const [saved, setSaved] = useState(false);
  // Read when a load finishes, so a load that started before an edit doesn't overwrite it.
  const dirtyRef = useRef(false);
  const setDirty = (d: boolean) => {
    dirtyRef.current = d;
    setDirtyState(d);
  };

  // Load when shown, unless there are unsaved edits; a backup import or "Delete all data"
  // elsewhere changes what's stored.
  useEffect(() => {
    if (!props.active || dirtyRef.current) return;
    Promise.all([getProfile(), getAccountPassword(), getSettings()]).then(([p, password, s]) => {
      if (dirtyRef.current) return;
      setProfile(p);
      setAccount({ password, anySite: s.passwordOnAnySite });
    });
  }, [props.active]);

  // "Set account password" on the Apply tab lands on that section, open, with the cursor in it.
  const handledNav = useRef<GotoOptions | null>(null);
  const loaded = profile !== null;
  useEffect(() => {
    if (!loaded || props.nav.section !== 'account' || handledNav.current === props.nav) return;
    handledNav.current = props.nav;
    const section = document.getElementById('section-account') as HTMLDetailsElement | null;
    if (!section) return;
    section.open = true;
    section.scrollIntoView({ block: 'start' });
    document.getElementById('account-password')?.focus({ preventScroll: true });
  }, [loaded, props.nav]);

  if (!profile) return <div className="view">Loading…</div>;

  const update = (fn: (p: Profile) => void) => {
    const next = structuredClone(profile);
    fn(next);
    setProfile(next);
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    // Drop blank lines left over from editing bullet lists.
    const clean = structuredClone(profile);
    for (const e of clean.experience) e.bullets = e.bullets.map((b) => b.trim()).filter(Boolean);
    for (const p of clean.projects) p.bullets = p.bullets.map((b) => b.trim()).filter(Boolean);
    await saveProfile(clean);
    await saveAccountPassword(account.password);
    await updateSettings((s) => (s.passwordOnAnySite = account.anySite));
    setProfile(clean);
    setDirty(false);
    setSaved(true);
    setNote('');
  };

  const p = profile;
  const a = p.personal.address;
  return (
    <div className="view profile">
      <ImportCard
        profile={profile}
        nav={props.nav}
        onParsed={(next, msg, unk) => {
          setProfile(next);
          setDirty(true);
          setSaved(false);
          setNote(msg);
          setUnknown(unk);
        }}
      />
      <LinkedInSection
        profile={profile}
        onParsed={(next, msg) => {
          setProfile(next);
          setDirty(true);
          setSaved(false);
          setNote(msg);
          setUnknown([]);
        }}
      />
      {note && <Banner tone="info">{note}</Banner>}
      {unknown.length > 0 && (
        <Banner tone="warn">
          These sections weren’t recognized and weren’t imported: {unknown.map((s) => s.heading).join(', ')}.
        </Banner>
      )}

      <Section title="Personal">
        <div className="grid">
          <TextInput label="First name" autoComplete="given-name" value={p.personal.firstName} onChange={(v) => update((x) => (x.personal.firstName = v))} />
          <TextInput label="Last name" autoComplete="family-name" value={p.personal.lastName} onChange={(v) => update((x) => (x.personal.lastName = v))} />
          <TextInput
            label="Preferred name"
            autoComplete="nickname"
            value={p.personal.preferredName}
            onChange={(v) => update((x) => (x.personal.preferredName = v))}
          />
          <TextInput label="Pronouns" autoComplete="off" value={p.personal.pronouns} onChange={(v) => update((x) => (x.personal.pronouns = v))} />
          <TextInput
            label="Email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            value={p.personal.email}
            onChange={(v) => update((x) => (x.personal.email = v))}
          />
          <TextInput label="Phone" type="tel" autoComplete="tel" value={p.personal.phone} onChange={(v) => update((x) => (x.personal.phone = v))} />
          <TextInput
            label="Street address"
            wide
            autoComplete="address-line1"
            value={a.line1}
            onChange={(v) => update((x) => (x.personal.address.line1 = v))}
          />
          <TextInput label="Apt / suite" autoComplete="address-line2" value={a.line2} onChange={(v) => update((x) => (x.personal.address.line2 = v))} />
          <TextInput label="City" autoComplete="address-level2" value={a.city} onChange={(v) => update((x) => (x.personal.address.city = v))} />
          <TextInput
            label="State / province"
            autoComplete="address-level1"
            value={a.region}
            onChange={(v) => update((x) => (x.personal.address.region = v))}
          />
          <TextInput
            label="Postal code"
            autoComplete="postal-code"
            value={a.postalCode}
            onChange={(v) => update((x) => (x.personal.address.postalCode = v))}
          />
          <TextInput label="Country" autoComplete="country-name" value={a.country} onChange={(v) => update((x) => (x.personal.address.country = v))} />
        </div>
      </Section>

      <Section title="Links">
        <div className="grid">
          <TextInput label="LinkedIn" type="url" spellCheck={false} value={p.links.linkedin} onChange={(v) => update((x) => (x.links.linkedin = v))} wide />
          <TextInput label="GitHub" type="url" spellCheck={false} value={p.links.github} onChange={(v) => update((x) => (x.links.github = v))} wide />
          <TextInput label="Portfolio" type="url" spellCheck={false} value={p.links.portfolio} onChange={(v) => update((x) => (x.links.portfolio = v))} wide />
          <TextInput label="Website" type="url" spellCheck={false} value={p.links.website} onChange={(v) => update((x) => (x.links.website = v))} wide />
        </div>
      </Section>

      <AccountSection
        account={account}
        onChange={(next) => {
          setAccount(next);
          setDirty(true);
          setSaved(false);
        }}
      />

      <Section title="Summary" defaultOpen={false}>
        <TextInput label="Professional summary" multiline value={p.summary} onChange={(v) => update((x) => (x.summary = v))} />
      </Section>

      <Section title="Work experience" count={p.experience.length}>
        <ExperienceEditor items={p.experience} onChange={(items) => update((x) => (x.experience = items))} />
      </Section>

      <Section title="Education" count={p.education.length}>
        <EducationEditor items={p.education} onChange={(items) => update((x) => (x.education = items))} />
      </Section>

      <Section title="Projects" count={p.projects.length} defaultOpen={false}>
        <ProjectEditor items={p.projects} onChange={(items) => update((x) => (x.projects = items))} />
      </Section>

      <Section title="Skills & more" defaultOpen={false}>
        <ListInput label="Skills" value={p.skills} onChange={(v) => update((x) => (x.skills = v))} />
        <ListInput label="Certifications" value={p.certifications} onChange={(v) => update((x) => (x.certifications = v))} />
        <ListInput label="Languages spoken" value={p.languages} onChange={(v) => update((x) => (x.languages = v))} />
      </Section>

      <Section title="Work authorization">
        <ListInput
          label="Countries you can work in without sponsorship"
          value={p.workAuth.authorizedCountries}
          onChange={(v) => update((x) => (x.workAuth.authorizedCountries = v))}
          hint="e.g. United States, Canada"
        />
        <TriInput label="Will you need visa sponsorship?" value={p.workAuth.needsSponsorship} onChange={(v) => update((x) => (x.workAuth.needsSponsorship = v))} />
        <TriInput label="Are you 18 or older?" value={p.workAuth.over18} onChange={(v) => update((x) => (x.workAuth.over18 = v))} />
        <div className="grid">
          <TextInput label="Citizenship" value={p.workAuth.citizenship} onChange={(v) => update((x) => (x.workAuth.citizenship = v))} />
          <TextInput label="Security clearance" value={p.workAuth.securityClearance} onChange={(v) => update((x) => (x.workAuth.securityClearance = v))} />
        </div>
      </Section>

      <Section title="Job preferences" defaultOpen={false}>
        <div className="grid">
          <TextInput label="Desired salary" placeholder="$120,000" value={p.preferences.desiredSalary} onChange={(v) => update((x) => (x.preferences.desiredSalary = v))} />
          <TextInput label="Available to start" placeholder="2 weeks notice, or YYYY-MM-DD" value={p.preferences.startDate} onChange={(v) => update((x) => (x.preferences.startDate = v))} />
          <TextInput label="Notice period" value={p.preferences.noticePeriod} onChange={(v) => update((x) => (x.preferences.noticePeriod = v))} />
          <TextInput label="How you usually find jobs" placeholder="LinkedIn" value={p.preferences.howHeard} onChange={(v) => update((x) => (x.preferences.howHeard = v))} />
        </div>
        <TriInput label="Willing to relocate?" value={p.preferences.willingToRelocate} onChange={(v) => update((x) => (x.preferences.willingToRelocate = v))} />
        <SelectInput
          label="Work arrangement"
          value={REMOTE.find(([v]) => v === p.preferences.remotePreference)?.[1] ?? 'Not set'}
          options={REMOTE.map(([, l]) => l)}
          onChange={(label) => update((x) => (x.preferences.remotePreference = REMOTE.find(([, l]) => l === label)?.[0] ?? ''))}
        />
      </Section>

      <Section title="Voluntary self-identification (EEO)" defaultOpen={false}>
        <p className="hint">US employers ask these optionally. “{DECLINE}” is always a safe answer.</p>
        <SelectInput label="Gender" value={p.eeo.gender} options={GENDERS} onChange={(v) => update((x) => (x.eeo.gender = v))} />
        <SelectInput label="Race / ethnicity" value={p.eeo.race} options={RACES} onChange={(v) => update((x) => (x.eeo.race = v))} />
        <SelectInput label="Hispanic or Latino" value={p.eeo.hispanicLatino} options={HISPANIC} onChange={(v) => update((x) => (x.eeo.hispanicLatino = v))} />
        <SelectInput label="Veteran status" value={p.eeo.veteran} options={VETERAN} onChange={(v) => update((x) => (x.eeo.veteran = v))} />
        <SelectInput label="Disability" value={p.eeo.disability} options={DISABILITY} onChange={(v) => update((x) => (x.eeo.disability = v))} />
      </Section>

      <div className="savebar">
        {saved && !dirty && <Saved />}
        {dirty && <span className="hint">Unsaved changes</span>}
        <Button kind="primary" disabled={!dirty} onClick={save}>
          Save profile
        </Button>
      </div>
    </div>
  );
}
