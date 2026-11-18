import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunState, StopReason } from '../../extension/src/run/types.ts';
import { type OfficeEvent, officeSnapshot, switchEvents } from './office.ts';
import { groupTickets, OUTCOMES, type Outcome, readIncidentFiles, readResolutions, type Ticket, writeResolutions } from './tickets.ts';
import { DEFAULT_SETTINGS, type FleetSettings, loadSettings, mergeSettings, saveSettings, switchedOff } from './settings.ts';
import { JOB_STATUSES, type JobStatus, type QueueStore } from './queue.ts';

/**
 * The local bridge (#16, docs/agent-fleet-plan.md §4.3): 127.0.0.1 only, every call but
 * /health carries the token. Agents claim jobs, start Runs and send answers; the extension
 * (when its "Connect to local bridge" setting is on, #17) long-polls /ext/commands for them and
 * reports each Run back on /ext/runs. The account password never crosses it.
 */

export interface BridgeOptions {
  token: string;
  queue: QueueStore;
  /** Where incidents are written (outside git): ~/.ezautoapply/incidents. */
  incidentsDir: string;
  /** For the Host check: the port the server listens on (0: whatever it was given, for tests). */
  port: number;
  now?: () => number;
  /** Longest /ext/commands long-poll, ms. */
  maxWaitMs?: number;
  /** Claims pause while this many jobs wait for the owner's Submit, each in its own open tab (#29). */
  maxReadyOpen?: number;
  /** The Fleet Office page (#35), served at /office. */
  officeFile?: string;
  /** Where the fleet switches are kept (#54); without it they live in memory only (tests). */
  settingsFile?: string;
}

export const OFFICE_FILE = fileURLToPath(new URL('../office/index.html', import.meta.url));
/** How often the Office stream looks for changes made outside the bridge (`/queue` appending jobs). */
const OFFICE_POLL_MS = 2000;
/** Screenshots kept: the latest of this many jobs. */
const MAX_SCREENS = 16;

export const MAX_READY_OPEN = 6;

/** What the extension is asked to do. */
export type Command =
  | { id: string; type: 'run'; jobId: string; urlPrefix?: string; at: number }
  | { id: string; type: 'answer'; jobId: string; fieldId: string; frameId?: number; answer: unknown; save?: unknown; at: number }
  | { id: string; type: 'stopAll'; at: number }
  /** Bring the job's tab and window to the front (the ready list's "go to tab", #29). */
  | { id: string; type: 'focus'; jobId: string; at: number }
  /** The Fixer rebuilt the fleet build: reload it (only "EzAutoApply (fleet)" obeys; #32). */
  | { id: string; type: 'reload'; at: number };

/** A command before it gets its id and time (Omit over each member of the union). */
type NewCommand = Command extends infer C ? (C extends Command ? Omit<C, 'id' | 'at'> : never) : never;

/** Where a job stands once its Run stops. Cancelled Runs leave the job as it was. */
const AFTER_RUN: Partial<Record<StopReason, JobStatus>> = {
  submitReady: 'ready',
  submitted: 'submitted',
  needsYou: 'needsYou',
  review: 'needsYou',
  validationErrors: 'needsYou',
  verificationCode: 'needsYou',
  captcha: 'needsYou',
  assessment: 'needsYou',
  noProgress: 'stuck',
  noButton: 'stuck',
  externalRedirect: 'stuck',
  maxPages: 'stuck',
  interrupted: 'stuck',
};

const MAX_BODY = 2 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createBridge(o: BridgeOptions) {
  const now = o.now ?? Date.now;
  const commands: (Command & { delivered?: boolean })[] = [];
  /** Each job's latest Run, and its fields as the extension saw them (labels and status, never values). */
  const runs = new Map<string, { run: RunState; fields: unknown[]; at: number }>();
  const waiters = new Set<() => void>();
  let stopped = false;
  /** Worker name → when it first asked for a job: the Office's applier desks. */
  let settings: FleetSettings = o.settingsFile ? loadSettings(o.settingsFile) : structuredClone(DEFAULT_SETTINGS);
  /** Switch changes since the bridge started, for the Office's ticker. */
  const switchLog: OfficeEvent[] = [];
  const workersSeen = new Map<string, number>();
  const incidentsByDay = new Map<string, number>();
  /**
   * Each job's latest screenshot of its tab (#37), for the Office. It shows the owner's answers,
   * so it is held in memory only (never written to disk, gone when the bridge stops) and served
   * only with the token.
   */
  const screens = new Map<string, { image: Buffer; type: string; at: string }>();
  /** The Fixer's tickets (#32), rebuilt from the incident files after any write. */
  const ticketsFile = join(o.incidentsDir, 'tickets.json');
  let ticketsCache: Ticket[] | null = null;
  const tickets = () => (ticketsCache ??= groupTickets(readIncidentFiles(o.incidentsDir), readResolutions(ticketsFile)));

  const queueCommand = (c: NewCommand): Command => {
    const cmd = { ...c, id: randomUUID(), at: now() } as Command;
    commands.push(cmd);
    for (const wake of [...waiters]) wake();
    return cmd;
  };

  const tokenOk = (req: IncomingMessage, url?: URL) => {
    // The Office page's EventSource can't send headers, so its stream alone takes the token in the query.
    const given = url?.searchParams.get('token') ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const got = Buffer.from(given);
    const want = Buffer.from(o.token);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
      chunks.push(c as Buffer);
    }
    if (!size) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* falls through */
    }
    throw new HttpError(400, 'Expected a JSON object');
  }

  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || !v) throw new HttpError(400, `${name} is required`);
    return v;
  };

  async function waitForCommands(ms: number): Promise<void> {
    if (commands.some((c) => !c.delivered) || ms <= 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
    });
  }

  async function route(req: IncomingMessage, url: URL): Promise<[number, unknown]> {
    const { pathname: p } = url;
    const m = req.method ?? 'GET';
    if (m === 'GET' && p === '/health') return [200, { ok: true, stopped }];
    if (!tokenOk(req)) throw new HttpError(401, 'Missing or wrong token');

    // ---- agents ----
    if (m === 'GET' && p === '/queue') return [200, o.queue.all()];
    if (m === 'POST' && p === '/queue') {
      const jobs = (await body(req)).jobs;
      if (!Array.isArray(jobs)) throw new HttpError(400, 'jobs must be a list');
      return [201, { added: o.queue.add(jobs) }];
    }
    if (m === 'GET' && p === '/queue/next') {
      if (stopped) throw new HttpError(423, 'Stopped: POST /resume first');
      if (!settings.parts.appliers) throw new HttpError(423, 'Appliers are switched off (PUT /settings)');
      // Each ready job keeps its tab open for the owner; past the limit the appliers wait (#29).
      const ready = o.queue.all().filter((j) => j.status === 'ready').length;
      const limit = o.maxReadyOpen ?? MAX_READY_OPEN;
      if (ready >= limit) return [429, { error: `Paused: ${ready} jobs wait for your Submit`, ready, maxReadyOpen: limit }];
      const worker = url.searchParams.get('worker') || 'worker';
      if (!workersSeen.has(worker)) workersSeen.set(worker, now());
      const job = o.queue.claim(worker, (j) => !switchedOff(j, settings));
      return job ? [200, job] : [204, null];
    }
    let hit = /^\/queue\/([^/]+)\/status$/.exec(p);
    if (m === 'POST' && hit) {
      const b = await body(req);
      const status = str(b.status, 'status') as JobStatus;
      if (!JOB_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${JOB_STATUSES.join(', ')}`);
      const job = o.queue.setStatus(decodeURIComponent(hit[1]), status, {
        note: typeof b.note === 'string' ? b.note : undefined,
        page: typeof b.page === 'number' ? b.page : undefined,
        tabUrl: typeof b.tabUrl === 'string' ? b.tabUrl : undefined,
      });
      if (!job) throw new HttpError(404, 'No such job');
      return [200, job];
    }
    if (m === 'POST' && p === '/run') {
      if (stopped) throw new HttpError(423, 'Stopped: POST /resume first');
      const b = await body(req);
      const jobId = str(b.jobId, 'jobId');
      const job = o.queue.get(jobId);
      if (!job) throw new HttpError(404, 'No such job');
      // The extension finds the job's tab by address: the job's own unless the agent says otherwise.
      const cmd = queueCommand({ type: 'run', jobId, urlPrefix: typeof b.urlPrefix === 'string' && b.urlPrefix ? b.urlPrefix : (job.tabUrl ?? job.applyUrl) });
      return [202, { commandId: cmd.id }];
    }
    hit = /^\/tabs\/([^/]+)\/status$/.exec(p);
    if (m === 'GET' && hit) {
      const got = runs.get(decodeURIComponent(hit[1]));
      if (!got) throw new HttpError(404, 'No Run reported for that job yet');
      return [200, got];
    }
    if (m === 'POST' && p === '/answers') {
      const b = await body(req);
      if (b.answer === undefined) throw new HttpError(400, 'answer is required');
      const cmd = queueCommand({
        type: 'answer',
        jobId: str(b.jobId, 'jobId'),
        fieldId: str(b.fieldId, 'fieldId'),
        answer: b.answer,
        ...(typeof b.frameId === 'number' && { frameId: b.frameId }),
        ...(b.save !== undefined && { save: b.save }),
      });
      o.queue.noteAgentAnswer(str(b.jobId, 'jobId'), str(b.fieldId, 'fieldId'));
      return [202, { commandId: cmd.id }];
    }
    if (m === 'POST' && p === '/incidents') {
      const b = await body(req);
      const at = new Date(now());
      // The id becomes a file name: only safe characters, so it can't climb out of the folder.
      const id = (typeof b.id === 'string' && b.id ? b.id : `${at.toISOString()}-${randomUUID().slice(0, 8)}`).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
      const dir = join(o.incidentsDir, at.toISOString().slice(0, 10));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${id}.json`);
      writeFileSync(file, JSON.stringify({ ...b, id, receivedAt: at.toISOString() }, null, 2));
      const day = at.toISOString().slice(0, 10);
      incidentsByDay.set(day, (incidentsByDay.get(day) ?? 0) + 1);
      ticketsCache = null;
      return [201, { id, file }];
    }
    if (m === 'GET' && p === '/ready') {
      // The owner's list (#29): each job with the fields an agent answered, by their labels, to check before Submit.
      const ready = o.queue.all().filter((j) => j.status === 'ready');
      return [200, ready.map((j) => {
        const fields = (runs.get(j.id)?.fields ?? []) as { id?: string; label?: string }[];
        const agentAnswered = (j.agentAnswers ?? []).map((a) => fields.find((f) => f.id === a.fieldId)?.label ?? a.fieldId);
        return { ...j, agentAnswered, maxReadyOpen: o.maxReadyOpen ?? MAX_READY_OPEN };
      })];
    }
    hit = /^\/ready\/([^/]+)\/focus$/.exec(p);
    if (m === 'POST' && hit) {
      const jobId = decodeURIComponent(hit[1]);
      if (!o.queue.get(jobId)) throw new HttpError(404, 'No such job');
      return [202, { commandId: queueCommand({ type: 'focus', jobId }).id }];
    }
    // ---- the Fixer (#32) ----
    if (m === 'GET' && p === '/tickets') {
      const open = url.searchParams.get('open') === '1';
      return [200, tickets().filter((t) => !open || t.open)];
    }
    hit = /^\/tickets\/(t-[0-9a-f]{10})$/.exec(p);
    if (m === 'GET' && hit) {
      const t = tickets().find((x) => x.key === hit![1]);
      if (!t) throw new HttpError(404, 'No such ticket');
      const ids = new Set(t.incidents);
      return [200, { ...t, details: readIncidentFiles(o.incidentsDir).filter((i) => ids.has(i.id)) }];
    }
    hit = /^\/tickets\/(t-[0-9a-f]{10})\/resolution$/.exec(p);
    if (m === 'POST' && hit) {
      const key = hit[1];
      if (!tickets().some((x) => x.key === key)) throw new HttpError(404, 'No such ticket');
      const b = await body(req);
      const outcome = str(b.outcome, 'outcome') as Outcome;
      if (!OUTCOMES.includes(outcome)) throw new HttpError(400, `outcome must be one of ${OUTCOMES.join(', ')}`);
      const all = readResolutions(ticketsFile);
      all[key] = { outcome, ...(typeof b.note === 'string' && b.note && { note: b.note.slice(0, 2000) }), at: new Date(now()).toISOString() };
      writeResolutions(ticketsFile, all);
      ticketsCache = null;
      return [200, tickets().find((x) => x.key === key)];
    }
    if (m === 'POST' && p === '/fleet/reload') return [202, { commandId: queueCommand({ type: 'reload' }).id }];

    // The fleet switches (#54): every agent reads them here; PUT takes a partial update.
    if (m === 'GET' && p === '/settings') return [200, settings];
    if (m === 'PUT' && p === '/settings') {
      const { settings: next, errors } = mergeSettings(settings, await body(req));
      if (errors.length) throw new HttpError(400, errors.join('; '));
      switchLog.push(...switchEvents(settings, next, new Date(now()).toISOString()));
      switchLog.splice(0, Math.max(0, switchLog.length - 30));
      settings = next;
      if (o.settingsFile) saveSettings(o.settingsFile, settings);
      return [200, settings];
    }
    if (m === 'POST' && p === '/stop-all') {
      stopped = true;
      const released = o.queue.releaseAll();
      // Commands not yet picked up won't run now.
      for (const c of commands) if (!c.delivered && c.type !== 'stopAll') c.delivered = true;
      queueCommand({ type: 'stopAll' });
      return [200, { stopped: true, released }];
    }
    if (m === 'POST' && p === '/resume') {
      stopped = false;
      return [200, { stopped: false }];
    }

    // ---- the extension ----
    if (m === 'GET' && p === '/ext/commands') {
      const wait = Math.min(Number(url.searchParams.get('wait') ?? 0) * 1000 || 0, o.maxWaitMs ?? 25_000);
      await waitForCommands(wait);
      const out = commands.filter((c) => !c.delivered);
      for (const c of out) c.delivered = true;
      // Keep the list short: delivered commands are only history.
      while (commands.length > 200 && commands[0].delivered) commands.shift();
      return [200, out.map(({ delivered: _, ...c }) => c)];
    }
    if (m === 'POST' && p === '/ext/runs') {
      const b = await body(req);
      const run = b.run as RunState | undefined;
      const jobId = str(b.jobId, 'jobId');
      if (!run || typeof run !== 'object') throw new HttpError(400, 'run is required');
      runs.set(jobId, { run, fields: Array.isArray(b.fields) ? b.fields : [], at: now() });
      if (run.status === 'running') o.queue.setStatus(jobId, 'running', { page: run.page });
      else if (run.stop && AFTER_RUN[run.stop.reason]) {
        const note = run.stop.detail ? `${run.stop.reason}: ${run.stop.detail}` : run.stop.reason;
        o.queue.setStatus(jobId, AFTER_RUN[run.stop.reason]!, { note, page: run.page });
      }
      return [200, { ok: true }];
    }
    if (m === 'POST' && p === '/ext/screens') {
      const b = await body(req);
      const jobId = str(b.jobId, 'jobId');
      const shot = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(typeof b.image === 'string' ? b.image : '');
      if (!shot) throw new HttpError(400, 'image must be a JPEG or PNG data URL');
      screens.delete(jobId); // re-added last: the map stays in age order
      screens.set(jobId, { image: Buffer.from(shot[2], 'base64'), type: shot[1], at: new Date(now()).toISOString() });
      while (screens.size > MAX_SCREENS) screens.delete(screens.keys().next().value!);
      return [201, { ok: true }];
    }
    throw new HttpError(404, 'Not found');
  }

  // ---- the Fleet Office (#35): the page, and a stream of snapshots while it is open ----
  const officeClients = new Set<{ res: ServerResponse; last: string }>();
  let officeTimer: ReturnType<typeof setInterval> | undefined;
  let lastPing = 0;
  const snapshot = () =>
    officeSnapshot({
      jobs: o.queue.all(),
      runs,
      workersSeen,
      stopped,
      maxReadyOpen: o.maxReadyOpen ?? MAX_READY_OPEN,
      incidentsToday: incidentsByDay.get(new Date(now()).toISOString().slice(0, 10)) ?? 0,
      screens: new Map([...screens].map(([id, s]) => [id, s.at])),
      settings,
      tickets: tickets().slice(0, 12),
      extraEvents: switchLog,
      now: now(),
    });
  /** Send each open page the latest snapshot when it changed, and a ping now and then to keep it open. */
  const pushOffice = () => {
    if (!officeClients.size) return;
    let data: string, same: string;
    try {
      const { at, ...rest } = snapshot();
      same = JSON.stringify(rest);
      data = JSON.stringify({ at, ...rest });
    } catch {
      return; // the queue file mid-write: the next poll gets it
    }
    const ping = now() - lastPing > 15_000;
    if (ping) lastPing = now();
    for (const c of officeClients) {
      if (c.last !== same) {
        c.last = same;
        c.res.write(`event: snapshot\ndata: ${data}\n\n`);
      } else if (ping) c.res.write(': ping\n\n');
    }
  };
  const openOffice = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const client = { res, last: '' };
    officeClients.add(client);
    if (!officeTimer) {
      officeTimer = setInterval(pushOffice, OFFICE_POLL_MS);
      officeTimer.unref?.();
    }
    pushOffice();
    req.on('close', () => {
      officeClients.delete(client);
      if (!officeClients.size && officeTimer) {
        clearInterval(officeTimer);
        officeTimer = undefined;
      }
    });
  };
  let officeHtml: string | undefined;
  const officePage = (res: ServerResponse) => {
    try {
      officeHtml ??= readFileSync(o.officeFile ?? OFFICE_FILE, 'utf8');
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('The Office page is missing (bridge/office/index.html).');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(officeHtml);
  };

  const server: Server = createServer((req, res: ServerResponse) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(status === 204 ? undefined : JSON.stringify(value));
    };
    // Only this machine, by name too (a web page can't rebind a domain to 127.0.0.1 and reach us),
    // and never from a web page: the extension's background has no web Origin.
    const host = (req.headers.host ?? '').toLowerCase();
    const port = o.port || (server.address() as AddressInfo | null)?.port;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: 'Wrong host' });
    const origin = req.headers.origin;
    // The Office page is served from here, so its own origin may call too (the Host check above
    // already refuses a name rebound to 127.0.0.1).
    if (origin && !origin.startsWith('chrome-extension://') && origin !== `http://${host}`) return send(403, { error: 'Not from a web page' });
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (req.method === 'GET' && (url.pathname === '/office' || url.pathname === '/office/')) return officePage(res);
    if (req.method === 'GET' && url.pathname === '/office/events') {
      if (!tokenOk(req, url)) return send(401, { error: 'Missing or wrong token' });
      return openOffice(req, res);
    }
    const shot = /^\/office\/screens\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && shot) {
      // An <img> can't send headers either.
      if (!tokenOk(req, url)) return send(401, { error: 'Missing or wrong token' });
      const s = screens.get(decodeURIComponent(shot[1]));
      if (!s) return send(404, { error: 'No screenshot for that job' });
      res.writeHead(200, { 'content-type': s.type, 'cache-control': 'no-store', 'content-length': s.image.length });
      res.end(s.image);
      return;
    }
    route(req, url).then(
      ([status, value]) => {
        send(status, value);
        if (req.method !== 'GET') pushOffice();
      },
      (e: unknown) => send(e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) }),
    );
  });

  server.on('close', () => {
    if (officeTimer) clearInterval(officeTimer);
    officeTimer = undefined;
  });

  return { server, commands, runs, isStopped: () => stopped, snapshot };
}
