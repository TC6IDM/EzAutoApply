import { cleanText } from '../core/normalize';
import { isBulletText, linesFromText, type TextLine } from './resume';

/**
 * Turn an uploaded file into text lines with layout hints (font size, bold,
 * bullets) for the resume parser. Runs in the side panel.
 */

interface PdfItem {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
  bold: boolean;
}

async function pdfLines(data: ArrayBuffer): Promise<TextLine[]> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(data) });
  const doc = await task.promise;
  const lines: TextLine[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    // Loading the operator list resolves real font names, which reveal bold faces.
    await page.getOperatorList().catch(() => null);
    const items: PdfItem[] = [];
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const [, , c, d, x, y] = it.transform as number[];
      let fontName = '';
      try {
        fontName = (page.commonObjs.get(it.fontName) as { name?: string } | undefined)?.name ?? '';
      } catch {
        fontName = content.styles[it.fontName]?.fontFamily ?? '';
      }
      items.push({ str: it.str, x, y, width: it.width, size: Math.round(Math.hypot(c, d) * 10) / 10, bold: /bold|black|heavy|semibold/i.test(fontName) });
    }
    // Rows top to bottom, then left to right; items within half a line height share a row.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: PdfItem[][] = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].y - it.y) <= Math.max(2, it.size * 0.5)) row.push(it);
      else rows.push([it]);
    }
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      // Wide gaps split a row into separate lines (two-column layouts, right-aligned dates stay attached).
      let parts: PdfItem[] = [];
      const flush = () => {
        if (!parts.length) return;
        let text = '';
        let prevEnd = parts[0].x;
        for (const p of parts) {
          const gap = p.x - prevEnd;
          text += (text && gap > p.size * 0.15 && !text.endsWith(' ') ? (gap > p.size * 3 ? '   ' : ' ') : '') + p.str;
          prevEnd = p.x + p.width;
        }
        const size = Math.max(...parts.map((p) => p.size));
        const bold = parts.filter((p) => p.bold).reduce((s, p) => s + p.str.length, 0) > text.length / 2;
        const clean = text.replace(/\s+$/, '');
        lines.push({ text: clean, size, bold, bullet: isBulletText(clean) });
        parts = [];
      };
      for (const it of row) {
        const last = parts[parts.length - 1];
        if (last && it.x - (last.x + last.width) > it.size * 12) flush();
        parts.push(it);
      }
      flush();
    }
  }
  await task.destroy();
  return lines.filter((l) => cleanText(l.text));
}

async function docxLines(data: ArrayBuffer): Promise<TextLine[]> {
  const mammoth = (await import('mammoth')).default;
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: data });
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const lines: TextLine[] = [];
  for (const el of Array.from(dom.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li'))) {
    if (el.tagName === 'P' && el.closest('li')) continue;
    // Paragraphs can hold soft line breaks; each is its own line.
    const chunks = el.innerHTML.split(/<br\s*\/?>/i).map((h) => {
      const tmp = dom.createElement('div');
      tmp.innerHTML = h;
      return { text: cleanText(tmp.textContent ?? ''), bold: !!tmp.querySelector('strong, b') && cleanText(Array.from(tmp.querySelectorAll('strong, b')).map((b) => b.textContent).join('')).length >= cleanText(tmp.textContent ?? '').length / 2 };
    });
    const heading = /^H\d$/.test(el.tagName);
    for (const c of chunks) {
      if (!c.text) continue;
      lines.push({
        text: c.text,
        size: heading ? 14 - Number(el.tagName[1]) : 0,
        bold: c.bold || heading,
        bullet: el.tagName === 'LI' || isBulletText(c.text),
      });
    }
  }
  return lines;
}

export type ExtractableKind = 'pdf' | 'docx' | 'text';

export function fileKindOf(file: File): ExtractableKind | null {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (file.type.startsWith('text/') || /\.(txt|md)$/.test(name)) return 'text';
  return null;
}

export async function extractLines(file: File): Promise<TextLine[]> {
  const kind = fileKindOf(file);
  if (!kind) throw new Error('Unsupported file type. Use PDF, DOCX or TXT.');
  const data = await file.arrayBuffer();
  if (kind === 'pdf') return pdfLines(data);
  if (kind === 'docx') return docxLines(data);
  return linesFromText(new TextDecoder().decode(data));
}

/** Plain text of any supported document, for "paste your resume/cover letter" fields. */
export async function extractText(file: File): Promise<string> {
  try {
    return (await extractLines(file)).map((l) => l.text).join('\n');
  } catch {
    return '';
  }
}
