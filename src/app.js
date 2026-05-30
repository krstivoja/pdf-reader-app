// PDF + EPUB Reader — local audiobook player using Kokoro TTS
// Works as a Tauri app (uses the HTTP plugin to reach localhost:8880)
// and in a plain browser (falls back to fetch).

import * as pdfjs from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";

const KOKORO = "http://localhost:8880/v1";
const KOKORO_ROOT = "http://localhost:8880";
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const THEME_STORE = "pdf-reader-theme";

function applyTheme(theme) {
  const light = theme === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  $("theme").textContent = light ? "☾ Dark" : "☀ Light";
  $("theme").title = light ? "Switch to dark theme" : "Switch to light theme";
}

applyTheme(localStorage.getItem(THEME_STORE) || "dark");

// ---- HTTP layer: prefer Tauri's plugin, fall back to fetch ----
let tauriFetch = null;
try {
  const mod = await import("@tauri-apps/plugin-http");
  tauriFetch = mod.fetch;
} catch {
  // not running under Tauri (or plugin missing) — use browser fetch
}
const http = (url, opts) => (tauriFetch ? tauriFetch(url, opts) : fetch(url, opts));

// ---- local book library: native app storage with a browser fallback ----
let invoke = window.__TAURI__?.core?.invoke || null;
if (!invoke) {
  try {
    const mod = await import("@tauri-apps/api/core");
    invoke = mod.invoke;
  } catch {
    // plain-browser previews store books in IndexedDB
  }
}

const LIBRARY_STORE = "pdfs";
let library = [], activeBookId = null, progressTimer = null;
const thumbnailJobs = new Set();
const bookmarkLabels = new Map();
const BOOK_FORMATS = {
  pdf: { mime: "application/pdf", label: "PDF" },
  epub: { mime: "application/epub+zip", label: "EPUB" },
};

function getBookFormat(fileOrBook) {
  const name = fileOrBook?.name?.toLowerCase() || "";
  if (fileOrBook?.format && BOOK_FORMATS[fileOrBook.format]) return fileOrBook.format;
  if (name.endsWith(".epub") || fileOrBook?.type === BOOK_FORMATS.epub.mime) return "epub";
  return "pdf";
}

function openLibraryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("pdf-reader-library", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => request.result.createObjectStore(LIBRARY_STORE, { keyPath: "id" });
  });
}

function dbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function listStoredBooks() {
  if (invoke) return invoke("list_books");
  const db = await openLibraryDb();
  const books = await dbRequest(db.transaction(LIBRARY_STORE).objectStore(LIBRARY_STORE).getAll());
  db.close();
  return books
    .map(({ bytes, ...book }) => ({ ...book, format: getBookFormat(book) }))
    .sort((left, right) => right.addedAt - left.addedAt);
}

async function saveStoredBook(name, format, bytes) {
  if (invoke) return invoke("save_book", { name, format, bytes: Array.from(new Uint8Array(bytes)) });
  const db = await openLibraryDb();
  const book = {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    size: bytes.byteLength,
    addedAt: Date.now(),
    currentPage: 0,
    format,
    bookmarks: [],
    bytes: new Blob([bytes], { type: BOOK_FORMATS[format].mime }),
  };
  await dbRequest(db.transaction(LIBRARY_STORE, "readwrite").objectStore(LIBRARY_STORE).put(book));
  db.close();
  return book;
}

async function readStoredBook(id) {
  if (invoke) return Uint8Array.from(await invoke("read_book", { id }));
  const db = await openLibraryDb();
  const book = await dbRequest(db.transaction(LIBRARY_STORE).objectStore(LIBRARY_STORE).get(id));
  db.close();
  if (!book) throw new Error("Stored book not found");
  return book.bytes.arrayBuffer();
}

async function removeStoredBook(id) {
  if (invoke) return invoke("remove_book", { id });
  const db = await openLibraryDb();
  await dbRequest(db.transaction(LIBRARY_STORE, "readwrite").objectStore(LIBRARY_STORE).delete(id));
  db.close();
}

async function updateStoredProgress(id, currentPage) {
  if (invoke) return invoke("update_book_progress", { id, currentPage });
  const db = await openLibraryDb();
  const book = await dbRequest(db.transaction(LIBRARY_STORE).objectStore(LIBRARY_STORE).get(id));
  if (book) {
    book.currentPage = currentPage;
    await dbRequest(db.transaction(LIBRARY_STORE, "readwrite").objectStore(LIBRARY_STORE).put(book));
  }
  db.close();
}

async function updateStoredThumbnail(id, thumbnail) {
  if (invoke) return invoke("update_book_thumbnail", { id, thumbnail });
  const db = await openLibraryDb();
  const book = await dbRequest(db.transaction(LIBRARY_STORE).objectStore(LIBRARY_STORE).get(id));
  if (book) {
    book.thumbnail = thumbnail;
    await dbRequest(db.transaction(LIBRARY_STORE, "readwrite").objectStore(LIBRARY_STORE).put(book));
  }
  db.close();
}

const CACHE_VERSION = 1;
const CACHE_STORE = "pdf-reader-cache";

function openCacheDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("pdf-reader-cache", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => request.result.createObjectStore(CACHE_STORE);
  });
}

async function readBookCache(id) {
  try {
    if (invoke) {
      const raw = await invoke("read_book_cache", { id });
      return raw ? JSON.parse(raw) : null;
    }
    const db = await openCacheDb();
    const value = await dbRequest(db.transaction(CACHE_STORE).objectStore(CACHE_STORE).get(id));
    db.close();
    return value || null;
  } catch (error) {
    console.error(`Could not read cache for ${id}:`, error);
    return null;
  }
}

async function writeBookCache(id, data) {
  try {
    if (invoke) return invoke("write_book_cache", { id, data: JSON.stringify(data) });
    const db = await openCacheDb();
    await dbRequest(db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE).put(data, id));
    db.close();
  } catch (error) {
    console.error(`Could not write cache for ${id}:`, error);
  }
}

async function updateStoredBookmarks(id, bookmarks) {
  if (invoke) return invoke("update_book_bookmarks", { id, bookmarks });
  const db = await openLibraryDb();
  const book = await dbRequest(db.transaction(LIBRARY_STORE).objectStore(LIBRARY_STORE).get(id));
  if (book) {
    book.bookmarks = bookmarks;
    await dbRequest(db.transaction(LIBRARY_STORE, "readwrite").objectStore(LIBRARY_STORE).put(book));
  }
  db.close();
}

function formatFileSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshLibrary() {
  library = (await listStoredBooks()).map((book) => ({ ...book, format: getBookFormat(book) }));
  renderLibrary();
  hydrateLibraryThumbnails();
  hydrateBookmarkLabels();
}

function bookmarkDisplay(book, pageIndex) {
  const cached = bookmarkLabels.get(book.id);
  if (cached?.has(pageIndex)) {
    const { unit, number, label } = cached.get(pageIndex);
    return unit === "Section" && label ? `${unit} ${number} · ${label}` : `${unit} ${number}`;
  }
  const unit = book.format === "epub" ? "Section" : "Page";
  return `${unit} ${pageIndex + 1}`;
}

async function hydrateBookmarkLabels() {
  for (const book of library) {
    if (!book.bookmarks?.length || bookmarkLabels.has(book.id)) continue;
    const cached = await readBookCache(book.id);
    if (!cached?.pages) continue;
    const map = new Map();
    cached.pages.forEach((page, index) => {
      map.set(index, { number: page.number, label: page.label, unit: cached.readerUnit || "Page" });
    });
    bookmarkLabels.set(book.id, map);
    renderLibrary();
  }
}

function renderLibrary() {
  $("libraryCount").textContent = library.length;
  $("bookList").innerHTML = library.length
    ? library.map((book) => `
      <div class="book-row${book.id === activeBookId ? " active" : ""}">
        <div class="book-row-main">
          <button class="book-open" data-book-id="${book.id}">
            ${book.thumbnail
              ? `<img class="book-cover" src="${book.thumbnail}" alt="">`
              : `<span class="book-cover placeholder">${BOOK_FORMATS[book.format].label}</span>`}
            <span class="book-details">
              <strong>${escapeHtml(book.name)}</strong>
              <span>${BOOK_FORMATS[book.format].label} · ${formatFileSize(book.size)} · ${book.format === "epub" ? "section" : "page"} ${(book.currentPage || 0) + 1}${book.bookmarks?.length ? ` · ★ ${book.bookmarks.length}` : ""}</span>
            </span>
          </button>
          <button class="book-remove" data-remove-id="${book.id}" title="Remove ${escapeHtml(book.name)}">×</button>
        </div>
        ${book.bookmarks?.length ? `<div class="book-bookmarks">${book.bookmarks
          .map((pageIndex) => `<button class="book-bookmark" data-bookmark-book-id="${book.id}" data-bookmark-page="${pageIndex}" title="Jump to ${escapeHtml(bookmarkDisplay(book, pageIndex))}"><span class="star">★</span>${escapeHtml(bookmarkDisplay(book, pageIndex))}</button>`)
          .join("")}</div>` : ""}
      </div>`).join("")
    : `<div class="library-empty">Imported PDFs and EPUBs will appear here.</div>`;
}

async function hydrateLibraryThumbnails() {
  for (const book of library.filter((candidate) => !candidate.thumbnail && !thumbnailJobs.has(candidate.id))) {
    thumbnailJobs.add(book.id);
    try {
      const thumbnail = await makeLibraryThumbnail(await readStoredBook(book.id), book.format);
      if (!thumbnail) continue;
      await updateStoredThumbnail(book.id, thumbnail);
      const currentBook = library.find((candidate) => candidate.id === book.id);
      if (currentBook) {
        currentBook.thumbnail = thumbnail;
        renderLibrary();
      }
    } catch (error) {
      console.error(`Could not generate thumbnail for ${book.name}:`, error);
    } finally {
      thumbnailJobs.delete(book.id);
    }
  }
}

function queueProgressUpdate() {
  if (!activeBookId) return;
  const id = activeBookId, pageIndex = currentPage;
  const book = library.find((candidate) => candidate.id === id);
  if (book) {
    book.currentPage = pageIndex;
    renderLibrary();
  }
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => updateStoredProgress(id, pageIndex).catch(console.error), 250);
}

function activeBook() {
  return library.find((book) => book.id === activeBookId);
}

function currentBookmarks() {
  return activeBook()?.bookmarks || [];
}

function renderBookmarks() {
  const bookmarks = currentBookmarks();
  const bookmarked = bookmarks.includes(currentPage);
  $("bookmarkPage").disabled = !activeBookId || !pages.length;
  $("bookmarkPage").textContent = bookmarked ? "★ Bookmarked" : "☆ Bookmark";
  $("bookmarkPage").classList.toggle("active", bookmarked);
  $("bookmark").disabled = !bookmarks.length;
  $("bookmark").innerHTML = bookmarks.length
    ? `<option value="">Jump to bookmark…</option>${bookmarks
      .filter((pageIndex) => pages[pageIndex])
      .map((pageIndex) => `<option value="${pageIndex}">${readerUnit} ${pages[pageIndex].number}${pages[pageIndex].label && readerUnit === "Section" ? ` · ${escapeHtml(pages[pageIndex].label)}` : ""}</option>`)
      .join("")}`
    : `<option value="">No bookmarks yet</option>`;
}

async function toggleBookmark() {
  const book = activeBook();
  if (!book || !pages.length) return;
  const bookmarks = [...(book.bookmarks || [])];
  const index = bookmarks.indexOf(currentPage);
  if (index >= 0) bookmarks.splice(index, 1);
  else bookmarks.push(currentPage);
  bookmarks.sort((left, right) => left - right);
  book.bookmarks = bookmarks;
  renderBookmarks();
  renderThumbnails();
  renderLibrary();
  try {
    await updateStoredBookmarks(book.id, bookmarks);
  } catch (error) {
    statusEl.textContent = `Could not save bookmark · ${error.message}`;
    statusEl.className = "status warn";
  }
}

// ---- check Kokoro + load voices ----
async function initKokoro() {
  try {
    const r = await http(`${KOKORO_ROOT}/health`);
    if (!r.ok) throw new Error();
    let voices = [];
    try {
      const vr = await http(`${KOKORO}/audio/voices`);
      const j = await vr.json();
      voices = (j.voices || j.data || [])
        .map((voice) => typeof voice === "string" ? voice : voice.id)
        .filter(Boolean);
    } catch { /* use fallback list below */ }
    if (!voices.length) {
      voices = ["af_heart", "af_bella", "af_sky", "af_nicole", "am_adam",
                "am_michael", "bf_emma", "bf_isabella", "bm_george", "bm_lewis"];
    }
    $("voice").innerHTML = voices.map((v) => `<option value="${v}">${v}</option>`).join("");
    statusEl.textContent = "Kokoro ready ✓";
    statusEl.className = "status ok";
  } catch {
    statusEl.textContent = "Kokoro not found on :8880 — start the Docker container";
    statusEl.className = "status warn";
    $("voice").innerHTML = `<option>af_heart</option>`;
  }
}
initKokoro();

// ---- book -> structured pages/sections -> sentences ----
let sentences = [], sentencePages = [], pages = [], chapters = [], currentPage = 0;
const THUMBNAIL_WIDTH = 104;
let readerUnit = "Page";

const normalizeText = (text) => text.replace(/\s+/g, " ").trim();
const splitSentences = (text) =>
  (text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [text])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 1);

function extractLines(items) {
  const lines = [];
  let parts = [], y = null, height = 0;

  const flush = () => {
    const text = normalizeText(parts.join(" "));
    if (text) lines.push({ text, y, height });
    parts = []; y = null; height = 0;
  };

  for (const item of items) {
    const text = normalizeText(item.str || "");
    const itemY = item.transform?.[5] ?? null;
    if (parts.length && y !== null && itemY !== null && Math.abs(itemY - y) > 2) flush();
    if (text) {
      parts.push(text);
      y = itemY;
      height = Math.max(height, item.height || 0);
    }
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

function isChapterHeading(text) {
  if (text.length > 100) return false;
  return /^(chapter|part|book|section)\s+([ivxlcdm]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(text)
    || /^(prologue|epilogue|introduction|preface|foreword|afterword|acknowledg(e)?ments|contents)$/i.test(text);
}

function lowerQuartile(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.25)];
}

function makeBlocks(lines) {
  const gaps = lines.slice(1)
    .map((line, i) => Math.abs((lines[i].y ?? 0) - (line.y ?? 0)))
    .filter((gap) => gap > 2 && gap < 100);
  const normalGap = lowerQuartile(gaps);
  const blocks = [];
  let paragraph = "";

  const flushParagraph = () => {
    if (paragraph) blocks.push({ type: "paragraph", text: paragraph });
    paragraph = "";
  };

  lines.forEach((line, i) => {
    const gap = i ? Math.abs((lines[i - 1].y ?? 0) - (line.y ?? 0)) : 0;
    if (isChapterHeading(line.text)) {
      flushParagraph();
      blocks.push({ type: "heading", text: line.text });
      return;
    }
    if (paragraph && normalGap && gap > normalGap * 1.45) flushParagraph();
    paragraph = paragraph.endsWith("-")
      ? paragraph.slice(0, -1) + line.text
      : `${paragraph}${paragraph ? " " : ""}${line.text}`;
  });
  flushParagraph();
  return blocks;
}

async function makeThumbnail(page) {
  const viewport = page.getViewport({ scale: 1 });
  const thumbnailViewport = page.getViewport({ scale: THUMBNAIL_WIDTH / viewport.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(thumbnailViewport.width);
  canvas.height = Math.ceil(thumbnailViewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: thumbnailViewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.72);
}

function wrapCanvasText(context, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = text.split(/\s+/);
  let line = "", lines = 0;
  for (const word of words) {
    const nextLine = `${line}${line ? " " : ""}${word}`;
    if (line && context.measureText(nextLine).width > maxWidth) {
      context.fillText(line, x, y);
      line = word;
      y += lineHeight;
      if (++lines >= maxLines) return y;
    } else {
      line = nextLine;
    }
  }
  if (line && lines < maxLines) context.fillText(line, x, y);
  return y + lineHeight;
}

function makeEpubThumbnail(title, excerpt) {
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = 146;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#25221f";
  context.font = "bold 10px sans-serif";
  let y = wrapCanvasText(context, title, 8, 18, canvas.width - 16, 13, 4) + 5;
  context.fillStyle = "#6b6259";
  context.font = "8px sans-serif";
  wrapCanvasText(context, excerpt, 8, y, canvas.width - 16, 10, 8);
  return canvas.toDataURL("image/jpeg", 0.72);
}

function makeImageThumbnail(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = THUMBNAIL_WIDTH;
      canvas.height = 146;
      const context = canvas.getContext("2d");
      const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
      const width = image.width * scale, height = image.height * scale;
      context.fillStyle = "#fffdf8";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    image.onerror = () => reject(new Error("Could not decode EPUB cover"));
    image.src = source;
  });
}

async function readEpubArchive(buf) {
  if (!window.JSZip) throw new Error("EPUB support could not load");
  const zip = await window.JSZip.loadAsync(buf);
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("Invalid EPUB: missing container.xml");
  const container = new DOMParser().parseFromString(await containerFile.async("string"), "application/xml");
  const packagePath = elementsByLocalName(container, "rootfile")[0]?.getAttribute("full-path");
  if (!packagePath) throw new Error("Invalid EPUB: missing package document");
  const packageFile = zip.file(packagePath);
  if (!packageFile) throw new Error("Invalid EPUB: package document not found");
  const packageDocument = new DOMParser().parseFromString(await packageFile.async("string"), "application/xml");
  const packageBase = packagePath.includes("/") ? packagePath.slice(0, packagePath.lastIndexOf("/") + 1) : "";
  const manifest = new Map(elementsByLocalName(packageDocument, "item").map((item) => [
    item.getAttribute("id"),
    {
      href: item.getAttribute("href"),
      type: item.getAttribute("media-type"),
      properties: item.getAttribute("properties") || "",
    },
  ]));
  const spine = elementsByLocalName(packageDocument, "itemref")
    .map((itemref) => manifest.get(itemref.getAttribute("idref")))
    .filter((item) => item?.href && (!item.type || /html|xhtml/i.test(item.type)));
  return { zip, packageDocument, packageBase, manifest, spine };
}

async function makeEpubCoverThumbnail(buf) {
  const { zip, packageDocument, packageBase, manifest, spine } = await readEpubArchive(buf);
  const coverId = elementsByLocalName(packageDocument, "meta")
    .find((meta) => meta.getAttribute("name") === "cover")
    ?.getAttribute("content");
  const cover = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes("cover-image"))
    || manifest.get(coverId)
    || [...manifest.values()].find((item) => /image/i.test(item.type || "") && /cover/i.test(item.href || ""));
  if (cover?.href && /image/i.test(cover.type || "")) {
    const coverFile = zip.file(archivePath(packageBase, cover.href));
    if (coverFile) {
      const source = `data:${cover.type};base64,${await coverFile.async("base64")}`;
      return makeImageThumbnail(source);
    }
  }
  const firstSection = spine[0]?.href && zip.file(archivePath(packageBase, spine[0].href));
  if (!firstSection) return null;
  const blocks = extractEpubBlocks(await firstSection.async("string"));
  const heading = blocks.find((block) => block.type === "heading")?.text || "EPUB";
  const excerpt = blocks.find((block) => block.type === "paragraph")?.text || heading;
  return makeEpubThumbnail(heading, excerpt);
}

async function makeLibraryThumbnail(buf, format) {
  if (format === "epub") return makeEpubCoverThumbnail(buf);
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  return makeThumbnail(await pdf.getPage(1));
}

function addReaderPage({ number, label, blocks, thumbnail }) {
  const pageIndex = pages.length;
  const sentenceIndexes = [];
  blocks.forEach((block) => {
    block.sentences = splitSentences(block.text).map((text) => {
      const index = sentences.length;
      sentences.push(text);
      sentencePages.push(pageIndex);
      sentenceIndexes.push(index);
      return { index, text };
    });
    if (block.type === "heading") {
      chapters.push({ title: block.text, pageIndex, sentenceIndex: block.sentences[0]?.index });
    }
  });
  pages.push({ number, label, blocks, sentenceIndexes, thumbnail });
}

function finishBookLoad(book, unit) {
  readerUnit = unit;
  $("pageUnit").textContent = unit;
  $("search").disabled = false;
  $("search").value = "";
  $("searchResults").hidden = true;
  if (book.id) {
    const map = new Map();
    pages.forEach((page, index) => map.set(index, { number: page.number, label: page.label, unit }));
    bookmarkLabels.set(book.id, map);
  }
  renderChapters();
  renderThumbnails();
  renderPage(Math.min(book.currentPage || 0, pages.length - 1));
  renderLibrary();
  $("drop").classList.add("hidden");
  $("reader").classList.add("show");
  $("play").disabled = !sentences.length;
  statusEl.textContent = `${book.name || "Book"} · ${pages.length} ${unit.toLowerCase()}s · ${chapters.length} chapters`;
  statusEl.className = "status ok";
}

async function importBook(file) {
  const format = getBookFormat(file);
  statusEl.textContent = `Saving ${BOOK_FORMATS[format].label}…`;
  statusEl.className = "status";
  const bytes = await file.arrayBuffer();
  let book = { name: file.name, format };
  try {
    book = await saveStoredBook(file.name, format, bytes);
    await refreshLibrary();
  } catch (error) {
    console.error("Could not save book:", error);
  }
  try {
    await loadBookBytes(bytes, book);
  } catch (error) {
    console.error("Could not open book:", error);
    statusEl.textContent = `Could not open book · ${error.message}`;
    statusEl.className = "status warn";
  }
}

async function openStoredBook(book) {
  stopAll();
  statusEl.textContent = `Opening ${book.name}…`;
  statusEl.className = "status";
  try {
    if (book.id && await loadFromCache(book)) return;
    await loadBookBytes(await readStoredBook(book.id), book);
  } catch (error) {
    statusEl.textContent = `Could not open book · ${error.message}`;
    statusEl.className = "status warn";
  }
}

async function loadBookBytes(buf, book = {}) {
  if (book.id && await loadFromCache(book)) return;
  if (getBookFormat(book) === "epub") return loadEpubBytes(buf, book);
  return loadPDFBytes(buf, book);
}

async function loadFromCache(book) {
  const cached = await readBookCache(book.id);
  if (!cached || cached.version !== CACHE_VERSION || !Array.isArray(cached.pages) || !cached.pages.length) return false;
  stopAll();
  $("play").disabled = true;
  statusEl.textContent = `Opening ${book.name || "book"}…`;
  statusEl.className = "status";
  activeBookId = book.id || null;
  sentences = []; sentencePages = []; pages = []; chapters = []; currentPage = 0;
  for (const page of cached.pages) {
    addReaderPage({
      number: page.number,
      label: page.label,
      blocks: page.blocks.map((block) => ({ type: block.type, text: block.text })),
      thumbnail: page.thumbnail || null,
    });
  }
  finishBookLoad(book, cached.readerUnit || "Page");
  return true;
}

function snapshotPagesForCache() {
  return {
    version: CACHE_VERSION,
    readerUnit,
    pages: pages.map((page) => ({
      number: page.number,
      label: page.label,
      thumbnail: page.thumbnail || null,
      blocks: page.blocks.map((block) => ({ type: block.type, text: block.text })),
    })),
  };
}

async function loadPDFBytes(buf, book = {}) {
  stopAll();
  $("play").disabled = true;
  statusEl.textContent = "Extracting text…";
  statusEl.className = "status";
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  activeBookId = book.id || null;
  sentences = []; sentencePages = []; pages = []; chapters = []; currentPage = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const blocks = makeBlocks(extractLines(content.items));
    let thumbnail = null;
    try {
      thumbnail = await makeThumbnail(page);
    } catch (error) {
      console.error(`Could not render thumbnail for page ${p}:`, error);
    }
    addReaderPage({ number: p, label: `Page ${p}`, blocks, thumbnail });
    statusEl.textContent = `Extracting… page ${p}/${pdf.numPages}`;
  }

  finishBookLoad(book, "Page");
  if (book.id) writeBookCache(book.id, snapshotPagesForCache());
}

function archivePath(basePath, relativePath) {
  const path = new URL(relativePath.split("#")[0], `https://epub.local/${basePath}`).pathname.slice(1);
  return decodeURIComponent(path);
}

function elementsByLocalName(root, localName) {
  return [...root.getElementsByTagNameNS("*", localName)];
}

function extractEpubBlocks(markup) {
  const document = new DOMParser().parseFromString(markup, "text/html");
  document.querySelectorAll("script, style, nav, svg").forEach((element) => element.remove());
  const elements = [...document.querySelectorAll("h1, h2, h3, h4, p, blockquote, li")];
  const blocks = elements
    .map((element) => ({
      type: /^H[1-4]$/.test(element.tagName) ? "heading" : "paragraph",
      text: normalizeText(element.textContent || ""),
    }))
    .filter((block) => block.text.length > 1);
  if (!blocks.length) {
    const text = normalizeText(document.body?.textContent || "");
    if (text) blocks.push({ type: "paragraph", text });
  }
  return blocks;
}

async function loadEpubBytes(buf, book = {}) {
  stopAll();
  $("play").disabled = true;
  statusEl.textContent = "Extracting EPUB…";
  statusEl.className = "status";
  const { zip, packageBase, spine } = await readEpubArchive(buf);

  activeBookId = book.id || null;
  sentences = []; sentencePages = []; pages = []; chapters = []; currentPage = 0;
  for (const [index, item] of spine.entries()) {
    const contentFile = zip.file(archivePath(packageBase, item.href));
    if (!contentFile) continue;
    const blocks = extractEpubBlocks(await contentFile.async("string"));
    if (!blocks.length) continue;
    const heading = blocks.find((block) => block.type === "heading")?.text || `Section ${pages.length + 1}`;
    const excerpt = blocks.find((block) => block.type === "paragraph")?.text || heading;
    const chapterCount = chapters.length;
    addReaderPage({
      number: pages.length + 1,
      label: heading,
      blocks,
      thumbnail: makeEpubThumbnail(heading, excerpt),
    });
    if (chapters.length === chapterCount) {
      chapters.push({ title: heading, pageIndex: pages.length - 1, sentenceIndex: pages[pages.length - 1].sentenceIndexes[0] });
    }
    statusEl.textContent = `Extracting… section ${index + 1}/${spine.length}`;
  }
  if (!pages.length) throw new Error("This EPUB does not contain readable text");
  finishBookLoad(book, "Section");
  if (book.id) writeBookCache(book.id, snapshotPagesForCache());
}
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function sentenceHtml(sentence) {
  return `<span class="sent" data-i="${sentence.index}">${escapeHtml(sentence.text)} </span>`;
}

function renderThumbnails() {
  const bookmarks = currentBookmarks();
  $("thumbnails").innerHTML = pages.map((page, pageIndex) => `
    <button class="page-thumbnail" data-page-index="${pageIndex}" title="Read from ${readerUnit.toLowerCase()} ${page.number}">
      ${bookmarks.includes(pageIndex) ? `<span class="thumbnail-bookmark" title="Bookmarked">★</span>` : ""}
      ${page.thumbnail
        ? `<img src="${page.thumbnail}" alt="Preview of ${readerUnit.toLowerCase()} ${page.number}">`
        : `<span class="thumbnail-placeholder">No preview</span>`}
      <span>${readerUnit} ${page.number}</span>
      ${readerUnit === "Section" ? `<small>${escapeHtml(page.label)}</small>` : ""}
    </button>`).join("");
  updateThumbnailSelection();
}

function updateThumbnailSelection() {
  document.querySelectorAll(".page-thumbnail.active").forEach((thumbnail) => {
    thumbnail.classList.remove("active");
    thumbnail.removeAttribute("aria-current");
  });
  const thumbnail = document.querySelector(`.page-thumbnail[data-page-index="${currentPage}"]`);
  if (thumbnail) {
    thumbnail.classList.add("active");
    thumbnail.setAttribute("aria-current", "page");
    thumbnail.scrollIntoView({ block: "nearest" });
  }
}

function renderPage(pageIndex) {
  if (!pages.length) return;
  currentPage = Math.max(0, Math.min(pageIndex, pages.length - 1));
  const page = pages[currentPage];
  $("text").innerHTML = `
    <article class="book-page">
      <div class="page-kicker">${readerUnit} ${page.number}</div>
      ${page.blocks.map((block) => block.type === "heading"
        ? `<h2 class="chapter-heading">${block.sentences.map(sentenceHtml).join("")}</h2>`
        : `<p>${block.sentences.map(sentenceHtml).join("")}</p>`).join("")}
    </article>`;
  $("pageCurrent").textContent = page.number;
  $("pageTotal").textContent = pages.length;
  updateThumbnailSelection();
  renderBookmarks();
  $("prevPage").disabled = currentPage === 0;
  $("nextPage").disabled = currentPage === pages.length - 1;
  $("pageScroll").scrollTop = 0;
  let chapterIndex = -1;
  chapters.forEach((chapter, i) => {
    if (chapter.pageIndex <= currentPage) chapterIndex = i;
  });
  $("chapter").value = chapterIndex >= 0 ? String(chapterIndex) : "";
  queueProgressUpdate();
}

function renderChapters() {
  $("chapter").disabled = !chapters.length;
  $("chapter").innerHTML = chapters.length
    ? `<option value="">Jump to chapter…</option>${chapters
      .map((chapter, i) => `<option value="${i}">${escapeHtml(chapter.title)}</option>`)
      .join("")}`
    : `<option value="">No chapters detected</option>`;
}

function goToPage(pageIndex, sentenceIndex) {
  renderPage(pageIndex);
  const nextIndex = sentenceIndex ?? pages[currentPage].sentenceIndexes[0];
  if (nextIndex === undefined) {
    if (playing) stopAll();
    highlight(-1);
  } else if (playing && !paused) {
    startPlaybackFrom(nextIndex);
  } else {
    if (paused) stopAll();
    idx = nextIndex;
    highlight(idx);
  }
}

// ---- playback: synth current, prefetch next, queue ----
let idx = 0, playing = false, paused = false, currentAudio = null, prefetch = null, playbackRun = 0;

function discardPrefetch() {
  if (prefetch?.url) URL.revokeObjectURL(prefetch.url);
  prefetch = null;
}

function discardCurrentAudio() {
  if (!currentAudio) return;
  const url = currentAudio.src;
  currentAudio.pause();
  currentAudio.removeAttribute("src");
  currentAudio.load();
  currentAudio = null;
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

async function synth(i) {
  const payload = {
    model: "kokoro",
    input: sentences[i],
    voice: $("voice").value,
    response_format: "mp3",
    speed: parseFloat($("speed").value),
  };

  const r = await http(`${KOKORO}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = await r.text();
    console.error("TTS request failed:", r.status, detail);
    throw new Error(`TTS failed: ${r.status}${detail ? ` · ${detail}` : ""}`);
  }
  const blob = await r.blob();
  return URL.createObjectURL(blob);
}

async function playFrom(i, run = playbackRun) {
  if (i >= sentences.length) {
    if (run === playbackRun) stopAll();
    return;
  }
  idx = i; highlight(i);
  let url;
  try {
    if (prefetch && prefetch.i === i && prefetch.run === run) {
      url = prefetch.url;
      prefetch = null;
    } else {
      url = await synth(i);
    }
  } catch (e) {
    if (run !== playbackRun) return;
    statusEl.textContent = e.message; statusEl.className = "status warn";
    stopAll(); return;
  }
  if (!playing || paused || run !== playbackRun) {
    URL.revokeObjectURL(url);
    return;
  }
  discardCurrentAudio();
  discardPrefetch();
  if (i + 1 < sentences.length) {
    synth(i + 1).then((nextUrl) => {
      if (!playing || paused || run !== playbackRun) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      discardPrefetch();
      prefetch = { i: i + 1, url: nextUrl, run };
    }).catch(() => {});
  }
  const audio = new Audio(url);
  currentAudio = audio;
  currentAudio.onended = () => {
    if (currentAudio === audio) {
      currentAudio = null;
      URL.revokeObjectURL(url);
    }
    if (playing && !paused && run === playbackRun) playFrom(i + 1, run);
  };
  await currentAudio.play();
}

function startPlaybackFrom(i) {
  playbackRun++;
  discardCurrentAudio();
  discardPrefetch();
  playing = true;
  paused = false;
  playFrom(i, playbackRun);
}

function highlight(i) {
  if (sentencePages[i] !== undefined && sentencePages[i] !== currentPage) renderPage(sentencePages[i]);
  document.querySelectorAll(".sent.active").forEach((e) => e.classList.remove("active"));
  const el = document.querySelector(`.sent[data-i="${i}"]`);
  if (el) { el.classList.add("active"); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
}

function stopAll() {
  playbackRun++;
  playing = false; paused = false;
  discardCurrentAudio();
  discardPrefetch();
  $("play").disabled = false; $("pause").disabled = true; $("stop").disabled = true;
  $("play").textContent = "▶ Play";
}

function resetReader() {
  stopAll();
  clearTimeout(progressTimer);
  progressTimer = null;
  activeBookId = null;
  idx = 0; sentences = []; sentencePages = []; pages = []; chapters = []; currentPage = 0;
  readerUnit = "Page";
  $("pageUnit").textContent = readerUnit;
  $("bookmarkPage").disabled = true;
  $("bookmarkPage").textContent = "☆ Bookmark";
  $("bookmarkPage").classList.remove("active");
  $("bookmark").disabled = true;
  $("bookmark").innerHTML = `<option value="">No bookmarks yet</option>`;
  $("thumbnails").innerHTML = "";
  $("reader").classList.remove("show"); $("drop").classList.remove("hidden");
  $("play").disabled = true;
  $("search").disabled = true;
  $("search").value = "";
  $("searchResults").hidden = true;
  renderLibrary();
}

function snippetAround(text, query) {
  const lower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const matchIndex = lower.indexOf(queryLower);
  if (matchIndex < 0) return escapeHtml(text);
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(text.length, matchIndex + query.length + 60);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix
    + escapeHtml(text.slice(start, matchIndex))
    + `<mark>${escapeHtml(text.slice(matchIndex, matchIndex + query.length))}</mark>`
    + escapeHtml(text.slice(matchIndex + query.length, end))
    + suffix;
}

function runSearch(query) {
  const resultsEl = $("searchResults");
  const trimmed = query.trim();
  if (trimmed.length < 2 || !sentences.length) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    return;
  }
  const lower = trimmed.toLowerCase();
  const hits = [];
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].toLowerCase().includes(lower)) {
      hits.push(i);
      if (hits.length >= 50) break;
    }
  }
  resultsEl.hidden = false;
  if (!hits.length) {
    resultsEl.innerHTML = `<div class="search-empty">No matches</div>`;
    return;
  }
  resultsEl.innerHTML = hits.map((sentenceIndex) => {
    const pageIndex = sentencePages[sentenceIndex];
    const page = pages[pageIndex];
    const meta = `${readerUnit} ${page.number}${page.label && readerUnit === "Section" ? ` · ${escapeHtml(page.label)}` : ""}`;
    return `<button class="search-result" data-sentence="${sentenceIndex}" data-page="${pageIndex}">
      <span class="meta">${meta}</span>
      ${snippetAround(sentences[sentenceIndex], trimmed)}
    </button>`;
  }).join("");
}

function jumpToSearchHit(pageIndex, sentenceIndex) {
  goToPage(pageIndex, sentenceIndex);
  $("searchResults").hidden = true;
  requestAnimationFrame(() => {
    const el = document.querySelector(`.sent[data-i="${sentenceIndex}"]`);
    if (!el) return;
    el.classList.add("search-hit");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => el.classList.remove("search-hit"), 1600);
  });
}

// ---- controls ----
$("play").onclick = () => {
  if (paused && currentAudio) { paused = false; currentAudio.play(); }
  else startPlaybackFrom(idx);
  $("play").disabled = true; $("pause").disabled = false; $("stop").disabled = false;
};
$("pause").onclick = () => {
  paused = true; if (currentAudio) currentAudio.pause();
  $("play").disabled = false; $("pause").disabled = true; $("play").textContent = "▶ Resume";
};
$("stop").onclick = () => {
  stopAll();
  idx = pages[currentPage]?.sentenceIndexes[0] ?? 0;
  highlight(-1);
};
$("theme").onclick = () => {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem(THEME_STORE, theme);
  applyTheme(theme);
};
$("speed").oninput = (e) => ($("speedVal").textContent = parseFloat(e.target.value).toFixed(1) + "×");
$("prevPage").onclick = () => goToPage(currentPage - 1);
$("nextPage").onclick = () => goToPage(currentPage + 1);
$("chapter").onchange = (e) => {
  if (e.target.value === "") return;
  const chapter = chapters[+e.target.value];
  if (chapter) goToPage(chapter.pageIndex, chapter.sentenceIndex);
};
$("bookmarkPage").onclick = toggleBookmark;
$("bookmark").onchange = (e) => {
  if (e.target.value === "") return;
  goToPage(+e.target.value);
  e.target.value = "";
};
let searchDebounce = null;
$("search").oninput = (e) => {
  clearTimeout(searchDebounce);
  const query = e.target.value;
  searchDebounce = setTimeout(() => runSearch(query), 120);
};
$("search").onfocus = () => {
  if ($("search").value.trim().length >= 2) runSearch($("search").value);
};
$("search").onkeydown = (e) => {
  if (e.key === "Escape") {
    $("searchResults").hidden = true;
    $("search").blur();
  }
};
$("searchResults").onclick = (e) => {
  const button = e.target.closest("[data-sentence]");
  if (!button) return;
  jumpToSearchHit(+button.dataset.page, +button.dataset.sentence);
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) $("searchResults").hidden = true;
});

$("thumbnails").onclick = (e) => {
  const thumbnail = e.target.closest("[data-page-index]");
  if (thumbnail) goToPage(+thumbnail.dataset.pageIndex);
};

$("text").onclick = (e) => {
  const s = e.target.closest(".sent"); if (!s) return;
  const i = +s.dataset.i;
  if (playing) startPlaybackFrom(i);
  else { idx = i; highlight(i); }
};

// ---- drop zone ----
const drop = $("drop"), fileInput = $("file");
const isSupportedBook = (file) => {
  const name = file.name.toLowerCase();
  return file.type === BOOK_FORMATS.pdf.mime || file.type === BOOK_FORMATS.epub.mime
    || name.endsWith(".pdf") || name.endsWith(".epub");
};
let ignoreDropZoneClicksUntil = 0;
drop.onclick = (event) => {
  if (Date.now() < ignoreDropZoneClicksUntil) {
    event.preventDefault();
    return;
  }
  fileInput.click();
};
fileInput.onchange = (e) => {
  if (e.target.files[0]) importBook(e.target.files[0]);
  e.target.value = "";
};
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.add("drag");
  }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove("drag");
  }));
drop.addEventListener("drop", (e) => {
  ignoreDropZoneClicksUntil = Date.now() + 500;
  const f = [...e.dataTransfer.files].find(isSupportedBook);
  if (f) importBook(f);
  else {
    statusEl.textContent = "Drop a PDF or EPUB file";
    statusEl.className = "status warn";
  }
});

// ---- library sidebar ----
$("addPdf").onclick = () => fileInput.click();
$("bookList").onclick = async (e) => {
  const bookmarkButton = e.target.closest("[data-bookmark-book-id]");
  if (bookmarkButton) {
    const bookId = bookmarkButton.dataset.bookmarkBookId;
    const pageIndex = +bookmarkButton.dataset.bookmarkPage;
    const book = library.find((candidate) => candidate.id === bookId);
    if (!book) return;
    if (activeBookId !== bookId) await openStoredBook(book);
    if (pages[pageIndex]) goToPage(pageIndex);
    return;
  }
  const removeButton = e.target.closest("[data-remove-id]");
  if (removeButton) {
    const id = removeButton.dataset.removeId;
    if (id === activeBookId) resetReader();
    try {
      await removeStoredBook(id);
      await refreshLibrary();
      statusEl.textContent = "Book removed from library";
      statusEl.className = "status";
    } catch (error) {
      statusEl.textContent = `Could not remove book · ${error.message}`;
      statusEl.className = "status warn";
    }
    return;
  }
  const openButton = e.target.closest("[data-book-id]");
  const book = library.find((candidate) => candidate.id === openButton?.dataset.bookId);
  if (book) openStoredBook(book);
};

refreshLibrary().catch((error) => {
  console.error("Could not load book library:", error);
  statusEl.textContent = "Could not load saved book library";
  statusEl.className = "status warn";
});
