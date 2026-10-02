import { EDUCATION_SECTION, EXPERIENCE_SECTION } from '../core/fieldKeys';
import { cleanText, normalize } from '../core/normalize';
import type { Profile } from '../core/profile';
import { deepQueryAll, isOwnUi, isVisible, waitFor } from './dom';
import { realClick } from './fillers';
import { sectionOf } from './labels';
import { matchRules } from './match/rules';
import { scanFields } from './scan';

/**
 * Forms like Workday show one empty job (or none) with an "Add Another" button.
 * Before filling, click it until there's one entry per job and school in the
 * profile, so every entry gets filled.
 */

/** "Add", "Add Another", "+ Add", "Add Work Experience", "Add another education"… */
const ADD_LABEL = /^\+?\s*add\b(\s+(another|more|new|an?))?(\s+(work\s+)?(experience|education|job|position|employment|school|degree))?\s*$/i;
/** Never click anything that could move the application forward. */
const UNSAFE = /\b(submit|save|next|continue|apply|review|sign|create|finish|done|upload|file)\b/i;

type Repeat = 'experience' | 'education';

const SECTION: Record<Repeat, RegExp> = { experience: EXPERIENCE_SECTION, education: EDUCATION_SECTION };
/** The fields whose count says how many entries are on the page. */
const ENTRY_KEYS: Record<Repeat, string[]> = { experience: ['expTitle', 'expCompany'], education: ['school'] };

function entryCount(kind: Repeat, root: ParentNode): number {
  const keys = scanFields(root).map((f) => matchRules(f)?.key);
  return Math.max(...ENTRY_KEYS[kind].map((k) => keys.filter((x) => x === k).length));
}

function buttonLabel(b: Element): string {
  return cleanText(b.textContent || b.getAttribute('aria-label') || '');
}

/** The add button for a section: says "Add…", and its own label or its heading names the section. */
export function addButtonFor(kind: Repeat, root: ParentNode = document): HTMLElement | null {
  const headings = deepQueryAll(root, 'h1, h2, h3, h4, h5, h6, [role="heading"]');
  const candidates = deepQueryAll<HTMLElement>(root, 'button, [role="button"]').filter((b) => {
    if (isOwnUi(b) || !isVisible(b) || (b as HTMLButtonElement).disabled) return false;
    const label = buttonLabel(b);
    const aria = cleanText(b.getAttribute('aria-label') ?? '');
    if (UNSAFE.test(label) || UNSAFE.test(aria)) return false;
    if (!ADD_LABEL.test(label) && !ADD_LABEL.test(aria)) return false;
    const context = normalize(`${aria} ${b.getAttribute('data-automation-id') ?? ''} ${sectionOf(b, headings)}`);
    return SECTION[kind].test(context) && !SECTION[kind === 'experience' ? 'education' : 'experience'].test(normalize(aria));
  });
  // The button after the last entry is the one that adds another.
  return candidates[candidates.length - 1] ?? null;
}

/** Click "Add Another" until the page has as many entries as the profile. Returns how many were added. */
export async function expandRepeatingSections(profile: Profile, root: ParentNode = document): Promise<number> {
  let added = 0;
  const wanted: Record<Repeat, number> = { experience: profile.experience.length, education: profile.education.length };
  for (const kind of ['experience', 'education'] as Repeat[]) {
    for (let guard = 0; guard < 15; guard++) {
      const have = entryCount(kind, root);
      if (have >= wanted[kind]) break;
      const button = addButtonFor(kind, root);
      if (!button) break;
      realClick(button);
      // Stop if the click didn't add an entry (a limit, or the wrong button).
      if (!(await waitFor(() => entryCount(kind, root) > have, 3000, 100))) break;
      added++;
    }
  }
  return added;
}
