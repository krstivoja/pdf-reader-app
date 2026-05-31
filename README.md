# PDF + EPUB Reader (Mac app)

Download latest:
https://github.com/krstivoja/pdf-reader-app/releases/latest

<img width="4238" height="2590" alt="Screenshot 2026-05-31 at 09 01 08" src="https://github.com/user-attachments/assets/44730e1b-8a89-4bc7-a6bc-759b49351a3a" />
<img width="4238" height="2590" alt="Screenshot 2026-05-31 at 09 01 05" src="https://github.com/user-attachments/assets/c6d813f9-5efa-4838-b169-72ef07e42228" />
<img width="4238" height="2590" alt="Screenshot 2026-05-31 at 09 00 59" src="https://github.com/user-attachments/assets/e77547c2-b18c-4b03-80e4-9b57474c43d6" />
<img width="4238" height="2590" alt="Screenshot 2026-05-31 at 09 00 55" src="https://github.com/user-attachments/assets/b5f71ee2-c358-4a93-a58f-086148a7c726" />


A local audiobook player: drag in a PDF or EPUB, pick a voice, and it reads the book
aloud using **Kokoro** TTS running on your machine. No cloud, no tokens, no
uploads, no Docker. PDF text is extracted in-app with pdf.js; EPUB text is extracted
from the book's reading-order sections. Speech comes from a bundled Kokoro inference
binary that the app launches and shuts down automatically.
Imported books are kept in a local library for quick switching, with reading
progress and page or section bookmarks saved per book.

Built with **Tauri v2** wrapping an HTML/JS front-end. The app bundle is roughly
220 MB because it includes the Kokoro model, voices, and native inference binary.

---

## 1. Prerequisites (one-time)

Install the toolchain Tauri needs:

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Xcode command-line tools (for the macOS build)
xcode-select --install

# Node.js 20+ (if you don't have it) — e.g. via Homebrew
brew install node
```

## 2. Install app dependencies

From this folder:

```bash
npm install
```

## 2a. Fetch the voice engine resources

The Kokoro ONNX model (~170 MB) and voice embeddings (~27 MB) are too large to
commit. Fetch them once:

```bash
npm run setup
```

This downloads `model.onnx` and `voices.bin` into `src-tauri/resources/tts/`.
The script is idempotent — running it again does nothing if the files are
already present.

## 3. App icons (required before first build)

Tauri needs icon files in `src-tauri/icons/`. Generate them from any square
PNG (1024×1024 works well):

```bash
npm run tauri icon /path/to/your-icon.png
```

This creates all the sizes referenced in `tauri.conf.json` (32x32.png,
128x128.png, 128x128@2x.png, icon.icns). Skip this and the build will fail on
missing icons.

## 4. Run in dev mode

```bash
npm run dev
```

This opens the app and starts its bundled Kokoro voice engine. Drag in a PDF or
EPUB and press Play.

## 5. Build the distributable Mac app

```bash
npm run build
```

Output lands in `src-tauri/target/release/bundle/`:

- `macos/PDF Reader.app` — the app bundle (drag to /Applications)
- `dmg/PDF Reader_0.1.0_aarch64.dmg` — a disk image for sharing

The bundled voice engine is currently an Apple Silicon binary, so the app runs
on M1 or newer Macs. An Intel or universal build also needs an Intel `koko`
binary in the app resources.

---

## Notes & limitations

- **Scanned PDFs** (image-only, no text layer) extract no text — they need OCR,
  which this version doesn't include. Ask if you want a Tesseract fallback added.
- **EPUB navigation** uses the book's reflowable reading-order sections instead
  of fixed pages.
- **macOS signing**: local builds use a complete ad-hoc bundle signature via
  `bundle.macOS.signingIdentity` in `src-tauri/tauri.conf.json`. Before sharing
  the DMG publicly, replace `-` with your Apple Developer ID signing identity and
  notarize it. The bundled `koko` executable is included inside that bundle and
  must be covered by the final signature. For a local install, use right-click →
  Open when Gatekeeper prompts. If a downloaded development build still cannot
  launch its voice engine, remove its quarantine attribute:
  `xattr -dr com.apple.quarantine "/Applications/PDF Reader.app"`.
- **Voices**: the app bundles `af_kore`, `af_nova`, and `af_sky`.
- **Local library**: imported PDFs and EPUBs are copied into the app-data directory on
  your Mac. Use the sidebar to reopen a book, resume its last page, or remove it.
- **Bookmarks**: open a book and use the bookmark button to save the visible PDF
  page or EPUB section. Saved bookmarks appear in the jump menu and thumbnail rail.
- **Themes**: use the header button to switch between dark and light mode. The
  selected theme is restored the next time the app opens.
- **Local voice engine**: the app starts the bundled `koko` process on an
  available `127.0.0.1` port and stops it when the app window closes. If `koko`
  exits unexpectedly, the app restarts it automatically and reconnects the UI.
- **Voice engine logs**: `koko` output is written to
  `~/Library/Logs/com.marko.pdfreader/tts.log`. When the file exceeds roughly
  1 MB, the previous log is kept as `tts.log.1`.
- **CORS / networking**: in the Tauri app, requests go through the HTTP plugin
  (allowed only for loopback ports in `src-tauri/capabilities/default.json`). The
  same front-end also runs in a plain browser via `fetch` if you just open
  `src/index.html` through a local web server. Browser preview mode falls back to
  `127.0.0.1:51234` because it cannot ask the Tauri backend for the selected port.

## How it works

```
PDF  ──pdf.js──────> text ──split──> sentences
EPUB ──spine XHTML─> text              │
                      (for each)  POST /v1/audio/speech ──> MP3 ──> <audio> play
                                         │
                                prefetch next sentence while current plays
```
