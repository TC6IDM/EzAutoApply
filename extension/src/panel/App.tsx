import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { send, useActiveTab } from './api';
import { AnswersView } from './views/AnswersView';
import { ApplyView } from './views/ApplyView';
import { DocumentsView } from './views/DocumentsView';
import { ProfileView } from './views/ProfileView';
import { SettingsView } from './views/SettingsView';

export type View = 'apply' | 'profile' | 'documents' | 'answers' | 'settings';

/** Where to land when switching views: a resume to parse, or a profile section to open. */
export interface GotoOptions {
  importDocId?: string;
  section?: 'account';
}

export type Goto = (v: View, opts?: GotoOptions) => void;

const VIEWS: [View, string][] = [
  ['apply', 'Apply'],
  ['profile', 'Profile'],
  ['documents', 'Documents'],
  ['answers', 'Answers'],
  ['settings', 'Settings'],
];

export interface Health {
  ok: boolean;
  /** Turned off in Settings, as opposed to unreachable. */
  off?: boolean;
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

function healthLabel(h: Health | null): [string, string] {
  if (!h) return ['unknown', 'Classifier…'];
  if (h.ok) return ['ok', 'Classifier on'];
  if (h.off) return ['off', 'Classifier off'];
  return ['down', 'Classifier offline'];
}

/** A file dropped outside a drop zone would replace the whole panel with that file; ignore it instead. */
function useBlockStrayDrops() {
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);
}

export function App() {
  useBlockStrayDrops();
  const [view, setView] = useState<View>('apply');
  /** Set on every navigation, so views can react to it (open a section, parse a document). */
  const [nav, setNav] = useState<GotoOptions>({});
  const tab = useActiveTab();
  const [health, recheck] = useClassifierHealth();
  const tabRefs = useRef<Partial<Record<View, HTMLButtonElement | null>>>({});

  const goto: Goto = (v, opts) => {
    setNav(opts ?? {});
    setView(v);
  };

  /** Arrow keys, Home and End move between tabs (the ARIA tabs pattern). */
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = VIEWS.findIndex(([v]) => v === view);
    const last = VIEWS.length - 1;
    const next = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const v = VIEWS[next][0];
    goto(v);
    tabRefs.current[v]?.focus();
  };

  const [healthState, healthText] = healthLabel(health);
  // Views stay mounted while hidden, so unsaved edits survive switching tabs.
  const content: Record<View, (active: boolean) => ReactNode> = {
    apply: (active) => <ApplyView tab={tab} goto={goto} active={active} />,
    profile: (active) => <ProfileView active={active} nav={nav} />,
    documents: () => <DocumentsView goto={goto} />,
    answers: () => <AnswersView />,
    settings: (active) => <SettingsView active={active} onSaved={recheck} health={health} />,
  };

  return (
    <div className="app">
      <header className="top">
        <h1>EzAutoApply</h1>
        <button type="button" className={`health ${healthState}`} title={health?.detail} onClick={() => goto('settings')}>
          <span className="dot" aria-hidden="true" />
          {healthText}
        </button>
      </header>
      <div className="tabs" role="tablist" aria-label="Sections">
        {VIEWS.map(([v, label]) => (
          <button
            key={v}
            ref={(el) => {
              tabRefs.current[v] = el;
            }}
            id={`tab-${v}`}
            type="button"
            role="tab"
            aria-selected={view === v}
            aria-controls={`panel-${v}`}
            tabIndex={view === v ? 0 : -1}
            className={view === v ? 'active' : ''}
            onClick={() => goto(v)}
            onKeyDown={onTabKey}
          >
            {label}
          </button>
        ))}
      </div>
      <main>
        {VIEWS.map(([v]) => (
          <section key={v} id={`panel-${v}`} role="tabpanel" aria-labelledby={`tab-${v}`} hidden={view !== v}>
            {content[v](view === v)}
          </section>
        ))}
      </main>
    </div>
  );
}
