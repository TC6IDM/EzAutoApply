import { describe, expect, it } from 'vitest';
import { ownJob, postingAddress, readTitle } from '../../src/bridge/ownJob';

describe('postings the owner sends to the fleet (#79)', () => {
  it('LinkedIn: one address per job, from a posting, a search or a collection', () => {
    const view = 'https://www.linkedin.com/jobs/view/4012345678/';
    expect(postingAddress('https://www.linkedin.com/jobs/view/4012345678/?refId=abc&trackingId=x%3D%3D&trk=flagship')).toBe(view);
    expect(postingAddress('https://ca.linkedin.com/jobs/view/software-engineer-at-acme-4012345678')).toBe(view);
    expect(postingAddress('https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=engineer')).toBe(view);
    expect(postingAddress('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4012345678')).toBe(view);
  });

  it('a LinkedIn page that shows no job is not a posting', () => {
    expect(postingAddress('https://www.linkedin.com/feed/')).toBeNull();
    expect(postingAddress('https://www.linkedin.com/jobs/search/?keywords=engineer')).toBeNull();
    expect(ownJob('https://www.linkedin.com/in/someone/')).toBeNull();
  });

  it('other sites keep their address, without trackers or the fragment', () => {
    expect(postingAddress('https://Jobs.Lever.co/acme/1a2b3c4d-0000-4000-8000-000000000000?lever-source=LinkedIn#top')).toBe(
      'https://jobs.lever.co/acme/1a2b3c4d-0000-4000-8000-000000000000',
    );
    expect(postingAddress('https://acme.com/careers?gh_jid=123&utm_source=x')).toBe('https://acme.com/careers?gh_jid=123');
    expect(postingAddress('chrome://extensions')).toBeNull();
    expect(postingAddress('not a url')).toBeNull();
  });

  it('the job: first in line, from the owner, with a stable id', () => {
    const job = ownJob('https://www.linkedin.com/jobs/view/4012345678/?trk=x', '(3) Software Engineer | Acme | LinkedIn');
    expect(job).toEqual({
      id: 'own-li-4012345678',
      applyUrl: 'https://www.linkedin.com/jobs/view/4012345678/',
      listingUrl: 'https://www.linkedin.com/jobs/view/4012345678/',
      source: 'owner',
      tier: 'A',
      title: 'Software Engineer',
      company: 'Acme',
    });
    const a = ownJob('https://jobs.ashbyhq.com/acme/abc?utm_source=x', 'Engineer @ Acme');
    const b = ownJob('https://jobs.ashbyhq.com/acme/abc');
    expect(a?.id).toMatch(/^own-[0-9a-f]{12}$/);
    expect(a?.id).toBe(b?.id);
    expect(a?.title).toBe('Engineer @ Acme');
  });

  it('reads LinkedIn tab titles', () => {
    expect(readTitle('Acme hiring Data Analyst in Toronto, ON | LinkedIn', true)).toEqual({ company: 'Acme', title: 'Data Analyst', location: 'Toronto, ON' });
    expect(readTitle('Jobs | LinkedIn', true)).toEqual({});
    expect(readTitle('', true)).toEqual({});
  });
});
