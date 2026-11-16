# EviCap — Browser Extension Specification

| | |
|---|---|
| **Status** | Draft v0.2 |
| **Product** | EviCap — forensic web evidence capture for investigators |
| **Publisher** | Civil Digital |
| **Platforms (v1)** | Google Chrome and Microsoft Edge (Manifest V3). Firefox desktop in v1.x. |
| **Data model** | Local-only. No evidence, history or case data ever leaves the device. Cases can also be saved as files in a folder on the user's computer, to protect against data loss. |
| **Outbound data** | Billing only, plus a hash sent to FreeTSA if the user turns on trusted timestamping (§10) |
| **Billing** | Stripe Managed Payments (Stripe is merchant of record) for card subscriptions, with a small Civil Digital licence service; invoice licence keys for organisations |

---

## 1. Summary

EviCap is a browser extension for OSINT investigators, law enforcement, legal teams and journalists. It records a tamper-evident log of every site visited while a case is active, and makes it fast to capture pages, screenshots, images and videos. Every artefact is hashed when it is created, and each case's log is signed with a local key. The result is a self-verifying evidence bundle that can be produced in court.

It is designed to do what Hunchly and Magnet Web Page Saver do, and to improve on them in five ways:

- **Stronger integrity.** Every artefact gets a SHA-256 hash, every case gets a hash-chained audit log, and capture manifests are signed. Bare MD5 hashes are not enough.
- **Open formats.** Forensic page captures use WACZ/WARC, the standard web-archive formats, so they replay and verify without EviCap.
- **Richer capture.** Raw HTTP responses, headers, TLS certificate details, server IP, MHTML, full-page screenshots and original media bytes.
- **First-class media capture.** One-click capture of user-selected images and videos, including streamed video via tab recording.
- **Offline verification.** Every export includes a standalone verifier page that recomputes every hash and signature.

## 2. Goals and non-goals

### Goals
1. Continuously log every site visited while recording is on, with no user action needed.
2. Let the user capture any of the following in one or two actions:
   - a forensic capture of the whole page
   - a screenshot (visible area, full page, selected region or a single element)
   - an image they select
   - a video they select, or a recording of the tab
3. Hash every artefact with SHA-256 when it is created, record the hash in an append-only, hash-chained audit log, and never modify an original afterwards.
4. Keep all data on the user's device. The extension operates no server, sends no telemetry, and sends nothing off the device except billing traffic and, if the user turns on trusted timestamping, a hash (§7.5).
5. Let the user protect against data loss by saving each case as files in a folder on their own computer (the optional disk mirror, §5.2).
6. Export a case as a self-contained bundle with a human-readable report and an offline verifier.
7. Sell a Pro tier through Stripe with as little backend work as possible.

### Non-goals (v1)
- Any cloud storage, sync, team sharing or server-side processing.
- Mobile browsers (see §15).
- Capturing DRM-protected media (Netflix and similar). This is technically blocked, and the extension says so rather than failing silently.
- Proving that a server really sent a given response (zkTLS/TLSNotary). This is research-grade today and tracked as future work.- Automatic "recipes" for specific social media sites. This is v1.x (see §16).

## 3. Users and core scenarios

| Persona | Scenario |
|---|---|
| OSINT investigator | Opens a case, browses a subject's public profiles for two hours, then exports the case. Every page visited is in the log, and key pages have forensic captures. |
| Police digital officer | Sees a threatening post, right-clicks the image and the video, and captures both in their original quality, with hashes, before the post is deleted. |
| Litigation paralegal | Captures a full-length competitor web page and produces a PDF report with a SHA-256 hash and an exhibit index for counsel. |
| Journalist | Keeps a per-story log of sources, adds notes and tags, and searches across every page captured. |

## 4. Product principles

1. **Local-first, local-only.** All case data stays in browser storage on the device and, if the user chooses, in a folder on their computer. Nothing leaves the device except billing traffic and opt-in timestamp hashes. See the network rules in §10.
2. **Originals never change.** Annotations, crops and redactions create new derived artefacts that point to their parent. The original bytes and hash are untouched.
3. **Hash at the moment of capture.** Hashes are computed from the exact bytes written to storage, before anything else touches them.
4. **Everything is logged.** Every action that creates, changes, exports or deletes data writes an audit event.
5. **Never hold evidence hostage.** Viewing, exporting and verifying existing cases is always free, even if a subscription lapses.
6. **Honest about limits.** The UI and reports state what the tool can and cannot prove, for example "the timestamp is from this computer's clock."

## 5. Architecture

### 5.1 Components (Manifest V3)

| Component | Responsibility |
|---|---|
| **Service worker** (`background`) | Event hub: navigation logging, commands, context menus, capture orchestration, `chrome.debugger` sessions, audit log writer, licence state. Holds no long-lived state in memory, because MV3 workers are killed when idle. |
| **Offscreen document** | Work the service worker can't do: streaming hashing of large files, `MediaRecorder` for tab recording, ZIP/WACZ assembly, image stitching for full-page screenshots, canvas work. |
| **Content script** (all frames, on demand) | Media picker overlay, region/element selection, page metadata collection (title, canonical URL, meta tags, author), selector (keyword) highlighting, auto-scroll. Injected with `chrome.scripting` only while recording or capturing. |
| **Side panel** (`chrome.sidePanel`) | Live view: active case, recording toggle, running visit log, recent captures, quick capture buttons, notes. |
| **Toolbar popup** | Minimal: case switcher, record/pause, capture buttons, licence status. |
| **Dashboard** (extension page in a full tab) | Case management, timeline, capture viewer, WACZ replay, search, tags, notes, export, verification, settings, billing. |
| **Verifier** (`verify.html`, also shipped inside exports) | Standalone page that recomputes every hash, the audit chain and the signatures. It makes no network calls. |

### 5.2 Storage

| Store | Contents |
|---|---|
| **IndexedDB** (`evicap` DB) | Metadata: cases, visits, captures, artefact records, notes, tags, selectors, audit events, search index, keys. |
| **Origin Private File System (OPFS)** | Artefact bytes: screenshots, MHTML, WARC/WACZ, images, videos. Large files are written as streams. |
| **`chrome.storage.local`** | Settings, active case id, cached licence entitlement. |
| **Disk mirror** (optional, offered during onboarding) | The user chooses a folder on their computer through the File System Access API (`showDirectoryPicker`). EviCap saves each case there as plain files plus manifests, as it is captured. This is the main protection against data loss on uninstall or when browser data is cleared (see §11.4), and it makes backups easy. Chrome 122+ keeps the folder permission between sessions. |

**Disk mirror rules:**
- The mirror is optional. Onboarding (F13) offers it, and a dismissible reminder appears in the dashboard until a folder is set or the user turns the reminder off.
- The browser doesn't tell EviCap the folder's full path, so it can't detect a cloud-synced folder (OneDrive, Dropbox, Google Drive, iCloud Drive). Onboarding warns the user not to pick one, because the sync service would upload the evidence.
- Each artefact is written to the mirror after its hash, manifest and audit event are committed. The mirror copy is re-hashed and compared with the recorded hash.
- If the folder permission is lost (for example, after the folder is moved or the browser is reset), EviCap shows a warning and queues the writes until the user picks the folder again. The queued files are then written and checked.
- The mirror only ever goes to a local or user-chosen folder. EviCap never uploads it anywhere.

- The extension requests the `unlimitedStorage` permission, calls `navigator.storage.persist()` and monitors free space with `navigator.storage.estimate()`.
- It warns the user at 80% of available space and blocks new captures, with a clear message, at 95%.

### 5.3 Suggested tech stack

- **Language/build:** TypeScript, with [WXT](https://wxt.dev) as the extension framework (it handles MV3 and builds for Chrome, Edge and Firefox).
- **UI:** Preact or React, with plain CSS.
- **Hashing:** WebCrypto `crypto.subtle.digest('SHA-256')` for small inputs. `hash-wasm` for streaming SHA-256 over large files (WebCrypto can't stream).
- **Signatures:** WebCrypto ECDSA P-256 (§7.3).
- **Timestamps:** an RFC 3161 request/response and CMS library (for example `pkijs`) for building requests and checking tokens (§7.5).
- **WARC/WACZ:** `warcio.js` (Webrecorder) to write WARC records; WACZ packaging per the Webrecorder spec. Check every library's licence before adopting it (some Webrecorder projects are AGPL-3.0).
- **ZIP:** `fflate` or `zip.js` (streaming).
- **Search:** `MiniSearch` or `FlexSearch` (in-browser full-text index).
- **Canonical JSON:** RFC 8785 (JCS) serialiser for anything that gets hashed or signed.
- **Billing:** Stripe Payment Links (no Stripe code in the extension) and Civil Digital's licence service (`service/`, a Cloudflare Worker) — see §9.
- **Tests:** Vitest for unit tests; Playwright with the unpacked extension loaded for end-to-end tests.

## 6. Features

Priority: **P0** = v1 must have, **P1** = v1 should have, **P2** = later.

### F1 — Cases and recording (P0)

- Create, rename, close, archive and delete cases. Fields: name, reference/case number, investigator name, organisation, description, created/closed timestamps.
- **Exactly one active case** at a time. Recording (the visit log and auto-capture) only happens while a case is active and recording is on.
- **Record / Pause** toggle in the popup, side panel and a keyboard shortcut. The toolbar badge shows the state: red dot = recording, grey = paused.
- Optional **per-case domain scope**: record everything, or only listed domains.
- **Global denylist** (never log), pre-filled with common banking, health and email domains; the user can edit it.
- Incognito: off by default. If the user allows the extension in incognito, recording there needs a separate explicit opt-in per case.

### F2 — Running log of sites visited (P0)

While a case is recording, every top-level navigation in every tab is written to the visit log automatically.

**Sources:**
- `chrome.webNavigation.onCommitted` (frameId 0): standard navigations, with `transitionType` and `transitionQualifiers` (typed, link, reload, form_submit, redirect…)
- `chrome.webNavigation.onHistoryStateUpdated` and `onReferenceFragmentUpdated`: single-page-app route changes (common on social media)
- `chrome.tabs.onUpdated`: final title and favicon
- `chrome.webRequest.onBeforeRedirect`: the redirect chain leading to the final URL (read-only, non-blocking)
- `chrome.tabs.onActivated`, `chrome.windows.onFocusChanged`: dwell time (how long the tab was in focus)

**Visit record:**

```jsonc
{
  "id": "uuid",
  "caseId": "uuid",
  "seq": 1042,                      // monotonic per case
  "url": "https://example.com/post/123",
  "finalUrl": "https://example.com/post/123?ref=x",
  "redirectChain": ["https://t.co/abc", "https://example.com/post/123"],
  "title": "…",
  "tabId": 812, "windowId": 3, "openerTabId": 800,
  "transitionType": "link",
  "transitionQualifiers": ["from_address_bar"],
  "referrer": "https://search.example/…",   // from content script, if available
  "navigatedAtUtc": "2026-11-16T10:42:07.123Z",
  "tzOffsetMinutes": 0,
  "leftAtUtc": "2026-11-16T10:44:51.004Z",
  "focusedMs": 151230,
  "spa": false,
  "autoCaptureId": "uuid|null",
  "auditEventHash": "sha256:…"
}
```

- Every visit writes a `visit.recorded` audit event (§7.4), so the log is part of the hash chain and can't be silently edited.
- **UI:** a live list in the side panel. In the dashboard, a timeline with filters by domain, time, tab and tag.
- **Exports:** CSV, JSON, and inside the PDF/HTML report.

### F3 — Automatic page capture (P0, Hunchly-style)

When enabled for a case (default **on**), each logged page also gets a lightweight capture once it has loaded and been idle for about 1.5 s:

- **MHTML** via `chrome.pageCapture.saveAsMHTML`
- **Screenshot of the visible area** via `chrome.tabs.captureVisibleTab`
- **Page text** extracted by the content script, for search
- **SHA-256** of each artefact

Rules:
- **Deduplication:** if the extracted text and MHTML body hash match the previous capture of the same URL in the same case, link to the existing capture instead of storing a new one.
- **Throttling:** at most one auto-capture per tab every N seconds (default 5). Skip pages over a size threshold (default 50 MB MHTML) and log the skip.
- **No debugger:** auto-capture never attaches `chrome.debugger`, so the "being debugged" banner doesn't appear while browsing.
- **Linking:** each visit records the id of its auto-capture (`autoCaptureId`), set in the same database transaction as the capture's audit event. A deduplicated visit points at the earlier capture and gets a `capture.reused` audit event; a skipped page gets `capture.skipped` with the reason and size.
- **Comparison:** the MHTML hash used for deduplication is taken after removing what changes on every save (the header block, the MIME boundary and Blink's per-save part ids). The stored file is never altered; both hashes are kept in the capture metadata.
- **Off screen:** `captureVisibleTab` can only see the active tab, so a page loaded in a background tab is saved without a screenshot and the capture is marked degraded with that reason.
- A newer navigation in the same tab cancels a pending auto-capture, and nothing is captured if recording was paused or the active case changed in the meantime.

### F4 — Forensic page capture (P0)

A manual, one-click capture that records everything about the current page. It uses `chrome.debugger` (Chrome DevTools Protocol) and shows Chrome's "EviCap started debugging this browser" banner while it runs. Tell users this in onboarding.

**Steps:**
1. Attach the debugger, then enable the `Network`, `Page`, `DOM` and `Security` domains.
2. **Optional reload with capture on.** Reloading with network recording active captures every request and response from the start. The default is "capture current state without reload"; the user can choose "reload & capture".
3. **Optional auto-scroll** to trigger lazy loading, with configurable limits (max height or time). Optional "expand all" clicks on elements matching configured selectors (v1.x recipes).
4. Collect:
   - **Network:** every request and response with headers, timing, `remoteIPAddress`/port and protocol. Response bodies via `Network.getResponseBody`.
   - **TLS:** `securityDetails` (protocol, cipher, certificate subject/issuer/SAN/validity, certificate transparency status) and the certificate chain (`Network.getCertificate`).
   - **Full-page screenshot:** `Page.captureScreenshot` with `captureBeyondViewport: true`, PNG. Very long pages are tiled and stitched in the offscreen document, with tile hashes recorded.
   - **MHTML:** `Page.captureSnapshot`.
   - **Rendered DOM:** serialised HTML (`DOM.getOuterHTML`), plus the original source HTML from the network body.
   - **Metadata:** title, canonical URL, meta/OpenGraph tags, `document.lastModified`, links on the page (list of outbound URLs), visible text.
   - **Environment:** extension version, browser name/version, OS, user agent, screen/viewport size, device pixel ratio, timezone, system clock time at start and end.
5. **Package** as **WACZ**: WARC records for every response, plus `pages.jsonl` and `datapackage.json`. Screenshots and MHTML are stored alongside as separate artefacts.
6. **Hash and sign:** hash every file, build the capture manifest (§7.2), sign it (§7.3), write the audit event, then detach the debugger.

**Failure handling:**
- If DevTools is already attached to the tab, the debugger can't attach. Fall back to the F3 method, mark the capture as *"degraded: debugger unavailable"*, and record this in the manifest.
- If a body can't be retrieved (evicted from cache, streaming), list it in the manifest as `bodyUnavailable` with the reason.
- Without a reload, the page's resources are read from the browser's memory (`Page.getResourceContent`) and stored as WARC `resource` records, which have no HTTP headers. The page's own HTML is often not kept in memory (never for `no-store` pages); it is then downloaded again at capture time (D5), stored as a `response` record with `WARC-EviCap-Refetched: true`, and the capture is marked degraded. `dom.html` is always the page as displayed.

**Files in a forensic capture:** `page.wacz` (primary), `fullpage.png` (or tiles), `page.mhtml`, `dom.html`, `source.html`, `network.json` (every request with headers, timing, server address and body status), `tls/chain.pem` (HTTPS only), `links.json`, `text.txt`.

**WACZ writer:** EviCap writes WARC 1.1 and WACZ 1.1.1 itself (one gzip member per record, a CDXJ index with SURT keys, `pages.jsonl`, `datapackage.json` and `datapackage-digest.json`, stored uncompressed in the ZIP). The Webrecorder libraries are AGPL-3.0, so none are bundled. Decoded bodies are stored, so `Content-Encoding` is renamed to `X-EviCap-Original-Content-Encoding` and `Content-Length` is set to the stored length.

### F5 — Screenshots (P0)

| Mode | How | Shortcut (default, editable) |
|---|---|---|
| Visible area | `tabs.captureVisibleTab` (PNG) | `Alt+Shift+S` |
| Full page | CDP `captureBeyondViewport`; falls back to scroll-and-stitch without the debugger | `Alt+Shift+F` |
| Region | Content-script overlay; drag a rectangle; the visible area is captured and cropped in the offscreen document. Crops beyond the viewport are stitched. | `Alt+Shift+R` |
| Element | Hover to highlight a DOM element, click, and capture its bounding box (scrolled into view and stitched if tall) | via the menu |

- **Stamp, but don't alter.** The PNG stays pristine. A metadata sidecar holds URL, title, UTC time, viewport, device pixel ratio, scroll position, the region rectangle and SHA-256. An optional **"burned-in"** derived copy shows the URL, time and hash in a footer; it is stored as a child artefact with its own hash.
- **Annotations (P1):** arrows, boxes, text and blur, saved as a derived artefact. The original is untouched and the link is logged.
- **Format:** PNG by default; JPEG optional for derived copies only.

### F6 — Capture selected images (P0)

**Entry points:**
- Right-click an image, then **"EviCap: Capture image"** (`contextMenus`, contexts `image`).
- **Media picker mode** (toolbar or `Alt+Shift+M`): an overlay highlights every image, video, CSS background image and `<picture>`/`srcset` candidate on the page. The user ticks one or many, then clicks **Capture selected**. Multi-select capture is a key time-saver.
- **"Capture all images on page"** (P1), with a minimum-size filter.

**Process for each image:**
1. Pick the best source: `currentSrc`, the largest `srcset` candidate, or `data-src`/lazy-load attributes (configurable in Settings → Images: the largest version, the default, or the one displayed). Every candidate the page offered is recorded in the metadata.
2. Get the **original bytes** rather than the re-encoded pixels, trying in order:
   1. the network response body from the debugger, if a forensic session is active (from M3)
   2. `fetch()` from the extension with host permission, credentials included where the browser allows
   3. `fetch()` from the content script in the page's own context (same-origin or CORS-allowed)
   4. last resort: draw to canvas and export PNG, marked *"re-encoded: original bytes unavailable"*
3. Keep EXIF and other embedded metadata exactly as delivered (no re-encoding). Parse and display EXIF in the viewer as read-only.
4. Record: source URL, page URL, alt/title/aria text, rendered and natural dimensions, MIME type, response headers (where available), surrounding text snippet, DOM path, retrieval method and SHA-256.
5. Also take an **in-context screenshot** of the element on the page (child artefact), which shows where the image appeared.

### F7 — Capture selected videos (P0)

Many sites stream video rather than serving a single file, so EviCap supports three methods and picks the best one automatically. The method used is always recorded.

| Method | When | How |
|---|---|---|
| **A. Direct file** | `<video>` `currentSrc` is a normal `http(s)` URL (mp4/webm/mov) | Stream download into OPFS with **incremental SHA-256** while writing. Supports resume via `Range` requests. Shows progress. |
| **B. Stream manifest** (P1) | HLS (`.m3u8`) or DASH (`.mpd`) seen in network traffic, not encrypted | Download the manifest and all segments of the chosen rendition, hash every segment and the manifest, then store them and also remux to one MP4 (derived artefact). Originals are kept. |
| **C. Tab recording** | `blob:`/MediaSource streams, encrypted media, or anything else | `chrome.tabCapture.getMediaStreamId` feeds an offscreen `MediaRecorder` (WebM, VP9/Opus, tab audio included). The user starts and stops it from the popup, the side panel, the right-click menu or a shortcut; the toolbar badge shows **REC** while it runs. There is deliberately no in-page overlay, because it would appear in the evidence video. The browser only allows recording a tab the user has just invoked EviCap on (toolbar button, menu or shortcut). Hashing runs incrementally on chunks in the offscreen document, and the final file hash is recorded at stop; the service worker then re-hashes the stored file and the two must match. The manifest records start/stop UTC times, the visited URL(s) during recording, and the visible-tab size. |

- **Entry points:** right-click a video, then **"EviCap: Capture video"**; the media picker (F6); or **"Record this tab"** in the popup or side panel.
- **Poster/thumbnail and metadata:** duration, dimensions, `currentTime`, captions/track URLs (also downloaded and hashed).
- **DRM:** if the media is EME-encrypted, Method C recording will show black frames. EviCap detects EME (`MediaKeys` on the element), warns the user, and records that the content is DRM-protected.
- **Large files:** no fixed limit beyond storage quota. A warning appears above 2 GB.
- **Interruptions:** a direct download that drops is resumed with `Range` (up to three times, each offset recorded); one that fails is logged as `capture.incomplete` with the reason. A tab recording is written to storage as it runs but only finalised when it stops, so if the browser itself closes mid-recording, that recording is lost and logged as incomplete.

### F8 — Notes, tags and selectors (P0 notes and tags; P1 selectors)

- **Notes:** free text, attachable to a case, visit or capture. Every create and edit is an audit event; edits keep the previous version.
- **Tags:** free-form, filterable everywhere.
- **Selectors** (keyword watch list, like Hunchly's): a per-case list of names, usernames, emails, phone numbers or regexes. While recording, the content script highlights matches on every page and writes a `selector.hit` record (term, URL, snippet, time). A side-panel counter shows the hits.

### F9 — Search and review (P1)

- Full-text search over page text, notes, titles, URLs and EXIF, scoped to a case or all cases.
- **Timeline view:** visits and captures on one time axis.
- **WACZ replay:** `replayweb.page` is AGPL-3.0, so it is not bundled. Instead the dashboard has a built-in **offline snapshot** (built in M3): the captured DOM with scripts, frames and event handlers removed, every image, stylesheet and font replaced by a `data:` URL from the WACZ, links disabled, and a CSP of `default-src 'none'` plus `data:` for images, styles, fonts and media, shown in a sandboxed frame. Anything not in the archive is left blank, so viewing never contacts a website. For full interactive replay the user can save the WACZ and open it in any WACZ viewer.

### F10 — Export and reporting (P0)

**Case export** produces one `.zip` with this layout:

```
EviCap_<case-ref>_<UTC timestamp>.zip
├── manifest.json            # every file, size, SHA-256
├── manifest.sig             # signature over JCS(manifest.json)
├── public-key.jwk           # install public key
├── audit-log.jsonl          # full hash-chained audit log
├── timestamps/              # FreeTSA tokens (.tsr) and certificates, if timestamping is on
├── visits.csv / visits.json
├── captures/<capture-id>/…  # WACZ, PNG, MHTML, images, videos, sidecar JSON
├── report.html              # human-readable report
├── report.pdf               # same, printed to PDF
└── verify.html              # offline verifier (no network)
```

- **The report includes:** case details, investigator, environment, a summary of what EviCap does and does not prove, a visit log table, an exhibit index (each capture with thumbnail, URL, UTC time, method and SHA-256), notes, selector hits, the audit chain head hash, and any trusted timestamps (capture time and TSA time side by side).
- **Exhibit-only export:** selected captures only, with the same manifest, signature and verifier.
- The **export file's own SHA-256** is computed after writing, shown to the user and recorded as an `export.created` audit event. That event is logged inside the case, but cannot be inside the ZIP it describes.
- PDF generation: open the report in an extension tab and use CDP `Page.printToPDF`. If that is unavailable, the user prints manually.

**As built (M4):**
- The export runs in the dashboard and streams into a ZIP in OPFS (`exports/<exportId>/`), so large cases are never held in memory. EviCap writes the ZIP itself: entries are stored uncompressed (evidence files are mostly compressed already, and stored entries can be checked one by one), and ZIP64 records are added only when a size or offset needs them, so ordinary exports open in every ZIP tool. Free space is checked first.
- Also in the ZIP: `case.json`, `captures.json` (every capture record with its exhibit number) and `notes.json` (with version history). `timestamps/` will be added with trusted timestamping.
- **Exhibit numbers** are stable within a case: top-level captures in time order (EV-001, EV-002…), with related artefacts lettered (EV-001a). They are the same in a whole-case and an exhibit-only export.
- **Export manifest** (`evicap.export/1`): export id and kind, case details, software and environment, key fingerprint, audit chain head, the captures with their capture hashes and exhibit numbers, whether the PDF is included, and every file's path, size and SHA-256. It is signed like a capture manifest.
- **Exhibit-only export:** the chosen captures and their related artefacts, the visits and notes about them, and the full audit log in which every unrelated event has `payload: null, redacted: true`. An event's hash covers its payload's hash, not the payload, so the chain still verifies end to end without revealing the other sites visited.
- `visits.csv` is UTF-8 with a byte-order mark. A cell that starts with `=`, `+`, `-`, `@` or a tab gets a leading apostrophe so spreadsheets don't run it as a formula; `visits.json` keeps the exact values.
- The PDF is printed from a hidden extension page (`print.html`) with `Page.printToPDF`; the debugging bar shows for a moment. If printing fails, the export still completes, without `report.pdf`, and the manifest says why.
- Saving uses an ordinary browser download of the file in OPFS, so the `downloads` permission isn't needed. EviCap keeps its copy until the user removes it from **Previous exports**; the record stays in the audit log.
- `verify.html` is built from the same TypeScript as the dashboard's verifier (`src/verifier`), bundled into one file at build time, with a CSP of `default-src 'none'`.

### F11 — Verification (P0)

- **Dashboard and verifier:** verify a case, a capture or an imported bundle. The verifier:
  1. recomputes the SHA-256 of every file and compares it with the manifest
  2. checks the manifest signature with the bundled public key
  3. walks the audit chain and checks every `prevHash`
  4. checks every timestamp token against the hash it covers and the bundled FreeTSA certificates
  5. shows a pass/fail report with details for each item
- The verifier is a single static HTML/JS file with no external dependencies and no network calls. It works when opened from disk in any modern browser.
- It also checks each capture's own signed manifest against its files and against the `capture.created` audit event that recorded it, and warns about files in the bundle that the manifest doesn't list.
- In the dashboard, **Check this case** re-hashes every stored file, checks every capture manifest and signature and walks the chain; **Verify** checks an export file. Both are recorded as `verify.run` events (a bundle check only when its case is in this browser).

### F12 — Settings (P0)

- Auto-capture on/off and its throttles
- Default screenshot mode and format
- Domain denylist; per-case scope
- Disk mirror folder, with its status (last write, queued files)
- Keyboard shortcuts (link to `chrome://extensions/shortcuts`)
- Storage usage
- Licence status
- Trusted timestamping (opt-in, off by default, §7.5) and the chain-head interval

### F13 — Onboarding (P0)

The first-run tab explains:
- that data is stored only on this device, and uninstalling or clearing browser data deletes it unless it has been exported or mirrored
- what the debugger banner means
- a privacy summary: nothing leaves the device except billing, and timestamp hashes if the user turns timestamping on, with a link to `PRIVACY.md`
- the Free and Pro plans, and how to start the trial

It then offers to set up a disk mirror folder (§5.2), with a warning not to pick a cloud-synced folder. This step is optional.

## 7. Integrity design

### 7.1 Hashing
- **Algorithm:** SHA-256 only, for every stored artefact, computed over the exact bytes written to storage (streamed for large files). MD5 and SHA-1 are not offered.
- **Form:** hashes are stored as lowercase hex, prefixed `sha256:`.
- **Timing:** the hash is computed and recorded **before** the capture appears in the UI.
- **Re-hash on view (P1):** opening an artefact re-hashes it in the background and flags any mismatch.

### 7.2 Capture manifest
Each capture has a manifest:

```jsonc
{
  "schema": "evicap.capture/1",
  "captureId": "uuid", "caseId": "uuid",
  "type": "forensic|auto|screenshot|image|video",
  "method": "cdp|pageCapture|direct-fetch|hls|tab-recording|…",
  "degraded": [],                       // reasons, if any
  "url": "…", "title": "…",
  "startedAtUtc": "…", "completedAtUtc": "…",
  "environment": { "extension": "1.0.0", "browser": "Chrome 142…", "os": "…", "tz": "Europe/London" },
  "files": [ { "path": "page.wacz", "bytes": 123456, "sha256": "…" } ],
  "parent": null,                       // for derived artefacts
  "meta": { }                           // viewport, scroll, region, page metadata…
}
```

The **capture hash** is the SHA-256 of the RFC 8785 canonical JSON of this manifest. The manifest can't contain the hash of the audit event that records it, because that event includes the capture hash, so the link is stored on the capture record (`auditEventHash`) and in the event's payload.

### 7.3 Signing
- **Key:** on install, EviCap generates an ECDSA P-256 key pair with WebCrypto. The private key is **non-extractable** and stored in IndexedDB as a `CryptoKey`.
- **What is signed:** every capture manifest and every export manifest.
- **Identity:** the public key and its fingerprint (SHA-256 of the SPKI) are shown in Settings and included in every export. The investigator can record the fingerprint in their notes or statement to link the key to themselves.
- **Limitation (stated in the report):** the key is self-generated. It proves that the same EviCap install produced the evidence and that it hasn't changed since. It doesn't independently prove who that installation belongs to.

### 7.4 Audit log (chain of custody)
- Append-only events in IndexedDB. There is no update or delete path in the data layer.
- **Event:**

  ```jsonc
  { "seq": 1, "caseId": "…", "type": "…", "atUtc": "…", "payload": { … },
    "payloadHash": "sha256:…", "prevHash": "sha256:…", "hash": "sha256:…" }
  ```

  where `hash = SHA-256(JCS({seq, caseId, type, atUtc, payloadHash, prevHash}))`.
- **Event types include:**
  - `case.created`, `case.updated`, `case.closed`, `case.reopened`
  - `recording.started`, `recording.paused`
  - `visit.recorded`, `visit.closed` (seals the final title, referrer and time in focus)
  - `capture.created`, `capture.incomplete`, `artefact.derived`, `clock.anomaly`
  - `note.created`, `note.edited`, `tag.added`, `tag.removed`, `selector.hit`
  - `export.created`, `verify.run`, `settings.changed`
  - `timestamp.obtained`, `timestamp.failed`
  - `artefact.deleted`, `licence.changed`
- **Deletion** asks for a reason. Artefact bytes are removed, but a tombstone event keeps the original hash and the reason, so the gap is visible and explained.
- **Chain head:** the current hash is shown in the case header and the report.

### 7.5 Trusted timestamping (P1, opt-in, off by default)
EviCap's own times come from the computer's clock, which the user can change. A trusted timestamp from an outside authority proves a hash existed at a given time, independently of that clock.

- **Service:** FreeTSA (`https://freetsa.org/tsr`), a free RFC 3161 Time Stamping Authority. It is the only TSA in v1, so the network allow-list stays fixed.
- **What is sent:** an RFC 3161 request containing only a SHA-256 hash and a random nonce. No URLs, content, case details or identity. As with any connection, FreeTSA sees the user's IP address and the time of each request. Onboarding and the privacy policy say so.
- **What is stamped:**
  - each manual capture's capture hash (§7.2), when the capture completes
  - the audit chain head, every 15 minutes while recording (configurable). This covers visits and auto-captures without a request per page.
  - each export manifest
- **Token:** the returned token (`.tsr`) is stored with the capture or case, and written to the disk mirror and to exports. A `timestamp.obtained` audit event records the stamped hash, the token's hash and the TSA's time. The token can't sit inside the manifest it stamps, so it is linked by the capture hash.
- **Verification:** FreeTSA's TSA and CA certificates are bundled in the extension and in every export, so tokens are checked offline. EviCap never downloads them at runtime.
- **Offline or failure:** captures never wait for a timestamp. Failed requests are queued and retried with backoff, and a `timestamp.failed` event is logged. The report shows the capture time and the TSA time side by side, so a late token is visible.
- **Limits (stated in the report):** FreeTSA is a free service with no service-level guarantee, and it is not an eIDAS-qualified TSA. A token proves the hash existed by the TSA's time; it doesn't prove who made it. Keep request volume modest, and check FreeTSA's terms of use before launch.

### 7.6 Clock
- Timestamps come from the system clock in UTC, with the timezone offset recorded.
- The report states that times come from the computer's clock, except where a FreeTSA token is present.
- Large clock jumps (detected by comparing `Date.now()` with `performance.timeOrigin + performance.now()` across events) are logged as `clock.anomaly`.

## 8. Permissions

| Permission | Why | Notes for store review |
|---|---|---|
| `storage`, `unlimitedStorage` | Settings, licence cache, large evidence store | — |
| `tabs` | URLs and titles for the visit log; screenshots | — |
| `webNavigation` | Visit log (F2) | — |
| `webRequest` (non-blocking) | Redirect chains | Read-only; never modifies requests |
| `scripting` | Inject media picker, region selector, metadata collector | — |
| `activeTab` | Capture the current tab on user action | — |
| `contextMenus` | Right-click capture for images and videos | — |
| `pageCapture` | MHTML | — |
| `debugger` | Forensic capture (F4), full-page screenshots, response bodies, TLS details | **Sensitive; expect manual review.** Only attached during a user-initiated capture. Justification text must be written carefully. |
| `tabCapture`, `offscreen` | Tab video recording (F7-C), hashing, ZIP building | — |
| `sidePanel` | Live log UI | — |
| `alarms` | Plan check every 6 hours (on the device; the licence service is asked about once a day, and only once a subscription key has been entered), periodic chain-head timestamp (opt-in) | — |
| Host permissions `<all_urls>` | Recording and capture work on any site the investigator visits; cross-origin media fetch | Requested at install, since recording all sites is the core function. Explain this in the listing. |
| The licence service (`*.workers.dev`) | Renewing a subscription licence key (§9) | Already covered by `<all_urls>`; listed for transparency. Only after the user enters a subscription key. |
| `https://freetsa.org/*` | Trusted timestamping (§7.5), opt-in | Already covered by `<all_urls>`; listed for transparency. Sends a hash only. |

Chrome version: **Chrome 116+** (promise-based `pageCapture`, mature offscreen and sidePanel APIs). Target the current stable release.

## 9. Billing (Stripe Managed Payments)

### 9.1 Why Stripe Managed Payments
The Chrome Web Store no longer handles payments. Stripe Managed Payments was chosen (D13) because:
- Stripe is the **merchant of record** ("Sold through Link"): it sells to the customer, and collects and pays VAT and sales tax in more than 80 countries. It also handles fraud, disputes, refunds, receipts and transaction support. Civil Digital doesn't need to register for VAT abroad (D6). UK businesses and software products are eligible.
- Checkout is a Stripe **Payment Link**, so the extension contains no Stripe code and no Stripe key.
- Lemon Squeezy, chosen first, is being folded into Stripe Managed Payments and recommended it. ExtensionPay was ruled out because its client library is copyleft.

**The gap:** Managed Payments has no licence keys, and the extension must never hold a Stripe secret key. Civil Digital therefore runs a small **licence service** (`service/`, a Cloudflare Worker, free tier) that turns a paid subscription into an EviCap licence key. It stores nothing.

### 9.2 Integration (as built)
- **Stripe objects** (live, Civil Digital Services): product *EviCap Pro* (tax code `txcd_10202003`, downloadable software, business use), prices £4/month (`price_1UcQm5QeMXeU9ocQ5MDGzuu9`) and £40/year (`price_1UcQm6QeMXeU9ocQ92CxjzLf`), both VAT-inclusive so buyers pay exactly £4 / £40; Payment Links with Managed Payments for each.
- **Buying:** Settings → Plan shows *Buy monthly* and *Buy yearly*, which open the Payment Links in a new tab. The extension sends nothing.
- **Getting the key:** after payment, Stripe redirects to the service's `/success?session_id=…` page. The service checks the Checkout Session with Stripe (complete, a subscription, an EviCap Pro price, still live) and shows a signed licence key with a *Copy key* button. Session IDs are unguessable, so that page works as a private link; Civil Digital can resend it from the Stripe Dashboard if a buyer loses the key.
- **Key format:** the same as invoice licences (§9.6), plus `subscriptionId`, signed with the service's own ECDSA P-256 key (public key bundled in `src/lib/licence.ts` as `SERVICE_KEY`; private key only in the service's secrets and an offline backup). The key is valid until the end of the paid period **plus 14 days**.
- **Activation:** the user pastes the key into Settings → Plan. It is checked on the device; **no request is made**.
- **Renewal:** about once a day (the 6-hourly `plan-check` alarm, skipped if the last attempt was under 20 hours ago) and on *Check now*, the extension sends the key to the service's `/refresh`. The service checks the subscription with Stripe and returns a renewed key (`active`, `trialing` or `past_due`, while Stripe retries a payment) or `ended`.
- **Grace:** if the service or Stripe can't be reached, the current key keeps working until it runs out (end of the paid period plus 14 days). Existing data is never locked (principle 5).
- **Cancelling:** customers manage their subscription at Stripe's Onelink (`app.link.com`), linked as *Manage subscription*. A cancelled subscription stays `active` until the paid period ends; the next renewal after that returns `ended`.
- **Removing:** *Remove from this computer* deletes the key locally; nothing is sent. There is no per-device activation limit (the key names its buyer; see §9.4).
- **No billing connection until the user acts (D4):** the extension contacts the licence service only after a subscription key is pasted. Buying happens on Stripe's own pages.
- **Trial:** 14 days, run on the device (§9.7). It sends nothing and needs no email address.
- **Deployed** (16 November 2026) at `https://evicap-licence.withered-resonance-d668.workers.dev` (Civil Digital's Cloudflare account). Both Payment Links redirect to its `/success` page, and `serviceUrl` in `src/lib/billing-config.ts` points to it. Deploy steps: `service/README.md`.

### 9.3 Plans and pricing

**Principle:** Free handles occasional cases well; Pro is for people who investigate every day. Everything that makes evidence trustworthy (hashing, audit log, signing, verifier, export, disk mirror) is free on every plan.

**Pro price (per user):**

| Billing | Price | Stripe price |
|---|---|---|
| Monthly | £4 per month, VAT included | `price_1UcQm5QeMXeU9ocQ5MDGzuu9` |
| Annual | £40 per year (two months free), VAT included | `price_1UcQm6QeMXeU9ocQ92CxjzLf` |

- A 14-day Pro trial is available, run on the device (§9.7).
- For comparison (November 2026): Hunchly Classic is $169 / €149 per year (about £128) with a 30-day trial and no free plan. Forensic OSINT Essential is $197 per year.

| Feature | Free | Pro |
|---|---|---|
| Open cases | 2 (closed cases don't count, and stay fully viewable and exportable) | Unlimited |
| Visit log | ✓ | ✓ |
| Auto-capture (F3) | ✓ (limit: 100 per case) | Unlimited |
| Screenshots, all modes | ✓ | ✓ |
| Image capture | Single (right-click) | Single + multi-select picker + capture all |
| Video capture | Direct file only | Direct + streams + tab recording |
| Forensic capture (F4, WACZ) | 10 per month | Unlimited |
| Hashing, audit log, signing | ✓ | ✓ |
| Export, reports, verifier | ✓ (always) | ✓ + branded reports, exhibit-only export |
| Selectors, search | — | ✓ |
| Trusted timestamping (FreeTSA) | — | ✓ |
| Disk mirror | ✓ (always) | ✓ |
| v1.x: annotations, case encryption, social-media capture recipes | — | ✓ |

### 9.4 Enforcement caveat
Because there is no server, paywall checks run in the client and a determined user could bypass them. That is accepted for v1. Paid value that can be enforced server-side, such as cloud signing or sync, would need a backend, which is deliberately out of scope for the local-only v1.

### 9.5 What billing transmits
The checkout happens on Stripe's pages: the buyer gives Stripe their email address and payment details, which the extension never sees. The extension itself sends only the subscription licence key to Civil Digital's licence service, about once a day; the key holds the buyer's email, name and Stripe subscription ID, which Stripe and Civil Digital already have. The service passes nothing on except a lookup of that subscription at Stripe. **No case data, visit history or captures.** Users who never paste a subscription key send nothing. Invoice licences (§9.6) send nothing at all. This is reflected in `PRIVACY.md`.

### 9.6 Invoice licences (organisations)
Organisations can pay Civil Digital by invoice or purchase order instead of by card. Civil Digital then sets up their users.

- **Licence key:** Civil Digital issues each user a signed licence key. It is the RFC 8785 canonical JSON of `{schema: "evicap.licence/1", licenceId, org, email, plan: "pro", issuedAtUtc, expiresAtUtc}`, signed with Civil Digital's ECDSA P-256 licence-signing key and encoded as text the user can paste. The matching public key is bundled in the extension.
- **Activation:** the user pastes the key into Settings → Plan. EviCap checks the signature and expiry on the device. **No network request is made**, so this route sends nothing off the device, not even billing traffic.
- **Either route unlocks Pro:** an invoice licence key or a subscription key from the licence service. Settings → Plan shows which one is in use.
- **Expiry:** keys are issued for 12 months. EviCap shows a renewal reminder 30 days before expiry. After expiry, the same rules as a lapsed subscription apply: Pro features switch off, and existing data is never locked (principle 5).
- **Issuing:** Civil Digital runs a small offline script (`tools/issue-licence`, in this repo) to sign keys. The private key never ships in the extension. Keep it offline and backed up; if it leaks, anyone can make keys, and the bundled public key must be replaced in an update.
- **Limits:** without a server, EviCap can't check a key against other installs or revoke it early. Issue one key per user, so a shared key can be traced to its licence, and rely on the 12-month expiry instead of revocation (as accepted in §9.4).
- **Audit:** activating, replacing or expiring a key writes a `licence.changed` event.

### 9.7 As built (M5)

**Done:**
- **Plans** (`src/lib/plan.ts`, `src/lib/plan-sw.ts`). Pro comes from, in order: a valid licence key, a cached paid subscription (kept for 14 days without an answer from the provider), or the trial. Everything is checked on the device.
- **Trial:** 14 days, started from Settings → Plan, once per browser profile. It is stored in `chrome.storage.local` and sends nothing. It keeps D4 (no billing connection until the user buys) and asks for no email address. Like every client-side check (§9.4), reinstalling resets it; that is accepted.
- **Licence keys** (`src/lib/licence.ts`): `EVICAP1-<base64url(JCS payload)>.<base64url(ECDSA P-256 signature)>`. Whitespace is ignored, so a key broken across lines by an email client still works. Test builds (`wxt build --mode e2e`, output in `.output/chrome-mv3-e2e`) also trust a test key in `tests/fixtures/`. Production builds trust only Civil Digital's key.
- **Issuing:** `node tools/issue-licence.ts issue --org "Acme Ltd" --email jo@acme.example [--months 12]` prints a key and appends it to `tools/keys/issued-licences.csv`. The signing key was created with `init` and lives in `tools/keys/`, which git ignores. **Back up `tools/keys/` offline.**
- **Limits** are enforced in the service worker: open cases (creating or re-opening a case), forensic captures per calendar month (UTC), and automatic captures per case (further pages are still logged; the first skip writes a `capture.skipped` event). On Free, the media picker, tab recording and exhibit-only export are refused with a message saying the feature is Pro and how to start the trial. Single right-click image capture and direct video stay free.
- **UI:** Settings → Plan (plan, usage, trial, licence key, prices, contact for invoices); a Free/Pro marker in the dashboard top bar; Pro markers on the picker and tab-recording buttons; renewal and trial-ending banners; an onboarding step about the plans.
- **Audit:** every plan change (licence activated, replaced or removed, trial started, expiry noticed by the 6-hourly `plan-check` alarm) writes `licence.changed` to each open case. Closed cases are left as they were.

- **Branded reports** (`src/lib/branding.ts`, Settings → Report branding). Pro users can set an organisation name ("Prepared by …" on the cover), a logo, a heading colour and a protective marking such as OFFICIAL-SENSITIVE, which is printed at the top and bottom of every PDF page and above the cover. Branding changes only the look: the integrity sections and the "Generated by EviCap" footer stay. Logos are redrawn as PNG (at most 900 × 300 px), which drops metadata and anything that isn't pixels. Colours must have at least 4.5:1 contrast on white. Branding is stored apart from the settings, and changes write `settings.changed` with the logo's SHA-256 rather than the image. On Free the saved branding is kept but not used. `export.created` records `branded: true/false`.
- **Subscriptions:** the licence service (`service/src/index.ts`) and the extension side (`src/lib/billing.ts`, `src/lib/plan-sw.ts`), as in §9.2. The service is unit-tested against a fake Stripe API; the extension is tested end to end against a fake service, whose address e2e builds read from `chrome.storage.local` (production builds ignore it).

**Not done (needs Civil Digital):**
- **A real purchase** has not been made yet: buy the monthly plan once, check the key page and activation, then refund and cancel it (§18 item 0).

## 10. Network rules (no outbound data except billing and opt-in timestamps)

**Rule:** no data leaves the device except billing traffic and, if the user turns on trusted timestamping, a hash sent to FreeTSA.

The extension may make network requests only of these kinds:

| # | Destination | Purpose | What is sent |
|---|---|---|---|
| 1 | Civil Digital's licence service (Cloudflare Worker) | Renew a subscription licence key | The key only, about once a day, and only after the user pastes a subscription key. (Checkout runs on Stripe's own pages, opened as an ordinary tab.) |
| 2 | `freetsa.org` (**opt-in, off by default**) | Trusted timestamp (§7.5) | A SHA-256 hash and a random nonce only |
| 3 | The websites the user is viewing | Re-fetch the original bytes of pages, images and video the user chose to capture (accepted, D5) | Only the ordinary request a browser sends to view the item. No case data, logs or captures are sent. |

**Hard rules:**
- No analytics, telemetry, crash reporting, remote config, remote code, ad SDKs, font/CDN loads, update pings or uninstall URLs. All code and assets are bundled (also required by MV3).
- No other third-party services, including backup or sync.
- The extension-page CSP sets `connect-src 'self' https: http:`. It cannot be narrower, because the service worker re-fetches originals from whichever site the user is capturing (row 3), and the extension CSP also governs the service worker. The narrow list is enforced in code instead: `src/lib/net.ts` is the only module in the extension's own contexts that requests site content, and the in-page media script (which runs as the page) is the only other place a request is made.
- A unit test (`tests/media.test.ts`) fails on any `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon`/`EventSource` use outside those two modules and `src/lib/billing.ts` (the licence service). FreeTSA calls will be added to the allow-list as their own module.
- An E2E test runs the extension through a recording proxy and fails on any request to a host not on the list above.

## 11. Security and data protection

1. **At rest:** data sits in the browser profile on disk. Anyone with access to the OS user account could read it.
   - The disk mirror is plain files and is not separately encrypted (D2). Integrity doesn't depend on encryption: any change to a mirrored file is caught by its hash and signature. For confidentiality, rely on full-disk encryption (BitLocker, FileVault) and the OS account password, which protect the browser profile in the same way.
   - If per-case encryption (below) is added, an encrypted case's mirror copy stays encrypted, so the mirror never weakens it.
   - P1: optional per-case passphrase encryption (AES-GCM-256, key derived with PBKDF2-SHA-256 at ≥600k iterations, or Argon2id via WASM). Hashes are computed over the plaintext and recorded before encryption.
2. **Isolation:** captured page content is never rendered in an extension-privileged context. MHTML and WACZ replay run in a sandboxed iframe (`sandbox` manifest key) with no extension API access.
3. **Content scripts:** treat the page DOM as untrusted. Never `eval` and never use `innerHTML` with page data in extension UI.
4. **Uninstall / data loss:** uninstalling the extension or clearing site data **deletes all local data**.
   - Main protection: the disk mirror (§5.2), which keeps a copy of every case as files in a folder on the user's computer. These files survive uninstalling the extension and clearing browser data.
   - Other mitigations: onboarding warning, a dismissible reminder until a disk mirror is set, a "last mirrored / last exported" indicator per case, and an export reminder when a case is closed.
   - Optional `chrome.runtime.setUninstallURL` is **not** used, because it would transmit data.
5. **Supply chain:** lockfile, pinned dependencies, `npm audit` in CI, minimal dependencies, reproducible builds, and store-signed releases.

## 12. Chrome Web Store compliance
- Single purpose: *"Capture and preserve web evidence for investigations."*
- **Privacy practices tab:**
  - Declare handling of web history, website content and (for billing) email/personally identifiable info and payment-related info.
  - State that evidence data is processed and stored locally and not transmitted.
  - Certify the Limited Use requirements.
  - Check the current definitions in the CWS User Data Policy at submission time.
- Privacy policy URL: host `PRIVACY.md` publicly (GitHub Pages or the product site).
- Permission justifications for `debugger`, `<all_urls>`, `tabCapture` and `webRequest` (copy based on §8).
- Expect manual review because of `debugger`. Use `activeTab` and optional permissions where possible.

## 13. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Visit logging adds < 5 ms per navigation in the service worker. Auto-capture never blocks page interaction. Hashing 1 GB takes < 10 s on a mid-range laptop (hash-wasm streaming). |
| Reliability | All writes are transactional. A capture is "complete" only after the bytes, hash, manifest, signature and audit event are all committed. Captures interrupted by a service-worker restart are marked `incomplete` and shown to the user. |
| Accessibility | WCAG 2.2 AA; full keyboard operation; screen-reader labels on all capture controls. |
| Localisation | UI strings in `_locales`; English at launch. |
| Time | All stored times are UTC ISO-8601 with milliseconds; the UI shows local time with the offset. |

## 14. Testing
- **Unit:**
  - hash vectors (NIST SHA-256 test vectors)
  - JCS canonicalisation vectors
  - audit chain building and tamper detection
  - manifest signing and verification
  - timestamp token checks against the bundled FreeTSA certificates (valid, wrong hash, tampered token)
- **E2E (Playwright, unpacked extension):**
  - visit log across redirects and SPA navigations
  - every screenshot mode
  - image capture from same-origin and cross-origin pages
  - direct video download
  - tab recording
  - forensic capture to WACZ, then replay
  - export, then verify with `verify.html`
- **Tamper tests:** modify one byte of an exported file and confirm the verifier flags exactly that file. Edit an audit line and confirm the chain breaks at that line.
- **Network test:** recording proxy. Fail on any request not allowed by §10.
- **Fixture site:** a local test site with lazy-load images, `srcset`, HLS, MSE and EME demo pages, redirects and an SPA.

## 15. Mobile (out of scope for v1)
Chrome on Android has no extension support, and Safari on iOS lacks `webRequest` and any `debugger` equivalent. The planned mobile route is a separate native app with its own capture browser, screen recording for in-app content, and a share-sheet capture. It would use the same case format and manifest schema, so the evidence is interoperable.

## 16. Roadmap

| Milestone | Scope |
|---|---|
| **M0 — Skeleton** | WXT project, MV3 manifest, storage layer, disk mirror, audit log, hashing/signing core, settings |
| **M1 — Logging & screenshots** | F1, F2, F5, notes/tags, side panel, basic dashboard |
| **M2 — Media** | F6, F7-A, F7-C, media picker |
| **M3 — Forensic & auto capture** | F3, F4 (WACZ), replay viewer |
| **M4 — Export & verify** | F10, F11, report HTML/PDF |
| **M5 — Billing & launch** | Done: Stripe Managed Payments products and Payment Links, the licence service (deployed), subscription and invoice licence keys, local trial, plan gating, onboarding. Branded reports. Still to do: a first live purchase test (§18 item 0), store listing submission, privacy policy hosting |
| **v1.x** | F7-B (HLS/DASH), selectors, search, annotations, trusted timestamps (FreeTSA), case encryption, Firefox build, social-media capture recipes (auto-expand comments, timeline scroll) |
| **v2** | Mobile app, zkTLS research. Anything else that sends data off the device (team sync, server-side signing) needs a change to the network rules (§10) first. |

## 17. Decisions
| # | Decision |
|---|---|
| D1 | **Publisher:** Civil Digital. Contact: info@civildigital.co.uk. No postal address is published. The product name is EviCap. |
| D2 | **Data loss:** saving cases as files in a folder on the user's computer is acceptable. The disk mirror is optional, offered during onboarding, and not separately encrypted (§5.2, §11.1). |
| D3 | **Outbound data:** none, except billing and opt-in trusted timestamping through FreeTSA, which sends a hash only (§7.5, §10). |
| D4 | **Billing connection:** none until the user pastes a subscription licence key (§9.2). Buying happens on Stripe's own pages, and the trial runs on the device. |
| D5 | **Re-fetching originals** from the websites being captured is acceptable (§10). |
| D6 | **VAT:** Civil Digital is not VAT-registered. Stripe, as merchant of record under Managed Payments, handles VAT and sales tax on card sales (D13). Prices include VAT. |
| D7 | **Auto-capture** is on by default (F3). |
| D8 | **Hashing:** SHA-256 only. No MD5 or SHA-1 (§7.1). |
| D9 | **Trusted timestamping** is a Pro feature, off by default (§9.3). |
| D10 | **Pricing:** Pro is £4 per user per month or £40 per year. Free/Pro split as in §9.3. |
| D11 | **Invoice payments:** organisations can pay Civil Digital by invoice, and Civil Digital sets up their users with offline licence keys (§9.6). |

| D12 | **No volume discounts.** Invoiced organisations pay the same per-user price. |
| D13 | **Card billing:** Stripe Managed Payments with Payment Links, plus Civil Digital's licence service for keys (§9.1). Lemon Squeezy (being merged into Stripe) and ExtensionPay (copyleft library) were considered first. The trial runs on the device. |

## 18. Open questions
0. **First live purchase test.** The licence service is deployed and checked (it reaches Stripe with the restricted key, and accepts keys signed with its signing key), but no real checkout has gone through it yet. Buy the monthly plan once with a real card, confirm the key page and activation in EviCap, then refund and cancel in the Stripe Dashboard and confirm *Check now* reports the end.
1. **Fees:** Managed Payments adds a fee on top of Stripe's card fees; check the current rate. At £4 a month, fixed per-payment fees take a larger share than on the annual plan.
