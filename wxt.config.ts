import { defineConfig } from 'wxt';

// EviCap — see docs/SPEC.md. Network rules (§10): EviCap contacts only
// ExtensionPay (billing), FreeTSA (opt-in timestamps) and the websites whose
// images and video the user chose to capture (re-fetching originals, D5).
// connect-src must therefore allow http(s); src/lib/net.ts is the only module
// allowed to fetch site content, and tests/network-rules.test.ts enforces it.
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
      'contextMenus',
      'tabCapture',
    ],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'EviCap' },
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https: http:",
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
      'open-media-picker': {
        suggested_key: { default: 'Alt+Shift+M' },
        description: 'Pick images and videos to capture',
      },
      'toggle-recording': {
        description: 'Start or pause recording',
      },
      'record-tab': {
        description: 'Start or stop recording this tab as video',
      },
    },
  },
});
