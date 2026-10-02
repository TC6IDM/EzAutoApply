import { useCallback, useEffect, useState } from 'react';
import { send, useActiveTab } from './api';
import { AnswersView } from './views/AnswersView';
import { ApplyView } from './views/ApplyView';
import { DocumentsView } from './views/DocumentsView';
import { ProfileView } from './views/ProfileView';
import { SettingsView } from './views/SettingsView';

export type View = 'apply' | 'profile' | 'documents' | 'answers' | 'settings';

const VIEWS: [View, string][] = [
  ['apply', 'Apply'],
  ['profile', 'Profile'],
  ['documents', 'Documents'],
  ['answers', 'Answers'],
  ['settings', 'Settings'],
];

export interface Health {
  ok: boolean;
  detail: string;
}

/** Polls the classifier so the header dot reflects whether Laya/Jev is reachable. */
function useClassifierHealth(): [Health | null, () => void] {
  const [health, setHealth] = useState<Health | null>(null);
  const check = useCallback(() => {
    send<Health>({ type: 'classifierHealth' })
      .then(setHealth)
      .catch((e: Error) => setHealth({ ok: false, detail: e.message }));
  }, []);
  useEffect(() => {
    check();
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, [check]);
  return [health, check];
}

export function App() {
  const [view, setView] = useState<View>('apply');
  /** A document to parse into the profile when the Profile view opens. */
  const [importDocId, setImportDocId] = useState<string | null>(null);
  const tab = useActiveTab();
  const [health, recheck] = useClassifierHealth();

  const goto = (v: View, opts?: { importDocId?: string }) => {
    setImportDocId(opts?.importDocId ?? null);
    setView(v);
  };

  return (
    <div className="app">
      <header className="top">
        <h1>EzAutoApply</h1>
        <span
          className={`health ${health === null ? 'unknown' : health.ok ? 'ok' : 'off'}`}
          title={health?.detail ?? 'Checking classifier…'}
          role="button"
          tabIndex={0}
          onClick={() => goto('settings')}
          onKeyDown={(e) => e.key === 'Enter' && goto('settings')}
        >
          <span className="dot" aria-hidden="true" />
          {health === null ? 'Classifier…' : health.ok ? 'Classifier on' : 'Classifier off'}
        </span>
      </header>
      <nav className="tabs" role="tablist" aria-label="Sections">
        {VIEWS.map(([v, label]) => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => goto(v)}>
            {label}
          </button>
        ))}
      </nav>
      <main>
        {view === 'apply' && <ApplyView tab={tab} goto={goto} />}
        {view === 'profile' && <ProfileView importDocId={importDocId} onImported={() => setImportDocId(null)} />}
        {view === 'documents' && <DocumentsView goto={goto} />}
        {view === 'answers' && <AnswersView />}
        {view === 'settings' && <SettingsView onSaved={recheck} health={health} />}
      </main>
    </div>
  );
}
