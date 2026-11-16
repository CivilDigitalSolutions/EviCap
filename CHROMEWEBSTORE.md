# Chrome Web Store Listing — EviCap

> Last updated: 2026-11-16 · Built from the template in Chrome's `chrome-extensions` skill (`.agents/skills/chrome-extensions/references/webstore/`). Keep this file up to date whenever the manifest, permissions, features or data handling change. It is not part of the extension package.

Everything here is ready to copy into the Chrome Web Store Developer Dashboard (https://chrome.google.com/webstore/devconsole). The same text works for Microsoft Edge Add-ons (https://partner.microsoft.com/dashboard/microsoftedge).

## Store listing

**Extension name** (matches `manifest.json`)

EviCap

**Short description** (manifest `description`, 54 of 132 characters)

Capture and preserve web evidence for investigations.

**Detailed description** (plain text; the store strips Markdown)

```
EviCap records the web pages you visit during an investigation and saves them as evidence you can rely on, with a hash, a signature and an audit trail for every item.

WHAT IT DOES
Keeps a case-by-case log of every page you visit while recording, with the time, title, address and any redirects.
Saves pages automatically as you browse, so nothing you saw is lost.
Takes screenshots of the visible area, the full page or a region you draw.
Makes forensic captures: a complete archive of the page (WACZ), a full-page screenshot, and the network and certificate details.
Captures images and videos from a page, including several at once, and records a tab as video when a stream can't be saved directly.
Lets you add notes and tags to pages and captures.
Exports a case, or selected exhibits, as a ZIP with a PDF report, an exhibit index, the full audit log and an offline verifier anyone can open.

WHY IT HOLDS UP
Every file gets a SHA-256 hash the moment it is saved. Each capture's list of files is signed with a key created on your computer. Every action in a case goes into an audit log in which each entry includes the hash of the one before, so a gap or an edit shows. The verifier in each export checks all of this offline, in any browser.

HOW TO USE IT
1. Create a case and give it a reference.
2. Press Start recording and browse as normal. EviCap logs each page and saves it.
3. Take screenshots or forensic captures of the pages that matter, and add notes.
4. Open the dashboard to review the case, then export it for disclosure or a statement.

YOUR DATA STAYS ON YOUR COMPUTER
Cases, logs and captures are stored only in your browser, and optionally in a folder you choose. EviCap has no account and no analytics, and Civil Digital cannot see your evidence. Common banking, health and email sites are never logged, and you can add your own.

FREE AND PRO
The free plan includes 2 open cases at a time, 10 forensic captures a month and up to 100 automatic captures per case, with hashing, signing, export and verification always included. EviCap Pro (£4 a month or £40 a year) removes the limits and adds the multi-select media picker, tab recording, exhibit-only export and branded reports with your organisation's name, logo and protective marking. Try Pro free for 14 days; the trial needs no sign-up. Organisations can also buy by invoice.

SUPPORT
Email info@civildigital.co.uk.
```

**Category:** Productivity → Tools. (The template lists the old category names; pick the closest current one in the dashboard.)

**Single purpose:** Capture and preserve web evidence for investigations.

**Primary language:** English (United Kingdom)

## Graphics and assets

| Asset | Size | Status | File |
|---|---|---|---|
| Store icon | 128×128 PNG | ✅ 96 px design with 16 px transparent padding | `store/store-icon-128.png` (same as `public/icon/128.png`) |
| Screenshot 1: case dashboard with a visit log | 1280×800 | ✅ | `store/screenshot-1-visit-log.png` |
| Screenshot 2: a shop page with the side panel open while recording | 1280×800 | ✅ | `store/screenshot-2-side-panel.png` |
| Screenshot 3: a forensic capture with its hashes and signature | 1280×800 | ✅ | `store/screenshot-3-forensic-capture.png` |
| Screenshot 4: export report (PDF) with branding | 1280×800 | ✅ | `store/screenshot-4-report.png` |
| Screenshot 5: offline verifier passing an export | 1280×800 | ✅ | `store/screenshot-5-verifier.png` |
| Small promo tile | 440×280 | ✅ Navy with the mark and wordmark | `store/promo-small-440x280.png` |
| Marquee promo tile | 1400×560 | ✅ (optional) With the tagline "Unyielding truth in investigation" | `store/promo-marquee-1400x560.png` |

All images are made by `npm run store:shots` (`tools/store-shots.shots.ts`). It loads the e2e build into Edge and serves a fictional shop on `.example` addresses. The case, the council (Northshire Trading Standards), its logo and the officer are all made up. Run it again after any visible change to the UI. The screenshots are 24-bit PNGs with no transparency, as the store asks.

## Permission justifications

Paste each one into the matching field in the dashboard's **Privacy practices** tab.

| Permission | Type | Justification |
|---|---|---|
| `storage` | permissions | Stores the user's settings, their plan and licence key, and the list of cases on their own computer. |
| `unlimitedStorage` | permissions | Evidence (saved pages, screenshots, videos and archives) is stored on the user's computer and often runs to several gigabytes per case, well past the normal storage limit. |
| `tabs` | permissions | Reads the address and title of the pages the user visits while a case is recording, to write the case's visit log, and takes screenshots of the current tab when the user asks. |
| `webNavigation` | permissions | Notices when a page in a recording tab finishes loading or changes address within the page (single-page sites), so each visit is logged with the right time and address. |
| `webRequest` | permissions | Read only. Records the chain of redirects that led to each page in the visit log, which investigators need to show how they reached a page. EviCap never blocks or changes requests. |
| `scripting` | permissions | Adds EviCap's own tools to a page when the user starts them: the region selector for screenshots, the picker for images and videos, and a script that reads the page's details (title, size, media addresses) for the capture record. |
| `activeTab` | permissions | Lets the user capture the tab they are looking at from the toolbar button, keyboard shortcut or right-click menu. |
| `debugger` | permissions | Used only while a capture the user started is running, and Chrome shows its notice bar for that time. It is needed to make forensic captures (a complete archive of the page including the network responses and the site's security certificate), full-page screenshots of long pages, and to print the export report to PDF. EviCap does not use it to change pages, and detaches as soon as the capture ends. |
| `pageCapture` | permissions | Saves a copy of the page as a single file (MHTML) for automatic captures and forensic captures. |
| `tabCapture` | permissions | Records the current tab as video, with its sound, when the user presses Record tab. This is for streamed or protected video that can't be saved as a file. |
| `offscreen` | permissions | Runs the tab recording, and the hashing and ZIP building for large evidence files, in a hidden extension page, because the background service worker can't do this work. |
| `sidePanel` | permissions | Shows the live log of the current case and quick capture buttons in the browser's side panel. |
| `contextMenus` | permissions | Adds EviCap's capture actions to the right-click menu on pages: capture an image or video, pick several, screenshot an element, make a forensic capture, and record the tab. |
| `alarms` | permissions | Checks on the user's computer every few hours whether a trial or licence has ended. If the user has entered a subscription licence key, renews that key about once a day. |
| `<all_urls>` | host_permissions | Investigations can involve any website, so recording and capture have to work on whichever site the user visits. EviCap only logs pages in tabs where the user has started recording, never logs sites on the built-in privacy list (banks, health and email), and also uses this access to download the original copy of an image or video the user asks to capture from the site that hosts it. |

**Remote code:** No. All code is in the package. Captured pages are saved as data and never run by the extension.

## Privacy practices (data use disclosure)

All evidence is processed and stored on the user's own computer. The only data that leaves it: a subscription licence key sent to Civil Digital's licence service to renew it (only after the user enters one), and the requests to a website that re-download an image or video the user chose to capture. Check the definitions in the Chrome Web Store User Data Policy when submitting; declaring the local evidence data is the safe choice.

| Data type | Handled? | Leaves the device? | Purpose | Shared with third parties? |
|---|---|---|---|---|
| Personally identifiable information | Yes | Only the name and email address inside a subscription licence key, sent to Civil Digital's licence service to renew it | Licensing | Stripe, which already holds them as the seller, is asked whether the subscription is active |
| Health information | No | — | — | — |
| Financial and payment information | No (payments are made on Stripe's own pages; the extension never sees them) | — | — | — |
| Authentication information | No | — | — | — |
| Personal communications | No | — | — | — |
| Location | No (the time zone is recorded with each capture) | — | — | — |
| Web history | Yes, while a case is recording | No | The case's visit log, which is the core function | No |
| User activity | No | — | — | — |
| Website content | Yes, pages and media the user captures | No | Evidence capture, which is the core function | No |

**Certifications** (all true):
- [x] User data is not sold to third parties.
- [x] User data is not used or transferred for purposes unrelated to the single purpose.
- [x] User data is not used or transferred to determine creditworthiness or for lending.

## Privacy policy

**URL:** https://github.com/CivilDigitalSolutions/EviCap/blob/main/PRIVACY.md (the repository is public, so this works now). A page on civildigital.co.uk or GitHub Pages would look better; if it moves, update this line, the dashboard and `README.md`.

## Distribution

**Visibility:** Public · **Regions:** All regions · **Pricing in the dashboard:** Free (Pro is sold through Stripe, not the store)

## Developer information

- **Publisher:** Civil Digital
- **Contact email:** info@civildigital.co.uk (Google sends policy and takedown notices here, so it must be monitored)
- **Support:** info@civildigital.co.uk
- **Homepage:** https://github.com/CivilDigitalSolutions/EviCap, or a product page on civildigital.co.uk once there is one

## Package

```bash
npm run zip
```

This makes `.output/evicap-<version>-chrome.zip`, which holds only the built extension (no source maps, tests, `node_modules` or this file). Raise `version` in `package.json` for every upload; the store rejects a version it has already seen. For Edge use `npx wxt zip -b edge`.

## Version history

| Version | Date | Changes | Status |
|---|---|---|---|
| 0.1.0 | 2026-11-16 | First release: visit log, automatic and forensic capture, screenshots, media capture, tab recording, notes, export with report and verifier, Free and Pro plans, branded reports | Draft |

## Review notes

### Expect a manual review
`debugger`, `<all_urls>`, `webRequest` and `tabCapture` together almost always send an extension to manual review, which can take a few weeks. The justifications above say exactly when each is used. If the reviewer asks, explain that `debugger` is the only way an extension can save a page's network responses and security certificate, which a forensic capture needs.

### Known issues and limitations
- Trusted timestamping is described in the privacy policy as an opt-in feature but isn't built yet; Settings says "coming in a later build".
- Tab recording hasn't yet been tested by hand on a real streaming site.

### Rejection history

| Date | Reason | Fix | Resubmitted |
|---|---|---|---|
| | | | |
