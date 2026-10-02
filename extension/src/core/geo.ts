import { normalize } from './normalize';

/**
 * Country names plus the alternate spellings application forms use. The first
 * entry of each row is the canonical name.
 */
const COUNTRY_ROWS: string[][] = [
  ['United States', 'united states of america', 'usa', 'us', 'u s', 'u s a', 'america', 'the united states', 'the us'],
  ['Canada', 'ca'],
  ['United Kingdom', 'uk', 'u k', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland', 'gb'],
  ['Ireland', 'republic of ireland'],
  ['Australia', 'au'],
  ['New Zealand', 'nz'],
  ['India', 'in'],
  ['Germany', 'de', 'deutschland'],
  ['France'],
  ['Spain', 'espana'],
  ['Italy'],
  ['Netherlands', 'the netherlands', 'holland'],
  ['Belgium'],
  ['Switzerland'],
  ['Austria'],
  ['Sweden'],
  ['Norway'],
  ['Denmark'],
  ['Finland'],
  ['Iceland'],
  ['Poland'],
  ['Portugal'],
  ['Greece'],
  ['Czech Republic', 'czechia'],
  ['Slovakia'],
  ['Hungary'],
  ['Romania'],
  ['Bulgaria'],
  ['Croatia'],
  ['Serbia'],
  ['Slovenia'],
  ['Ukraine'],
  ['Russia', 'russian federation'],
  ['Turkey', 'turkiye'],
  ['Israel'],
  ['United Arab Emirates', 'uae', 'u a e'],
  ['Saudi Arabia'],
  ['Qatar'],
  ['Egypt'],
  ['South Africa'],
  ['Nigeria'],
  ['Kenya'],
  ['Ghana'],
  ['Morocco'],
  ['Mexico'],
  ['Brazil', 'brasil'],
  ['Argentina'],
  ['Chile'],
  ['Colombia'],
  ['Peru'],
  ['Venezuela'],
  ['Costa Rica'],
  ['Puerto Rico'],
  ['Jamaica'],
  ['Cuba'],
  ['Dominican Republic'],
  ['China', "people's republic of china", 'peoples republic of china', 'prc', 'mainland china'],
  ['Hong Kong', 'hong kong sar'],
  ['Taiwan'],
  ['Japan'],
  ['South Korea', 'korea', 'republic of korea', 'korea republic of', 'korea south'],
  ['North Korea'],
  ['Singapore'],
  ['Malaysia'],
  ['Indonesia'],
  ['Philippines', 'the philippines'],
  ['Thailand'],
  ['Vietnam', 'viet nam'],
  ['Pakistan'],
  ['Bangladesh'],
  ['Sri Lanka'],
  ['Nepal'],
  ['Iran'],
  ['Iraq'],
  ['Jordan'],
  ['Lebanon'],
  ['Ethiopia'],
  ['Estonia'],
  ['Latvia'],
  ['Lithuania'],
  ['Luxembourg'],
  ['Malta'],
  ['Cyprus'],
];

const US_STATES: [string, string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  // Canadian provinces and territories
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'],
  ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'],
  ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
];

const countryByAlias = new Map<string, string>();
for (const row of COUNTRY_ROWS) {
  for (const name of row) countryByAlias.set(normalize(name), row[0]);
}

const regionByAlias = new Map<string, string>();
for (const [abbr, name] of US_STATES) {
  regionByAlias.set(normalize(abbr), name);
  regionByAlias.set(normalize(name), name);
}

/** Canonical country name for any alias, or null. Strips "(+1)"-style dial codes. */
export function canonicalCountry(s: string): string | null {
  const n = normalize((s || '').replace(/\(\s*\+?\d[\d\s-]*\)|\+\d+/g, ' '));
  return countryByAlias.get(n) ?? null;
}

/** Canonical state/province name for an abbreviation or name, or null. */
export function canonicalRegion(s: string): string | null {
  return regionByAlias.get(normalize(s)) ?? null;
}

export function regionAbbreviation(s: string): string | null {
  const canon = canonicalRegion(s);
  if (!canon) return null;
  return US_STATES.find(([, name]) => name === canon)?.[0] ?? null;
}

// Longest aliases first so "united states of america" wins over "america". Two-letter
// aliases are excluded from free-text detection because they collide with words ("in", "us").
const DETECTABLE = [...countryByAlias.entries()]
  .filter(([alias]) => alias.replace(/ /g, '').length > 2 || alias === 'u s' || alias === 'u s a')
  .sort((a, b) => b[0].length - a[0].length);

/** Find the country a question mentions ("authorized to work in the United States?"). */
export function detectCountry(text: string): string | null {
  const n = ` ${normalize(text)} `;
  for (const [alias, canon] of DETECTABLE) {
    if (n.includes(` ${alias} `)) return canon;
  }
  // "in the US" / "in the UK" style mentions
  const m = /\b(?:in|within|of) (?:the )?(us|uk|usa)\b/.exec(n);
  if (m) return countryByAlias.get(m[1]) ?? null;
  return null;
}
