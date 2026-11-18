import { beforeEach, describe, expect, it } from 'vitest';
import { scanFields } from '../../src/fill/scan';
import { applySiteErrors, readSiteErrors } from '../../src/fill/siteErrors';
import type { FieldReport } from '../../src/fill/types';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** Scan first (the ids Run's report uses), then read the errors back by label. */
const errorsByLabel = (html: string) => {
  document.body.innerHTML = html;
  const fields = scanFields(document);
  const label = (id: string | null) => (id ? fields.find((f) => f.id === id)?.label ?? `?${id}` : null);
  return { fields, errors: readSiteErrors(document).map((e) => [label(e.fieldId), e.message]) };
};

const GREENHOUSE_ERRORS = `
  <form id="application-form">
    <div class="field-wrapper">
      <label for="first_name">First Name<span>*</span></label>
      <input id="first_name" aria-required="true" aria-invalid="true" aria-describedby="first_name-error">
      <p id="first_name-error" class="helper-text error">First Name is required</p>
    </div>
    <div class="field-wrapper">
      <label for="email">Email<span>*</span></label>
      <input id="email" type="email" value="sam@" aria-invalid="true" aria-describedby="email-error">
      <p id="email-error" class="helper-text error">Enter a valid email address</p>
    </div>
    <div class="field-wrapper">
      <label for="phone">Phone</label><input id="phone" value="5550100">
    </div>
    <button type="submit">Submit application</button>
  </form>`;

const WORKDAY_ERRORS = `
  <div data-automation-id="errorBanner" role="alert">
    <button data-automation-id="errorBannerToggle">Errors Found</button>
    <ul>
      <li><button data-automation-id="errorItem">Error: The field Phone Number is required and must have a value.</button></li>
      <li><button data-automation-id="errorItem">Error: The field Legal First Name is required and must have a value.</button></li>
    </ul>
  </div>
  <div data-automation-id="formField-legalNameSection_firstName">
    <label for="legalNameSection_firstName">Legal First Name</label>
    <input id="legalNameSection_firstName" data-automation-id="legalNameSection_firstName" aria-invalid="true">
    <div data-automation-id="errorMessage"><p>Error: The field Legal First Name is required and must have a value.</p></div>
  </div>
  <div data-automation-id="formField-phoneNumber">
    <label for="phoneNumber">Phone Number</label>
    <input id="phoneNumber" data-automation-id="phone-number" aria-invalid="true">
    <div data-automation-id="errorMessage"><p>Error: The field Phone Number is required and must have a value.</p></div>
  </div>
  <div data-automation-id="formField-city">
    <label for="city">City</label><input id="city" value="Springfield">
  </div>`;

describe('the site\'s validation errors after Next (#12)', () => {
  it('Greenhouse-like: each invalid field gets the message it points at', () => {
    const { errors } = errorsByLabel(GREENHOUSE_ERRORS);
    expect(errors).toEqual([
      ['First Name*', 'First Name is required'],
      ['Email*', 'Enter a valid email address'],
    ]);
  });

  it('Workday-like: field messages and the error banner map to the same fields, once each', () => {
    const { errors } = errorsByLabel(WORKDAY_ERRORS);
    // The banner comes first on the page, so its order wins; only the pairs matter.
    expect(errors.sort()).toEqual([
      ['Legal First Name', 'The field Legal First Name is required and must have a value.'],
      ['Phone Number', 'The field Phone Number is required and must have a value.'],
    ]);
  });

  it('a summary link to the field maps it; a page-level message stays unplaced', () => {
    const { errors } = errorsByLabel(`
      <div role="alert"><p>There was a problem</p><ul>
        <li><a href="#city">City can't be blank</a></li>
        <li>Please try again later, our servers are busy</li></ul></div>
      <label for="city">City</label><input id="city">
      <label for="zip">Postal code</label><input id="zip">`);
    expect(errors).toEqual([
      ['City', "City can't be blank"],
      [null, 'Please try again later, our servers are busy'],
    ]);
  });

  it('nothing to read on a page without errors, and hidden or wordless ones don\'t count', () => {
    expect(errorsByLabel('<label for="a">A</label><input id="a" value="x"><div class="error" hidden>A is required</div>').errors).toEqual([]);
    expect(errorsByLabel('<label for="a">A</label><input id="a" value="x"><div role="alert">Saved</div>').errors).toEqual([]);
  });

  it('marks the named fields needs, with the site\'s words', () => {
    const report = (id: string, label: string): FieldReport => ({
      id, frameId: 0, label, kind: 'text', options: [], required: true, status: 'filled', source: 'rule', confidence: 1, valueText: 'x',
    });
    const { reports, unplaced } = applySiteErrors(
      [report('f1', 'Email'), report('f2', 'Phone')],
      [{ fieldId: 'f1', message: 'Enter a valid email address' }, { fieldId: null, message: 'Something went wrong' }, { fieldId: 'gone', message: 'x' }],
    );
    expect(reports[0]).toMatchObject({ status: 'needs', note: 'The site says: Enter a valid email address' });
    expect(reports[1].status).toBe('filled');
    expect(unplaced).toEqual(['Something went wrong', 'x']);
  });
});
