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
import { addDocument, getDocument, getProfile, hasProfile, saveProfile } from '../../db';
import { extractLines, fileKindOf } from '../../parse/extract';
import { parseResume, type RawSection } from '../../parse/resume';
import { classifyHeading } from '../api';
import { Banner, Button, Empty, ListInput, Section, SelectInput, TextInput, TriInput } from '../ui';

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

type ParsedProfile = Awaited<ReturnType<typeof parseResume>>['profile'];

/** Merge parsed resume data into the profile. `fillEmpty` keeps everything the user already has. */
function mergeParsed(current: Profile, parsed: ParsedProfile, mode: 'replace' | 'fillEmpty'): Profile {
  const next = structuredClone(current);
  const pick = (a: string, b: string) => (mode === 'replace' ? b || a : a || b);
  const pp = parsed.personal;
  next.personal.firstName = pick(next.personal.firstName, pp.firstName);
  next.personal.lastName = pick(next.personal.lastName, pp.lastName);
  next.personal.email = pick(next.personal.email, pp.email);
  next.personal.phone = pick(next.personal.phone, pp.phone);
  next.personal.address.city = pick(next.personal.address.city, pp.address.city);
  next.personal.address.region = pick(next.personal.address.region, pp.address.region);
  next.personal.address.country = pick(next.personal.address.country, pp.address.country);
  for (const k of ['linkedin', 'github', 'portfolio', 'website'] as const) next.links[k] = pick(next.links[k], parsed.links[k]);
  next.summary = pick(next.summary, parsed.summary);
  const list = <T,>(a: T[], b: T[]) => (mode === 'replace' ? (b.length ? b : a) : a.length ? a : b);
  next.experience = list(next.experience, parsed.experience);
  next.education = list(next.education, parsed.education);
  next.projects = list(next.projects, parsed.projects);
  next.skills = list(next.skills, parsed.skills);
  next.certifications = list(next.certifications, parsed.certifications);
  next.languages = list(next.languages, parsed.languages);
  return next;
}

function ImportCard(props: { profile: Profile; importDocId: string | null; onParsed(p: Profile, note: string, unknown: RawSection[]): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [keepFile, setKeepFile] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const started = useRef<string | null>(null);

  const run = async (file: File, saveAsDocument: boolean) => {
    setBusy(true);
    setError('');
    try {
      const lines = await extractLines(file);
      if (!lines.length) throw new Error('No text found. Scanned (image-only) PDFs aren’t supported; try a DOCX or a text-based PDF.');
      const parsed = await parseResume(lines, props.profile, classifyHeading);
      if (saveAsDocument) {
        await addDocument({ kind: 'resume', file, fileName: file.name, text: parsed.text });
      }
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
    if (!props.importDocId || started.current === props.importDocId) return;
    started.current = props.importDocId;
    getDocument(props.importDocId).then((d) => {
      if (d) run(new File([d.blob], d.fileName, { type: d.mime }), false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.importDocId]);

  return (
    <div className="import-card">
      <p>
        <strong>Import from a resume</strong>
        <br />
        PDF, DOCX or TXT. The text is parsed on your computer; nothing is uploaded.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx,.txt,.md,application/pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (!fileKindOf(f)) return setError('Unsupported file type. Use PDF, DOCX or TXT.');
          run(f, keepFile);
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
    </div>
  );
}

function ExperienceEditor(props: { items: Experience[]; onChange(items: Experience[]): void }) {
  const set = (i: number, patch: Partial<Experience>) => props.onChange(props.items.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <>
      {props.items.length === 0 && <Empty>No jobs yet.</Empty>}
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
      <Button small onClick={() => props.onChange([...props.items, emptyExperience()])}>
        + Add job
      </Button>
    </>
  );
}

function EducationEditor(props: { items: Education[]; onChange(items: Education[]): void }) {
  const set = (i: number, patch: Partial<Education>) => props.onChange(props.items.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <>
      {props.items.length === 0 && <Empty>No schools yet.</Empty>}
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
      <Button small onClick={() => props.onChange([...props.items, emptyEducation()])}>
        + Add school
      </Button>
    </>
  );
}

function ProjectEditor(props: { items: Project[]; onChange(items: Project[]): void }) {
  const set = (i: number, patch: Partial<Project>) => props.onChange(props.items.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <>
      {props.items.length === 0 && <Empty>No projects yet.</Empty>}
      {props.items.map((p, i) => (
        <div className="entry" key={p.id}>
          <div className="grid">
            <TextInput label="Name" value={p.name} onChange={(v) => set(i, { name: v })} />
            <TextInput label="Link" value={p.url} onChange={(v) => set(i, { url: v })} />
          </div>
          <ListInput label="Technologies" value={p.tech} onChange={(v) => set(i, { tech: v })} />
          <TextInput label="Highlights" hint="One per line" multiline value={p.bullets.join('\n')} onChange={(v) => set(i, { bullets: v.split('\n') })} />
          <Button kind="danger" small onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}>
            Remove project
          </Button>
        </div>
      ))}
      <Button small onClick={() => props.onChange([...props.items, emptyProject()])}>
        + Add project
      </Button>
    </>
  );
}

export function ProfileView(props: { importDocId: string | null; onImported(): void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [unknown, setUnknown] = useState<RawSection[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getProfile().then(setProfile);
  }, []);

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
        importDocId={props.importDocId}
        onParsed={(next, msg, unk) => {
          setProfile(next);
          setDirty(true);
          setNote(msg);
          setUnknown(unk);
          props.onImported();
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
          <TextInput label="First name" value={p.personal.firstName} onChange={(v) => update((x) => (x.personal.firstName = v))} />
          <TextInput label="Last name" value={p.personal.lastName} onChange={(v) => update((x) => (x.personal.lastName = v))} />
          <TextInput label="Preferred name" value={p.personal.preferredName} onChange={(v) => update((x) => (x.personal.preferredName = v))} />
          <TextInput label="Pronouns" value={p.personal.pronouns} onChange={(v) => update((x) => (x.personal.pronouns = v))} />
          <TextInput label="Email" type="email" value={p.personal.email} onChange={(v) => update((x) => (x.personal.email = v))} />
          <TextInput label="Phone" type="tel" value={p.personal.phone} onChange={(v) => update((x) => (x.personal.phone = v))} />
          <TextInput label="Street address" wide value={a.line1} onChange={(v) => update((x) => (x.personal.address.line1 = v))} />
          <TextInput label="Apt / suite" value={a.line2} onChange={(v) => update((x) => (x.personal.address.line2 = v))} />
          <TextInput label="City" value={a.city} onChange={(v) => update((x) => (x.personal.address.city = v))} />
          <TextInput label="State / province" value={a.region} onChange={(v) => update((x) => (x.personal.address.region = v))} />
          <TextInput label="Postal code" value={a.postalCode} onChange={(v) => update((x) => (x.personal.address.postalCode = v))} />
          <TextInput label="Country" value={a.country} onChange={(v) => update((x) => (x.personal.address.country = v))} />
        </div>
      </Section>

      <Section title="Links">
        <div className="grid">
          <TextInput label="LinkedIn" value={p.links.linkedin} onChange={(v) => update((x) => (x.links.linkedin = v))} wide />
          <TextInput label="GitHub" value={p.links.github} onChange={(v) => update((x) => (x.links.github = v))} wide />
          <TextInput label="Portfolio" value={p.links.portfolio} onChange={(v) => update((x) => (x.links.portfolio = v))} wide />
          <TextInput label="Website" value={p.links.website} onChange={(v) => update((x) => (x.links.website = v))} wide />
        </div>
      </Section>

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
        {saved && !dirty && <span className="saved">Saved ✓</span>}
        {dirty && <span className="hint">Unsaved changes</span>}
        <Button kind="primary" disabled={!dirty} onClick={save}>
          Save profile
        </Button>
      </div>
    </div>
  );
}
