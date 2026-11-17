# EviCap

Forensic web evidence capture for investigators, by Civil Digital. A Chrome and Edge extension (Manifest V3) that logs every site visited while a case is recording, captures screenshots, and protects everything with SHA-256 hashes, signed manifests and a hash-chained audit log. Everything stays on the user's computer.

- Specification: [docs/SPEC.md](docs/SPEC.md)
- Privacy policy: [PRIVACY.md](PRIVACY.md)

## Status

Built so far (spec milestones M0 to M5):

- Cases: create, edit, close, reopen, archive, delete; one active case; Record/Pause
- Visit log: every top-level navigation, including redirect chains and in-page (SPA) navigation, with time in focus; denylist, per-case domain scope, incognito opt-in
- Screenshots: visible area, full page (debugger, with a scroll-and-stitch fallback), region and element
- Integrity: SHA-256 for every file, signed capture manifests (ECDSA P-256 install key), append-only hash-chained audit log per case, re-check on view, chain verification
- Images: right-click capture or a multi-select picker; the original bytes (not a re-encode) where possible, EXIF shown read-only, every source the page offered recorded, and an in-context screenshot
- Video: direct download of video files, streamed and hashed as it arrives, resumed if the connection drops, with the poster and caption tracks; tab recording (with sound) for streamed or protected video
- Automatic capture: every logged page saved as MHTML with its text and a screenshot, linked to its visit; unchanged pages link to the earlier capture; large pages skipped and logged
- Forensic capture: one click (or reload and capture) records the page's network traffic, TLS certificate, full-page screenshot, MHTML, rendered DOM, source and links, packaged as a WACZ web archive; an offline, script-free snapshot view in the dashboard
- Export: one ZIP per case (or selected exhibits) with every file, the visit log (CSV and JSON), notes, the audit log, a report in HTML and PDF, and a signed manifest of every file's SHA-256; the export's own hash goes in the audit log
- Verification: an offline checker ("3 - Check nothing has been changed.html") in every export, beside a plain-English "1 - START HERE" page, a Verify page in the dashboard, and a whole-case check; exhibit-only exports keep the audit chain checkable while leaving out unrelated sites
- Disk mirror: optional copy of every case to a folder the user picks, re-hashed after writing
- Notes (with version history) and tags
- Popup, side panel, dashboard, onboarding, settings
- Plans: Free limits and Pro features enforced on the device, a 14-day trial that sends nothing, card subscriptions through Stripe Managed Payments with Civil Digital's licence service (`service/`), and signed offline licence keys for invoiced organisations

Still to do before launch: a first live purchase test (SPEC §18) and submitting to the Chrome Web Store and Edge Add-ons. Everything the store dashboard asks for (listing text, permission justifications, privacy answers) is in `CHROMEWEBSTORE.md`; `npm run zip` makes the upload, and `npm run store:shots` remakes the screenshots and promo tiles in `store/`.

## Brand

Navy `#14213d` (Primary Navy), teal `#006d77` (Security Teal) and grey `#edf2f4` (Data Grey), with the shield-and-lens mark. The colours and the mark are defined once in `src/lib/brand.ts`, which the icons (`node tools/make-icons.mts`), the app (`src/ui/Logo.tsx`, `src/ui/styles.css`), the report and the verifier all use. Headings and the wordmark use Montserrat (SIL Open Font License), bundled in `src/assets/fonts/`; body text uses the system font. Recording red stays red: it is a warning, not decoration. Reports use the teal for headings unless a Pro user sets their own colour.

## Licence keys

Civil Digital issues Pro licence keys offline:

```bash
node tools/issue-licence.ts issue --org "Acme Ltd" --email jo@acme.example --months 12
```

The key is printed and logged in `tools/keys/issued-licences.csv`. The signing key is `tools/keys/licence-signing-key.private.jwk`. Git ignores `tools/keys/`; keep an offline backup, because losing it means no more keys can be issued without an extension update, and leaking it lets anyone make keys.

## Build with AI agents

Chrome's agent skills are installed in `.agents/skills` (`chrome-extensions` and `modern-web-guidance`, from `GoogleChrome/modern-web-guidance`, pinned in `skills-lock.json`). Claude Code reads them through `.claude/skills`, which git ignores; recreate the links with `npx skills add GoogleChrome/modern-web-guidance --skill chrome-extensions -y` and the same for `modern-web-guidance`.

`.mcp.json` adds Chrome DevTools for agents (`chrome-devtools-mcp` with its extension tools), which lets an agent load, reload and inspect EviCap in your own Chrome. To use it, open `chrome://inspect/#remote-debugging` in Chrome, turn on *Allow remote debugging for this browser instance* (needed each time Chrome starts), and approve the server when Claude Code asks.

## Develop

Needs Node 20 or later.

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` opens a browser with the extension loaded and reloads it on changes. For Edge, use `npm run dev:edge`.

To build and load it by hand:

```bash
npm run build
```

Then open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, choose **Load unpacked** and pick `.output/chrome-mv3`.

## Test

```bash
npm test
```

Unit tests: canonical JSON (RFC 8785 vectors), SHA-256 (NIST vectors), audit chain building and tamper detection, signing, recording rules, EXIF reading, WARC/WACZ writing and reading, MHTML comparison, the ZIP writer and reader (including ZIP64), exhibit-only redaction, CSV and report output, the bundled verifier, licence keys (valid, changed, expired, signed by another key), the licence service against a fake Stripe (checkout pages, renewals, ended subscriptions, forged keys) and plan rules, and a check that only the network module makes requests.

```bash
npm run test:e2e
```

Builds a test copy of the extension (`.output/chrome-mv3-e2e`, which also trusts a test licence key), loads it into a real browser (Edge by default; set `EVICAP_BROWSER` to another Chromium-based browser's path) and checks recording, redirects, SPA navigation, screenshots (including the pixels of a full-page capture), signatures, the audit chain, the disk mirror and the dashboard; and media capture: a cross-origin image byte for byte with its EXIF, the picker, the largest srcset version, inline images, a video download that is cut off and resumed, and streamed video being sent to tab recording; automatic capture (files, visit links, deduplication, changed pages, the size limit) and forensic capture with and without a reload (WACZ contents and hashes, HTTP headers, server address, network log, the offline snapshot); and export: the ZIP, report and PDF, verify.html opened from disk passing the export and catching a changed byte, an exhibit-only export, and the dashboard checks; and plans: the open-case and forensic limits, Pro features refused on Free, licence keys accepted and rejected from Settings, the trial, subscription keys against a fake licence service (activation with no request, renewal, the service being down, the subscription ending, removal), and the audit records of each change.

Tab recording needs a real click on the toolbar button, so it is checked by hand: open a page with a video, click EviCap, press **Record this tab**, play for a few seconds, press **Stop**, and open the capture.

## Layout

| Path | What |
|---|---|
| `src/lib/` | Core: hashing, canonical JSON, audit chain, signing, storage, recorder, screenshots, media capture, disk mirror |
| `src/lib/net.ts` | The only code that requests content from websites (re-fetching originals) |
| `src/entrypoints/background.ts` | Service worker: browser events, shortcuts, RPC for the UI |
| `src/entrypoints/offscreen/` | Writes the disk mirror; records tabs |
| `src/entrypoints/popup/`, `sidepanel/`, `dashboard/` | User interface (React) |
| `tests/` | Unit tests; `tests/e2e/` browser tests |
| `tools/make-icons.mts` | Draws the icons in `public/icon/` from the mark in `src/lib/brand.ts` (`node tools/make-icons.mts`) |
