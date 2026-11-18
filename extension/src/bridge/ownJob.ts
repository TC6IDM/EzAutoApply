/**
 * A posting the owner sends to the fleet themselves (#79): the side panel's "Send to the fleet"
 * or the right-click "Send to the EzAutoApply fleet" on a page or a link. Pure, so it is
 * unit-tested; the background posts the result to the bridge's POST /queue.
 *
 * The owner's picks come first (`tier: "A"`) and carry `source: "owner"`, which no fleet switch
 * holds back. The appliers open `applyUrl` and press a listing's Apply button themselves.
 */

export interface OwnJob {
  id: string;
  applyUrl: string;
  listingUrl: string;
  source: 'owner';
  tier: 'A';
  title?: string;
  company?: string;
  location?: string;
}

/** Query parameters that only say where a click came from (the same list as ai-job-search's apply_queue.py). */
const TRACKING = /^(utm_.*|gh_src|source|src|ref|refid|referrer|trk|trkinfo|trackingid|lever-source|lever-origin|iis|iisn|ccuid|mode|_ga|gclid|fbclid|mc_[a-z]+|sid|ebp|lipi|midtoken|midsig|eid|otptoken)$/i;

const isLinkedIn = (host: string) => host === 'linkedin.com' || host.endsWith('.linkedin.com');

/** LinkedIn's job id from a posting, search or collection address (`/jobs/view/<id>`, `?currentJobId=<id>`). */
export function linkedInJobId(url: URL): string | null {
  if (!isLinkedIn(url.hostname.toLowerCase())) return null;
  const view = url.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/);
  return view?.[1] ?? url.searchParams.get('currentJobId')?.match(/^\d{6,}$/)?.[0] ?? null;
}

/**
 * The posting's address without trackers or the fragment, or null when it isn't a web page
 * (or is a LinkedIn page that shows no job).
 */
export function postingAddress(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (isLinkedIn(url.hostname.toLowerCase())) {
    const id = linkedInJobId(url);
    return id ? `https://www.linkedin.com/jobs/view/${id}/` : null;
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

/** A short, stable id for an address (two FNV-1a passes). */
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0').slice(0, 4);
}

/** What a tab's title says about the job: LinkedIn's "Title | Company | LinkedIn" or "Company hiring Title in City | LinkedIn". */
export function readTitle(title: string, linkedIn: boolean): Pick<OwnJob, 'title' | 'company' | 'location'> {
  let t = title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s+/g, ' ').trim();
  if (!t) return {};
  if (linkedIn) {
    t = t.replace(/\s*\|\s*LinkedIn\s*$/i, '');
    const hiring = t.match(/^(.+?) hiring (.+?)(?: in (.+))?$/);
    if (hiring) return { company: hiring[1], title: hiring[2], ...(hiring[3] && { location: hiring[3] }) };
    const [jobTitle, company] = t.split(/\s+\|\s+/);
    // A search page's title ("Software Engineer jobs | LinkedIn") names no job.
    if (/^(jobs|linkedin|feed)$/i.test(jobTitle) || (!company && /\bjobs$/i.test(jobTitle))) return {};
    return { title: jobTitle, ...(company && { company }) };
  }
  return { title: t.slice(0, 140) };
}

/** The queue job for a posting the owner sends, or null when the address isn't one. */
export function ownJob(url: string, tabTitle = ''): OwnJob | null {
  const address = postingAddress(url);
  if (!address) return null;
  const linkedIn = linkedInJobId(new URL(address));
  return {
    id: linkedIn ? `own-li-${linkedIn}` : `own-${hash(address)}`,
    applyUrl: address,
    listingUrl: address,
    source: 'owner',
    tier: 'A',
    ...readTitle(tabTitle, !!linkedIn),
  };
}
