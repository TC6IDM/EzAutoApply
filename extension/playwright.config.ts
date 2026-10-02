import { defineConfig } from '@playwright/test';

// End-to-end tests load the built extension (.output/chrome-mv3) into Chromium.
// Run `npm run build` first, or use `npm run test:e2e`, which builds.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
});
