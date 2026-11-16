# EviCap

Forensic web evidence capture for investigators, by Civil Digital. A Chrome and Edge extension (Manifest V3) that logs every site visited while a case is recording, captures screenshots, and protects everything with SHA-256 hashes, signed manifests and a hash-chained audit log. Everything stays on the user's computer.

- Specification: [docs/SPEC.md](docs/SPEC.md)
- Privacy policy: [PRIVACY.md](PRIVACY.md)

## Status

Built so far (spec milestones M0 to M4):

- Cases: create, edit, close, reopen, archive, delete; one active case; Record/Pause
- Visit log: every top-level navigation, including redirect chains and in-page (SPA) navigation, with time in focus; denylist, per-case domain scope, incognito opt-in
- Screenshots: visible area, full page (debugger, with a scroll-and-stitch fallback), region and element
- Integrity: SHA-256 for every file, signed capture manifests (ECDSA P-256 install key), append-only hash-chained audit log per case, re-check on view, chain verification
- Images: right-click capture or a multi-select picker; the original bytes (not a re-encode) where possible, EXIF shown read-only, every source the page offered recorded, and an in-context screenshot
- Video: direct download of video files, streamed and hashed as it arrives, resumed if the connection drops, with the poster and caption tracks; tab recording (with sound) for streamed or protected video
- Automatic capture: every logged page saved as MHTML with its text and a screenshot, linked to its visit; unchanged pages link to the earlier capture; large pages skipped and logged
- Forensic capture: one click (or reload and capture) records the page's network traffic, TLS certificate, full-page screenshot, MHTML, rendered DOM, source and links, packaged as a WACZ web archive; an offline, script-free snapshot view in the dashboard
- Export: one ZIP per case (or selected exhibits) with every file, the visit log (CSV and JSON), notes, the audit log, a report in HTML and PDF, and a signed manifest of every file's SHA-256; the export's own hash goes in the audit log
- Verification: an offline verify.html in every export, a Verify page in the dashboard, and a whole-case check; exhibit-only exports keep the audit chain checkable while leaving out unrelated sites
- Disk mirror: optional copy of every case to a folder the user picks, re-hashed after writing
- Notes (with version history) and tags
- Popup, side panel, dashboard, onboarding, settings

Next: billing, licence keys and plan limits (M5).

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

Unit tests: canonical JSON (RFC 8785 vectors), SHA-256 (NIST vectors), audit chain building and tamper detection, signing, recording rules, EXIF reading, WARC/WACZ writing and reading, MHTML comparison, the ZIP writer and reader (including ZIP64), exhibit-only redaction, CSV and report output, the bundled verifier, and a check that only the network module makes requests.

```bash
npm run test:e2e
```

Builds the extension, loads it into a real browser (Edge by default; set `EVICAP_BROWSER` to another Chromium-based browser's path) and checks recording, redirects, SPA navigation, screenshots (including the pixels of a full-page capture), signatures, the audit chain, the disk mirror and the dashboard; and media capture: a cross-origin image byte for byte with its EXIF, the picker, the largest srcset version, inline images, a video download that is cut off and resumed, and streamed video being sent to tab recording; automatic capture (files, visit links, deduplication, changed pages, the size limit) and forensic capture with and without a reload (WACZ contents and hashes, HTTP headers, server address, network log, the offline snapshot); and export: the ZIP, report and PDF, verify.html opened from disk passing the export and catching a changed byte, an exhibit-only export, and the dashboard checks.

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
| `tools/make-icons.mjs` | Draws the icons in `public/icon/` |
