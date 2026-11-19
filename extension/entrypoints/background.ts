import { type Browser, browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { type BridgeCommand, BridgeClient, bridgeFields, findJobTab, obeysReload, screenMoment } from '../src/bridge/client';
import { ownJob } from '../src/bridge/ownJob';
import { bangsFor, lengthen } from '../src/fill/password';
import { SystemOneClient } from '../src/classifier/systemone';
import { uploadFileName } from '../src/core/documents';
import { isAccountSite, isExternalRedirect } from '../src/core/sites';
import type { SiteError } from '../src/fill/siteErrors';
import { fieldIncidents, type Incident, incidentKey, missedIncident, type Redaction, redactionsFor, runIncidents } from '../src/incidents/incident';
import type { MissedField } from '../src/content/missed';
import { newRun, type PageCheck, type RunDeps, runPages } from '../src/run/loop';
import type { RunState } from '../src/run/types';
import type { AnswerValue, DocKind, DocSelection, SavedAnswer } from '../src/core/types';
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
  SendToFleetResult,
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
    sendScreen(run).catch(() => {});
  }
  if (bridge && run.status === 'stopped') {
    const tab = await readTab(run.tabId);
    const fields = Object.values(tab.reports).flatMap((r) => r.fields);
    const url = tab.reports['0']?.url ?? run.startUrl;
    fileIncidents((r) => runIncidents(run, fields, { url, now: Date.now() }, r)).catch(() => {});
  }
}

/**
 * The Office's "last screenshot" (#37): a small JPEG of the job's tab, once per page and once
 * when the Run stops. captureVisibleTab only sees a window's showing tab, so a tab in the
 * background is skipped. The picture shows the owner's answers: it goes to the bridge's memory
 * only, never into incidents.
 */
const lastScreen = new Map<number, string>();
async function sendScreen(run: RunState): Promise<void> {
  const moment = screenMoment(run);
  if (!run.jobId || !bridge || lastScreen.get(run.tabId) === moment) return;
  const tab = await browser.tabs.get(run.tabId);
  if (!tab.active || tab.windowId === undefined) return;
  lastScreen.set(run.tabId, moment);
  const image = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 45 });
  await bridge.client.postScreen(run.jobId, image);
}
browser.tabs.onRemoved.addListener((tabId) => lastScreen.delete(tabId));

// ---- Incidents (#18, plan §8.2) ------------------------------------------------------------
// Every field it couldn't fill, and every Run that couldn't move on, goes to the bridge with
// the profile's values replaced by placeholders. Only while the bridge is on: there is
// nowhere else to put them, and nothing is kept in the extension.
const filed = new Set<string>();

async function fileIncidents(make: (r: Redaction[]) => Incident[]): Promise<void> {
  const client = bridge?.client;
  if (!client) return;
  const incidents = make(redactionsFor(await getProfile()));
  if (filed.size > 5000) filed.clear();
  for (const incident of incidents) {
    const key = incidentKey(incident);
    if (filed.has(key)) continue;
    filed.add(key);
    client.postIncident(incident as unknown as Record<string, unknown>).catch(() => filed.delete(key));
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

/** The Run a bridge job is on (the latest one kept in session storage), or undefined. */
/** A job's open tab: the one its Run used, else one showing `urlPrefix` (the address its applier recorded). */
async function jobTabId(jobId: string, urlPrefix?: string): Promise<number | undefined> {
  const ran = await runForJob(jobId);
  if (ran && (await browser.tabs.get(ran.tabId).catch(() => null))) return ran.tabId;
  return urlPrefix ? findJobTab(await browser.tabs.query({}), urlPrefix)?.id : undefined;
}

async function runForJob(jobId: string): Promise<RunState | undefined> {
  const all = await browser.storage.session.get(null);
  return Object.values(all).find((v) => (v as RunState)?.jobId === jobId && typeof (v as RunState).tabId === 'number') as RunState | undefined;
}

/**
 * The owner pressed Submit on a job Run left ready (#29): when the tab then shows the
 * confirmation page, the Run's stop becomes "submitted" and the bridge marks the job so.
 */
async function checkSubmitted(tabId: number): Promise<void> {
  const run = await readRun(tabId);
  if (!run?.jobId || run.status !== 'stopped' || run.stop?.reason !== 'submitReady') return;
  for (const wait of [1500, 4000]) {
    await sleep(wait);
    const said = (await toTab(tabId, { type: 'confirmation' }, 0).catch(() => null)) as { detail?: string } | null;
    if (said?.detail) {
      const now = await readRun(tabId);
      if (now?.stop?.reason !== 'submitReady') return;
      await saveRun({ ...now, stop: { reason: 'submitted', detail: said.detail }, updatedAt: Date.now() });
      // The fleet's job is done: its tab closes a few seconds after the confirmation shows (owner, 2026-11-18).
      setTimeout(async () => {
        const later = await readRun(tabId).catch(() => null);
        if (later?.jobId === run.jobId && later?.stop?.reason === 'submitted') browser.tabs.remove(tabId).catch(() => {});
      }, CLOSE_AFTER_SUBMIT_MS);
      return;
    }
  }
}

/** How long a submitted fleet job's confirmation page stays before its tab closes. */
const CLOSE_AFTER_SUBMIT_MS = 5000;

/** The owner sends a posting to the fleet (#79): the panel's button or the right-click item. */
async function sendToFleet(url: string, title: string): Promise<SendToFleetResult> {
  const s = await getSettings();
  if (!s.bridgeEnabled || !s.bridgeToken) throw new Error('Turn on the agent fleet bridge in Settings first.');
  const job = ownJob(url, title);
  if (!job) throw new Error('This page isn’t a job posting the fleet can open.');
  const out = await new BridgeClient(s.bridgeUrl, s.bridgeToken).queueJobs([job]);
  const had = out.already?.[0];
  const name = (j: { title?: string; company?: string }) => [j.title, j.company].filter(Boolean).join(' at ');
  if (had) return { queued: false, id: had.id, status: had.status, name: name(had) || name(job) || job.applyUrl };
  return { queued: true, id: job.id, name: name(job) || job.applyUrl };
}

/** Feedback for the right-click item: a mark on the toolbar icon for a few seconds. */
function badge(tabId: number | undefined, ok: boolean, title: string): void {
  if (tabId === undefined) return;
  browser.action.setBadgeBackgroundColor({ tabId, color: ok ? '#2f7d4f' : '#b3261e' }).catch(() => {});
  browser.action.setBadgeText({ tabId, text: ok ? '✓' : '!' }).catch(() => {});
  browser.action.setTitle({ tabId, title }).catch(() => {});
  setTimeout(() => {
    browser.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    browser.action.setTitle({ tabId, title: 'EzAutoApply' }).catch(() => {});
  }, 6000);
}

async function onBridgeCommand(client: BridgeClient, cmd: BridgeCommand): Promise<void> {
  if (cmd.type === 'reload') {
    // The Fixer's rebuilt fleet build (#32). Running Runs resume after the reload (resumeRuns).
    if (obeysReload(browser.runtime.getManifest().name)) setTimeout(() => browser.runtime.reload(), 250);
    return;
  }
  if (cmd.type === 'stopAll') {
    for (const tabId of runs.keys()) cancelled.add(tabId);
    return;
  }
  if (cmd.type === 'run') {
    const asked = Date.now();
    // By address; else the tab this job ran in before (a send-back, or an address spelt another way, #86).
    let tabId = findJobTab(await browser.tabs.query({}), cmd.urlPrefix ?? '')?.id;
    if (tabId === undefined) {
      const before = await runForJob(cmd.jobId);
      if (before && (await browser.tabs.get(before.tabId).catch(() => null))) tabId = before.tabId;
    }
    if (tabId !== undefined) {
      const run = await startRun(tabId, cmd.jobId);
      // Already running there: report it now, so the agent waiting on this command hears back.
      if (run.startedAt < asked && run.jobId === cmd.jobId) await saveRun({ ...(await readRun(tabId) ?? run), updatedAt: Date.now() });
      return;
    }
    const run = newRun(-1, cmd.urlPrefix ?? '', Date.now(), cmd.jobId);
    run.status = 'stopped';
    run.stop = { reason: 'interrupted', detail: 'No open tab shows this job' };
    await client.reportRun(cmd.jobId, run, []);
    return;
  }
  if (cmd.type === 'close') {
    // Submitted (#94): its tab closes a few seconds later, like after the confirmation page.
    const tabId = await jobTabId(cmd.jobId, cmd.urlPrefix);
    if (tabId !== undefined) setTimeout(() => browser.tabs.remove(tabId).catch(() => {}), CLOSE_AFTER_SUBMIT_MS);
    return;
  }
  if (cmd.type === 'snippet') {
    // An applier filled a field itself (#98): the field's markup from whichever frame shows it, for the Fixer.
    const tabId = await jobTabId(cmd.jobId, cmd.urlPrefix);
    if (tabId === undefined) return;
    for (const frameId of await frameIds(tabId)) {
      const found = (await toTab(tabId, { type: 'missedField', label: cmd.label }, frameId).catch(() => null)) as MissedField | null;
      if (!found?.html) continue;
      const tab = await browser.tabs.get(tabId);
      const ctx = { url: tab.url ?? cmd.urlPrefix ?? '', now: Date.now(), jobId: cmd.jobId };
      await fileIncidents((r) => [missedIncident(ctx, { ...found, label: cmd.label, frameId, kind: cmd.kind, note: cmd.note, replaces: cmd.incidentId }, r)]);
      return;
    }
    return;
  }
  if (cmd.type === 'adopt') {
    // The applier started again in a new tab group (#95): the job's tab joins it, and the emptied old group goes.
    const tabId = await jobTabId(cmd.jobId, cmd.urlPrefix);
    if (tabId !== undefined) await browser.tabs.group({ tabIds: [tabId], groupId: cmd.groupId }).catch(() => {});
    return;
  }
  const run = await runForJob(cmd.jobId);
  if (!run) return;
  if (cmd.type === 'focus') {
    const tab = await browser.tabs.update(run.tabId, { active: true }).catch(() => null);
    if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return;
  }
  // An answer for a field on the job's tab. With `save`, it also goes into the answer bank as an
  // agent's answer, which fills for review until the owner approves it in Answers (#21).
  const fields = Object.values((await readTab(run.tabId)).reports).flatMap((r) => r.fields);
  const field = fields.find((f) => f.id === cmd.fieldId && (cmd.frameId === undefined || f.frameId === cmd.frameId));
  const frameId = cmd.frameId ?? field?.frameId ?? 0;
  await toTab(run.tabId, { type: 'applyAnswer', fieldId: cmd.fieldId, answer: cmd.answer as AnswerValue }, frameId);
  const save = cmd.save as { scope?: unknown; sourceRefs?: unknown; createdBy?: unknown } | null | undefined;
  const a = cmd.answer;
  const storable = typeof a === 'string' || typeof a === 'boolean' || (Array.isArray(a) && a.every((x) => typeof x === 'string'));
  // Never a password or a file, and never a field nobody could name again.
  if (save && field && storable && field.kind !== 'password' && field.kind !== 'file' && field.label !== '(unlabeled field)') {
    await saveAnswer({
      question: field.label.replace(/\s*\*\s*$/, ''),
      fieldKind: field.kind,
      ...(field.options.length && { options: field.options }),
      ...(field.key && { canonicalKey: field.key }),
      answer: a as SavedAnswer['answer'],
      scope: typeof save.scope === 'string' && save.scope ? save.scope : 'global',
      origin: 'agent',
      ...(Array.isArray(save.sourceRefs) && { sourceRefs: save.sourceRefs.map(String).slice(0, 10) }),
      ...(typeof save.createdBy === 'string' && { createdBy: save.createdBy.slice(0, 40) }),
    });
  }
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
      const saved = (await getAccountPassword()) || null;
      if (!saved) return null;
      // A site that asked for a longer password got "!" added (#85): every later fill there, sign-in too, types the same.
      let host = '';
      try {
        host = new URL(sender.url ?? '').hostname;
      } catch {
        /* no site: the saved password as it is */
      }
      if (!host) return saved;
      const key = `passwordBangs:${host}`;
      const had = Number((await browser.storage.local.get(key))[key]) || 0;
      const need = bangsFor(saved.length, msg.minLength ?? 0);
      if (need > had) await browser.storage.local.set({ [key]: need });
      return lengthen(saved, Math.max(had, need));
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
      // Once the frame is done (not while the classifier still works on its leftovers).
      if (bridge && !report.pending && report.fields.length) {
        const run = await readRun(tabId);
        const ctx = { url: report.url || sender.url || '', now: Date.now(), ...(run?.status === 'running' && { page: run.page, ...(run.jobId && { jobId: run.jobId }) }) };
        fileIncidents((r) => fieldIncidents(report.fields, ctx, r)).catch(() => {});
      }
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
    case 'sendToFleet': {
      const tab = await browser.tabs.get(msg.tabId);
      return sendToFleet(tab.url ?? '', tab.title ?? '');
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

  // Right-click a page or a link (LinkedIn's job list) → the fleet's queue (#79).
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus?.removeAll().then(() => browser.contextMenus.create({ id: 'ezaa-send', title: 'Send to the EzAutoApply fleet', contexts: ['page', 'link'] }));
  });
  browser.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'ezaa-send') return;
    const url = info.linkUrl ?? info.pageUrl ?? tab?.url ?? '';
    sendToFleet(url, info.linkUrl ? '' : (tab?.title ?? '')).then(
      (r) => badge(tab?.id, true, r.queued ? `Queued for the fleet: ${r.name}` : `Already in the queue (${r.status}): ${r.name}`),
      (e: Error) => badge(tab?.id, false, `Not queued: ${e.message}`),
    );
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'autofill') return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) autofillTab(tab.id).catch(() => {});
  });

  // A new page in the tab means the old report no longer applies.
  browser.tabs.onUpdated.addListener((tabId, info) => {
    // A page load or an in-page move after the owner's Submit may be the confirmation (#29).
    if (bridge && (info.status === 'complete' || info.url)) checkSubmitted(tabId).catch(() => {});
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
