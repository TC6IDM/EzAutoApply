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

describe('run mode: Submit is never mistaken for Next (#10)', () => {
  const run = () => {
    const b = findAdvanceButton(document, { run: true });
    return b && { label: b.label, kind: b.kind, why: !!b.why };
  };

  it('Lever-style one-page form ending in "Apply": Submit in run mode, Start for the manual button', () => {
    document.body.innerHTML = `
      <form class="application-form"><input name="name" value="Sam Sample"><input name="email" value="sam@example.com">
      <button type="submit" class="postings-btn template-btn-submit">Apply</button></form>`;
    expect(run()).toEqual({ label: 'Apply', kind: 'submit', why: true });
    expect(found()).toEqual({ label: 'Apply', kind: 'start' });
  });

  it('a listing page\'s "Apply" with nothing answered stays Start (Run may open the form)', () => {
    document.body.innerHTML = `
      <header><form role="search"><input name="q" value="developer"><button>Search</button></form></header>
      <main><h1>Junior Developer</h1><p>About the role…</p><a href="/apply" class="btn-primary">Apply for this job</a></main>`;
    expect(run()).toEqual({ label: 'Apply for this job', kind: 'start', why: false });
  });

  it('Greenhouse-style input button "Submit Application" is Submit', () => {
    document.body.innerHTML = `
      <form id="application_form"><input id="first_name" value="Sam"><input type="button" id="submit_app" value="Submit Application"></form>`;
    expect(run()).toEqual({ label: 'Submit Application', kind: 'submit', why: false });
  });

  it('Ashby-style form: Submit Application after Yes/No buttons', () => {
    document.body.innerHTML = `
      <form><input name="_systemfield_name" value="Sam Sample">
      <div><button type="button" aria-pressed="true">Yes</button><button type="button" aria-pressed="false">No</button></div>
      <button type="submit" class="ashby-application-form-submit-button">Submit Application</button></form>`;
    expect(run()).toEqual({ label: 'Submit Application', kind: 'submit', why: false });
  });

  it('Workday: Next stays Next on an ordinary step, and anything onward on the Review step is Submit', () => {
    const page = (active: string, button: string) => `
      <ol data-automation-id="progressBar">
        <li data-automation-id="progressBarCompletedStep"><div>completed step 1 of 6</div><label>My Information</label></li>
        <li data-automation-id="progressBarActiveStep"><div>current step ${active === 'Review' ? 6 : 2} of 6</div><label>${active}</label></li>
      </ol>
      <input data-automation-id="legalNameSection_firstName" value="Sam">
      <div data-automation-id="pageFooter"><button data-automation-id="pageFooterBackButton">Back</button>
      <button data-automation-id="pageFooterNextButton">${button}</button></div>`;
    document.body.innerHTML = page('My Experience', 'Save and Continue');
    expect(run()).toEqual({ label: 'Save and Continue', kind: 'next', why: false });
    document.body.innerHTML = page('Review', 'Submit');
    expect(run()).toEqual({ label: 'Submit', kind: 'submit', why: false });
    document.body.innerHTML = page('Review', 'Continue');
    expect(run()).toEqual({ label: 'Continue', kind: 'submit', why: true });
    expect(found()).toEqual({ label: 'Continue', kind: 'next' });
  });

  it('LinkedIn Easy Apply: Next and Review may be pressed; Submit application on the review step is Submit', () => {
    document.body.innerHTML = `
      <div role="dialog"><h3>Contact info</h3><input id="phone" value="5550100">
      <button aria-label="Continue to next step"><span>Next</span></button></div>`;
    expect(run()).toMatchObject({ kind: 'next' });
    document.body.innerHTML = `
      <div role="dialog"><h3>Additional questions</h3><input id="years" value="1">
      <button aria-label="Review your application"><span>Review</span></button></div>`;
    expect(run()).toMatchObject({ kind: 'next', why: false });
    document.body.innerHTML = `
      <div role="dialog"><h3>Review your application</h3><p>Contact info: Sam Sample</p>
      <button aria-label="Submit application"><span>Submit application</span></button></div>`;
    expect(run()).toMatchObject({ kind: 'submit' });
  });

  it('SmartRecruiters / iCIMS wordings: Send, Complete, Confirm and submit', () => {
    for (const word of ['Send', 'Complete', 'Confirm and submit', 'I agree and submit', 'Submit for review', 'Done', 'Finish and submit']) {
      document.body.innerHTML = `<form><input name="email" value="sam@example.com"><button type="button">${word}</button></form>`;
      expect(run(), word).toMatchObject({ kind: 'submit' });
    }
  });

  it('an unknown main button on an answered form is Submit, with the reason', () => {
    document.body.innerHTML = `<form><input name="email" value="sam@example.com"><button class="btn btn-primary">Let's go</button></form>`;
    const b = findAdvanceButton(document, { run: true })!;
    expect(b).toMatchObject({ label: "Let's go", kind: 'submit' });
    expect(b.why).toMatch(/unknown/);
    expect(findAdvanceButton(document)).toBeNull();
  });

  it('a type="submit" Continue in a filled form stays Next; the form\'s last unknown submit is Submit', () => {
    document.body.innerHTML = `<form><input name="city" value="Springfield"><button type="submit">Continue</button></form>`;
    expect(run()).toMatchObject({ kind: 'next' });
    document.body.innerHTML = `<form><input name="city" value="Springfield"><input type="submit" value="Go"></form>`;
    expect(run()).toMatchObject({ kind: 'submit', why: true });
  });

  it('sign-in, search and the site header keep their meaning in run mode', () => {
    document.body.innerHTML = `
      <header><nav><a href="/apply">Apply</a></nav></header>
      <form><input type="email" value="sam@example.com"><input type="password" value="x"><button type="submit">Sign In</button></form>`;
    expect(run()).toMatchObject({ label: 'Sign In', kind: 'signIn' });
    document.body.innerHTML = `<form><input name="keywords" value="developer"><button class="btn-primary">Search jobs</button></form>`;
    expect(findAdvanceButton(document, { run: true })).toBeNull();
  });
});
