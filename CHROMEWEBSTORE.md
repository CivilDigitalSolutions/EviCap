# Chrome Web Store Listing — EviCap

> Last updated: 2026-11-16 · Built from the template in Chrome's `chrome-extensions` skill (`.agents/skills/chrome-extensions/references/webstore/`). Keep this file up to date whenever the manifest, permissions, features or data handling change. It is not part of the extension package.

Everything here is ready to copy into the Chrome Web Store Developer Dashboard (https://chrome.google.com/webstore/devconsole). The same text works for Microsoft Edge Add-ons (https://partner.microsoft.com/dashboard/microsoftedge).

## Store listing

**Extension name** (matches `manifest.json`)

EviCap

**Short description** (manifest `description`, 54 of 132 characters)

Capture and preserve web evidence for investigations.

**Detailed description** (plain text, 8154 of 16,000 characters; the store strips Markdown). The same text is in `store/description.txt` for copying.

```
EviCap turns your browser into an evidence recorder. It logs the web pages you visit during an investigation and saves what you see as evidence you can stand behind: every file is hashed the moment it is captured, every capture is signed, and every action goes into a tamper-evident audit log. When you are done, export the case with a PDF report and an offline verifier that anyone can use to check that nothing has changed.

Made for anyone who has to show what was on a website and when: trading standards and consumer protection officers, police and fraud investigators, open-source (OSINT) researchers, compliance and HR investigators, solicitors and paralegals, and journalists.

━━━━━━━━━━━━━━━━━━━━
HOW IT WORKS
━━━━━━━━━━━━━━━━━━━━

1. Create a case and give it a name, a reference and the investigator's details.
2. Press Start recording and browse as you normally would. EviCap logs each page and, if you choose, saves a copy of it automatically.
3. Take screenshots and forensic captures of the pages that matter, and add notes and tags as you go.
4. Open the dashboard to review the timeline, the visit log, your captures and the audit log.
5. Export the case, or just the exhibits you need, as a ZIP ready for disclosure or to attach to a statement.

━━━━━━━━━━━━━━━━━━━━
A RECORD OF EVERY PAGE YOU VISIT
━━━━━━━━━━━━━━━━━━━━

While a case is recording, EviCap keeps a visit log with:
• the date and time of each visit, in UTC with your local offset
• the page title and full address
• how you got there: a link, a typed address, a reload, or back and forward
• any redirects on the way, so you can show how you reached a page
• how long the page was in focus
• changes of address inside single-page sites

You decide what is recorded. Each case can record every site, or only the domains you list. Banking, health and email sites are never logged, and you can add your own sites to that list. Private (incognito) windows are recorded only if you turn that on for the case.

━━━━━━━━━━━━━━━━━━━━
CAPTURE WHAT YOU SEE
━━━━━━━━━━━━━━━━━━━━

• Automatic capture: saves a copy of each page as you browse, so nothing you saw is lost even if the site changes later.
• Screenshots: the visible area, the full length of the page, a region you draw, or a single element you click.
• Forensic capture: a complete record of the page in one step. It includes a Web Archive (WACZ) file that opens in standard archive viewers such as ReplayWeb.page, a full-page screenshot, the page as a single file (MHTML), the page's HTML, the network responses and the site's security certificate. Reload and capture records the page again from scratch with full network detail.
• Images and video: save the original copy of an image or video, straight from the site that hosts it.
• Media picker (Pro): pick several images and videos on a page and save them together.
• Tab recording (Pro): record the tab as video with its sound, for streamed or protected video that can't be saved as a file.

Every capture can be opened and checked from the dashboard, with its hashes, its signature and the audit entry that recorded it.

Capture from wherever is quickest: the toolbar button, the side panel, the right-click menu, or keyboard shortcuts (Alt+Shift+S for the visible area, Alt+Shift+F for the full page, Alt+Shift+R for a region, Alt+Shift+M for the media picker).

━━━━━━━━━━━━━━━━━━━━
NOTES, TAGS AND A TIMELINE
━━━━━━━━━━━━━━━━━━━━

Add notes to the case, to any visit or to any capture, and tag the ones that matter, for example "key" or "test purchase". Notes are part of the record: each one goes into the audit log, and if you edit a note, the log keeps what it said before. The timeline shows visits, captures and notes in order, and the side panel shows the live log of the case while you work.

━━━━━━━━━━━━━━━━━━━━
WHY THE EVIDENCE HOLDS UP
━━━━━━━━━━━━━━━━━━━━

• Hashing: every file gets a SHA-256 hash the moment it is saved.
• Signing: each capture's list of files and hashes is signed with an ECDSA P-256 key created on your computer. The key's fingerprint is printed in every report, so you can quote it in your statement.
• Audit log: every action in a case is written to a log in which each entry contains the hash of the one before it. A missing, reordered or edited entry breaks the chain and shows up.
• Context: each capture records the browser, operating system, time zone, screen size and the time source used.
• Honest limits: the report says plainly what the checks prove (the files are unchanged since EviCap saved them, and the log is complete) and what they don't prove on their own (who was at the computer, or whether its clock was right).

━━━━━━━━━━━━━━━━━━━━
EXPORT AND VERIFY
━━━━━━━━━━━━━━━━━━━━

Export a whole case as one ZIP containing:
• a PDF report, and the same report as a web page, with the case details, an integrity summary, an exhibit index with thumbnails, the notes and an audit summary
• every capture, numbered as exhibits (EV-001, EV-002 and so on)
• the visit log as a spreadsheet (CSV) and as JSON
• the complete audit log
• a signed list of every file, and the public key
• verify.html, an offline verifier

Anyone can open verify.html in a modern browser, choose the ZIP, and check every hash, every signature and the whole audit chain. It works without an internet connection, uploads nothing and doesn't need EviCap installed, so you can hand it to a colleague, a lawyer or a court along with the evidence. You can also check an export, or the live case, from the dashboard, and each check is itself recorded in the audit log.

Selected exhibits (Pro): export only the exhibits you choose. Audit entries about unrelated pages are left out, and the verifier still confirms that the chain is intact and says how many entries were left out.

Branded reports (Pro): put your organisation's name, logo and colour on the report, and a protective marking such as OFFICIAL-SENSITIVE at the top and bottom of every PDF page. Branding changes only how the report looks. The integrity sections always stay, and the report always says it was made by EviCap.

━━━━━━━━━━━━━━━━━━━━
YOUR DATA STAYS ON YOUR COMPUTER
━━━━━━━━━━━━━━━━━━━━

Cases, logs and captures are stored only in your browser on your own computer. There is no account to create, no analytics and no tracking, and Civil Digital cannot see, collect or recover your evidence.

Optional disk mirror: keep a copy of every case as ordinary files in a folder you choose, so your evidence survives uninstalling the extension or clearing browser data.

EviCap connects to something other than the sites you visit only when:
• you capture an image or video, when it downloads the original from the site that hosts it
• you have entered a subscription licence key, which it renews with Civil Digital's licence service about once a day

━━━━━━━━━━━━━━━━━━━━
FREE AND PRO
━━━━━━━━━━━━━━━━━━━━

Free:
• 2 open cases at a time
• up to 100 automatic captures per case
• 10 forensic captures a month
• screenshots, single image and video capture, notes and tags
• hashing, signing, the audit log, export with the PDF report, and verification, always

EviCap Pro, £4 a month or £40 a year:
• no limits on cases or captures
• the media picker, for several images and videos at once
• tab recording
• exporting selected exhibits
• branded reports

Try Pro free for 14 days from Settings. The trial needs no sign-up and no card. Organisations can buy licences by invoice. Whatever your plan, your evidence is never locked: you can always open, verify and export what you have captured.

━━━━━━━━━━━━━━━━━━━━
ABOUT THE PERMISSIONS
━━━━━━━━━━━━━━━━━━━━

EviCap asks for access to all websites because an investigation can involve any site. It logs pages only while a case is recording, and captures only what you ask it to. Forensic captures and full-page screenshots briefly use the browser's debugging feature, so Chrome shows a notice bar while the capture runs. That's expected, and EviCap lets go as soon as the capture ends.

━━━━━━━━━━━━━━━━━━━━
SUPPORT
━━━━━━━━━━━━━━━━━━━━

Questions, feedback or invoices: info@civildigital.co.uk

EviCap is made by Civil Digital.
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

**Visibility:** Public · **Regions:** All regions · **Payments in the dashboard:** Contains in-app purchases. EviCap is free to install, but Pro is bought from inside the extension (through Stripe), and Google's "Free of charge" option is only for items with nothing to buy. This shows an "in-app purchases" badge on the listing.

## Developer information

- **Publisher:** Civil Digital (the publisher display name on the dashboard's Settings page; it starts as the Google account's email address)
- **Trader:** Yes. Verified as CIVIL DIGITAL through the Google payments profile, with D-U-N-S; the address and phone number are shown on the listing
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
