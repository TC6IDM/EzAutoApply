import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Field reports (#112, #115): the owner pressed "Report a field" and said what is wrong. The
 * extension sends a snapshot of the page (the form's markup with values stripped and profile
 * values redacted, what the scan found with no values, and a screenshot), kept here on disk,
 * outside git: ~/.ezautoapply/reports/<id>/. The Reporter agent reads it and logs a public-safe
 * GitHub issue that names the report; the markup and the picture never leave this folder.
 */

export interface ReportField {
  frameId: number;
  id: string;
  label: string;
  kind: string;
  status: string;
  required: boolean;
  source?: string;
  key?: string;
  options: string[];
}

export interface FieldReportFile {
  id: string;
  at: string;
  /** The page's address without its query or hash. */
  url: string;
  host: string;
  ats: string;
  title?: string;
  /** What the owner wrote ("the Notice period box wasn't found"), redacted by the extension. */
  note: string;
  /** What the scan found, no values. */
  fields: ReportField[];
  /** Set once the Reporter logged (or found) the issue. */
  issue?: string;
  /** Files beside report.json the Reporter can read: the markup, the screenshot. */
  files: string[];
}

const MAX_HTML = 400_000;
const MAX_FIELDS = 400;
const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;

export class ReportError extends Error {}

/** Writes a report from the extension's body; its summary, or a ReportError saying what is wrong. */
export function writeReport(dir: string, b: Record<string, unknown>, id: string, at: string): FieldReportFile {
  if (!SAFE_ID.test(id)) throw new ReportError('bad id');
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 2000) : '';
  if (!note) throw new ReportError('note is required: say what is wrong');
  if (typeof b.url !== 'string' || !b.url) throw new ReportError('url is required');
  const url = b.url.replace(/[?#].*$/, '');
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new ReportError('url must be an address');
  }
  const fields: ReportField[] = (Array.isArray(b.fields) ? b.fields : []).slice(0, MAX_FIELDS).flatMap((f) => {
    if (!f || typeof f !== 'object') return [];
    const x = f as Record<string, unknown>;
    // Only these keys: whatever else a caller sends (a value) is dropped here.
    return [{
      frameId: Number(x.frameId) || 0,
      id: String(x.id ?? ''),
      label: String(x.label ?? '').slice(0, 500),
      kind: String(x.kind ?? ''),
      status: String(x.status ?? ''),
      required: x.required === true,
      ...(typeof x.source === 'string' && { source: x.source }),
      ...(typeof x.key === 'string' && { key: x.key }),
      options: Array.isArray(x.options) ? x.options.slice(0, 30).map(String) : [],
    }];
  });
  const folder = join(dir, id);
  mkdirSync(folder, { recursive: true });
  const files: string[] = [];
  if (typeof b.html === 'string' && b.html) {
    writeFileSync(join(folder, 'page.html'), b.html.slice(0, MAX_HTML));
    files.push(join(folder, 'page.html'));
  }
  const screen = typeof b.screen === 'string' ? /^data:image\/(jpeg|png);base64,(.+)$/.exec(b.screen) : null;
  if (screen) {
    const file = join(folder, `screen.${screen[1] === 'png' ? 'png' : 'jpg'}`);
    writeFileSync(file, Buffer.from(screen[2], 'base64'));
    files.push(file);
  }
  const report: FieldReportFile = {
    id,
    at,
    url,
    host,
    ats: typeof b.ats === 'string' ? b.ats.slice(0, 40) : 'other',
    ...(typeof b.title === 'string' && b.title && { title: b.title.slice(0, 200) }),
    note,
    fields,
    files,
  };
  writeFileSync(join(folder, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

export function readReport(dir: string, id: string): FieldReportFile | null {
  if (!SAFE_ID.test(id)) return null;
  const file = join(dir, id, 'report.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as FieldReportFile;
  } catch {
    return null;
  }
}

/** Every report, oldest first. */
export function readReports(dir: string): FieldReportFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((id) => readReport(dir, id))
    .filter((r): r is FieldReportFile => !!r)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** The Reporter logged (or found) the issue for it. */
export function markFiled(dir: string, id: string, issue: string): FieldReportFile | null {
  const r = readReport(dir, id);
  if (!r) return null;
  r.issue = issue.slice(0, 300);
  writeFileSync(join(dir, id, 'report.json'), JSON.stringify(r, null, 2));
  return r;
}
