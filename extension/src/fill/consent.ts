import { cleanText } from '../core/normalize';
import { deepQueryAll, isOwnUi, isVisible, sleep, waitFor } from './dom';
import { realClick } from './fillers';
import { textOf } from './labels';

/**
 * Some applications won't submit until a privacy notice has been opened and acknowledged
 * (SuccessFactors: "Click to read and acknowledge the privacy notice" → dialog → Acknowledge).
 * This opens each one and presses its acknowledge button. Nothing else is clicked: the
 * button must say acknowledge/accept/agree and sit in a dialog about privacy or data protection.
 */

const NOTICE_LINK =
  /\b(read|review|view|open|click)\b.{0,50}\b(acknowledge|accept|agree)\b.{0,50}\b(privacy|data protection|data privacy)\b|\b(acknowledge|accept)\b.{0,30}\b(privacy|data protection) (notice|policy|statement)\b/i;
const ACK_BUTTON = /^(i )?(acknowledge|accept|agree|have read)( and (accept|agree))?\.?$/i;
const UNSAFE = /\b(submit|apply|next|continue|save|sign|create|decline|reject)\b/i;
const DIALOG = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog, .sapMDialog';

export interface Acknowledged {
  label: string;
}

function visibleDialogs(doc: Document): HTMLElement[] {
  return (Array.from(doc.querySelectorAll(DIALOG)) as HTMLElement[]).filter(isVisible);
}

export async function acknowledgePrivacyNotices(root: Document = document): Promise<Acknowledged[]> {
  const done: Acknowledged[] = [];
  const links = deepQueryAll<HTMLElement>(root, 'a, button, [role="button"], [role="link"]').filter(
    (l) => !isOwnUi(l) && isVisible(l) && NOTICE_LINK.test(cleanText(l.textContent ?? '')),
  );
  for (const link of links) {
    const before = new Set(visibleDialogs(root));
    realClick(link);
    const dialog = await waitFor(() => visibleDialogs(root).find((d) => !before.has(d) && /privacy|data protection/i.test(textOf(d))), 4000, 100);
    if (!dialog) continue;
    // Some notices only enable the button once scrolled to the end.
    for (const scroller of [dialog, ...Array.from(dialog.querySelectorAll<HTMLElement>('*'))]) {
      if (scroller.scrollHeight > scroller.clientHeight + 10) scroller.scrollTop = scroller.scrollHeight;
    }
    await sleep(200);
    const button = (Array.from(dialog.querySelectorAll<HTMLElement>('button, [role="button"], a')) as HTMLElement[]).find((b) => {
      const t = cleanText(b.textContent ?? b.getAttribute('aria-label') ?? '');
      return ACK_BUTTON.test(t) && !UNSAFE.test(t) && isVisible(b) && !(b as HTMLButtonElement).disabled;
    });
    if (!button) continue;
    realClick(button);
    await waitFor(() => !dialog.isConnected || !isVisible(dialog), 3000, 100);
    done.push({ label: cleanText(link.textContent ?? 'Privacy notice') });
  }
  return done;
}
