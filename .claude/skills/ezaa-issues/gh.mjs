// Every gh call the issue and sprint scripts make goes through here (claude-workflow#2).
//
// gh has no network timeout of its own: one dropped connection to api.github.com
// held a sprint's `finish` for 24 minutes (1456 s of wall clock for 0.8 s of CPU),
// and the same call answered in 0.3 s a moment later. So each call here has a
// time limit, read-only calls are tried again after a stall, a reset or a 5xx,
// and a write is never tried twice (one that landed would land twice).
// Calls slower than SLOW_MS go to a log, so slowness can be told from hanging
// (`sprint.mjs stalls` prints it). The log holds the command's first words and
// the time, never its arguments' text (bodies, notes).
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREFIX } from './config.mjs';

export const GH_TIMEOUT_MS = (Number(process.env.GH_TIMEOUT_SECONDS) || 60) * 1000;
export const GH_TRIES = 3;          // for read-only calls; writes get one
export const SLOW_MS = 5000;
export const GH_LOG = join(tmpdir(), `${PREFIX}-sprint`, 'gh-slow.log');

// The subcommands that only read. `api` reads unless it names a method other
// than GET or sends fields (gh then POSTs); a GraphQL call reads unless its
// query is a mutation.
const READ_VERBS = new Set(['view', 'list', 'status', 'checks', 'diff', 'field-list', 'item-list', 'search']);
const READ_COMMANDS = new Set(['search', 'browse', 'version', '--version']);

/** True when running `gh <args>` twice changes nothing a first run didn't. */
export function ghReadOnly(args) {
  const [cmd, sub] = args;
  if (READ_COMMANDS.has(cmd)) return true;
  if (cmd === 'auth') return sub === 'status' || sub === 'token';
  if (cmd !== 'api') return READ_VERBS.has(sub);
  const at = name => args.findIndex(a => a === name || a.startsWith(`${name}=`));
  const valueOf = i => (args[i].includes('=') && args[i].startsWith('-') ? args[i].split('=').slice(1).join('=') : args[i + 1]);
  const method = [at('-X'), at('--method')].filter(i => i >= 0).map(valueOf)[0];
  if (method) return method.toUpperCase() === 'GET';
  const fields = args.filter((a, i) => /^(-f|-F|--field|--raw-field)$/.test(args[i - 1] || '') || /^(--field|--raw-field)=/.test(a));
  if (args.includes('--input')) return false;
  if (sub === 'graphql') return !fields.some(f => /^query=\s*mutation\b/.test(f.replace(/^--(raw-)?field=/, '')));
  return fields.length === 0;
}

/** True when what gh said (or how it died) means the network let it down, not the request. */
export function ghTransient(text) {
  return /ETIMEDOUT|timed out|timeout|connection reset|reset by peer|EOF|broken pipe|TLS handshake|i\/o timeout|no such host|could not resolve host|connection refused|network is unreachable|HTTP 50[0234]|\b50[234] (Bad Gateway|Service Unavailable|Gateway Timeout)|secondary rate limit|something went wrong/i.test(text || '');
}

/** 'retry' or 'fail' for a failed attempt (1-based) of `gh <args>`. */
export function ghRetry(args, errorText, attempt, tries = GH_TRIES) {
  if (attempt >= tries) return 'fail';
  if (!ghReadOnly(args)) return 'fail';
  return ghTransient(errorText) ? 'retry' : 'fail';
}

/** How a call is named in messages and the log: the command and subcommand, no values. */
export const ghName = args => `gh ${args.filter(a => !a.startsWith('-')).slice(0, 2).join(' ')}`.trim();

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function log(file, args, ms, outcome) {
  if (!file || (ms < SLOW_MS && outcome === 'ok')) return;
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${(ms / 1000).toFixed(1)}s ${ghName(args)} ${outcome}\n`);
  } catch { /* the log is a help, never a reason to fail */ }
}

/**
 * Runs `gh <args>` and returns its trimmed stdout. Options: input (stdin text),
 * quiet (drop stderr), timeoutMs, tries, logTo (the slow-call log; null for none). Throws an Error whose message says
 * which call failed and how; a write that timed out says it may have landed.
 */
export function gh(args, options = {}) { return ghWith({ bin: 'gh', pre: [] }, args, options); }

/** gh() with the program named: { bin, pre } runs `bin ...pre ...args` (the tests use a stand-in). */
export function ghWith({ bin, pre = [] }, args, { input, quiet = false, timeoutMs = GH_TIMEOUT_MS, tries = GH_TRIES, logTo = GH_LOG } = {}) {
  for (let attempt = 1; ; attempt++) {
    const began = Date.now();
    try {
      const out = execFileSync(bin, [...pre, ...args], {
        encoding: 'utf8', input, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 << 20,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', quiet ? 'ignore' : 'pipe'],
      });
      log(logTo, args, Date.now() - began, attempt > 1 ? `ok after ${attempt} tries` : 'ok');
      return out.trim();
    } catch (e) {
      const ms = Date.now() - began;
      const stalled = e.code === 'ETIMEDOUT' || (e.signal && ms >= timeoutMs - 50);
      const said = stalled ? `no answer in ${Math.round(timeoutMs / 1000)} s` : String(e.stderr || e.message || '').trim().split('\n').slice(-1)[0];
      log(logTo, args, ms, stalled ? 'timeout' : 'failed');
      if (ghRetry(args, stalled ? 'timeout' : `${e.stderr || ''} ${e.message || ''}`, attempt, tries) === 'retry') { pause(1000 * attempt * attempt); continue; }
      const write = !ghReadOnly(args);
      const err = new Error(`${ghName(args)}: ${said}${attempt > 1 ? ` (tried ${attempt} times)` : ''}${stalled && write ? '; it may have landed: check before running it again' : ''}`);
      err.stderr = e.stderr; err.status = e.status; err.stalled = stalled; err.cause = e;
      throw err;
    }
  }
}
