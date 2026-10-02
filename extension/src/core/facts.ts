import { educationByRecency, experienceByRecency, type Profile, type TriState, yearsOfExperience } from './profile';

const yn = (v: TriState) => (v === null ? 'unknown' : v ? 'yes' : 'no');

/**
 * A compact plain-text summary of the profile, used as the classifier's state
 * when a yes/no question has to be answered from the applicant's background.
 */
export function profileFacts(p: Profile): string {
  const lines: string[] = [];
  const a = p.personal.address;
  const where = [a.city, a.region, a.country].filter(Boolean).join(', ');
  if (where) lines.push(`Lives in: ${where}`);
  if (p.workAuth.authorizedCountries.length) lines.push(`Authorized to work in: ${p.workAuth.authorizedCountries.join(', ')}`);
  lines.push(`Needs visa sponsorship: ${yn(p.workAuth.needsSponsorship)}`);
  if (p.workAuth.citizenship) lines.push(`Citizenship: ${p.workAuth.citizenship}`);
  if (p.workAuth.over18 !== null) lines.push(`At least 18 years old: ${yn(p.workAuth.over18)}`);
  if (p.workAuth.securityClearance) lines.push(`Security clearance: ${p.workAuth.securityClearance}`);
  if (p.experience.length) {
    lines.push(`Total years of work experience: ${yearsOfExperience(p)}`);
    for (const e of experienceByRecency(p).slice(0, 4)) {
      const dates = [e.start, e.current ? 'present' : e.end].filter(Boolean).join(' to ');
      lines.push(`${e.current ? 'Current' : 'Past'} job: ${e.title} at ${e.company}${dates ? ` (${dates})` : ''}`);
    }
  }
  for (const ed of educationByRecency(p).slice(0, 3)) {
    const what = [ed.degree, ed.field && `in ${ed.field}`].filter(Boolean).join(' ');
    lines.push(`Education: ${what || 'studied'} at ${ed.school}${ed.end ? ` (${ed.end})` : ''}`);
  }
  if (p.skills.length) lines.push(`Skills: ${p.skills.slice(0, 40).join(', ')}`);
  if (p.certifications.length) lines.push(`Certifications: ${p.certifications.join(', ')}`);
  if (p.languages.length) lines.push(`Languages: ${p.languages.join(', ')}`);
  if (p.preferences.willingToRelocate !== null) lines.push(`Willing to relocate: ${yn(p.preferences.willingToRelocate)}`);
  if (p.preferences.remotePreference) lines.push(`Preferred work arrangement: ${p.preferences.remotePreference}`);
  return lines.join('\n');
}
