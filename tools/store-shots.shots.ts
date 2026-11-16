import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { afterAll, beforeAll, it } from 'vitest';
import { testLicenceKey } from '../tests/e2e/licence';
import { BRAND, MARK_ON_DARK, markSvg } from '../src/lib/brand';
import type { AuditEvent, CaptureRecord } from '../src/lib/types';

/**
 * Makes the Chrome Web Store screenshots (1280×800) and promo tiles in store/.
 * Run with `npm run store:shots`. Everything shown is made up: a fictional shop on a
 * .example domain served from this script, a fictional council and a fictional officer.
 */

const EXT = resolve('.output/chrome-mv3-e2e');
const OUT = resolve('store');
const BROWSER = process.env.EVICAP_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SHOP = 'http://harbourline-deals.example';
const REG = 'http://company-lookup.example';

let server: Server;
let ctx: BrowserContext;
let sw: Worker;
let dash: Page;
let extId = '';
let profile = '';
let work = '';
let caseId = '';

// ---------- The fictional site ----------

const CHARGER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#f3f5f8"/><rect x="120" y="110" width="160" height="190" rx="18" fill="#fdfdfd" stroke="#c9d0da" stroke-width="4"/><rect x="160" y="60" width="16" height="60" fill="#9aa4b2"/><rect x="224" y="60" width="16" height="60" fill="#9aa4b2"/><rect x="170" y="250" width="60" height="14" rx="3" fill="#2b2f36"/><text x="200" y="200" font-family="Arial" font-size="30" font-weight="700" text-anchor="middle" fill="#2b2f36">65W</text><text x="200" y="228" font-family="Arial" font-size="15" text-anchor="middle" fill="#6b7480">FAST CHARGE</text></svg>`;

const shopPage = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} | Harbourline Deals</title>
<style>
html{background:#fff}body{margin:0;min-height:100vh;font-family:"Segoe UI",Arial,sans-serif;color:#222;background:#fff}
header{background:#0f3d3e;color:#fff;padding:14px 28px;display:flex;align-items:center;gap:24px}
header b{font-size:22px;letter-spacing:.02em}header input{flex:1;max-width:420px;padding:8px 10px;border:0;border-radius:3px;font:inherit}
nav{background:#e7efef;padding:8px 28px;font-size:14px;color:#0f3d3e}nav span{margin-right:22px}
main{padding:22px 28px;max-width:1100px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}.card{border:1px solid #dde3ea;border-radius:4px;padding:10px;font-size:14px}
.card img{width:100%;display:block}.price{color:#b3261e;font-weight:700;font-size:20px}.muted{color:#69717d}
.product{display:grid;grid-template-columns:380px 1fr;gap:30px}.btn{background:#f2a516;border:0;padding:12px 26px;font-weight:600;font-size:15px;border-radius:3px}
.badge{display:inline-block;border:1px solid #2e7d32;color:#2e7d32;padding:2px 8px;font-size:13px;border-radius:3px;margin-right:6px}
.review{border-top:1px solid #e3e7ec;padding:14px 0}.stars{color:#f2a516}
table{border-collapse:collapse}td{padding:4px 18px 4px 0;font-size:14px}
</style></head><body><header><b>Harbourline Deals</b><input value="fast charger"><span>Basket (0)</span></header>
<nav><span>Phones &amp; accessories</span><span>Chargers</span><span>Cables</span><span>Power banks</span><span>Clearance</span></nav><main>${body}</main></body></html>`;

const card = (name: string, price: string, n: number) =>
  `<div class="card"><img src="/img/charger.svg" alt=""><div>${name}</div><div class="price">${price}</div><div class="muted">${n} sold</div></div>`;

const PAGES: Record<string, () => string> = {
  [`${SHOP}/`]: () =>
    shopPage('Everyday electronics for less', `<h1>Everyday electronics for less</h1><p class="muted">Free delivery on orders over £10.</p><div class="grid">${card('HX 65W GaN fast charger', '£8.99', 4812)}${card('Dual USB-C wall plug', '£5.49', 2290)}${card('3-in-1 charging cable', '£2.99', 9120)}${card('20000mAh power bank', '£11.99', 1630)}</div>`),
  [`${SHOP}/search?q=fast+charger`]: () =>
    shopPage('Search: fast charger', `<h2>142 results for "fast charger"</h2><div class="grid">${card('HX 65W GaN fast charger', '£8.99', 4812)}${card('HX 45W PD charger', '£6.99', 3011)}${card('Turbo 100W desk charger', '£12.49', 877)}${card('Mini 30W travel adapter', '£4.29', 5402)}</div>`),
  [`${SHOP}/listing/hx-65w-gan-charger`]: () =>
    shopPage(
      'HX 65W GaN fast charger',
      `<div class="product"><img src="/img/charger.svg" alt="HX 65W GaN fast charger" width="380" height="380"><div>
<h1 style="margin-top:0">HX 65W GaN Fast Charger, UK Plug, USB-C PD</h1><div class="price">£8.99</div><p class="muted">RRP £34.99 · 4,812 sold · Sold by <a href="/go/voltking">VoltKing Direct</a></p>
<p><span class="badge">CE certified</span><span class="badge">Safety tested</span><span class="badge">Fireproof shell</span></p>
<ul><li>Charges laptops, tablets and phones at up to 65W</li><li>Universal 100–240V input</li><li>Ships within 24 hours from our overseas warehouse</li></ul>
<button class="btn">Add to basket</button><p class="muted" style="margin-top:18px">Model HX-65G · Importer details not provided</p></div></div>`,
    ),
  [`${SHOP}/listing/hx-65w-gan-charger/reviews`]: () =>
    shopPage(
      'Reviews: HX 65W GaN fast charger',
      `<h2>Customer reviews (318)</h2>${[
        ['★★☆☆☆', 'Gets very hot after 20 minutes of charging my laptop. Unplugged it to be safe.'],
        ['★☆☆☆☆', 'Plug pins came loose in the socket. Plastic smelled of burning.'],
        ['★★★★★', 'Fast delivery, works fine with my phone.'],
        ['★☆☆☆☆', 'Sparked when I plugged it in. Do not buy.'],
        ['★★★☆☆', 'Cheap and does the job, but the case is very thin.'],
        ['★★☆☆☆', 'No instructions or safety leaflet in the box.'],
        ['★☆☆☆☆', 'Stopped working after three days and the casing has melted.'],
        ['★★★★☆', 'Good value for money.'],
      ]
        .map(([s, t], i) => `<div class="review"><span class="stars">${s}</span> <b>Verified buyer ${i + 1}</b><p>${t}</p></div>`)
        .join('')}`,
    ),
  [`${SHOP}/seller/voltking-direct`]: () =>
    shopPage(
      'VoltKing Direct',
      `<h1>VoltKing Direct</h1><p class="muted">Member since March 2025 · 96% positive · 12,406 sales</p><table><tr><td>Business name</td><td>VoltKing Trading Ltd</td></tr><tr><td>Address</td><td>Not provided</td></tr><tr><td>Returns</td><td>Within 7 days, buyer pays return postage</td></tr><tr><td>Ships from</td><td>Overseas warehouse</td></tr></table><h3>Other items from this seller</h3><div class="grid">${card('HX 65W GaN fast charger', '£8.99', 4812)}${card('HX 45W PD charger', '£6.99', 3011)}${card('Travel adapter set', '£7.49', 1950)}${card('Wireless charging pad', '£5.99', 640)}</div>`,
    ),
  [`${REG}/company/voltking-trading-ltd`]: () =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>VoltKing Trading Ltd | Company lookup</title><style>body{margin:0;font-family:Arial,sans-serif}header{background:#1d2a3a;color:#fff;padding:16px 28px;font-size:20px}main{padding:24px 28px}td{padding:6px 24px 6px 0}</style></head><body><header>Company lookup (example register)</header><main><h1>VOLTKING TRADING LTD</h1><table><tr><td>Status</td><td>Active</td></tr><tr><td>Incorporated</td><td>2 February 2025</td></tr><tr><td>Registered office</td><td>Suite 4, 12 Example Street, Exampleton</td></tr><tr><td>Nature of business</td><td>Retail sale via mail order houses or via the internet</td></tr></table></main></body></html>`,
};

function startServer(): Promise<number> {
  // Works as an HTTP proxy, so the browser shows real-looking .example addresses.
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const key = `${url.origin}${url.pathname}${url.search}`;
    if (url.pathname === '/img/charger.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(CHARGER_SVG);
    }
    if (url.pathname === '/go/voltking') {
      res.writeHead(302, { Location: '/seller/voltking-direct' });
      return res.end();
    }
    const page = PAGES[key];
    res.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page ? page() : '<!doctype html><title>Not found</title><h1>Not found</h1>');
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      r(typeof a === 'object' && a ? a.port : 0);
    }),
  );
}

// ---------- Helpers ----------

async function rpc<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  const res = await dash.evaluate(([m, a]) => chrome.runtime.sendMessage({ kind: 'rpc', method: m, args: a }), [method, args] as const);
  if (!res?.ok) throw new Error(`rpc ${method} failed: ${res?.error}`);
  return res.value as T;
}

async function idbAll<T>(store: string): Promise<T[]> {
  return dash.evaluate(
    (s) =>
      new Promise<unknown[]>((ok, fail) => {
        const open = indexedDB.open('evicap');
        open.onsuccess = () => {
          const req = open.result.transaction(s).objectStore(s).getAll();
          req.onsuccess = () => ok(req.result);
          req.onerror = () => fail(req.error);
        };
      }),
    store,
  ) as Promise<T[]>;
}

async function opfsFile(path: string): Promise<Uint8Array> {
  const arr = await dash.evaluate(async (p) => {
    let dir = await navigator.storage.getDirectory();
    const parts = p.split('/');
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return Array.from(new Uint8Array(await (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).arrayBuffer()));
  }, path);
  return new Uint8Array(arr);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tabIdOf = (u: string) => sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, u) as Promise<number>;

async function newPage(w = 1280, h = 800) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: w, height: h });
  return p;
}

/** Render HTML in a page and save a PNG of the given size. */
async function renderHtml(html: string, file: string, w: number, h: number) {
  const p = await newPage(w, h);
  const src = join(work, file.replace(/\.png$/, '.html'));
  writeFileSync(src, html);
  await p.goto(pathToFileURL(src).href);
  await p.bringToFront();
  await p.evaluate(() => document.fonts.ready);
  await pause(300);
  await p.screenshot({ path: join(OUT, file) });
  await p.close();
}

const png = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;

const ORG_LOGO_HTML = `<!doctype html><body style="margin:0;background:transparent"><div id="logo" style="display:inline-flex;align-items:center;gap:14px;padding:6px 10px;font-family:Georgia,serif;color:#0b5d3b">
<svg width="64" height="72" viewBox="0 0 64 72"><path d="M32 2 L60 12 V36 C60 54 46 66 32 70 C18 66 4 54 4 36 V12 Z" fill="#0b5d3b"/><path d="M20 36 L29 45 L45 27" stroke="#fff" stroke-width="6" fill="none"/></svg>
<div style="line-height:1.1"><div style="font-size:26px;font-weight:700">Northshire</div><div style="font-size:17px;letter-spacing:.06em">TRADING STANDARDS</div></div></div></body>`;

// ---------- Run ----------

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  const port = await startServer();
  profile = mkdtempSync(join(tmpdir(), 'evicap-shots-'));
  work = mkdtempSync(join(tmpdir(), 'evicap-shots-files-'));
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: BROWSER,
    headless: true,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    proxy: { server: `http://127.0.0.1:${port}` },
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--hide-scrollbars',
      '--window-size=1600,1300', // new tabs otherwise render only ~700 px tall
    ],
    viewport: { width: 1280, height: 800 },
  });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20_000 }));
  extId = new URL(sw.url()).host;
  dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${extId}/dashboard.html`);
  await pause(1500);
  for (const p of ctx.pages()) if (p !== dash) await p.close(); // the onboarding tab
  await rpc('activateLicence', await testLicenceKey());
});

afterAll(async () => {
  await ctx?.close();
  server?.close();
  for (const d of [profile, work])
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* locked briefly */
    }
});

it('makes the store screenshots and promo tiles', async () => {
  // Branding for the report: a made-up council with a logo drawn here.
  const logoPage = await newPage(600, 200);
  await logoPage.setContent(ORG_LOGO_HTML);
  const logo = png(await logoPage.locator('#logo').screenshot({ omitBackground: true }));
  await logoPage.close();
  await rpc('saveBranding', { organisation: 'Northshire Trading Standards', accent: '#0b5d3b', marking: 'OFFICIAL-SENSITIVE', logoDataUrl: logo });

  ({ id: caseId } = await rpc<{ id: string }>('createCase', {
    name: 'Unsafe phone chargers sold online',
    reference: 'NTS/2026/0418',
    investigator: 'Sam Whitfield',
    organisation: 'Northshire Trading Standards',
    description: 'Listings for 65W chargers with false safety claims, reported by a consumer after a fire.',
    autoCapture: true,
  }));
  await rpc('setActiveCase', caseId);
  await rpc('setRecording', true);

  const tab = await newPage();
  const visit = async (u: string) => {
    await tab.goto(u);
    await tab.bringToFront();
    await pause(900);
    return tabIdOf(tab.url());
  };
  await visit(`${SHOP}/`);
  let id = await visit(`${SHOP}/search?q=fast+charger`);
  await rpc('screenshot', 'visible', id);
  id = await visit(`${SHOP}/listing/hx-65w-gan-charger`);
  const { captureId: forensicId } = await rpc<{ captureId: string }>('forensicCapture', true, id);
  await pause(1500);
  id = await visit(`${SHOP}/listing/hx-65w-gan-charger/reviews`);
  await rpc('screenshot', 'full', id);
  await tab.goto(`${SHOP}/listing/hx-65w-gan-charger`);
  await pause(600);
  await tab.click('text=VoltKing Direct'); // through the /go/ redirect
  await tab.waitForURL(/seller/);
  await pause(900);
  await rpc('screenshot', 'visible', await tabIdOf(tab.url()));
  id = await visit(`${REG}/company/voltking-trading-ltd`);
  await rpc('screenshot', 'visible', id);
  await pause(1500);

  await rpc('addNote', caseId, 'capture', forensicId, 'Listing claims "CE certified" and "Safety tested". No UKCA mark, importer name or address shown. Test purchase made, order HD-55821.');
  await rpc('setTag', caseId, 'capture', forensicId, 'key', true);
  await rpc('setTag', caseId, 'capture', forensicId, 'test purchase', true);
  await rpc('addNote', caseId, 'case', caseId, 'Complaint received 14 November from a consumer whose charger caught fire. Seller trades as VoltKing Direct.');

  // 2: the site with the side panel open while recording.
  await tab.goto(`${SHOP}/listing/hx-65w-gan-charger`);
  await tab.setViewportSize({ width: 880, height: 744 });
  await tab.bringToFront();
  await pause(800);
  const site = png(await tab.screenshot({ fullPage: true })); // fullPage avoids a headless tiling glitch on new tabs
  const side = await newPage(400, 744);
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await pause(1500);
  const sideImg = png(await side.screenshot());
  await side.close();
  const shot2 = () => renderHtml(
    `<!doctype html><body style="margin:0;width:1280px;height:800px;background:#dfe3e8;font-family:'Segoe UI',sans-serif;position:relative;overflow:hidden">
<div style="height:56px;background:#f1f3f5;border-bottom:1px solid #cfd5dc;display:flex;align-items:center;padding:0 18px;gap:12px">
<div style="flex:1;max-width:820px;background:#fff;border:1px solid #cfd5dc;border-radius:4px;padding:7px 12px;color:#444;font-size:14px">harbourline-deals.example/listing/hx-65w-gan-charger</div></div>
<img src="${site}" style="position:absolute;left:0;top:56px;width:880px;height:744px">
<img src="${sideImg}" style="position:absolute;left:880px;top:56px;width:400px;height:744px;border-left:1px solid #cfd5dc;box-sizing:border-box"></body>`,
    'screenshot-2-side-panel.png',
    1280,
    800,
  );

  // 1: the case dashboard with the visit log.
  await dash.setViewportSize({ width: 1280, height: 800 });
  await dash.goto(`chrome-extension://${extId}/dashboard.html#/case/${caseId}`);
  await dash.bringToFront();
  await dash.getByRole('tab', { name: 'Visits' }).click();
  await pause(1200);
  await dash.screenshot({ path: join(OUT, 'screenshot-1-visit-log.png') });

  // 3: the forensic capture with its hashes and signature.
  await dash.goto(`chrome-extension://${extId}/dashboard.html#/case/${caseId}/capture/${forensicId}`);
  await pause(1800);
  await dash.screenshot({ path: join(OUT, 'screenshot-3-forensic-capture.png') });

  // Stop recording, so the local pages used to build the other images stay out of the case.
  await rpc('setRecording', false);
  await shot2();

  // Export the case through the dashboard, as a user would.
  await dash.goto(`chrome-extension://${extId}/dashboard.html#/case/${caseId}`);
  await dash.getByRole('tab', { name: 'Export & verify' }).click();
  await dash.getByRole('button', { name: 'Export case' }).click();
  await dash.getByText('Export saved as').waitFor({ timeout: 120_000 });
  const ev = (await idbAll<AuditEvent>('audit')).filter((e) => e.caseId === caseId && e.type === 'export.created').at(-1)!;
  const { path, fileName } = ev.payload as { path: string; fileName: string };
  const zip = await opfsFile(path);
  const zipPath = join(work, fileName);
  writeFileSync(zipPath, zip);
  const files = unzipSync(zip, { filter: (f) => f.name === 'report.html' || f.name === 'verify.html' });

  // 4: the report's first page, as it prints (A4 at 96 dpi is 794 px wide).
  const reportPath = join(work, 'report.html');
  writeFileSync(reportPath, strFromU8(files['report.html']!));
  const rep = await newPage(794, 1123);
  await rep.emulateMedia({ media: 'print' });
  await rep.goto(pathToFileURL(reportPath).href);
  await pause(800);
  const repImg = png(await rep.screenshot({ clip: { x: 0, y: 0, width: 794, height: 732 } }));
  await rep.close();
  await renderHtml(
    `<!doctype html><html style="overflow:hidden"><body style="margin:0;width:1280px;height:800px;background:#5f6670;overflow:hidden;position:relative;font-family:'Segoe UI',sans-serif">
<div style="height:44px;background:#3a3f46;color:#e8eaed;display:flex;align-items:center;padding:0 20px;font-size:14px">report.pdf · page 1</div>
<div style="position:absolute;left:243px;top:68px;width:794px;height:732px;background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.4);overflow:hidden"><img src="${repImg}" style="display:block;width:794px;height:732px"></div></body>`,
    'screenshot-4-report.png',
    1280,
    800,
  );

  // 5: the offline verifier from the export, opened from disk, passing it.
  const verifyPath = join(work, 'verify.html');
  writeFileSync(verifyPath, strFromU8(files['verify.html']!));
  const ver = await newPage();
  await ver.goto(pathToFileURL(verifyPath).href);
  await ver.locator('#zip').setInputFiles(zipPath);
  await ver.waitForFunction(() => document.body.dataset.result, null, { timeout: 90_000 });
  if ((await ver.evaluate(() => document.body.dataset.result)) !== 'pass') throw new Error('The verifier did not pass the export');
  await pause(500);
  await ver.screenshot({ path: join(OUT, 'screenshot-5-verifier.png') });
  await ver.close();

  // Promo tiles, in the brand's navy with the mark, Montserrat and Security Teal.
  const font = (await import('node:fs')).readFileSync(resolve('src/assets/fonts/montserrat-latin-wght-normal.woff2')).toString('base64');
  const tile = (w: number, h: number, big: boolean) => `<!doctype html><style>@font-face{font-family:M;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}</style>
<body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${BRAND.navy};color:#fff;font-family:M,sans-serif;display:flex;align-items:center;padding:0 ${big ? 110 : 36}px;box-sizing:border-box;gap:${big ? 54 : 22}px;border-bottom:${big ? 10 : 6}px solid ${BRAND.tealOnDark}">
${markSvg(MARK_ON_DARK, { size: big ? 230 : 120 })}
<div><div style="font-size:${big ? 104 : 52}px;font-weight:800;letter-spacing:-.02em;line-height:1">EviCap</div>
<div style="font-size:${big ? 28 : 15}px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${BRAND.tealOnDark};margin-top:${big ? 18 : 10}px;line-height:1.3">${big ? 'Unyielding truth in investigation' : 'Web evidence,<br>preserved'}</div>
${big ? '<div style="font-size:24px;font-weight:500;color:#c9d4e3;margin-top:22px;line-height:1.45">Capture web pages with hashes, signatures<br>and an audit trail that holds up.</div>' : ''}</div></body>`;
  await renderHtml(tile(440, 280, false), 'promo-small-440x280.png', 440, 280);
  await renderHtml(tile(1400, 560, true), 'promo-marquee-1400x560.png', 1400, 560);
});
