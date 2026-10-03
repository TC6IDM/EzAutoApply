import { beforeEach, describe, expect, it } from 'vitest';
import { findAdvanceButton, pressAdvance } from '../../src/fill/advance';

beforeEach(() => {
  document.body.innerHTML = '';
});

const found = () => {
  const b = findAdvanceButton(document);
  return b && { label: b.label, kind: b.kind };
};

describe('the Advance button target', () => {
  it('is Workday’s footer button, not Back or Add Another', () => {
    document.body.innerHTML = `
      <button data-automation-id="add-button">Add Another</button>
      <div data-automation-id="pageFooter">
        <button data-automation-id="pageFooterBackButton">Back</button>
        <button data-automation-id="pageFooterNextButton">Save and Continue</button>
      </div>`;
    expect(found()).toEqual({ label: 'Save and Continue', kind: 'next' });
  });

  it('says when the footer button submits', () => {
    document.body.innerHTML = '<button data-automation-id="pageFooterBackButton">Back</button><button data-automation-id="pageFooterNextButton">Submit</button>';
    expect(found()).toEqual({ label: 'Submit', kind: 'submit' });
  });

  it('prefers the form’s submit button over the site header’s links', () => {
    document.body.innerHTML = `
      <header><nav><a href="/login">Sign in</a><button>Apply now</button></nav></header>
      <form><input name="first_name"><button type="submit">Submit application</button></form>`;
    expect(found()).toEqual({ label: 'Submit application', kind: 'submit' });
  });

  it('signs in, but not with Google, and not "Forgot your password?"', () => {
    document.body.innerHTML = `
      <input type="email"><input type="password">
      <button>Sign in with Google</button>
      <button>Forgot your password?</button>
      <button type="submit">Sign In</button>`;
    expect(found()).toEqual({ label: 'Sign In', kind: 'signIn' });
  });

  it('presses Workday’s click layer over its sign-in button', () => {
    document.body.innerHTML = `
      <div><button data-automation-id="signInSubmitButton" aria-hidden="true" tabindex="-1">Sign In</button>
      <div data-automation-id="click_filter" role="button" tabindex="0" aria-label="Sign In"></div></div>`;
    let clicked = '';
    document.querySelector('[data-automation-id="click_filter"]')!.addEventListener('click', () => (clicked = 'filter'));
    const b = findAdvanceButton(document)!;
    expect(b).toMatchObject({ label: 'Sign In', kind: 'signIn' });
    pressAdvance(b);
    expect(clicked).toBe('filter');
  });

  it('applies manually rather than letting Workday read the resume', () => {
    document.body.innerHTML = `
      <a data-automation-id="autofillWithResume" role="button">Autofill with Resume</a>
      <a data-automation-id="applyManually" role="button">Apply Manually</a>
      <a data-automation-id="useMyLastApplication" role="button">Use My Last Application</a>`;
    expect(found()).toEqual({ label: 'Apply Manually', kind: 'start' });
  });

  it('is off when nothing moves the application on', () => {
    document.body.innerHTML = `
      <button>Add</button><button>Cancel</button><a href="?page=2">Next</a>
      <button type="submit" disabled>Submit</button>`;
    expect(findAdvanceButton(document)).toBeNull();
  });

  it('presses the button it found', () => {
    document.body.innerHTML = '<form><button type="button" id="next">Next</button></form>';
    let pressed = false;
    document.querySelector('#next')!.addEventListener('click', () => (pressed = true));
    pressAdvance(findAdvanceButton(document)!);
    expect(pressed).toBe(true);
  });
});
