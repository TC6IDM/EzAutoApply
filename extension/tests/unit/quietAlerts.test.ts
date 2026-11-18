import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAlertGuard, LAST_ALERT_ATTR, QUIET_ATTR, quietAlerts } from '../../src/content/quietAlerts';

describe('page alerts while the extension fills (#83)', () => {
  const original = window.alert;
  afterEach(() => {
    window.alert = original;
    document.documentElement.removeAttribute(QUIET_ATTR);
    document.documentElement.removeAttribute(LAST_ALERT_ATTR);
  });

  it('closes them while the page is marked busy, and keeps their text', () => {
    const shown = vi.fn();
    window.alert = shown;
    installAlertGuard(window);
    quietAlerts(document, 20_000);
    window.alert('You have Uploaded Resume Successfully.');
    expect(shown).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute(LAST_ALERT_ATTR)).toBe('You have Uploaded Resume Successfully.');
  });

  it('shows them as usual otherwise, and installs once', () => {
    const shown = vi.fn();
    window.alert = shown;
    installAlertGuard(window);
    installAlertGuard(window);
    window.alert('hello');
    quietAlerts(document, 20_000, Date.now() - 60_000);
    window.alert('later');
    expect(shown.mock.calls).toEqual([['hello'], ['later']]);
  });
});
