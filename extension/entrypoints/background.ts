import { type Browser, browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { SystemOneClient } from '../src/classifier/systemone';
import { uploadFileName } from '../src/core/documents';
import { isAccountSite } from '../src/core/sites';
import type { DocKind, DocSelection } from '../src/core/types';
import {
  blobToBase64,
  documentFor,
  getAccountPassword,
  getProfile,
  getSettings,
  listAnswers,
  logApplication,
  markAnswersUsed,
  saveAnswer,
} from '../src/db';
import type { FrameReport } from '../src/fill/types';
import type {
  BackgroundBroadcast,
  BackgroundToContent,
  ContentContext,
  ContentToBackground,
  DocumentResponse,
  PanelToBackground,
  TabState,
} from '../src/messages';

/**
 * The background worker owns the database and the classifier connection.
 * Per-tab fill reports live in session storage so they survive the worker
 * being suspended.
 */

const tabKey = (tabId: number) => `tab:${tabId}`;

interface StoredTabState {
  reports: Record<string, FrameReport>;
  selection: DocSelection;
}

async function readTab(tabId: number): Promise<StoredTabState> {
  const key = tabKey(tabId);
  const got = await browser.storage.session.get(key);
  return (got[key] as StoredTabState | undefined) ?? { reports: {}, selection: {} };
}

async function writeTab(tabId: number, state: StoredTabState): Promise<void> {
  await browser.storage.session.set({ [tabKey(tabId)]: state });
  broadcast({ type: 'tabStateChanged', tabId });
}

/** Serialize read-modify-write of a tab's state; frames report concurrently. */
const tabLocks = new Map<number, Promise<unknown>>();
function updateTab<T>(tabId: number, fn: (s: StoredTabState) => Promise<T> | T): Promise<T> {
  const prev = tabLocks.get(tabId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const s = await readTab(tabId);
    const out = await fn(s);
    await writeTab(tabId, s);
    return out;
  });
  tabLocks.set(tabId, next);
  return next;
}

function broadcast(msg: BackgroundBroadcast): void {
  // No side panel open is normal; ignore "receiving end does not exist".
  browser.runtime.sendMessage(msg).catch(() => {});
}

async function toTab(tabId: number, msg: BackgroundToContent, frameId?: number): Promise<unknown> {
  return browser.tabs.sendMessage(tabId, msg, frameId === undefined ? undefined : { frameId });
}

async function autofillTab(tabId: number): Promise<void> {
  broadcast({ type: 'autofillStarted', tabId });
  // Sent to every frame; each frame scans and fills its own fields and reports back.
  await toTab(tabId, { type: 'autofill' }).catch(() => {
    throw new Error('This page can’t be autofilled. Reload it, or open a regular website tab.');
  });
}

async function classifier() {
  const settings = await getSettings();
  if (settings.classifier.provider === 'none') throw new Error('Classifier disabled');
  return new SystemOneClient(settings.classifier);
}

async function documentPayload(tabId: number | undefined, kind: DocKind): Promise<DocumentResponse> {
  const selection = tabId === undefined ? {} : (await readTab(tabId)).selection;
  if (selection[kind] === 'none') return null;
  const doc = await documentFor(kind, selection[kind]);
  if (!doc) return null;
  // Employers receive a standardized name (Jordan_Rivera_Resume.pdf), not whatever the file was called locally.
  const [profile, settings] = await Promise.all([getProfile(), getSettings()]);
  const fileName = uploadFileName(doc, profile.personal, settings.fileNameFormat);
  return { name: doc.name, fileName, mime: doc.mime, base64: await blobToBase64(doc.blob), text: doc.text };
}

async function recordApplication(tabId: number, report: FrameReport, tab: Browser.tabs.Tab | undefined): Promise<void> {
  if (report.frameId !== 0 && !tab?.url) return;
  const state = await readTab(tabId);
  const fields = Object.values(state.reports).flatMap((r) => r.fields);
  if (!fields.length) return;
  const url = tab?.url ?? report.url;
  const resume = await documentFor('resume', state.selection.resume);
  const cover = await documentFor('coverLetter', state.selection.coverLetter);
  const usedCover = fields.some((f) => f.key === 'coverLetter' && (f.status === 'filled' || f.status === 'review'));
  await logApplication({
    url,
    host: new URL(url).hostname,
    title: tab?.title ?? report.title,
    date: Date.now(),
    resumeId: resume?.id,
    coverLetterId: usedCover ? cover?.id : undefined,
    filled: fields.filter((f) => f.status === 'filled').length,
    review: fields.filter((f) => f.status === 'review').length,
    needs: fields.filter((f) => f.status === 'needs').length,
  });
}

async function handleContent(msg: ContentToBackground, sender: Browser.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  switch (msg.type) {
    case 'getContext': {
      const ctx: ContentContext = { profile: await getProfile(), answers: await listAnswers(), settings: await getSettings() };
      return ctx;
    }
    case 'getSettings':
      return getSettings();
    case 'classify': {
      const c = await classifier();
      return msg.op === 'predict' ? c.predict(msg.req) : c.predictBatch(msg.req);
    }
    case 'getDocument':
      return documentPayload(tabId, msg.kind);
    case 'getSecret': {
      // sender.url is the frame's own URL, so an embedded iframe is judged by its own site.
      const settings = await getSettings();
      if (!settings.passwordOnAnySite && !isAccountSite(sender.url ?? '')) return null;
      return (await getAccountPassword()) || null;
    }
    case 'report': {
      if (tabId === undefined) return null;
      const frameId = sender.frameId ?? 0;
      const report = { ...msg.report, frameId, fields: msg.report.fields.map((f) => ({ ...f, frameId })) };
      await updateTab(tabId, (state) => {
        if (report.fields.length) state.reports[String(frameId)] = report;
        else delete state.reports[String(frameId)];
      });
      if (report.fields.length) await recordApplication(tabId, report, sender.tab).catch(() => {});
      return null;
    }
    case 'fieldEdited': {
      if (tabId === undefined) return null;
      await updateTab(tabId, (state) => {
        const f = state.reports[String(sender.frameId ?? 0)]?.fields.find((x) => x.id === msg.fieldId);
        if (f) f.userValue = msg.userValue;
      });
      return null;
    }
    case 'answersUsed':
      await markAnswersUsed(msg.ids);
      return null;
    case 'autofillAll':
      if (tabId !== undefined) await autofillTab(tabId);
      return null;
  }
}

async function handlePanel(msg: PanelToBackground): Promise<unknown> {
  switch (msg.type) {
    case 'getTabState': {
      const s = await readTab(msg.tabId);
      const state: TabState = {
        reports: Object.values(s.reports).sort((a, b) => a.frameId - b.frameId),
        selection: s.selection,
      };
      return state;
    }
    case 'autofillTab':
      await autofillTab(msg.tabId);
      return null;
    case 'clearTab':
      await updateTab(msg.tabId, (s) => {
        s.reports = {};
      });
      await toTab(msg.tabId, { type: 'clearHighlights' }).catch(() => {});
      return null;
    case 'setDocSelection':
      await updateTab(msg.tabId, (s) => {
        s.selection = msg.selection;
      });
      return null;
    case 'answerField': {
      if (msg.save) await saveAnswer({ ...msg.save, answer: msg.answer });
      return toTab(msg.tabId, { type: 'applyAnswer', fieldId: msg.fieldId, answer: msg.answer }, msg.frameId);
    }
    case 'focusField':
      return toTab(msg.tabId, { type: 'focusField', fieldId: msg.fieldId }, msg.frameId);
    case 'classifierHealth':
      return new SystemOneClient((await getSettings()).classifier).health();
    case 'settingsChanged': {
      const settings = await getSettings();
      const tabs = await browser.tabs.query({});
      for (const t of tabs) if (t.id !== undefined) toTab(t.id, { type: 'settingsChanged', settings }).catch(() => {});
      return null;
    }
  }
}

export default defineBackground(() => {
  browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  const extensionOrigin = browser.runtime.getURL('/');
  browser.runtime.onMessage.addListener((msg: ContentToBackground | PanelToBackground, sender, sendResponse) => {
    // Extension pages (the side panel, even when opened in a tab) vs content scripts in web pages.
    const fromExtensionPage = !!sender.url?.startsWith(extensionOrigin);
    const work = fromExtensionPage ? handlePanel(msg as PanelToBackground) : handleContent(msg as ContentToBackground, sender);
    work.then(
      (res) => sendResponse(res === undefined ? { error: `Unknown message: ${(msg as { type?: string }).type}` } : res),
      (e: Error) => sendResponse({ error: e.message || String(e) }),
    );
    return true; // keep the channel open for the async response
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'autofill') return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) autofillTab(tab.id).catch(() => {});
  });

  // A new page in the tab means the old report no longer applies.
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) {
      updateTab(tabId, (s) => {
        s.reports = {};
      }).catch(() => {});
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    browser.storage.session.remove(tabKey(tabId)).catch(() => {});
  });
});
