import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { SystemOneClient } from '../classifier/systemone';
import type { DocSelection } from '../core/types';
import { getSettings } from '../db';
import { type BackgroundBroadcast, call, type PanelToBackground, type TabState } from '../messages';
import type { SectionType } from '../parse/resume';
import { SECTION_TYPES } from '../parse/resume';

/** Side-panel side of the message protocol, plus hooks for the active tab. */

export function send<T>(msg: PanelToBackground): Promise<T> {
  return call<T>(() => browser.runtime.sendMessage(msg));
}

export interface ActiveTab {
  id: number;
  url: string;
  title: string;
}

/** The tab the side panel is currently next to. */
export function useActiveTab(): ActiveTab | null {
  const [tab, setTab] = useState<ActiveTab | null>(null);
  useEffect(() => {
    const refresh = async () => {
      const [t] = await browser.tabs.query({ active: true, currentWindow: true });
      setTab(t?.id !== undefined ? { id: t.id, url: t.url ?? '', title: t.title ?? '' } : null);
    };
    refresh();
    const onUpdated = (_id: number, info: { status?: string; url?: string; title?: string }) => {
      if (info.status === 'complete' || info.url || info.title) refresh();
    };
    browser.tabs.onActivated.addListener(refresh);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.windows.onFocusChanged.addListener(refresh);
    return () => {
      browser.tabs.onActivated.removeListener(refresh);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.windows.onFocusChanged.removeListener(refresh);
    };
  }, []);
  return tab;
}

const EMPTY: TabState = { reports: [], selection: {} };

/** Fill reports and document choices for a tab, kept live via background broadcasts. */
export function useTabState(tabId: number | undefined): { state: TabState; busy: boolean; setBusy(b: boolean): void } {
  const [state, setState] = useState<TabState>(EMPTY);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (tabId === undefined) return;
    let alive = true;
    const load = () =>
      send<TabState>({ type: 'getTabState', tabId })
        .then((s) => alive && setState(s ?? EMPTY))
        .catch(() => {});
    load();
    const onMsg = (msg: BackgroundBroadcast) => {
      if (msg.tabId !== tabId) return;
      if (msg.type === 'autofillStarted') setBusy(true);
      if (msg.type === 'tabStateChanged') {
        setBusy(false);
        load();
      }
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => {
      alive = false;
      browser.runtime.onMessage.removeListener(onMsg);
    };
  }, [tabId]);
  return { state, busy, setBusy };
}

export function setDocSelection(tabId: number, selection: DocSelection) {
  return send<null>({ type: 'setDocSelection', tabId, selection });
}

/** Ask the classifier which resume section an unrecognized heading is. */
export async function classifyHeading(heading: string, sample: string): Promise<SectionType | null> {
  const settings = await getSettings();
  if (settings.classifier.provider === 'none') return null;
  const client = new SystemOneClient(settings.classifier);
  const criteria: Record<string, string> = {
    summary: 'A professional summary or objective',
    experience: 'Jobs and work history',
    education: 'Schools, degrees and coursework',
    projects: 'Personal or academic projects',
    skills: 'Skills, tools and technologies',
    certifications: 'Certifications, licenses or courses',
    languages: 'Spoken languages',
    links: 'Links to online profiles',
    other: 'Awards, volunteering, interests, publications or anything else',
  };
  const res = await client.predict(
    {
      state: { body: `Resume section heading: ${heading}\nFirst lines: ${sample.slice(0, 300)}` },
      questions: { section: { type: 'choice', instructions: 'What kind of resume section is this?', criteria } },
    },
    20_000,
  );
  const a = res.answers.section;
  const choice = a?.choice as SectionType | undefined;
  const conf = a?.answer_confidence ?? a?.probabilities?.[a?.choice ?? ''] ?? 0;
  return choice && SECTION_TYPES.includes(choice) && conf >= settings.classifier.reviewThreshold ? choice : null;
}
