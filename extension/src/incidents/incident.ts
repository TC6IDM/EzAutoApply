import type { Profile } from '../core/profile';
import { atsOf } from '../core/sites';
import type { FieldReport } from '../fill/types';
import type { RunState } from '../run/types';

/**
 * Incidents (#18, plan §8.2): a record of every field the extension couldn't fill and every
 * Run that couldn't move on, for the Fixer to learn from. The background builds them from the
 * fill reports and posts them to the local bridge, which writes them to
 * ~/.ezautoapply/incidents/<date>/ (never into git). With the bridge off nothing is built.
 *
 * Everything here is pure, so the redaction is unit-tested: no profile value may survive.
 */

export type IncidentKind = 'unmatched' | 'wrongValue' | 'widgetFailed' | 'rejected' | 'navigation';

export interface Incident {
  id: string;
  at: string;
  host: string;
  ats: string;
  /** The frame's address without its query or hash (trackers, tokens). */
  url: string;
  page?: number;
  jobId?: string;
  kind: IncidentKind;
  field?: { id: string; frameId: number; label: string; kind: string; options: string[]; required: boolean; status: string };
  pipeline?: { source: string; key?: string; confidence: number };
  /** What was filled, if anything, redacted. */
  value?: string;
  note?: string;
  siteMessage?: string;
  /** The HTML around the field: values stripped by the content script, profile values replaced here. ≤ MAX_SNIPPET. */
  domSnippet?: string;
  stop?: { reason: string; detail?: string };
}

export const MAX_SNIPPET = 30_000;

/** A profile value and what replaces it. Order matters only for overlaps: longer values go first. */
export type Redaction = { value: string; placeholder: string };

const urlForms = (url: string): string[] => {
  const bare = url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  return [url.trim(), bare];
};
/** The account name at the end of a LinkedIn or GitHub address ("jordan-rivera"), which pages show on its own. */
const handleOf = (url: string): string => url.trim().replace(/\/+$/, '').split('/').pop() ?? '';

/**
 * The profile values that identify the owner, each with its placeholder: names, contact
 * details, the street address, links, employers and schools. Not skills, titles or degrees
 * (site wording the Fixer needs), and not EEO answers or country/region: those are option
 * labels on the page, and a snippet's option list would give the choice away by elimination
 * anyway. The account password never reaches a report (fillers never read it back).
 */
export function redactionsFor(p: Profile): Redaction[] {
  const out: Redaction[] = [];
  const add = (value: string | undefined, placeholder: string) => {
    const v = (value ?? '').trim();
    if (v.length >= 2) out.push({ value: v, placeholder });
  };
  const { personal: me, links } = p;
  add(`${me.firstName} ${me.lastName}`, '{{name.full}}');
  add(`${me.lastName}, ${me.firstName}`, '{{name.full}}');
  if (me.preferredName) add(`${me.preferredName} ${me.lastName}`, '{{name.full}}');
  add(me.firstName, '{{name.first}}');
  add(me.lastName, '{{name.last}}');
  add(me.preferredName, '{{name.preferred}}');
  add(me.email, '{{email}}');
  if (me.email) add(encodeURIComponent(me.email), '{{email}}');
  add(me.phone, '{{phone}}');
  add(me.address.line1, '{{address.line1}}');
  add(me.address.line2, '{{address.line2}}');
  add(me.address.city, '{{address.city}}');
  add(me.address.postalCode, '{{address.postalCode}}');
  for (const [k, url] of [['linkedin', links.linkedin], ['github', links.github], ['portfolio', links.portfolio], ['website', links.website]] as const) {
    for (const form of urlForms(url)) add(form, `{{links.${k}}}`);
  }
  for (const k of ['linkedin', 'github'] as const) if (handleOf(links[k]).length >= 4) add(handleOf(links[k]), `{{links.${k}}}`);
  links.other.forEach((l, i) => urlForms(l.url).forEach((form) => add(form, `{{links.other.${i}}}`)));
  p.experience.forEach((e, i) => add(e.company, `{{experience.${i}.company}}`));
  p.education.forEach((e, i) => add(e.school, `{{education.${i}.school}}`));
  return out.sort((a, b) => b.value.length - a.value.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const htmlEscaped = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Digits with any spacing or punctuation between them, so "(555) 010-0100" and "5550100100" both match. */
function phonePattern(phone: string): RegExp | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return null;
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  return new RegExp(`(?<!\\d)(?:\\+?\\d{1,3}[\\s().-]*)?${national.split('').join('[\\s().-]*')}(?!\\d)`, 'g');
}

/**
 * Replaces every profile value in `text`, in any case, as a whole word where the value starts or
 * ends with a letter or digit. Only letters and digits count as the word going on: an uploaded
 * "Jordan_Rivera_Resume.pdf" has its name taken out too (the e2e test caught that one).
 */
export function redact(text: string, redactions: Redaction[]): string {
  let out = text;
  for (const { value, placeholder } of redactions) {
    if (placeholder === '{{phone}}') {
      const re = phonePattern(value);
      if (re) out = out.replace(re, placeholder);
      continue;
    }
    for (const form of new Set([value, htmlEscaped(value)])) {
      const start = /^[\p{L}\p{N}]/u.test(form) ? '(?<![\\p{L}\\p{N}])' : '';
      const end = /[\p{L}\p{N}]$/u.test(form) ? '(?![\\p{L}\\p{N}])' : '';
      out = out.replace(new RegExp(`${start}${escapeRe(form)}${end}`, 'giu'), placeholder);
    }
  }
  return out;
}

export function bareUrl(url: string): string {
  return url.replace(/[?#].*$/, '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface IncidentContext {
  url: string;
  now: number;
  page?: number;
  jobId?: string;
  /** Random, so two incidents in the same second don't share an id. */
  rand?: () => string;
}

function base(ctx: IncidentContext, kind: IncidentKind): Incident {
  const at = new Date(ctx.now).toISOString();
  const ats = atsOf(ctx.url);
  const rand = (ctx.rand ?? (() => Math.random().toString(36).slice(2, 6)))();
  return {
    id: `${at.replace(/[:.]/g, '-')}-${ats}-${rand}`,
    at,
    host: hostOf(ctx.url),
    ats,
    url: bareUrl(ctx.url),
    kind,
    ...(ctx.page !== undefined && { page: ctx.page }),
    ...(ctx.jobId && { jobId: ctx.jobId }),
  };
}

const UNCERTAIN_NOTE = /didn.t clearly confirm|couldn.t confirm|close match/i;

/** What went wrong with a field, or null when it filled (or was left alone on purpose). */
export function incidentKind(f: FieldReport): IncidentKind | null {
  if (/^The site says:/.test(f.note ?? '')) return 'rejected';
  if (f.status === 'needs') return 'unmatched';
  if (f.status === 'review' && (f.uncertain || UNCERTAIN_NOTE.test(f.note ?? ''))) return 'widgetFailed';
  return null;
}

function fieldIncident(f: FieldReport, kind: IncidentKind, ctx: IncidentContext, r: Redaction[], siteMessage?: string): Incident {
  const said = siteMessage ?? (kind === 'rejected' ? f.note?.replace(/^The site says:\s*/, '') : undefined);
  const incident: Incident = {
    ...base(ctx, kind),
    field: { id: f.id, frameId: f.frameId, label: redact(f.label, r), kind: f.kind, options: f.options.slice(0, 200), required: f.required, status: f.status },
    pipeline: { source: f.source, confidence: f.confidence, ...(f.key && { key: f.key }) },
    ...(f.valueText && { value: redact(f.valueText, r) }),
    ...(f.note && { note: redact(f.note, r) }),
    ...(said && { siteMessage: redact(said, r) }),
    ...(f.debug && { domSnippet: redact(f.debug, r).slice(0, MAX_SNIPPET) }),
  };
  return incident;
}

/** One incident per field that ended `needs`, was rejected by the site, or whose filler wasn't sure. */
export function fieldIncidents(fields: FieldReport[], ctx: IncidentContext, r: Redaction[]): Incident[] {
  return fields.flatMap((f) => {
    const kind = incidentKind(f);
    return kind ? [fieldIncident(f, kind, ctx, r)] : [];
  });
}

/**
 * A Run that stopped where the Fixer can help: the site rejected values (one incident per
 * field it named), or the page didn't move on / had no onward button (one for the page).
 */
export function runIncidents(run: RunState, fields: FieldReport[], ctx: IncidentContext, r: Redaction[]): Incident[] {
  const stop = run.stop;
  if (run.status !== 'stopped' || !stop) return [];
  const c = { ...ctx, page: run.page, ...(run.jobId && { jobId: run.jobId }) };
  if (stop.reason === 'validationErrors') {
    const named = fields.filter((f) => stop.fieldIds?.includes(f.id));
    if (named.length) return named.map((f) => fieldIncident(f, 'rejected', c, r, stop.detail));
  }
  if (stop.reason === 'validationErrors' || stop.reason === 'noProgress' || stop.reason === 'noButton') {
    return [{ ...base(c, 'navigation'), stop: { reason: stop.reason, ...(stop.detail && { detail: redact(stop.detail, r) }) } }];
  }
  return [];
}

/** The same problem on the same page is filed once (reports are re-sent after every edit). */
export function incidentKey(i: Incident): string {
  return [i.url, i.kind, i.field?.frameId ?? '', i.field?.id ?? '', i.field?.label ?? '', i.stop?.reason ?? '', i.page ?? ''].join('|');
}
