#!/usr/bin/env node
// The Fixer's only way to the bridge (#69): `node .claude/skills/ezaa-fixer/bridge.mjs <METHOD> <path> [json | --file <path>]`.
// It reads the token itself (it is never printed), talks only to the bridge on 127.0.0.1, and allows
// only the calls the Fixer needs, so a page's text can't steer it into starting Runs or changing the queue.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ALLOWED = [
  ['GET', /^\/settings$/],
  ['GET', /^\/tickets(\?open=1)?$/],
  ['GET', /^\/tickets\/t-[0-9a-f]{10}$/],
  ['POST', /^\/tickets\/t-[0-9a-f]{10}\/resolution$/],
  ['POST', /^\/answers$/],
  ['GET', /^\/tabs\/[A-Za-z0-9._-]+\/status$/],
  ['POST', /^\/fleet\/reload$/],
];

const [method = '', raw = '', ...rest] = process.argv.slice(2);
const m = method.toUpperCase();
// Git Bash turns a leading-slash argument into a Windows path (`C:/Program Files/Git/tickets`): undo it, and take it without the slash too.
const path = `/${raw.replace(/^[A-Za-z]:\/.*?\/Git(?=\/)/, '').replace(/^\/+/, '')}`;
if (!ALLOWED.some(([am, re]) => am === m && re.test(path))) {
  console.error(`Not a Fixer call: ${m} ${path}. Allowed: ${ALLOWED.map(([am, re]) => `${am} ${re.source}`).join(', ')}`);
  process.exit(2);
}
let body;
if (rest[0] === '--file') body = readFileSync(rest[1], 'utf8');
else if (rest.length) body = rest.join(' ');
if (body !== undefined) JSON.parse(body); // refuse broken JSON here, not at the bridge

const home = process.env.EZAA_HOME || join(homedir(), '.ezautoapply');
const token = readFileSync(join(home, 'bridge-token'), 'utf8').trim();
const port = Number(process.env.EZAA_BRIDGE_PORT) || 8100;
const res = await fetch(`http://127.0.0.1:${port}${path}`, {
  method: m,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body,
});
const text = await res.text();
console.log(text || `{"status":${res.status}}`);
if (!res.ok) process.exit(1);
