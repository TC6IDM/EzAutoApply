import { describe, expect, it } from 'vitest';
import { FloatingUi } from '../../src/content/floatingUi';
import { OWN_UI_ID } from '../../src/fill/dom';

describe('floating button', () => {
  it('replaces the button an orphaned content script left behind', () => {
    // The fleet build reloads (#32) and the background injects the content script again into
    // open tabs: the old script's button is still on the page, cut off from the extension.
    new FloatingUi(() => {});
    const fresh = new FloatingUi(() => {});
    expect(document.querySelectorAll(`#${OWN_UI_ID}`)).toHaveLength(1);
    expect(fresh.attached).toBe(true);
  });
});
