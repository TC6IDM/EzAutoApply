import { atsOf } from '../core/sites';
import type { FieldReport } from '../fill/types';
import { bareUrl, MAX_SNIPPET, type Redaction, redact } from './incident';

/**
 * "Report a field" (#114): the owner says what is wrong ("the Notice period box wasn't found",
 * "Degree gave the wrong answer") and the page goes to the bridge for the Reporter agent. Pure,
 * so the redaction is tested: the markup comes in with values already stripped (`cleanHtml`), and
 * here every profile value is swapped for its placeholder, in the markup, the labels and the
 * owner's own note. The scan's findings go without values. The screenshot stays on the
 * owner's computer (the bridge keeps it beside the report) and is never put in an issue.
 */

export const MAX_REPORT_HTML = 10 * MAX_SNIPPET;

export interface ReportBody {
  url: string;
  ats: string;
  title?: string;
  note: string;
  html: string;
  fields: { frameId: number; id: string; label: string; kind: string; status: string; required: boolean; source?: string; key?: string; options: string[] }[];
  screen?: string;
}

export function reportBody(
  page: { url: string; title?: string; frames: { frameId: number; html: string }[]; screen?: string },
  note: string,
  fields: FieldReport[],
  r: Redaction[],
): ReportBody {
  const html = page.frames.map((f) => `<!-- frame ${f.frameId} -->\n${f.html}`).join('\n');
  return {
    url: bareUrl(page.url),
    ats: atsOf(page.url),
    ...(page.title && { title: redact(page.title, r) }),
    note: redact(note.trim(), r),
    html: redact(html, r).slice(0, MAX_REPORT_HTML),
    fields: fields.map((f) => ({
      frameId: f.frameId,
      id: f.id,
      label: redact(f.label, r),
      kind: f.kind,
      status: f.status,
      required: f.required,
      ...(f.source !== 'none' && { source: f.source }),
      ...(f.key && { key: f.key }),
      options: f.options.slice(0, 30).map((o) => redact(o, r)),
    })),
    ...(page.screen && { screen: page.screen }),
  };
}
