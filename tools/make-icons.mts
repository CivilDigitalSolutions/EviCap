// Draws EviCap's toolbar and store icons from the shield-and-lens mark in src/lib/brand.ts,
// by rendering it in Edge. Run: node tools/make-icons.mts
// The 128 px icon has the 16 px transparent border the Chrome Web Store asks for; the 16 and
// 32 px icons use the simple mark, without the inner lines that would blur at that size.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { MARK_ICON, markSvg } from '../src/lib/brand.ts';

const BROWSER = process.env.EVICAP_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath: BROWSER });
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
mkdirSync('public/icon', { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const pad = size === 128 ? 16 : size === 48 ? 1 : 0;
  const h = size - 2 * pad;
  const svg = markSvg(MARK_ICON, { filled: true, simple: size <= 32, size: h });
  await page.setContent(
    `<body style="margin:0;background:transparent"><div id="i" style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">${svg}</div></body>`,
  );
  await page.locator('#i').screenshot({ path: `public/icon/${size}.png`, omitBackground: true });
}
await browser.close();
console.log('Wrote public/icon/{16,32,48,128}.png');
