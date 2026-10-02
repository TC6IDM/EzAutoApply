import { describe, expect, it } from 'vitest';
import { canonicalCountry, detectCountry } from '../../src/core/geo';
import { normalize, questionSimilarity } from '../../src/core/normalize';
import { boolOf, degreeLevel, isPlaceholderOption, matchOption, parseRange } from '../../src/core/options';
import { opts } from './helpers';

const pick = (labels: string[], want: string | boolean, variants: string[] = []) => {
  const m = matchOption(opts(...labels), want, variants);
  return m ? labels[m.index] : null;
};

describe('normalize', () => {
  it('strips required markers, punctuation and accents', () => {
    expect(normalize('  Résumé / CV *')).toBe('resume / cv');
    expect(normalize('First Name (required)')).toBe('first name');
    expect(normalize("Don't know")).toBe("don't know");
  });

  it('scores rephrased questions as similar', () => {
    expect(questionSimilarity('Are you legally authorized to work in the US?', 'Are you legally authorized to work in the U.S.?')).toBeGreaterThan(0.85);
    expect(questionSimilarity('Why do you want to work here?', 'What is your GPA?')).toBeLessThan(0.3);
  });
});

describe('yes/no', () => {
  it('reads yes and no phrasings', () => {
    expect(boolOf('Yes, I am authorized')).toBe(true);
    expect(boolOf('No, I will require sponsorship')).toBe(false);
    expect(boolOf("I don't wish to answer")).toBeNull();
    expect(boolOf('Maybe')).toBeNull();
  });

  it('picks the yes/no option for a boolean', () => {
    expect(pick(['Select...', 'Yes', 'No'], true)).toBe('Yes');
    expect(pick(['Yes', 'No'], false)).toBe('No');
  });
});

describe('option matching', () => {
  it('matches countries across spellings', () => {
    expect(pick(['Canada', 'United States of America', 'Mexico'], 'United States')).toBe('United States of America');
    expect(pick(['United States (+1)', 'United Kingdom (+44)'], 'USA')).toBe('United States (+1)');
    expect(canonicalCountry('U.S.A.')).toBe('United States');
  });

  it('matches state abbreviations', () => {
    expect(pick(['California', 'Texas', 'Washington'], 'TX')).toBe('Texas');
  });

  it('matches degree levels', () => {
    expect(degreeLevel('B.S. in Computer Science')).toBe('bachelor');
    expect(pick(["High School", "Associate's Degree", "Bachelor's Degree", "Master's Degree"], 'Bachelor of Science')).toBe("Bachelor's Degree");
  });

  it('matches EEO answers phrased differently', () => {
    const veteran = ['I am not a protected veteran', 'I identify as one or more of the classifications of protected veteran', "I don't wish to answer"];
    expect(pick(veteran, 'I am not a protected veteran')).toBe(veteran[0]);
    expect(pick(veteran, 'Decline to self-identify')).toBe(veteran[2]);
    const disability = ['Yes, I have a disability (or previously had a disability)', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer'];
    expect(pick(disability, 'No, I do not have a disability')).toBe(disability[1]);
    expect(pick(['Yes', 'No', 'Decline'], 'No, I do not have a disability')).toBe('No');
  });

  it('uses variants to reach differently-worded options', () => {
    expect(pick(['Hispanic or Latino', 'Not Hispanic or Latino', 'Decline to answer'], 'No', ['No', 'Not Hispanic or Latino'])).toBe('Not Hispanic or Latino');
  });

  it('matches numbers into ranges', () => {
    expect(parseRange('3-5 years')).toEqual({ lo: 3, hi: 5 });
    expect(parseRange('10+ years')).toEqual({ lo: 10, hi: Infinity });
    expect(pick(['0-1 years', '1-3 years', '4-6 years', '7+ years'], '5')).toBe('4-6 years');
    expect(pick(['Under $100k', '$100,000 - $150,000', '$150k+'], '$140,000')).toBe('$100,000 - $150,000');
  });

  it('never picks a placeholder', () => {
    expect(isPlaceholderOption({ label: 'Select...', value: '' })).toBe(true);
    expect(pick(['Please select', 'Red'], 'Select')).toBeNull();
  });

  it('returns null when nothing is close', () => {
    expect(pick(['Engineering', 'Sales'], 'Underwater basket weaving')).toBeNull();
  });
});

describe('country detection', () => {
  it('finds the country a question is about', () => {
    expect(detectCountry('Are you legally authorized to work in the United States?')).toBe('United States');
    expect(detectCountry('Are you authorized to work in the UK?')).toBe('United Kingdom');
    expect(detectCountry('Can you legally work in Canada')).toBe('Canada');
    expect(detectCountry('Are you authorized to work in the country where this job is located?')).toBeNull();
  });
});
