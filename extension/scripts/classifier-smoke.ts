// Sends realistic application questions to a running classifier and prints
// what it decided and how sure it was, so you can see Laya/Jev working and
// judge the confidence thresholds. Run: npm run smoke:classifier
//   CLASSIFIER_URL=http://127.0.0.1:8000 CLASSIFIER_KEY=... npm run smoke:classifier
import { SystemOneClient } from '../src/classifier/systemone';
import { defaultSettings } from '../src/core/types';
import { chooseOption, classifyGroups, deriveYesNo, KEY_MARGIN, likelyGroups, rankKeys } from '../src/fill/match/classify';
import type { FieldInfo } from '../src/fill/types';

const settings = defaultSettings().classifier;
settings.baseUrl = process.env.CLASSIFIER_URL ?? settings.baseUrl;
settings.apiKey = process.env.CLASSIFIER_KEY ?? '';
const client = new SystemOneClient(settings);

const field = (label: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({
  id: label, kind: 'text', label, help: '', name: '', htmlId: '', placeholder: '', autocomplete: '', inputType: 'text',
  options: [], required: false, section: '', multiple: false, hasValue: false, ...extra,
});
const opts = (...labels: string[]) => labels.map((l) => ({ label: l, value: l }));

// [field, the key it should map to, or null when it should be left to the user]
const CASES: [FieldInfo, string | null][] = [
  [field('Institution you graduated from'), 'school'],
  [field('Alma mater'), 'school'],
  [field('Best number to reach you'), 'phone'],
  [field('Your current employer'), 'currentCompany'],
  [field('What are your compensation requirements for this role?'), 'desiredSalary'],
  [field('Do you now, or will you in the future, need an employer to file a petition on your behalf to work in the US?', { kind: 'radio', options: opts('Yes', 'No') }), 'needsSponsorship'],
  [field('Personal web presence (URL)'), 'website'],
  [field('Earliest date you could join us'), 'startDate'],
  [field('Please describe a challenging project you led', { kind: 'textarea' }), null],
  [field('I consent to the processing of my personal data', { kind: 'checkbox' }), null],
];

const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4);
const { autoThreshold: auto, reviewThreshold: review } = settings;

const health = await client.health();
console.log(`${health.detail}\n`);
if (!health.ok) process.exit(1);

let t = Date.now();
const groups = await classifyGroups(CASES.map(([f]) => f), client);
console.log(`Step 1, groups for ${CASES.length} fields in one batch: ${Date.now() - t} ms\n`);

let right = 0;
let wrong = 0;
for (const [i, [f, expected]] of CASES.entries()) {
  t = Date.now();
  const likely = likelyGroups(groups[i]);
  const [best, second] = await rankKeys(f, likely, client);
  const accepted = !!best && best.p >= review && best.p - (second?.p ?? 0) >= KEY_MARGIN;
  const outcome = accepted ? best.key : null;
  const mark = outcome === expected ? '✓' : outcome === null ? '·' : '✗';
  if (outcome === expected) right++;
  else if (outcome !== null) wrong++;
  const top = best ? `${best.key} ${pct(best.p)}${second ? `, next ${second.key} ${pct(second.p)}` : ''}` : 'no candidates';
  const verdict = !accepted ? 'ask you' : best.p >= auto ? 'fill' : 'fill for review';
  console.log(`${mark} ${f.label.slice(0, 50).padEnd(50)} ${likely.join('+').padEnd(20)} ${top.padEnd(46)} → ${verdict} (${Date.now() - t} ms)`);
}
console.log(`\n${right}/${CASES.length} as expected, ${wrong} wrong (✓ right, · left for you, ✗ wrong field).\n`);

t = Date.now();
const opt = await chooseOption(
  field('What is your work authorization status?', { kind: 'select', options: opts('Select...', 'Authorized to work without sponsorship', 'Will require sponsorship now or in the future', 'Not authorized') }),
  'Authorized to work in the United States; does not need visa sponsorship',
  client,
);
console.log(`Option for an authorized applicant: index ${opt.value} at ${pct(opt.confidence)} (${Date.now() - t} ms)`);

const facts = 'Skills: TypeScript, React, Python\nTotal years of work experience: 5\nCurrent job: Software Engineer at Acme Corp (2021-06 to present)';
for (const q of ['Do you have professional experience with React?', 'Do you have 3+ years of experience with Kubernetes?', 'Have you worked as a registered nurse?']) {
  t = Date.now();
  const p = await deriveYesNo(field(q, { kind: 'radio', options: opts('Yes', 'No') }), facts, client);
  console.log(`P(yes) ${pct(p ?? 0)} (${Date.now() - t} ms)  ${q}`);
}
