import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueueStore } from './queue.ts';
import { createBridge } from './server.ts';

/**
 * `npm start` in bridge/. Settings by environment:
 *   EZAA_HOME          ~/.ezautoapply (the token, incidents)
 *   EZAA_QUEUE_FILE    ../ai-job-search/apply_queue/queue.jsonl next to this repo
 *   EZAA_BRIDGE_PORT   8100
 *   EZAA_MAX_READY     6 (claims pause while this many jobs wait for your Submit)
 *   EZAA_OUTREACH_DIR  ~/.ezautoapply/outreach (ai-job-search's prospects.jsonl, for the recruiter page)
 */
const home = process.env.EZAA_HOME || join(homedir(), '.ezautoapply');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const queueFile = process.env.EZAA_QUEUE_FILE || resolve(repo, '..', 'ai-job-search', 'apply_queue', 'queue.jsonl');
const port = Number(process.env.EZAA_BRIDGE_PORT) || 8100;
const maxReadyOpen = Number(process.env.EZAA_MAX_READY) || undefined;
// Where ai-job-search's /prospects keeps the people and messages for the recruiter page (#41).
const prospectsFile = join(process.env.EZAA_OUTREACH_DIR || join(home, 'outreach'), 'prospects.jsonl');
// A running /ezaa-sprint (#50): its state lives in the temp folder; Wind down runs its own script.
const sprint = { dir: join(tmpdir(), 'ezaa-sprint'), script: join(repo, '.claude', 'skills', 'ezaa-sprint', 'sprint.mjs') };

mkdirSync(home, { recursive: true });
const tokenFile = join(home, 'bridge-token');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, `${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
const token = readFileSync(tokenFile, 'utf8').trim();

const { server } = createBridge({ token, queue: new QueueStore(queueFile), incidentsDir: join(home, 'incidents'), port, maxReadyOpen, settingsFile: join(home, 'fleet-settings.json'), prospectsFile, sprint });
server.listen(port, '127.0.0.1', () => {
  console.log(`EzAutoApply bridge on http://127.0.0.1:${port}`);
  console.log(`  token: ${tokenFile} (paste it into the extension's Settings once)`);
  console.log(`  queue: ${queueFile}`);
  // The token rides in the address's #fragment, which the browser never sends; the page keeps it for its stream.
  console.log(`  Fleet Office: http://127.0.0.1:${port}/office#token=${token}`);
});
