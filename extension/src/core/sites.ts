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
