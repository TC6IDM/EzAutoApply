import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { FILE_NAME_FORMATS, uploadFileName } from '../../core/documents';
import { type ClassifierSettings, LAYA_DEFAULT_URL, type Settings } from '../../core/types';
import { db, type ExportFile, exportAll, getProfile, getSettings, importAll, listApplications, updateSettings } from '../../db';
import type { Health } from '../App';
import { send } from '../api';
import { Banner, Button, Empty, formatDate, Section, SelectInput, TextInput } from '../ui';

const PROVIDERS: [ClassifierSettings['provider'], string][] = [
  ['laya', 'Laya (local, private)'],
  ['jev', 'Jev (TypeSafe cloud)'],
  ['none', 'Off (rules and saved answers only)'],
];

function Toggle(props: { label: string; hint?: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>
        {props.label}
        {props.hint && <small className="hint">{props.hint}</small>}
      </span>
    </label>
  );
}

/** A text setting saved when the field loses focus, not on every keystroke. */
function SettingText(props: { label: string; value: string; onCommit(v: string): void; type?: string; placeholder?: string; hint?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <TextInput
      label={props.label}
      type={props.type}
      placeholder={props.placeholder}
      hint={props.hint}
      spellCheck={false}
      wide
      value={draft ?? props.value}
      onChange={setDraft}
      onBlur={() => {
        if (draft !== null && draft.trim() !== props.value) props.onCommit(draft.trim());
        setDraft(null);
      }}
    />
  );
}

/** A 0–1 confidence threshold, shown and set as a percentage. */
function Threshold(props: { label: string; hint: string; value: number; min: number; onChange(v: number): void }) {
  const pct = Math.round(props.value * 100);
  return (
    <div className="field threshold">
      <label>
        <span className="threshold-head">
          {props.label}
          <output>{pct}%</output>
        </span>
        <input type="range" min={props.min} max={99} step={1} value={pct} onChange={(e) => props.onChange(Number(e.target.value) / 100)} />
      </label>
      <small className="hint">{props.hint}</small>
    </div>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Settings save as they change. Each change is applied to what's stored, so nothing set elsewhere is lost. */
export function SettingsView(props: { active: boolean; onSaved(): void; health: Health | null }) {
  const stored = useLiveQuery(getSettings);
  /** Shown at once while the write is in flight (and while a slider is being dragged). */
  const [local, setLocal] = useState<Settings | null>(null);
  const [testing, setTesting] = useState<Health | null | 'busy'>(null);
  const [backupMsg, setBackupMsg] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const lastWrite = useRef<Promise<unknown>>(Promise.resolve());
  const thresholdTimer = useRef<number | undefined>(undefined);
  const apps = useLiveQuery(() => listApplications(50), [], []);
  const person = useLiveQuery(async () => (await getProfile()).personal, [], null);

  useEffect(() => setLocal(null), [stored]);
  useEffect(() => setTesting(null), [props.active]);
  const s = local ?? stored;
  if (!s) return <div className="view">Loading…</div>;

  const persist = (fn: (x: Settings) => void) => {
    lastWrite.current = updateSettings(fn)
      .then(() => send({ type: 'settingsChanged' }).catch(() => {}))
      .then(() => props.onSaved());
  };
  const change = (fn: (x: Settings) => void) => {
    const next = structuredClone(s);
    fn(next);
    setLocal(next);
    setTesting(null);
    persist(fn);
  };
  /** Sliders show every step but save once the value stops changing. */
  const changeThresholds = (auto: number, review: number) => {
    const next = structuredClone(s);
    next.classifier.autoThreshold = auto;
    next.classifier.reviewThreshold = review;
    setLocal(next);
    window.clearTimeout(thresholdTimer.current);
    thresholdTimer.current = window.setTimeout(() => {
      persist((x) => {
        x.classifier.autoThreshold = auto;
        x.classifier.reviewThreshold = review;
      });
    }, 300);
  };

  const test = async () => {
    setTesting('busy');
    await lastWrite.current;
    setTesting(await send<Health>({ type: 'classifierHealth' }).catch((e: Error) => ({ ok: false, detail: e.message })));
  };

  const c = s.classifier;
  const status = testing && testing !== 'busy' ? testing : props.health;
  /** Each naming format, shown with the user's own name when the profile has one. */
  const formatLabel = (format: Settings['fileNameFormat']) => {
    if (format === 'original') return 'Keep the original file name';
    const named = person && (person.firstName || person.lastName);
    if (!named) return FILE_NAME_FORMATS.find((f) => f.value === format)!.label;
    return uploadFileName({ kind: 'resume', name: 'Resume', fileName: 'resume.pdf', mime: 'application/pdf' }, person, format);
  };
  return (
    <div className="view settings">
      <Section title="Classifier">
        <p className="hint">
          Questions the built-in rules and your saved answers don’t cover go to a classifier, a small model that picks the right profile
          field or option. It never writes text for you.
        </p>
        <SelectInput
          label="Classifier"
          value={PROVIDERS.find(([v]) => v === c.provider)![1]}
          options={PROVIDERS.map(([, l]) => l)}
          onChange={(label) =>
            change((x) => {
              const provider = PROVIDERS.find(([, l]) => l === label)![0];
              if (provider === 'laya' && x.classifier.provider !== 'laya') x.classifier.baseUrl = LAYA_DEFAULT_URL;
              if (provider === 'jev' && x.classifier.baseUrl === LAYA_DEFAULT_URL) x.classifier.baseUrl = '';
              x.classifier.provider = provider;
            })
          }
          wide
        />
        {c.provider === 'jev' && (
          <Banner tone="warn">Jev runs in the cloud: question text and short summaries of your profile are sent to TypeSafe.</Banner>
        )}
        {c.provider !== 'none' && (
          <>
            <div className="grid">
              <SettingText
                label="Server URL"
                type="url"
                value={c.baseUrl}
                placeholder={c.provider === 'laya' ? LAYA_DEFAULT_URL : 'https://… (from your Jev account)'}
                onCommit={(v) => change((x) => (x.classifier.baseUrl = v))}
              />
              <SettingText
                label="API key"
                type="password"
                value={c.apiKey}
                hint={c.provider === 'laya' ? 'The LAYA_API_KEY you started laya-serve with (optional)' : 'Your Jev API key'}
                onCommit={(v) => change((x) => (x.classifier.apiKey = v))}
              />
              {c.provider === 'laya' && (
                <SelectInput
                  label="Laya checkpoint"
                  value={c.model}
                  options={['typed-decisions', 'english', 'multilingual']}
                  onChange={(v) => change((x) => (x.classifier.model = v))}
                />
              )}
            </div>
            <Threshold
              label="Fill automatically at"
              hint="Answers at least this confident are filled without asking."
              value={c.autoThreshold}
              min={30}
              onChange={(v) => changeThresholds(v, Math.min(c.reviewThreshold, v))}
            />
            <Threshold
              label="Fill for review at"
              hint="From here up to the line above: filled, but listed under “Check these”."
              value={c.reviewThreshold}
              min={30}
              onChange={(v) => changeThresholds(c.autoThreshold, Math.min(v, c.autoThreshold))}
            />
            <div className="row">
              <Button onClick={test} disabled={testing === 'busy'}>
                {testing === 'busy' ? 'Testing…' : 'Test connection'}
              </Button>
              {status && !status.off && testing !== 'busy' && (
                <span className={`status-line ${status.ok ? 'ok' : 'down'}`} role="status">
                  <span className="dot" aria-hidden="true" />
                  {status.detail}
                </span>
              )}
            </div>
            {c.provider === 'laya' && props.health && !props.health.ok && (
              <Banner tone="info">
                Start Laya from the project folder with <code>classifier\start.ps1</code> (see the README). The first start downloads the model
                (about 0.8 GB).
              </Banner>
            )}
          </>
        )}
      </Section>

      <Section title="Filling">
        <Toggle
          label="Show the Autofill button on application pages"
          checked={s.showFloatingButton}
          onChange={(v) => change((x) => (x.showFloatingButton = v))}
        />
        <Toggle
          label="Autofill each new step of multi-page forms"
          hint="Workday, LinkedIn Easy Apply and similar. Off: the button pulses when a new step appears."
          checked={s.autoFillNextStep}
          onChange={(v) => change((x) => (x.autoFillNextStep = v))}
        />
        <Toggle
          label="Acknowledge privacy notices"
          hint="Opens “read and acknowledge the privacy notice” links and presses Acknowledge. Shown under “Check these”."
          checked={s.acknowledgePrivacyNotices}
          onChange={(v) => change((x) => (x.acknowledgePrivacyNotices = v))}
        />
        <Toggle
          label="Correct what the site filled in from your resume"
          hint="Sites that read your resume often get it wrong. Where they disagree with your profile, your profile wins; shown under “Check these”. Fields you typed in yourself are left alone."
          checked={s.fixSiteValues}
          onChange={(v) => change((x) => (x.fixSiteValues = v))}
        />
        <Toggle
          label="Overwrite fields that already have a value"
          checked={s.overwriteFilled}
          onChange={(v) => change((x) => (x.overwriteFilled = v))}
        />
        <SelectInput
          label="Name uploaded files"
          hint="Employers see this name instead of whatever the file is called on your computer."
          value={formatLabel(s.fileNameFormat)}
          options={FILE_NAME_FORMATS.map((f) => formatLabel(f.value))}
          onChange={(label) => change((x) => (x.fileNameFormat = FILE_NAME_FORMATS.find((f) => formatLabel(f.value) === label)!.value))}
          wide
        />
      </Section>

      <Section title="Backup" defaultOpen={false}>
        <p className="hint">
          Your data lives only in this browser profile. A backup holds your profile, documents, saved answers and settings, but not the job-site
          password.
        </p>
        <div className="row">
          <Button
            onClick={async () => {
              download(`ezautoapply-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await exportAll()));
              setBackupMsg('Backup downloaded.');
            }}
          >
            Export backup
          </Button>
          <Button onClick={() => importRef.current?.click()}>Import backup…</Button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f || !confirm('Importing replaces your current profile, documents and saved answers. Continue?')) return;
              try {
                await importAll(JSON.parse(await f.text()) as ExportFile);
                setBackupMsg('Backup imported.');
              } catch (err) {
                setBackupMsg(`Import failed: ${(err as Error).message}`);
              }
            }}
          />
        </div>
        {backupMsg && <p className="hint">{backupMsg}</p>}
        <Button
          kind="danger"
          small
          onClick={async () => {
            if (!confirm('Delete your profile, documents, saved answers and history from this browser? Export a backup first if unsure.')) return;
            await Promise.all([db.kv.clear(), db.documents.clear(), db.answers.clear(), db.applications.clear()]);
            setBackupMsg('All data deleted.');
          }}
        >
          Delete all data
        </Button>
      </Section>

      <Section title="Recent applications" count={apps.length} defaultOpen={false}>
        {apps.length ? (
          <ul className="history rows">
            {apps.map((a) => (
              <li key={a.id}>
                <a href={a.url} target="_blank" rel="noreferrer">
                  {a.title || a.host}
                </a>
                <small>
                  {a.host} · {formatDate(a.date)} · {a.filled} filled, {a.needs} needed you
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Pages you autofill are listed here.</Empty>
        )}
      </Section>
    </div>
  );
}
