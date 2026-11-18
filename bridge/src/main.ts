import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueueStore } from './queue.ts';
import { createBridge } from './server.ts';

/**
 * `npm start` in bridge/. Settings by environment:
 *   EZAA_HOME          ~/.ezautoapply (the token, incidents)
 *   EZAA_QUEUE_FILE    ../ai-job-search/apply_queue/queue.jsonl next to this repo
 *   EZAA_BRIDGE_PORT   8100
 */
const home = process.env.EZAA_HOME || join(homedir(), '.ezautoapply');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const queueFile = process.env.EZAA_QUEUE_FILE || resolve(repo, '..', 'ai-job-search', 'apply_queue', 'queue.jsonl');
const port = Number(process.env.EZAA_BRIDGE_PORT) || 8100;

mkdirSync(home, { recursive: true });
const tokenFile = join(home, 'bridge-token');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, `${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
const token = readFileSync(tokenFile, 'utf8').trim();

const { server } = createBridge({ token, queue: new QueueStore(queueFile), incidentsDir: join(home, 'incidents'), port });
server.listen(port, '127.0.0.1', () => {
  console.log(`EzAutoApply bridge on http://127.0.0.1:${port}`);
  console.log(`  token: ${tokenFile} (paste it into the extension's Settings once)`);
  console.log(`  queue: ${queueFile}`);
});
