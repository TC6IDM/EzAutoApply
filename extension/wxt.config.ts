import { defineConfig } from 'wxt';

// `npm run build:fleet` (scripts/build-fleet.mjs) builds a second copy into
// .output/fleet-chrome-mv3 for the fleet's Chrome profile, which the Fixer rebuilds and
// reloads without touching the owner's own copy (#33, docs/agent-fleet-plan.md §8.3).
// Unpacked from another folder it gets its own extension id, so its own database: import a
// backup into it once.
const fleet = process.env.EZAA_FLEET === '1';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  ...(fleet ? { outDirTemplate: 'fleet-{{browser}}-mv{{manifestVersion}}' } : {}),
  manifest: {
    name: fleet ? 'EzAutoApply (fleet)' : 'EzAutoApply',
    description: 'Autofill job applications from your profile, documents and saved answers.',
    // alarms: restarts the local bridge's long-poll after the worker was suspended (#17), only while it is on.
    // contextMenus: "Send to the EzAutoApply fleet" on a page or a link (#79).
    permissions: ['storage', 'unlimitedStorage', 'sidePanel', 'tabs', 'scripting', 'activeTab', 'alarms', 'contextMenus', 'tabGroups'],
    // <all_urls> lets the content script run on any application site and lets the
    // background reach the local classifier without CORS configuration.
    host_permissions: ['<all_urls>'],
    action: { default_title: 'EzAutoApply' },
    commands: {
      autofill: {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Autofill the application on this page',
      },
    },
  },
});
