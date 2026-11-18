import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { QueueJob } from './queue.ts';

/**
 * The fleet switches (#53, #54): every part of the fleet, every job source and every way of
 * applying can be turned off. They live in the bridge (`~/.ezautoapply/fleet-settings.json`),
 * so every agent and the Office read one copy. Switches only take things away: none of them
 * can let an agent press Submit, see the password or send a message.
 */
export interface FleetSettings {
  parts: { scout: boolean; appliers: boolean; answerer: boolean; fixer: boolean; outreach: boolean };
  sources: { linkedin: boolean; simplify: boolean; recommendations: boolean; jobbank: boolean; indeed: boolean };
  apply: { external: boolean; linkedinEasy: boolean; indeedApply: boolean; tailored: boolean };
  site: { createAccounts: boolean; gmailCodes: boolean };
}

/** Plan §0.1 (2026-11-17): Indeed off for now, LinkedIn Easy Apply off for the first month, the rest on. */
export const DEFAULT_SETTINGS: FleetSettings = {
  parts: { scout: true, appliers: true, answerer: true, fixer: true, outreach: true },
  sources: { linkedin: true, simplify: true, recommendations: true, jobbank: true, indeed: false },
  apply: { external: true, linkedinEasy: false, indeedApply: false, tailored: true },
  site: { createAccounts: true, gmailCodes: true },
};

type Group = keyof FleetSettings;

/**
 * `current` with `patch` laid over it: known groups and switches only, booleans only. Anything
 * else is an error, so a typo can't silently leave a switch as it was.
 */
export function mergeSettings(current: FleetSettings, patch: unknown): { settings: FleetSettings; errors: string[] } {
  const settings = structuredClone(current);
  const errors: string[] = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { settings, errors: ['settings must be an object'] };
  for (const [group, values] of Object.entries(patch)) {
    if (!(group in DEFAULT_SETTINGS)) { errors.push(`unknown group "${group}"`); continue; }
    if (!values || typeof values !== 'object' || Array.isArray(values)) { errors.push(`${group} must be an object`); continue; }
    const target = settings[group as Group] as Record<string, boolean>;
    for (const [key, v] of Object.entries(values)) {
      if (!(key in DEFAULT_SETTINGS[group as Group])) errors.push(`unknown switch "${group}.${key}"`);
      else if (typeof v !== 'boolean') errors.push(`${group}.${key} must be true or false`);
      else target[key] = v;
    }
  }
  return { settings, errors };
}

/** The switches saved in `file`, over the defaults (a switch added later starts at its default). */
export function loadSettings(file: string): FleetSettings {
  if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS);
  try {
    // Only what still merges cleanly: an unknown or broken entry in the file falls back to its default.
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    let out = structuredClone(DEFAULT_SETTINGS);
    for (const [group, values] of Object.entries(saved ?? {})) {
      for (const [key, v] of Object.entries(values ?? {})) {
        const r = mergeSettings(out, { [group]: { [key]: v } });
        if (!r.errors.length) out = r.settings;
      }
    }
    return out;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(file: string, s: FleetSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

const SOURCE: Record<string, keyof FleetSettings['sources']> = {
  linkedin: 'linkedin',
  simplify: 'simplify',
  simplifyjobs: 'simplify',
  recommendations: 'recommendations',
  ai: 'recommendations',
  scrape: 'recommendations',
  jobbank: 'jobbank',
  indeed: 'indeed',
};

/** Why the switches keep `job` out of an applier's hands, or null when it may be claimed. */
export function switchedOff(job: Pick<QueueJob, 'source' | 'applyKind' | 'applyUrl'>, s: FleetSettings): string | null {
  const source = SOURCE[(job.source ?? '').toLowerCase().replace(/[^a-z]/g, '')];
  if (source && !s.sources[source]) return `the ${source} source is off`;
  const kind = (job.applyKind ?? '').toLowerCase();
  let host = '';
  try {
    host = new URL(job.applyUrl).hostname;
  } catch {
    /* no address: nothing to judge by */
  }
  if (kind === 'linkedin-easy' && !s.apply.linkedinEasy) return 'LinkedIn Easy Apply is off';
  if ((kind === 'indeed' || /(^|\.)indeed\.com$/.test(host)) && !s.apply.indeedApply) return 'Indeed Apply is off';
  if (kind === 'external' && !s.apply.external) return 'applying on company sites is off';
  return null;
}
