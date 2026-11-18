import type { Prospect } from '../src/outreach.ts';

// Made-up people only (the real file lives outside both repos).
const msgs = { note: 'Hi, I applied for the Junior Developer role.', follow_up: 'Thanks for connecting.', reason: 'A tested Python backend', reason_source: '01-candidate-profile.md' };
export const sampleProspects = (): Prospect[] => [
  { id: 'p-000000000a', status: 'found', found_at: '2026-11-18T10:00:00Z', company: 'Example Corp', name: 'Alex Sample', title: 'Technical Recruiter', source_url: 'https://example.test/team', messages: msgs },
  { id: 'p-000000000b', status: 'found', found_at: '2026-11-17T10:00:00Z', company: 'Sample Labs', name: 'Sam Example', title: 'Engineering Manager', source_url: 'https://example.test/about', messages: msgs },
  { id: 'p-000000000c', status: 'found', found_at: '2026-11-18T11:00:00Z', company: 'Waiting Co', name: 'No Draft Yet', title: 'Recruiter', source_url: 'https://example.test/x' },
  { id: 'p-000000000d', status: 'sent', found_at: '2026-11-10T10:00:00Z', sent_at: '2026-11-12T10:00:00Z', company: 'Old Co', name: 'Pat Sent', title: 'Recruiter', source_url: 'https://example.test/y', messages: msgs },
  { id: 'p-000000000e', status: 'skip', found_at: '2026-11-10T10:00:00Z', company: 'Skip Co', name: 'Skipped Person', title: 'Recruiter', source_url: 'https://example.test/z', messages: msgs },
];
