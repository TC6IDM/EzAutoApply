import { defineContentScript } from 'wxt/utils/define-content-script';
import { installAlertGuard } from '../src/content/quietAlerts';

// The page's own world (#83): closes `alert()` boxes while the extension fills or advances the page.
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    installAlertGuard(window);
  },
});
