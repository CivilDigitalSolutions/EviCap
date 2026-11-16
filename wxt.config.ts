import { defineConfig } from 'wxt';

// EviCap — see docs/SPEC.md. Network rules (§10): the only hosts EviCap's own
// pages may contact are ExtensionPay (billing) and FreeTSA (opt-in timestamps).
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'EviCap',
    description: 'Capture and preserve web evidence for investigations.',
    author: { email: 'info@civildigital.co.uk' },
    minimum_chrome_version: '116',
    incognito: 'spanning',
    permissions: [
      'storage',
      'unlimitedStorage',
      'tabs',
      'webNavigation',
      'webRequest',
      'scripting',
      'activeTab',
      'debugger',
      'offscreen',
      'sidePanel',
      'alarms',
    ],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'EviCap' },
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://extensionpay.com https://freetsa.org",
    },
    commands: {
      'capture-visible': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Screenshot the visible area',
      },
      'capture-full': {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Screenshot the full page',
      },
      'capture-region': {
        suggested_key: { default: 'Alt+Shift+R' },
        description: 'Screenshot a region',
      },
      'toggle-recording': {
        description: 'Start or pause recording',
      },
    },
  },
});
