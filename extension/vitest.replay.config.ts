import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// `npm run replay` (#19): the stored incidents only, kept apart from `npm test`.
// (Not mergeConfig with vitest.config.ts: that would add these files to its `include`, not replace it.)
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'happy-dom',
    environmentOptions: { happyDOM: { settings: { disableIframePageLoading: true } } },
    include: ['tests/replay/**/*.test.ts'],
    // The report is the point: show it even when the run passes.
    silent: false,
    printConsoleTrace: false,
  },
});
