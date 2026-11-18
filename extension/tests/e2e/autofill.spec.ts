import { type BrowserContext, test as base, chromium, expect, type Page, type Worker } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { browser as ExtensionApi } from 'wxt/browser';

// Code passed to worker.evaluate / page.evaluate runs inside the extension, where `chrome` exists.
declare const chrome: typeof ExtensionApi;

/**
 * Loads the built extension into Chromium, imports a resume through the side
 * panel UI, then autofills a local application form (with an embedded iframe
 * and a custom dropdown) and checks what landed on the page.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(here, '..', '..', '.output', 'chrome-mv3');
const PAGES = join(here, 'pages');

type Fixtures = { context: BrowserContext; worker: Worker; extensionId: string; site: string };

let server: Server;
let site = '';

base.beforeAll(async () => {
  server = createServer((req, res) => {
    const name = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'apply.html';
    try {
      const body = readFileSync(join(PAGES, name));
      res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

base.afterAll(() => new Promise<void>((r) => server.close(() => r())));

const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  site: async ({}, use) => {
    await use(site);
  },
});

/** Ask every frame of the tab showing `url` to autofill, as the toolbar button does. */
async function autofill(worker: Worker, url: string): Promise<void> {
  await worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await chrome.tabs.sendMessage(tab.id!, { type: 'autofill' });
  }, url);
}

/** Keep tests independent of whether a Laya server happens to be running on this machine. */
async function classifierOff(panel: Page): Promise<void> {
  await panel.getByRole('tab', { name: 'Settings' }).click();
  await panel.getByLabel('Classifier', { exact: true }).selectOption('Off (rules and saved answers only)');
  // Settings save as they change; the header reads the stored setting back.
  await expect(panel.getByRole('button', { name: 'Classifier off' })).toBeVisible();
  await panel.getByRole('tab', { name: 'Apply' }).click();
}

async function importResume(panel: Page): Promise<void> {
  await panel.getByRole('tab', { name: 'Profile' }).click();
  await panel.locator('.import-card input[type=file]').setInputFiles(join(PAGES, 'resume.txt'));
  await expect(panel.getByText(/Parsed resume\.txt/)).toBeVisible();
  await expect(panel.getByLabel('First name')).toHaveValue('Jordan');
  await expect(panel.getByLabel('Email')).toHaveValue('jordan.rivera@example.com');
  // Facts a resume doesn't contain.
  await panel.getByLabel('Countries you can work in without sponsorship').fill('United States');
  await panel.getByRole('group', { name: 'Will you need visa sponsorship?' }).getByText('No', { exact: true }).click();
  await panel.getByRole('button', { name: 'Save profile' }).click();
  await expect(panel.getByText('Saved', { exact: true })).toBeVisible();
}

test('imports a resume, autofills a form across frames, and learns a new answer', async ({ context, worker, extensionId, site }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await importResume(panel);

  await classifierOff(panel);

  const form = await context.newPage();
  const url = `${site}/apply.html`;
  await form.goto(url);
  await form.bringToFront();
  await autofill(worker, url);

  await expect(form.locator('#first_name')).toHaveValue('Jordan');
  await expect(form.locator('#last_name')).toHaveValue('Rivera');
  await expect(form.locator('#phone')).toHaveValue('(555) 123-4567');
  await expect(form.locator('#country')).toHaveAttribute('data-selected', 'United States of America');
  await expect(form.locator('input[name=q_auth][value=yes]')).toBeChecked();
  await expect(form.locator('#sponsor')).toHaveValue('0');
  // Uploaded under the standardized name, not the local file name (resume.txt).
  expect(await form.locator('#resume').evaluate((el: HTMLInputElement) => el.files?.[0]?.name)).toBe('Jordan_Rivera_Resume.txt');

  const frame = form.frameLocator('iframe');
  await expect(frame.locator('#email')).toHaveValue('jordan.rivera@example.com');
  await expect(frame.locator('#gh')).toHaveValue('https://github.com/jrivera');
  await expect(frame.locator('#years')).toHaveValue('5+');

  // The open-ended question is left empty for the user, and nothing is drawn around the fields.
  await expect(form.locator('#why')).toHaveValue('');
  await expect(form.locator('[data-ezaa-status]')).toHaveCount(0);
  expect(await form.evaluate(() => document.body.dataset.submitted)).toBeUndefined();

  // Answer it the way the side panel does, and remember it.
  const fieldId = await form.locator('#why').getAttribute('data-ezaa-id');
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id!, url);
  const out = await panel.evaluate(
    ([tabId, fieldId]) =>
      chrome.runtime.sendMessage({
        type: 'answerField',
        tabId,
        frameId: 0,
        fieldId,
        answer: 'I like what Initech is building.',
        save: { question: 'Why do you want to work at Initech? *', fieldKind: 'textarea', scope: 'global' },
      }),
    [tabId, fieldId] as const,
  );
  expect(out).toMatchObject({ ok: true });
  await expect(form.locator('#why')).toHaveValue('I like what Initech is building.');

  // Next time, the saved answer fills it automatically.
  await form.reload();
  await autofill(worker, url);
  await expect(form.locator('#why')).toHaveValue('I like what Initech is building.');
});

test('the side panel lists what needs an answer', async ({ context, worker, extensionId, site }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await importResume(panel);
  await classifierOff(panel);

  const form = await context.newPage();
  const url = `${site}/apply.html`;
  await form.goto(url);
  await autofill(worker, url);
  await expect(form.locator('#first_name')).toHaveValue('Jordan');

  // Each frame reports separately (the first to finish answers the autofill message), so wait for both.
  type Report = { frameId: number; fields: { label: string; status: string }[] };
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id!, url);
  const reports = async (): Promise<Report[]> =>
    (await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'getTabState', tabId: id }), tabId)).reports;
  await expect.poll(async () => (await reports()).length).toBe(2); // top page + iframe

  const fields = (await reports()).flatMap((r) => r.fields);
  expect(fields.find((f) => f.label.startsWith('Why do you want'))).toMatchObject({ status: 'needs' });
  expect(fields.find((f) => f.label === 'Email address')).toMatchObject({ status: 'filled' });
  expect(fields.find((f) => f.label === 'Country')).toMatchObject({ status: 'filled' });
});

test('sorts a dropped document by type and uploads it under a standard name', async ({ context, worker, extensionId, site }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await importResume(panel);
  await classifierOff(panel);

  // Drop a cover letter whose file name gives no hint; its wording should identify it.
  await panel.getByRole('tab', { name: 'Documents' }).click();
  const drop = await panel.evaluateHandle(() => {
    const dt = new DataTransfer();
    const text = ['Dear Hiring Manager,', 'I am writing to apply for the Software Engineer role.', 'Sincerely,', 'Jordan Rivera'].join('\n');
    dt.items.add(new File([text], 'acme-application.txt', { type: 'text/plain' }));
    return dt;
  });
  await panel.locator('.drop-main').dispatchEvent('drop', { dataTransfer: drop });
  await expect(panel.getByText('acme-application.txt added to Cover letters')).toBeVisible();
  const coverLetters = panel.locator('details', { hasText: 'Cover letters' });
  await expect(coverLetters.getByText('Jordan_Rivera_Cover_Letter.txt')).toBeVisible();
  await expect(panel.getByText('Jordan_Rivera_Resume.txt')).toBeVisible();

  const form = await context.newPage();
  const url = `${site}/apply.html`;
  await form.goto(url);
  await autofill(worker, url);
  const uploaded = (sel: string) => form.locator(sel).evaluate((el: HTMLInputElement) => el.files?.[0]?.name ?? null);
  await expect.poll(() => uploaded('#cover_letter')).toBe('Jordan_Rivera_Cover_Letter.txt');
  expect(await uploaded('#resume')).toBe('Jordan_Rivera_Resume.txt');
});

test('adds a LinkedIn data export to a profile imported from a resume', async ({ context, extensionId }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await importResume(panel);

  const zip = zipSync({
    'Positions.csv': strToU8(
      [
        'Company Name,Title,Description,Location,Started On,Finished On',
        'Acme Corp,Software Engineer,Owns the billing pipeline,"Austin, Texas",Jun 2021,',
        'Initech,Junior Developer,,Remote,Jan 2019,Apr 2020',
      ].join('\n'),
    ),
    'Skills.csv': strToU8('Name\nTypeScript\nGo\n'),
  });
  // Dropped onto the LinkedIn section, as from the file explorer.
  const drop = await panel.evaluateHandle((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'Basic_LinkedInDataExport.zip', { type: 'application/zip' }));
    return dt;
  }, [...zip]);
  await panel.locator('.linkedin-import').dispatchEvent('drop', { dataTransfer: drop });
  await expect(panel.getByText(/Imported your LinkedIn data export: 2 jobs, 2 skills\./)).toBeVisible();

  // The resume's jobs stay as they were; the job only LinkedIn knows about is added.
  await expect(panel.locator('summary', { hasText: 'Work experience' })).toContainText('3');
  await expect(panel.getByLabel('Job title').nth(0)).toHaveValue('Software Engineer');
  await expect(panel.getByLabel('Job title').nth(2)).toHaveValue('Junior Developer');
  await expect(panel.getByLabel('Skills', { exact: true })).toHaveValue('TypeScript, Python, React, PostgreSQL, Go');
  await panel.getByRole('button', { name: 'Save profile' }).click();
  await expect(panel.getByText('Saved', { exact: true })).toBeVisible();
});

test('fills a Workday-style application: account, dropdowns, work history, resume, and asks about the rest', async ({ context, worker, extensionId, site }) => {
  test.setTimeout(120_000);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await importResume(panel);
  await classifierOff(panel);
  await panel.getByRole('tab', { name: 'Profile' }).click();

  // Profile extras: how you usually hear about jobs, and the job-site account password.
  await panel.locator('summary', { hasText: 'Job preferences' }).click();
  await panel.getByLabel('How you usually find jobs').fill('LinkedIn');
  await panel.getByRole('button', { name: 'Save profile' }).click();
  await expect(panel.getByText('Saved', { exact: true })).toBeVisible();
  await panel.locator('summary', { hasText: 'Job site accounts' }).click();
  await panel.getByLabel('Password', { exact: true }).fill('Tr0ub4dor&3xyz');
  // The test page is on 127.0.0.1, not a known job site, so allow it explicitly.
  await panel.getByLabel(/Also fill it on sites that aren/).check();
  // The password is saved with the profile.
  await panel.getByRole('button', { name: 'Save profile' }).click();
  await expect(panel.getByText('Saved', { exact: true })).toBeVisible();

  const form = await context.newPage();
  const url = `${site}/workday.html`;
  await form.goto(url);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id!, url);
  type Progress = { filled: number; remaining: number } | null;
  const progress = async (): Promise<Progress> =>
    (await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'getTabState', tabId: id }), tabId)).progress;
  const filling = autofill(worker, url);
  // While it works, the panel can say how many fields are filled so far and how many are still to go.
  await expect.poll(async () => {
    const p = await progress();
    return !!p && p.filled > 0 && p.remaining > 0;
  }).toBe(true);
  await filling;
  await expect.poll(progress).toBeNull();

  // Account creation.
  await expect(form.locator('#email')).toHaveValue('jordan.rivera@example.com');
  await expect(form.locator('#password')).toHaveValue('Tr0ub4dor&3xyz');
  await expect(form.locator('#verify')).toHaveValue('Tr0ub4dor&3xyz');
  await expect(form.locator('#first')).toHaveValue('Jordan');
  await expect(form.locator('#last')).toHaveValue('Rivera');

  // Dropdowns that need mousedown to open, Enter to select, type-ahead, and Enter-to-search.
  const selectText = (label: string) => form.locator(`[data-label="${label}"] button`);
  await expect(selectText('Phone Device Type*')).toHaveText('Mobile');
  await expect(selectText('Province or Territory*')).toHaveText('Texas');
  await expect(form.locator('#heard .pill')).toHaveText('LinkedIn');

  // "Add Another" was clicked once for the second job; both are filled, most recent first.
  await expect(form.locator('#jobs .job')).toHaveCount(2);
  await expect(form.locator('#title1')).toHaveValue('Software Engineer');
  await expect(form.locator('#company1')).toHaveValue('Acme Corp');
  await expect(form.locator('#jobs .job').nth(0).locator('.current')).toBeChecked();
  const date = (job: number, which: string, part: string) =>
    form.locator('#jobs .job').nth(job).locator(`[data-automation-id="formField-${which}"] [aria-label="${part}"]`);
  await expect(date(0, 'startDate', 'Month')).toHaveValue('06');
  await expect(date(0, 'startDate', 'Year')).toHaveValue('2021');
  await expect(form.locator('#jobs .job').nth(0).locator('[data-automation-id="formField-endDate"]')).toHaveCount(0);
  await expect(form.locator('#title2')).toHaveValue('Software Engineering Intern');
  await expect(date(1, 'startDate', 'Month')).toHaveValue('05');
  await expect(date(1, 'endDate', 'Month')).toHaveValue('08');
  await expect(date(1, 'endDate', 'Year')).toHaveValue('2020');

  // The resume box ignores its input, so the file is dropped on it, under its standard name.
  await expect(form.locator('#uploaded')).toHaveText('Jordan_Rivera_Resume.txt');

  // Nothing that moves the application forward was clicked.
  expect(await form.evaluate(() => document.body.dataset.submitted)).toBeUndefined();

  // The unanswered screening question is listed with its options, and left untouched.
  type Field = { id: string; frameId: number; label: string; status: string; options: string[] };
  const fields = async (): Promise<Field[]> =>
    (await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'getTabState', tabId: id }), tabId)).reports.flatMap(
      (r: { fields: Field[] }) => r.fields,
    );
  await expect.poll(async () => (await fields()).find((f) => f.label.startsWith('Please select your age'))?.options).toEqual([
    'Under 18',
    '18 and over',
  ]);
  const age = (await fields()).find((f) => f.label.startsWith('Please select your age'))!;
  expect(age.status).toBe('needs');
  await expect(selectText('Please select your age category:*')).toHaveText('Select One');
  await expect(form.locator('[data-label="Please select your age category:*"] ul')).toBeHidden();

  // Answer it once from the panel; it's remembered and filled automatically next time.
  const out = await panel.evaluate(
    ([tabId, fieldId]) =>
      chrome.runtime.sendMessage({
        type: 'answerField',
        tabId,
        frameId: 0,
        fieldId,
        answer: '18 and over',
        save: { question: 'Please select your age category:*', fieldKind: 'combobox', options: ['Under 18', '18 and over'], scope: 'global' },
      }),
    [tabId, age.id] as const,
  );
  expect(out).toMatchObject({ ok: true });
  await expect(selectText('Please select your age category:*')).toHaveText('18 and over');

  await form.reload();
  await autofill(worker, url);
  await expect(selectText('Please select your age category:*')).toHaveText('18 and over');
});

test('fills Workday’s education prompts, year-only dates and skills, then Advance presses Save and Continue', async ({ context, worker, extensionId, site }) => {
  test.setTimeout(120_000);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await importResume(panel);
  await classifierOff(panel);

  const form = await context.newPage();
  const url = `${site}/workday-experience.html`;
  await form.goto(url);
  await autofill(worker, url);

  const pills = (field: string) => form.locator(`[data-automation-id="formField-${field}"] [data-automation-id="selectedItem"]`);
  await expect(pills('school')).toHaveText(['University of Texas at Austin']);
  await expect(form.locator('#education-7--degree')).toHaveText("Bachelor's Degree");
  await expect(pills('fieldOfStudy')).toHaveText(['Computer Science']);
  await expect(form.locator('#education-7--firstYearAttended-dateSectionYear-input')).toHaveValue('2017');
  await expect(form.locator('#education-7--lastYearAttended-dateSectionYear-input')).toHaveValue('2021');
  await expect(pills('skills')).toHaveText(['TypeScript', 'Python', 'React', 'PostgreSQL']);
  // Search text isn't left behind in the prompts.
  await expect(form.locator('#education-7--school')).toHaveValue('');

  // Autofill never advances; the Advance button does, when pressed.
  expect(await form.evaluate(() => document.body.dataset.advanced)).toBeUndefined();
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id!, url);
  expect(await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'findAdvance', tabId: id }), tabId)).toMatchObject({
    frameId: 0,
    label: 'Save and Continue',
    kind: 'next',
  });
  // The panel follows the active tab, so put the application in front.
  await form.bringToFront();
  await panel.getByRole('button', { name: 'Advance: Save and Continue' }).click();
  await expect.poll(() => form.evaluate(() => document.body.dataset.advanced)).toBe('yes');
});

test('run mode reads a one-form application’s last "Apply" as Submit, and nothing is sent (#10)', async ({ context, worker, extensionId, site }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const form = await context.newPage();
  const url = `${site}/multistep.html`;
  await form.goto(url);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id!, url);
  const find = (run: boolean) => panel.evaluate(([id, r]) => chrome.runtime.sendMessage({ type: 'findAdvance', tabId: id, run: r }), [tabId, run] as const);
  const press = () => panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'advance', tabId: id, frameId: 0 }), tabId);

  await form.fill('#first', 'Sam');
  await form.fill('#email', 'sam@example.com');
  expect(await find(true)).toMatchObject({ label: 'Next', kind: 'next' });
  await press();
  await expect.poll(() => form.evaluate(() => document.body.dataset.step)).toBe('2');

  await form.fill('#years', '1');
  expect(await find(true)).toMatchObject({ label: 'Continue', kind: 'next' });
  await press();
  await expect.poll(() => form.evaluate(() => document.body.dataset.step)).toBe('3');

  // The last step: run mode says Submit (with why), the manual Advance button still says Apply.
  const last = await find(true);
  expect(last).toMatchObject({ label: 'Apply', kind: 'submit' });
  expect((last as { why?: string }).why).toMatch(/sends the application|submits this form/);
  expect(await find(false)).toMatchObject({ label: 'Apply', kind: 'start' });
  expect(await form.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
});

test('Run fills every step, presses Next and Continue, and stops at "Apply" without pressing it (#9)', async ({ context, worker, extensionId, site }) => {
  test.setTimeout(90_000);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await importResume(panel);
  await classifierOff(panel);
  const form = await context.newPage();
  const url = `${site}/multistep.html`;
  await form.goto(url);
  // Step 2's one question isn't in the profile: answered here, as a saved answer would.
  await form.evaluate(() => ((document.getElementById('years') as HTMLInputElement).value = '1'));
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id!, url);
  type Run = { status: string; page: number; stop?: { reason: string; detail?: string }; history: { page: number; pressed?: string }[] };
  const getRun = () => panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'getRun', tabId: id }), tabId) as Promise<Run | null>;

  await form.bringToFront();
  await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'startRun', tabId: id }), tabId);
  await expect.poll(async () => (await getRun())?.status, { timeout: 60_000 }).toBe('stopped');
  const run = (await getRun())!;
  expect(run.stop).toMatchObject({ reason: 'submitReady' });
  expect(run.stop?.detail).toMatch(/^"Apply"/);
  expect(run.history.map((h) => h.pressed)).toEqual(['Next', 'Continue', undefined]);
  expect(await form.evaluate(() => document.body.dataset.step)).toBe('3');
  expect(await form.inputValue('#first')).toBe('Jordan');
  expect(await form.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
});

test('the panel\'s Run button runs to Submit and says what to do next (#13)', async ({ context, extensionId, site }) => {
  test.setTimeout(90_000);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await importResume(panel);
  await classifierOff(panel);
  const form = await context.newPage();
  await form.goto(`${site}/multistep.html`);
  await form.evaluate(() => ((document.getElementById('years') as HTMLInputElement).value = '1'));
  // The panel follows the active tab.
  await form.bringToFront();
  await panel.getByRole('button', { name: 'Run to Submit', exact: true }).click();
  const stop = panel.locator('.run-stop');
  await expect(stop).toContainText('Ready to submit', { timeout: 60_000 });
  await expect(stop).toContainText('press its Submit button yourself');
  await expect(stop).toContainText('3 pages · pressed “Next”, “Continue”');
  await expect(panel.getByRole('button', { name: 'Run to Submit again' })).toBeEnabled();
  expect(await form.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
});

test('an agent queues a job and asks the bridge for a Run; the extension runs it and reports back (#17)', async ({ context, worker, extensionId, site }) => {
  test.setTimeout(120_000);
  // The real bridge (bridge/src/main.ts) on its own port, with a throwaway home and queue.
  const home = mkdtempSync(join(tmpdir(), 'ezaa-e2e-bridge-'));
  const port = 8197;
  const proc = spawn(process.execPath, [join(here, '..', '..', '..', 'bridge', 'src', 'main.ts')], {
    env: { ...process.env, EZAA_HOME: home, EZAA_QUEUE_FILE: join(home, 'queue.jsonl'), EZAA_BRIDGE_PORT: String(port) },
    stdio: 'ignore',
  });
  try {
    const bridgeUrl = `http://127.0.0.1:${port}`;
    await expect.poll(() => fetch(`${bridgeUrl}/health`).then((r) => r.ok).catch(() => false), { timeout: 15_000 }).toBe(true);
    const token = readFileSync(join(home, 'bridge-token'), 'utf8').trim();
    const api = (method: string, path: string, body?: unknown) =>
      fetch(bridgeUrl + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await importResume(panel);
    await classifierOff(panel);
    await panel.getByRole('tab', { name: 'Settings' }).click();
    await panel.getByText('Agent fleet bridge').click();
    await panel.getByLabel('Connect to the local bridge').check();
    await panel.getByLabel('Bridge address').fill(bridgeUrl);
    await panel.getByLabel('Bridge address').blur();
    await panel.getByLabel('Bridge token').fill(token);
    await panel.getByLabel('Bridge token').blur();
    await expect(panel.getByText('The bridge is running.')).toBeVisible();

    const url = `${site}/multistep.html`;
    const form = await context.newPage();
    await form.goto(url);
    await form.evaluate(() => ((document.getElementById('years') as HTMLInputElement).value = '1'));
    await form.bringToFront();

    // What an applier agent does: queue the job, claim it, ask for a Run, then watch its status.
    expect((await api('POST', '/queue', { jobs: [{ id: 'job-1', applyUrl: url, company: 'Example Co.' }] })).status).toBe(201);
    expect((await (await api('GET', '/queue/next?worker=w1')).json()).id).toBe('job-1');
    expect((await api('POST', '/run', { jobId: 'job-1' })).status).toBe(202);
    const status = async () => {
      const r = await api('GET', '/tabs/job-1/status');
      return r.ok ? ((await r.json()) as { run: { status: string; stop?: { reason: string } }; fields: { label: string }[] }) : null;
    };
    await expect.poll(async () => (await status())?.run.stop?.reason, { timeout: 60_000 }).toBe('submitReady');
    const queue = (await (await api('GET', '/queue')).json()) as { id: string; status: string }[];
    expect(queue.find((j) => j.id === 'job-1')?.status).toBe('ready');
    expect((await status())?.fields.length).toBeGreaterThan(0);
    expect(await form.evaluate(() => document.body.dataset.submitted)).toBeUndefined();

    // #29: the owner submits (here: the site shows its thank-you page), and the job is marked submitted.
    const ready = (await (await api('GET', '/ready')).json()) as { id: string; title?: string; company?: string }[];
    expect(ready.map((j) => [j.id, j.company])).toEqual([['job-1', 'Example Co.']]);
    await form.evaluate(() => {
      document.body.innerHTML = '<h1>Thank you for applying</h1><p>We received your application.</p>';
      history.pushState({}, '', '/thanks');
    });
    await expect
      .poll(async () => ((await (await api('GET', '/queue')).json()) as { id: string; status: string }[]).find((j) => j.id === 'job-1')?.status, { timeout: 20_000 })
      .toBe('submitted');

    // #18: a field it couldn't fill becomes an incident in the bridge's folder, with no profile value in it.
    const apply = `${site}/apply.html`;
    await form.goto(apply);
    await autofill(worker, apply);
    const dir = join(home, 'incidents');
    const incidents = (): { kind: string; ats: string; url: string; field?: { id: string; frameId: number; label: string } }[] => {
      try {
        return readdirSync(dir, { recursive: true })
          .map(String)
          .filter((name) => name.endsWith('.json'))
          .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
      } catch {
        return [];
      }
    };
    await expect.poll(() => incidents().find((i) => i.field?.label.startsWith('Why do you want'))?.kind, { timeout: 30_000 }).toBe('unmatched');
    const written = JSON.stringify(incidents()).toLowerCase();
    for (const value of ['jordan', 'rivera', 'example.com', '123-4567', 'jrivera', 'acme corp']) expect(written, value).not.toContain(value);

    // #21: an agent answers that field and saves it; the owner approves it in Answers.
    const why = incidents().find((i) => i.field?.label.startsWith('Why do you want'))!.field!;
    const answer = { jobId: 'job-1', fieldId: why.id, frameId: why.frameId, answer: 'The work on TPS reports.', save: { scope: 'global', createdBy: 'answerer' } };
    expect((await api('POST', '/answers', answer)).status).toBe(202);
    await expect(form.locator('#why')).toHaveValue('The work on TPS reports.', { timeout: 30_000 });
    await panel.bringToFront();
    await panel.getByRole('tab', { name: 'Answers' }).click();
    await expect(panel.getByText('1 answer from an agent or an import waits')).toBeVisible();
    await expect(panel.getByText('From an agent (answerer)')).toBeVisible();
    await panel.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(panel.getByText('1 answer from an agent or an import waits')).toBeHidden();
  } finally {
    proc.kill();
  }
});

test('with Laya running: rules fill instantly, then leftovers go to the classifier', async ({ context, worker, extensionId, site }) => {
  const laya = await fetch('http://127.0.0.1:8000/health').then((r) => r.ok).catch(() => false);
  test.skip(!laya, 'needs a Laya server on 127.0.0.1:8000 (classifier\start.ps1)');
  test.setTimeout(120_000);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await importResume(panel);

  const form = await context.newPage();
  const url = `${site}/apply.html`;
  await form.goto(url);
  const started = Date.now();
  // Don't wait for the message to resolve: the point is that fields appear before the classifier is done.
  void autofill(worker, url).catch(() => {});
  await expect(form.locator('#first_name')).toHaveValue('Jordan', { timeout: 3000 });
  expect(Date.now() - started).toBeLessThan(3000);

  type Report = { classifierError?: string; fields: { label: string; status: string }[] };
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id!, url);
  const top = async (): Promise<Report | undefined> =>
    (await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'getTabState', tabId: id }), tabId)).reports.find(
      (r: Report) => r.fields.some((f) => f.label.startsWith('Why do you want')),
    );
  // The open-ended question still ends up asking the user, and the classifier ran without errors.
  await expect.poll(async () => (await top())?.fields.find((f) => f.label.startsWith('Why do you want'))?.status, { timeout: 60_000 }).toBe('needs');
  expect((await top())?.classifierError).toBeUndefined();
});

test('with Laya running: dropdown options reach the panel before Laya starts', async ({ context, worker, extensionId, site }) => {
  const laya = await fetch('http://127.0.0.1:8000/health').then((r) => r.ok).catch(() => false);
  test.skip(!laya, 'needs a Laya server on 127.0.0.1:8000 (classifier\start.ps1)');
  test.setTimeout(180_000);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await importResume(panel);

  const form = await context.newPage();
  const url = `${site}/workday.html`;
  await form.goto(url);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id!, url);

  // Record every state the panel sees while autofill runs.
  await panel.evaluate((id) => {
    (window as unknown as { seen: unknown[] }).seen = [];
    chrome.runtime.onMessage.addListener((msg: { type: string; tabId: number }) => {
      if (msg.type !== 'tabStateChanged' || msg.tabId !== id) return;
      chrome.runtime
        .sendMessage({ type: 'getTabState', tabId: id })
        .then((s) => (window as unknown as { seen: unknown[] }).seen.push(s));
    });
  }, tabId);
  await autofill(worker, url);

  type Snapshot = { reports: { pending?: string; fields: { label: string; options: string[] }[] }[] };
  const seen = async () => (await panel.evaluate(() => (window as unknown as { seen: Snapshot[] }).seen)) as Snapshot[];
  const ageOptions = (s: Snapshot) => s.reports.flatMap((r) => r.fields).find((f) => f.label.startsWith('Please select your age'))?.options ?? [];
  // While Laya was still working, the panel already had the age question's options...
  await expect.poll(async () => (await seen()).some((s) => s.reports.some((r) => r.pending) && ageOptions(s).length === 2), { timeout: 120_000 }).toBe(true);
  // ...and the final state has no pending work.
  await expect.poll(async () => { const all = await seen(); return all.length > 0 && !all[all.length - 1].reports.some((r) => r.pending); }, { timeout: 120_000 }).toBe(true);
});
