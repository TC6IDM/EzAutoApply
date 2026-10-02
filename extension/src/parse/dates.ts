/** Resume date parsing: "Jan 2020 – Present", "05/2019 - 08/2021", "2018–2022", "Expected May 2026". */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12, spring: 3, summer: 6, fall: 9, autumn: 9, winter: 12,
};

const MONTH_WORD = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|spring|summer|fall|autumn|winter)\\.?';
const DATE = `(?:${MONTH_WORD},?\\s+\\d{4}|\\d{1,2}\\s*/\\s*\\d{4}|\\d{4}\\s*[-/.]\\s*\\d{1,2}(?!\\d)|\\d{4})`;
const PRESENT = '(?:present|current|now|today|ongoing)';
const SEP = '\\s*(?:–|—|-|−|to|until|thru|through)\\s*';

export const DATE_RANGE = new RegExp(`(${DATE})${SEP}(${DATE}|${PRESENT})`, 'i');
const SINGLE = new RegExp(`(?:expected|anticipated|graduat(?:ed|ing|ion)?|class of)?\\s*(${DATE})`, 'i');

export interface DateRange {
  start: string;
  end: string;
  current: boolean;
  /** The matched text, so callers can strip it from the line. */
  raw: string;
}

/** "Jan 2020" → "2020-01", "05/2019" → "2019-05", "2018" → "2018". */
export function toYm(token: string): string {
  const t = token.trim().toLowerCase().replace(/\.$/, '');
  let m = new RegExp(`^(${MONTH_WORD}),?\\s+(\\d{4})$`, 'i').exec(t);
  if (m) {
    const month = MONTHS[m[1].replace(/\./g, '')] ?? MONTHS[m[1].slice(0, 3)];
    return `${m[2]}-${String(month).padStart(2, '0')}`;
  }
  m = /^(\d{1,2})\s*\/\s*(\d{4})$/.exec(t);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})\s*[-/.]\s*(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = /^(\d{4})$/.exec(t);
  return m ? m[1] : '';
}

function plausibleYear(ym: string): boolean {
  const y = Number(ym.slice(0, 4));
  return y >= 1950 && y <= new Date().getFullYear() + 8;
}

export function findDateRange(line: string): DateRange | null {
  const m = DATE_RANGE.exec(line);
  if (!m) return null;
  const start = toYm(m[1]);
  const current = new RegExp(`^${PRESENT}$`, 'i').test(m[2].trim());
  const end = current ? '' : toYm(m[2]);
  if (!plausibleYear(start) || (end && !plausibleYear(end))) return null;
  return { start, end, current, raw: m[0] };
}

/** A lone date such as a graduation date. */
export function findSingleDate(line: string): { date: string; raw: string } | null {
  const m = SINGLE.exec(line);
  if (!m) return null;
  const date = toYm(m[1]);
  return date && plausibleYear(date) ? { date, raw: m[0] } : null;
}

export function hasDate(line: string): boolean {
  return !!findDateRange(line) || !!findSingleDate(line);
}
