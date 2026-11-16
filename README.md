# EviCap

Forensic web evidence capture for investigators, by Civil Digital. A Chrome and Edge extension (Manifest V3) that logs every site visited while a case is recording, captures screenshots, and protects everything with SHA-256 hashes, signed manifests and a hash-chained audit log. Everything stays on the user's computer.

- Specification: [docs/SPEC.md](docs/SPEC.md)
- Privacy policy: [PRIVACY.md](PRIVACY.md)

## Status

Built so far (spec milestones M0 and M1):

- Cases: create, edit, close, reopen, archive, delete; one active case; Record/Pause
- Visit log: every top-level navigation, including redirect chains and in-page (SPA) navigation, with time in focus; denylist, per-case domain scope, incognito opt-in
- Screenshots: visible area, full page (debugger, with a scroll-and-stitch fallback), region and element
- Integrity: SHA-256 for every file, signed capture manifests (ECDSA P-256 install key), append-only hash-chained audit log per case, re-check on view, chain verification
- Disk mirror: optional copy of every case to a folder the user picks, re-hashed after writing
- Notes (with version history) and tags
- Popup, side panel, dashboard, onboarding, settings

Next: media capture (M2), automatic and forensic WACZ capture (M3), export and offline verifier (M4), billing and licence keys (M5).

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

Unit tests: canonical JSON (RFC 8785 vectors), SHA-256 (NIST vectors), audit chain building and tamper detection, signing, recording rules.

```bash
npm run test:e2e
```

Builds the extension, loads it into a real browser (Edge by default; set `EVICAP_BROWSER` to another Chromium-based browser's path) and checks recording, redirects, SPA navigation, screenshots (including the pixels of a full-page capture), signatures, the audit chain, the disk mirror and the dashboard.

## Layout

| Path | What |
|---|---|
| `src/lib/` | Core: hashing, canonical JSON, audit chain, signing, storage, recorder, screenshots, disk mirror |
| `src/entrypoints/background.ts` | Service worker: browser events, shortcuts, RPC for the UI |
| `src/entrypoints/offscreen/` | Writes the disk mirror |
| `src/entrypoints/popup/`, `sidepanel/`, `dashboard/` | User interface (React) |
| `tests/` | Unit tests; `tests/e2e/` browser tests |
| `tools/make-icons.mjs` | Draws the icons in `public/icon/` |
