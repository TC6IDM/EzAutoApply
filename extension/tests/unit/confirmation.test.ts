import { beforeEach, describe, expect, it } from 'vitest';
import { confirmationOf } from '../../src/fill/confirmation';

beforeEach(() => {
  document.body.innerHTML = '';
});

const said = (html: string, url = 'https://example.com/jobs/1') => {
  document.body.innerHTML = html;
  return confirmationOf(document, url)?.detail ?? null;
};

describe('the page that says the application went through (#14)', () => {
  it('Greenhouse: the confirmation page and its address', () => {
    expect(said('<main><h1>Thank you for applying.</h1><p>Your application has been received.</p></main>')).toBe('Thank you for applying.');
    expect(said('<main><p>We will be in touch.</p></main>', 'https://boards.greenhouse.io/acme/jobs/4567/confirmation')).toBe(
      'the address ends in confirmation',
    );
  });

  it('Lever: /thanks; Ashby and others: the wording', () => {
    expect(said('<div><h3>Application submitted!</h3></div>')).toBe('Application submitted!');
    expect(said('<p>x</p>', 'https://jobs.lever.co/acme/abc/thanks')).toBe('the address ends in thanks');
    expect(said("<main><h2>You've successfully applied</h2></main>")).toBe("You've successfully applied");
    expect(said('<main><p>We have received your application for Junior Developer.</p></main>')).toBe(
      'We have received your application for Junior Developer.',
    );
  });

  it('Workday: the congratulations dialog', () => {
    expect(
      said('<div role="dialog" data-automation-id="congratulationsPopup"><h2>Congratulations!</h2><p>Your application was successfully submitted.</p></div>'),
    ).toContain('Your application was successfully submitted.');
  });

  it('not a form that still offers Submit, even if its help text quotes the thank-you', () => {
    expect(
      said(`<main><form><input name="email" value="sam@example.com">
        <p>After you submit, you'll see "Thank you for applying".</p>
        <button type="submit">Submit application</button></form></main>`),
    ).toBeNull();
  });

  it('not an ordinary posting or form page', () => {
    expect(said('<main><h1>Junior Developer</h1><p>Apply by Friday.</p><a href="/apply">Apply</a></main>')).toBeNull();
    expect(said('<main><h1>Thank you for applying</h1></main>'.replace('<h1>', '<h1 hidden>'))).toBeNull();
  });
});
