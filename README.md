# PDF + EPUB Reader (Mac app)

A local audiobook player: drag in a PDF or EPUB, pick a voice, and it reads the book
aloud using **Kokoro** TTS running on your machine. No cloud, no tokens, no
uploads. PDF text is extracted in-app with pdf.js; EPUB text is extracted from
the book's reading-order sections. Speech comes from a local Kokoro server.
Imported books are kept in a local library for quick switching, with reading
progress and page or section bookmarks saved per book.

Built with **Tauri v2** (tiny native macOS app, ~3–5 MB) wrapping an
HTML/JS front-end.

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

You also need **Docker Desktop** running, for the Kokoro server.

## 2. Start Kokoro (the speech server)

```bash
docker run -d --name kokoro -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

First run downloads the image + model (~1 GB). After that it restarts with
Docker. Verify it's up:

```bash
curl http://localhost:8880/health
```

The app talks to `http://localhost:8880`. If Kokoro isn't running, the app
still opens — it just shows a warning in the status badge and can't speak.

## 3. Install app dependencies

From this folder:

```bash
npm install
```

## 4. App icons (required before first build)

Tauri needs icon files in `src-tauri/icons/`. Generate them from any square
PNG (1024×1024 works well):

```bash
npm run tauri icon /path/to/your-icon.png
```

This creates all the sizes referenced in `tauri.conf.json` (32x32.png,
128x128.png, 128x128@2x.png, icon.icns). Skip this and the build will fail on
missing icons.

## 5. Run in dev mode

```bash
npm run dev
```

This opens the app in a live window with hot reload. Drag in a PDF or EPUB and press
Play.

## 6. Build the distributable Mac app

```bash
npm run build
```

Output lands in `src-tauri/target/release/bundle/`:

- `macos/PDF Reader.app` — the app bundle (drag to /Applications)
- `dmg/PDF Reader_0.1.0_aarch64.dmg` — a disk image for sharing

On an M1/M2/M3 Mac this builds for Apple Silicon by default. For a universal
binary:

```bash
rustup target add x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

---

## Notes & limitations

- **Scanned PDFs** (image-only, no text layer) extract no text — they need OCR,
  which this version doesn't include. Ask if you want a Tesseract fallback added.
- **EPUB navigation** uses the book's reflowable reading-order sections instead
  of fixed pages.
- **Unsigned app**: the first time you open the built .app, macOS Gatekeeper will
  warn it's from an unidentified developer. Right-click → Open to bypass, or
  sign it with an Apple Developer ID if you plan to distribute.
- **Voices**: the dropdown auto-populates from Kokoro's `/v1/audio/voices`. The
  `af_*` voices are American female, `am_*` American male, `bf_*`/`bm_*` British.
- **Local library**: imported PDFs and EPUBs are copied into the app-data directory on
  your Mac. Use the sidebar to reopen a book, resume its last page, or remove it.
- **Bookmarks**: open a book and use the bookmark button to save the visible PDF
  page or EPUB section. Saved bookmarks appear in the jump menu and thumbnail rail.
- **CORS / networking**: in the Tauri app, requests go through the HTTP plugin
  (allowed for `localhost:8880` in `src-tauri/capabilities/default.json`). The
  same front-end also runs in a plain browser via `fetch` if you just open
  `src/index.html` through a local web server.

## How it works

```
PDF  ──pdf.js──────> text ──split──> sentences
EPUB ──spine XHTML─> text              │
                      (for each)  POST /v1/audio/speech ──> MP3 ──> <audio> play
                                         │
                                prefetch next sentence while current plays
```
