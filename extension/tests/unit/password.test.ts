import { describe, expect, it } from 'vitest';
import { bangsFor, lengthen, minLengthFromText, passwordMinLength } from '../../src/fill/password';

describe('password length (#85)', () => {
  it('reads the rule from the wording sites use', () => {
    expect(minLengthFromText('Password must be at least 12 characters.')).toBe(12);
    expect(minLengthFromText('A minimum of 10 characters')).toBe(10);
    expect(minLengthFromText('Minimum 14 chars, one number')).toBe(14);
    expect(minLengthFromText('Must contain 12 or more characters')).toBe(12);
    expect(minLengthFromText('Use 12-64 characters')).toBe(12);
    expect(minLengthFromText('Enter your password')).toBe(0);
    // Not a password rule: too short to be one, or a field limit.
    expect(minLengthFromText('at least 2 characters')).toBe(0);
  });

  it('takes the box minlength, its hint, then the form', () => {
    document.body.innerHTML = `
      <form>
        <p>Password requirements: must be at least 12 characters</p>
        <input type="password" id="a" aria-describedby="h">
        <span id="h">Use a strong password</span>
        <input type="password" id="b" minlength="16">
      </form>`;
    expect(passwordMinLength(document.getElementById('a') as HTMLInputElement)).toBe(12);
    expect(passwordMinLength(document.getElementById('b') as HTMLInputElement)).toBe(16);
  });

  it('adds "!" only when the saved one is too short', () => {
    expect(bangsFor(11, 12)).toBe(1);
    expect(bangsFor(11, 8)).toBe(0);
    expect(bangsFor(11, 0)).toBe(0);
    expect(lengthen('abcdefghijk', 1)).toBe('abcdefghijk!');
    expect(lengthen('abc', 0)).toBe('abc');
  });
});
