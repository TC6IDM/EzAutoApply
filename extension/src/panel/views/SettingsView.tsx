import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { type ClassifierSettings, LAYA_DEFAULT_URL, type Settings } from '../../core/types';
import { db, type ExportFile, exportAll, getSettings, importAll, listApplications, saveSettings } from '../../db';
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

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function SettingsView(props: { onSaved(): void; health: Health | null }) {
  const [s, setS] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState<Health | null | 'busy'>(null);
  const [backupMsg, setBackupMsg] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const apps = useLiveQuery(() => listApplications(50), [], []);

  useEffect(() => {
    getSettings().then(setS);
  }, []);
  if (!s) return <div className="view">Loading…</div>;

  const change = (fn: (x: Settings) => void) => {
    const next = structuredClone(s);
    fn(next);
    setS(next);
    setDirty(true);
  };

  const save = async () => {
    await saveSettings(s);
    setDirty(false);
    await send({ type: 'settingsChanged' }).catch(() => {});
    props.onSaved();
  };

  const test = async () => {
    await save();
    setTesting('busy');
    setTesting(await send<Health>({ type: 'classifierHealth' }).catch((e: Error) => ({ ok: false, detail: e.message })));
  };

  const c = s.classifier;
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
              <TextInput
                label="Server URL"
                value={c.baseUrl}
                placeholder={c.provider === 'laya' ? LAYA_DEFAULT_URL : 'https://… (from your Jev account)'}
                onChange={(v) => change((x) => (x.classifier.baseUrl = v.trim()))}
                wide
              />
              <TextInput
                label="API key"
                type="password"
                value={c.apiKey}
                hint={c.provider === 'laya' ? 'The LAYA_API_KEY you started laya-serve with (optional)' : 'Your Jev API key'}
                onChange={(v) => change((x) => (x.classifier.apiKey = v.trim()))}
                wide
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
            <div className="grid">
              <TextInput
                label="Fill automatically at"
                type="number"
                hint="Confidence 0–1. Answers at or above this are filled without asking."
                value={String(c.autoThreshold)}
                onChange={(v) => change((x) => (x.classifier.autoThreshold = Math.min(1, Math.max(0, Number(v) || 0))))}
              />
              <TextInput
                label="Fill for review at"
                type="number"
                hint="Between this and the line above: filled, but marked for you to check."
                value={String(c.reviewThreshold)}
                onChange={(v) => change((x) => (x.classifier.reviewThreshold = Math.min(1, Math.max(0, Number(v) || 0))))}
              />
            </div>
            <div className="row">
              <Button onClick={test} disabled={testing === 'busy'}>
                {testing === 'busy' ? 'Testing…' : 'Save & test connection'}
              </Button>
              {testing && testing !== 'busy' && <span className={testing.ok ? 'saved' : 'error-text'}>{testing.detail}</span>}
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
          label="Overwrite fields that already have a value"
          checked={s.overwriteFilled}
          onChange={(v) => change((x) => (x.overwriteFilled = v))}
        />
      </Section>

      <div className="savebar">
        {dirty && <span className="hint">Unsaved changes</span>}
        <Button kind="primary" disabled={!dirty} onClick={save}>
          Save settings
        </Button>
      </div>

      <Section title="Backup" defaultOpen={false}>
        <p className="hint">Your data lives only in this browser profile. Export a backup to move it or keep it safe.</p>
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
                setS(await getSettings());
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
            setS(await getSettings());
          }}
        >
          Delete all data
        </Button>
      </Section>

      <Section title="Recent applications" count={apps.length} defaultOpen={false}>
        {apps.length ? (
          <ul className="history">
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
