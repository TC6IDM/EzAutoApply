import { type BrowserContext, test as base, chromium, expect, type Page, type Worker } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  await panel.getByRole('button', { name: 'Save settings' }).click();
  await panel.getByRole('tab', { name: 'Apply' }).click();
}

async function importResume(panel: Page): Promise<void> {
  await panel.getByRole('tab', { name: 'Profile' }).click();
  await panel.locator('input[type=file]').setInputFiles(join(PAGES, 'resume.txt'));
  await expect(panel.getByText(/Parsed resume\.txt/)).toBeVisible();
  await expect(panel.getByLabel('First name')).toHaveValue('Jordan');
  await expect(panel.getByLabel('Email')).toHaveValue('jordan.rivera@example.com');
  // Facts a resume doesn't contain.
  await panel.getByLabel('Countries you can work in without sponsorship').fill('United States');
  await panel.getByRole('group', { name: 'Will you need visa sponsorship?' }).getByText('No', { exact: true }).click();
  await panel.getByRole('button', { name: 'Save profile' }).click();
  await expect(panel.getByText('Saved ✓')).toBeVisible();
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

  // The open-ended question is outlined for the user and left empty.
  await expect(form.locator('#why')).toHaveValue('');
  await expect(form.locator('#why')).toHaveAttribute('data-ezaa-status', 'needs');
  await expect(form.locator('#first_name')).toHaveAttribute('data-ezaa-status', 'filled');
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
  await expect(form.locator('#why')).toHaveAttribute('data-ezaa-status', 'filled');
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
  await expect(panel.getByText('acme-application.txt → cover letter')).toBeVisible();
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
  await expect(panel.getByText('Saved ✓').first()).toBeVisible();
  await panel.locator('summary', { hasText: 'Job site accounts' }).click();
  await panel.getByLabel('Password', { exact: true }).fill('Tr0ub4dor&3xyz');
  // The test page is on 127.0.0.1, not a known job site, so allow it explicitly.
  await panel.getByLabel(/Also fill it on sites that aren/).check();
  await panel.getByRole('button', { name: 'Save password' }).click();

  const form = await context.newPage();
  const url = `${site}/workday.html`;
  await form.goto(url);
  await autofill(worker, url);

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
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id!, url);
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
