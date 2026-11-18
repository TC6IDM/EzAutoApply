/** Known job-application sites, by domain. A host matches its domain or any subdomain of it. */

/** Applicant-tracking systems whose pages always get the Autofill button. */
const APPLICATION_SITES = [
  'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'myworkdaysite.com', 'workday.com', 'ashbyhq.com',
  'smartrecruiters.com', 'icims.com', 'jobvite.com', 'bamboohr.com', 'workable.com', 'taleo.net',
  'successfactors.com', 'successfactors.eu', 'breezy.hr', 'recruitee.com', 'applytojob.com', 'teamtailor.com',
  'personio.de', 'personio.com', 'rippling.com', 'dover.com', 'wellfound.com', 'oraclecloud.com',
  'brassring.com', 'ultipro.com', 'adp.com', 'avature.net', 'paylocity.com', 'paycomonline.net', 'csod.com',
  'dayforcehcm.com',
];

/**
 * Sites where applicants create an account, so the saved account password may
 * be filled there. Deliberately narrower than "any page with a form".
 */
const ACCOUNT_SITES = [
  'myworkdayjobs.com', 'myworkdaysite.com', 'workday.com', 'icims.com', 'taleo.net', 'successfactors.com',
  'successfactors.eu', 'oraclecloud.com', 'brassring.com', 'jobvite.com', 'smartrecruiters.com', 'ultipro.com',
  'adp.com', 'avature.net', 'paylocity.com', 'paycomonline.net', 'csod.com', 'dayforcehcm.com',
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matches(host: string, domains: string[]): boolean {
  return !!host && domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export function isApplicationSite(url: string): boolean {
  if (/linkedin\.com\/jobs|indeed\.com/i.test(url)) return true;
  return matches(hostOf(url), APPLICATION_SITES);
}

export function isAccountSite(url: string): boolean {
  return matches(hostOf(url), ACCOUNT_SITES);
}

/** Second-level suffixes where the registrable domain is three labels ("example.co.uk"). */
const TWO_PART_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.in', 'co.jp', 'com.br', 'com.mx', 'co.za', 'com.sg', 'com.hk']);

/** "careers.example.co.uk" → "example.co.uk"; an IP or a one-label host is returned as is. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || !h.includes('.')) return h;
  const labels = h.split('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * Run to Submit's "externalRedirect" stop (#11): the top frame moved to another site that
 * isn't a job-application site. Moving onto an ATS (a LinkedIn or company listing handing
 * over to Greenhouse or Workday) is the expected way in, so it isn't one.
 */
export function isExternalRedirect(fromUrl: string, toUrl: string): boolean {
  const from = hostOf(fromUrl);
  const to = hostOf(toUrl);
  if (!from || !to) return false;
  if (registrableDomain(from) === registrableDomain(to)) return false;
  return !isApplicationSite(toUrl);
}
