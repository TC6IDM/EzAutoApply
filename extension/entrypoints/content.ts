import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { AutofillController, settle } from '../src/content/controller';
import { FloatingUi } from '../src/content/floatingUi';
import { findAdvanceButton, pressAdvance } from '../src/fill/advance';
import { findBlockers } from '../src/fill/blockers';
import { confirmationOf } from '../src/fill/confirmation';
import { readSiteErrors } from '../src/fill/siteErrors';
import type { Settings } from '../src/core/types';
import { type BackgroundToContent, call, type ContentToBackground, type RunCheckResponse } from '../src/messages';
import { acceptAccountTerms, pageFingerprint } from '../src/run/page';
import { quietAlerts } from '../src/content/quietAlerts';
import { findMissed, formSnapshot } from '../src/content/missed';

/** How long after a fill or a Next the page's alerts still close themselves (sites answer an upload late). */
const QUIET_AFTER_MS = 20_000;

/** Applicant-tracking systems whose pages always get the Autofill button. */
const ATS =
  /greenhouse\.io|lever\.co|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|ashbyhq\.com|smartrecruiters\.com|icims\.com|jobvite\.com|bamboohr\.com|workable\.com|taleo\.net|successfactors\.|linkedin\.com\/jobs|indeed\.com|breezy\.hr|recruitee\.com|applytojob\.com|teamtailor\.com|personio\.|rippling\.com|dover\.com|wellfound\.com/i;

function looksLikeApplication(): boolean {
  if (ATS.test(location.href)) return true;
  if (Array.from(document.querySelectorAll('iframe')).some((f) => ATS.test(f.src))) return true;
  const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]), select, textarea').length;
  const hasUpload = !!document.querySelector('input[type="file"]');
  const wording = /\b(apply|application|resume|cv|candidate)\b/i.test(`${document.title} ${document.querySelector('h1')?.textContent ?? ''}`);
  return inputs >= 4 && (hasUpload || wording);
}

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_idle',
  main() {
    const send = (msg: ContentToBackground) => browser.runtime.sendMessage(msg);
    const isTop = window.top === window;
    let ui: FloatingUi | null = null;
    let settings: Settings | null = null;
    const controller = new AutofillController(send, () => ui);

    const showButton = () => {
      if (!isTop || ui?.attached || !settings?.showFloatingButton || !looksLikeApplication()) return;
      ui = new FloatingUi(
        () => send({ type: 'autofillAll' }).catch((e: Error) => ui?.toast(e.message)),
        (stop) => send({ type: stop ? 'stopRun' : 'runAll' }).catch((e: Error) => ui?.toast(e.message)),
      );
    };

    const applySettings = (s: Settings) => {
      settings = s;
      controller.settings = s;
      if (!s.showFloatingButton) {
        ui?.remove();
        ui = null;
      } else showButton();
    };

    browser.runtime.onMessage.addListener((msg: BackgroundToContent, _sender, sendResponse) => {
      switch (msg.type) {
        case 'autofill':
          // The page's alerts close themselves while it fills, and for a little after (#83).
          quietAlerts(document, 10 * 60_000);
          controller
            .autofill()
            .finally(() => quietAlerts(document, QUIET_AFTER_MS))
            .then(
              () => sendResponse({ ok: true }),
              (e: Error) => sendResponse({ error: e.message }),
            );
          return true;
        case 'applyAnswer':
          controller.applyAnswer(msg.fieldId, msg.answer).then(sendResponse, (e: Error) => sendResponse({ error: e.message }));
          return true;
        case 'clearReports':
          controller.clearReports();
          sendResponse(null);
          return false;
        case 'focusField':
          sendResponse(controller.focusField(msg.fieldId));
          return false;
        case 'findAdvance': {
          const b = findAdvanceButton(document, { run: msg.run });
          sendResponse(b ? { label: b.label, kind: b.kind, score: b.score, ...(b.why && { why: b.why }) } : null);
          return false;
        }
        case 'confirmation':
          sendResponse(confirmationOf(document, location.href));
          return false;
        case 'advance': {
          // Looked up again: the page may have changed since the panel last asked.
          const b = findAdvanceButton(document, { run: msg.run });
          // Run never presses Submit, even if the page changed between finding and pressing.
          if (msg.run && b?.kind === 'submit') {
            sendResponse({ ok: false, reason: 'That button is Submit' });
            return false;
          }
          if (b) {
            quietAlerts(document, QUIET_AFTER_MS);
            pressAdvance(b);
          }
          sendResponse(b ? { ok: true, label: b.label } : { ok: false, reason: 'That button is no longer on the page' });
          return false;
        }
        case 'runCheck': {
          const res: RunCheckResponse = {
            url: location.href,
            fingerprint: pageFingerprint(document, location.href),
            blockers: findBlockers(document).map((b) => ({ kind: b.kind, detail: b.detail })),
            confirmation: isTop ? (confirmationOf(document, location.href)?.detail ?? null) : null,
          };
          sendResponse(res);
          return false;
        }
        case 'settle':
          settle(document, 1000, 10_000).then(() => sendResponse(null), () => sendResponse(null));
          return true;
        case 'acceptTerms':
          sendResponse(acceptAccountTerms(document));
          return false;
        case 'siteErrors':
          sendResponse(readSiteErrors(document));
          return false;
        case 'missedField':
          sendResponse(findMissed(document, msg.label));
          return false;
        case 'formSnapshot':
          sendResponse(formSnapshot(document));
          return false;
        case 'settingsChanged':
          applySettings(msg.settings);
          sendResponse(null);
          return false;
        case 'fillProgress':
          ui?.setProgress(msg.progress);
          sendResponse(null);
          return false;
        case 'runState':
          ui?.setRun(msg.run);
          sendResponse(null);
          return false;
      }
    });

    if (!isTop) return;
    call<Settings>(() => send({ type: 'getSettings' }))
      .then((s) => {
        applySettings(s);
        // Single-page apps render the form after load; keep checking briefly until it shows up.
        if (!ui) {
          let timer: number | undefined;
          const obs = new MutationObserver(() => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
              showButton();
              if (ui) obs.disconnect();
            }, 500);
          });
          obs.observe(document.documentElement, { childList: true, subtree: true });
          setTimeout(() => obs.disconnect(), 60_000);
        }
      })
      .catch(() => {});
  },
});
