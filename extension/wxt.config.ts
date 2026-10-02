import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'EzAutoApply',
    description: 'Autofill job applications from your profile, documents and saved answers.',
    permissions: ['storage', 'unlimitedStorage', 'sidePanel', 'tabs', 'scripting', 'activeTab'],
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
