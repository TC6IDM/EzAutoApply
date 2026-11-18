import { type Browser, browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { type BridgeCommand, BridgeClient, bridgeFields, findJobTab } from '../src/bridge/client';
import { SystemOneClient } from '../src/classifier/systemone';
import { uploadFileName } from '../src/core/documents';
import { isAccountSite, isExternalRedirect } from '../src/core/sites';
import type { SiteError } from '../src/fill/siteErrors';
import { newRun, type PageCheck, type RunDeps, runPages } from '../src/run/loop';
import type { RunState } from '../src/run/types';
import type { AnswerValue, DocKind, DocSelection } from '../src/core/types';
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
import type { FillProgress, FrameReport } from '../src/fill/types';
import type {
  AdvanceTarget,
  BackgroundBroadcast,
  BackgroundToContent,
  ContentContext,
  ContentToBackground,
  DocumentResponse,
  PanelToBackground,
  RunCheckResponse,
  TabState,
} from '../src/messages';
import { isError } from '../src/messages';

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

/**
 * Each frame's running autofill, by tab and then frame. Kept in memory: a run keeps messaging the
 * worker, so it isn't suspended mid-run, and a worker that restarted has nothing running to show.
 */
const fillProgress = new Map<number, Map<number, FillProgress>>();

function tabProgress(tabId: number): FillProgress | null {
  const frames = [...(fillProgress.get(tabId)?.values() ?? [])];
  if (!frames.length) return null;
  return { filled: frames.reduce((n, p) => n + p.filled, 0), remaining: frames.reduce((n, p) => n + p.remaining, 0) };
}

/** Record a frame's progress (null: it finished) and show the tab's total in the panel and on the page's button. */
function setProgress(tabId: number, frameId: number, progress: FillProgress | null): void {
  const frames = fillProgress.get(tabId) ?? new Map<number, FillProgress>();
  if (progress) frames.set(frameId, progress);
  else if (!frames.delete(frameId)) return;
  if (frames.size) fillProgress.set(tabId, frames);
  else fillProgress.delete(tabId);
  const total = tabProgress(tabId);
  broadcast({ type: 'fillProgress', tabId, progress: total });
  // Only the top frame has the floating button; a form in an iframe still shows its progress there.
  toTab(tabId, { type: 'fillProgress', progress: total }, 0).catch(() => {});
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

/**
 * The frames of a tab. tabs.sendMessage to a whole tab only returns the first frame's answer, so
 * questions every frame must answer go to each one. The list is kept briefly; the panel asks often.
 */
const frameCache = new Map<number, { ids: number[]; at: number }>();
async function frameIds(tabId: number): Promise<number[]> {
  const hit = frameCache.get(tabId);
  if (hit && Date.now() - hit.at < 5000) return hit.ids;
  let ids = [0];
  try {
    const found = await browser.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => 0 });
    ids = [...new Set(found.map((r) => r.frameId))];
  } catch {
    // Pages scripts can't run on (the Web Store, chrome://): only the top frame is asked.
  }
  frameCache.set(tabId, { ids, at: Date.now() });
  return ids;
}

/** The page's Next / Submit / Sign In / Apply button, from whichever frame has the strongest one. */
async function findAdvance(tabId: number, run = false): Promise<AdvanceTarget | null> {
  const ids = await frameIds(tabId);
  const found = await Promise.all(
    ids.map((frameId) =>
      toTab(tabId, { type: 'findAdvance', run }, frameId)
        .then((r) => (r ? { ...(r as Omit<AdvanceTarget, 'frameId'>), frameId } : null))
        .catch(() => null),
    ),
  );
  return found.filter((t): t is AdvanceTarget => !!t).sort((a, b) => b.score - a.score)[0] ?? null;
}

// ---- Run to Submit (#9, docs/agent-fleet-plan.md §6) -------------------------------------
// One press fills a page, presses its Next / Sign in / Create account, and repeats until
// Submit, which it never presses, or a stop (src/run/loop.ts). RunState lives in session
// storage, so a worker that restarted (or the fleet build reloaded) carries on with the Run.

const runKey = (tabId: number) => `run:${tabId}`;
const runs = new Map<number, Promise<RunState>>();
const cancelled = new Set<number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readRun(tabId: number): Promise<RunState | null> {
  const key = runKey(tabId);
  return ((await browser.storage.session.get(key))[key] as RunState | undefined) ?? null;
}

async function saveRun(run: RunState): Promise<void> {
  await browser.storage.session.set({ [runKey(run.tabId)]: run });
  broadcast({ type: 'runChanged', tabId: run.tabId, run });
  toTab(run.tabId, { type: 'runState', run }, 0).catch(() => {});
  if (run.jobId && bridge) {
    const fields = Object.values((await readTab(run.tabId)).reports).flatMap((r) => r.fields);
    bridge.client.reportRun(run.jobId, run, bridgeFields(fields)).catch(() => {});
  }
}

// ---- The local bridge (#17, bridge/README.md) ---------------------------------------------
// Only while settings.bridgeEnabled is on and a token is set. The background long-polls the
// bridge for commands; an alarm restarts the loop after the worker was suspended. Unreachable
// is quiet: it tries again in a few seconds, and nothing else in the extension changes.

let bridge: { client: BridgeClient; stop(): void } | null = null;
const BRIDGE_ALARM = 'bridge';

async function syncBridge(): Promise<void> {
  const s = await getSettings();
  bridge?.stop();
  bridge = null;
  if (!s.bridgeEnabled || !s.bridgeToken) {
    await browser.alarms?.clear(BRIDGE_ALARM).catch(() => {});
    return;
  }
  browser.alarms?.create(BRIDGE_ALARM, { periodInMinutes: 1 });
  const client = new BridgeClient(s.bridgeUrl, s.bridgeToken);
  const ctl = new AbortController();
  let on = true;
  bridge = {
    client,
    stop: () => {
      on = false;
      ctl.abort();
    },
  };
  (async () => {
    while (on) {
      try {
        for (const cmd of await client.commands(25, ctl.signal)) await onBridgeCommand(client, cmd).catch(() => {});
      } catch {
        if (on) await sleep(5000);
      }
    }
  })();
}

async function onBridgeCommand(client: BridgeClient, cmd: BridgeCommand): Promise<void> {
  if (cmd.type === 'stopAll') {
    for (const tabId of runs.keys()) cancelled.add(tabId);
    return;
  }
  if (cmd.type === 'run') {
    const tab = findJobTab(await browser.tabs.query({}), cmd.urlPrefix ?? '');
    if (tab?.id !== undefined) {
      await startRun(tab.id, cmd.jobId);
      return;
    }
    const run = newRun(-1, cmd.urlPrefix ?? '', Date.now(), cmd.jobId);
    run.status = 'stopped';
    run.stop = { reason: 'interrupted', detail: 'No open tab shows this job' };
    await client.reportRun(cmd.jobId, run, []);
    return;
  }
  // An answer for a field on the job's tab. It fills the field only: agent answers are saved to
  // the answer bank once they can be flagged for approval (#21).
  const all = await browser.storage.session.get(null);
  const run = Object.values(all).find((v) => (v as RunState)?.jobId === cmd.jobId && typeof (v as RunState).tabId === 'number') as RunState | undefined;
  if (!run) return;
  const fields = Object.values((await readTab(run.tabId)).reports).flatMap((r) => r.fields);
  const frameId = cmd.frameId ?? fields.find((f) => f.id === cmd.fieldId)?.frameId ?? 0;
  await toTab(run.tabId, { type: 'applyAnswer', fieldId: cmd.fieldId, answer: cmd.answer as AnswerValue }, frameId);
}

/** Autofill every frame and wait until the last one is done (the message only waits for the first). */
async function fillAndWait(tabId: number): Promise<void> {
  await autofillTab(tabId);
  const end = Date.now() + 180_000;
  let quietSince = Date.now();
  while (Date.now() < end) {
    await sleep(250);
    if (tabProgress(tabId)) quietSince = Date.now();
    else if (Date.now() - quietSince >= 1000) break;
  }
  await tabLocks.get(tabId)?.catch(() => {}); // the frames' reports are written
}

/** Every frame's look at the page; the top frame must answer (retried while a new page loads). */
async function checkPage(tabId: number): Promise<PageCheck> {
  for (let tries = 0; ; tries++) {
    const ids = await frameIds(tabId);
    const got = await Promise.all(
      ids.map((frameId) => (toTab(tabId, { type: 'runCheck' }, frameId) as Promise<RunCheckResponse>).then((r) => ({ frameId, r })).catch(() => null)),
    );
    const ok = got.filter((g): g is { frameId: number; r: RunCheckResponse } => !!g?.r && !isError(g.r)).sort((a, b) => a.frameId - b.frameId);
    const top = ok.find((g) => g.frameId === 0);
    if (top) {
      return {
        url: top.r.url,
        fingerprint: ok.map((g) => g.r.fingerprint).join('+'),
        blockers: ok.flatMap((g) => g.r.blockers),
        confirmation: top.r.confirmation,
      };
    }
    if (tries >= 40) throw new Error('The page stopped answering');
    frameCache.delete(tabId);
    await sleep(500);
  }
}

/** Ask every frame and put the answers together (lists). */
async function fromFrames<T>(tabId: number, msg: BackgroundToContent): Promise<T[]> {
  const ids = await frameIds(tabId);
  const got = await Promise.all(ids.map((frameId) => (toTab(tabId, msg, frameId) as Promise<T[]>).catch(() => [] as T[])));
  return got.flatMap((g) => (Array.isArray(g) ? g : []));
}

/** After a press: did the page move on? Waits through full page loads, then for the page to go quiet. */
async function waitForChange(tabId: number, before: PageCheck): Promise<boolean> {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    await sleep(500);
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('The tab was closed');
    if (tab.status === 'loading') continue;
    const now = await checkPage(tabId).catch(() => null);
    if (!now) continue;
    if (now.url.replace(/#.*$/, '') !== before.url.replace(/#.*$/, '') || now.fingerprint !== before.fingerprint) {
      await toTab(tabId, { type: 'settle' }, 0).catch(() => {});
      return true;
    }
  }
  return false;
}

function runDeps(tabId: number): RunDeps {
  return {
    fill: () => fillAndWait(tabId),
    reports: async () => Object.values((await readTab(tabId)).reports).flatMap((r) => r.fields),
    check: () => checkPage(tabId),
    acceptTerms: () => fromFrames<string>(tabId, { type: 'acceptTerms' }),
    findButton: () => findAdvance(tabId, true),
    press: async (t) => {
      const r = (await toTab(tabId, { type: 'advance', run: true }, t.frameId).catch(() => null)) as { ok?: boolean } | null;
      return !!r?.ok;
    },
    waitForChange: (before) => waitForChange(tabId, before),
    siteErrors: () => fromFrames<SiteError>(tabId, { type: 'siteErrors' }),
    save: saveRun,
    cancelled: () => cancelled.has(tabId),
    now: () => Date.now(),
  };
}

/** Carry on with a Run (a new one, or one a restarted worker found still running). */
function launchRun(run: RunState): Promise<RunState> {
  const going = runs.get(run.tabId);
  if (going) return going;
  cancelled.delete(run.tabId);
  const p = getSettings()
    .then((s) => runPages(run, runDeps(run.tabId), { maxPages: s.runMaxPages, stopOnReview: s.runStopOnReview, isExternal: isExternalRedirect }))
    .finally(() => runs.delete(run.tabId));
  runs.set(run.tabId, p);
  return p;
}

async function startRun(tabId: number, jobId?: string): Promise<RunState> {
  const current = await readRun(tabId);
  if (current?.status === 'running' && runs.has(tabId)) return current;
  const tab = await browser.tabs.get(tabId);
  const run = newRun(tabId, tab.url ?? '', Date.now(), jobId);
  await saveRun(run);
  launchRun(run).catch(() => {});
  return run;
}

/** Runs a previous worker left running: carry on with them. */
async function resumeRuns(): Promise<void> {
  const all = await browser.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    const run = value as RunState;
    if (!key.startsWith('run:') || run?.status !== 'running') continue;
    const tab = await browser.tabs.get(run.tabId).catch(() => null);
    if (tab) launchRun(run).catch(() => {});
    else await browser.storage.session.remove(key);
  }
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
    case 'progress':
      if (tabId !== undefined) setProgress(tabId, sender.frameId ?? 0, msg.progress);
      return null;
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
    case 'runAll':
      return tabId === undefined ? null : startRun(tabId);
    case 'stopRun':
      if (tabId !== undefined) cancelled.add(tabId);
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
        progress: tabProgress(msg.tabId),
        run: await readRun(msg.tabId),
      };
      return state;
    }
    case 'startRun':
      return startRun(msg.tabId);
    case 'cancelRun':
      cancelled.add(msg.tabId);
      return readRun(msg.tabId);
    case 'getRun':
      return readRun(msg.tabId);
    case 'autofillTab':
      await autofillTab(msg.tabId);
      return null;
    case 'clearTab':
      await updateTab(msg.tabId, (s) => {
        s.reports = {};
      });
      await toTab(msg.tabId, { type: 'clearReports' }).catch(() => {});
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
    case 'findAdvance':
      return findAdvance(msg.tabId, msg.run);
    case 'advance':
      return toTab(msg.tabId, { type: 'advance' }, msg.frameId);
    case 'confirmation':
      return toTab(msg.tabId, { type: 'confirmation' }, 0).catch(() => null);
    case 'classifierHealth':
      return new SystemOneClient((await getSettings()).classifier).health();
    case 'bridgeHealth': {
      const s = await getSettings();
      return new BridgeClient(s.bridgeUrl, s.bridgeToken).health();
    }
    case 'settingsChanged': {
      await syncBridge();
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
      frameCache.delete(tabId);
      // The page that was filling is gone, so its run won't report finishing.
      if (fillProgress.delete(tabId)) broadcast({ type: 'fillProgress', tabId, progress: null });
      updateTab(tabId, (s) => {
        s.reports = {};
      }).catch(() => {});
    }
  });
  resumeRuns().catch(() => {});
  syncBridge().catch(() => {});
  browser.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === BRIDGE_ALARM && !bridge) syncBridge().catch(() => {});
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    cancelled.add(tabId);
    browser.storage.session.remove([tabKey(tabId), runKey(tabId)]).catch(() => {});
    frameCache.delete(tabId);
    fillProgress.delete(tabId);
  });
});
