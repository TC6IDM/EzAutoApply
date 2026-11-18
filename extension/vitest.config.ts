import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'happy-dom',
    // Fixtures copy real pages, including CAPTCHA and assessment iframes (#11): never fetch them.
    // happy-dom logs "Iframe page loading is disabled" for each; that line is expected.
    environmentOptions: { happyDOM: { settings: { disableIframePageLoading: true } } },
    include: ['tests/unit/**/*.test.ts'],
  },
});
