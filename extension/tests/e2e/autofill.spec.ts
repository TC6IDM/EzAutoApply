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

  // Turn the classifier off so this test doesn't depend on Laya running.
  await panel.getByRole('tab', { name: 'Settings' }).click();
  await panel.getByLabel('Classifier', { exact: true }).selectOption('Off (rules and saved answers only)');
  await panel.getByRole('button', { name: 'Save settings' }).click();

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
  expect(await form.locator('#resume').evaluate((el: HTMLInputElement) => el.files?.[0]?.name)).toBe('resume.txt');

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
