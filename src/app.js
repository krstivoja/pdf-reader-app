// PDF Reader — local audiobook player using Kokoro TTS
// Works as a Tauri app (uses the HTTP plugin to reach localhost:8880)
// and in a plain browser (falls back to fetch).

import * as pdfjs from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";

const KOKORO = "http://localhost:8880/v1";
const KOKORO_ROOT = "http://localhost:8880";
const $ = (id) => document.getElementById(id);
const statusEl = $("status");

// ---- HTTP layer: prefer Tauri's plugin, fall back to fetch ----
let tauriFetch = null;
try {
  const mod = await import("@tauri-apps/plugin-http");
  tauriFetch = mod.fetch;
} catch {
  // not running under Tauri (or plugin missing) — use browser fetch
}
const http = (url, opts) => (tauriFetch ? tauriFetch(url, opts) : fetch(url, opts));

// ---- local PDF library: native app storage with a browser fallback ----
let invoke = window.__TAURI__?.core?.invoke || null;
if (!invoke) {
  try {
    const mod = await import("@tauri-apps/api/core");
    invoke = mod.invoke;
  } catch {
    // plain-browser previews store PDFs in IndexedDB
  }
}

const LIBRARY_STORE = "pdfs";
let library = [], activeBookId = null, progressTimer = null;

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

async function listStoredPDFs() {
  if (invoke) return invoke("list_pdfs");
  const db = await openLibraryDb();
  const books = await dbRequest(db.transaction(LIBRARY_STORE).objectStore(LIBRARY_STORE).getAll());
  db.close();
  return books
    .map(({ bytes, ...book }) => book)
    .sort((left, right) => right.addedAt - left.addedAt);
}

async function saveStoredPDF(name, bytes) {
  if (invoke) return invoke("save_pdf", { name, bytes: Array.from(new Uint8Array(bytes)) });
  const db = await openLibraryDb();
  const book = {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    size: bytes.byteLength,
    addedAt: Date.now(),
    currentPage: 0,
    bytes: new Blob([bytes], { type: "application/pdf" }),
  };
  await dbRequest(db.transaction(LIBRARY_STORE, "readwrite").objectStore(LIBRARY_STORE).put(book));
  db.close();
  return book;
}

async function readStoredPDF(id) {
  if (invoke) return Uint8Array.from(await invoke("read_pdf", { id }));
  const db = await openLibraryDb();
  const book = await dbRequest(db.transaction(LIBRARY_STORE).objectStore(LIBRARY_STORE).get(id));
  db.close();
  if (!book) throw new Error("Stored PDF not found");
  return book.bytes.arrayBuffer();
}

async function removeStoredPDF(id) {
  if (invoke) return invoke("remove_pdf", { id });
  const db = await openLibraryDb();
  await dbRequest(db.transaction(LIBRARY_STORE, "readwrite").objectStore(LIBRARY_STORE).delete(id));
  db.close();
}

async function updateStoredProgress(id, currentPage) {
  if (invoke) return invoke("update_pdf_progress", { id, currentPage });
  const db = await openLibraryDb();
  const book = await dbRequest(db.transaction(LIBRARY_STORE).objectStore(LIBRARY_STORE).get(id));
  if (book) {
    book.currentPage = currentPage;
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
  library = await listStoredPDFs();
  renderLibrary();
}

function renderLibrary() {
  $("libraryCount").textContent = library.length;
  $("bookList").innerHTML = library.length
    ? library.map((book) => `
      <div class="book-row${book.id === activeBookId ? " active" : ""}">
        <button class="book-open" data-book-id="${book.id}">
          <strong>${escapeHtml(book.name)}</strong>
          <span>${formatFileSize(book.size)} · page ${(book.currentPage || 0) + 1}</span>
        </button>
        <button class="book-remove" data-remove-id="${book.id}" title="Remove ${escapeHtml(book.name)}">×</button>
      </div>`).join("")
    : `<div class="library-empty">Imported PDFs will appear here.</div>`;
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

// ---- PDF -> structured pages -> sentences ----
let sentences = [], sentencePages = [], pages = [], chapters = [], currentPage = 0;

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

async function importPDF(file) {
  statusEl.textContent = "Saving PDF…";
  statusEl.className = "status";
  const bytes = await file.arrayBuffer();
  let book = { name: file.name };
  try {
    book = await saveStoredPDF(file.name, bytes);
    await refreshLibrary();
  } catch (error) {
    console.error("Could not save PDF:", error);
  }
  await loadPDFBytes(bytes, book);
}

async function openStoredPDF(book) {
  stopAll();
  statusEl.textContent = `Opening ${book.name}…`;
  statusEl.className = "status";
  try {
    await loadPDFBytes(await readStoredPDF(book.id), book);
  } catch (error) {
    statusEl.textContent = `Could not open PDF · ${error.message}`;
    statusEl.className = "status warn";
  }
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
    const sentenceIndexes = [];
    blocks.forEach((block) => {
      block.sentences = splitSentences(block.text).map((text) => {
        const index = sentences.length;
        sentences.push(text);
        sentencePages.push(p - 1);
        sentenceIndexes.push(index);
        return { index, text };
      });
      if (block.type === "heading") {
        chapters.push({ title: block.text, pageIndex: p - 1, sentenceIndex: block.sentences[0]?.index });
      }
    });
    pages.push({ number: p, blocks, sentenceIndexes });
    statusEl.textContent = `Extracting… page ${p}/${pdf.numPages}`;
  }

  renderChapters();
  renderPage(Math.min(book.currentPage || 0, pages.length - 1));
  renderLibrary();
  $("drop").classList.add("hidden");
  $("reader").classList.add("show");
  $("play").disabled = !sentences.length;
  statusEl.textContent = `${book.name || "PDF"} · ${pages.length} pages · ${chapters.length} chapters`;
  statusEl.className = "status ok";
}
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function sentenceHtml(sentence) {
  return `<span class="sent" data-i="${sentence.index}">${escapeHtml(sentence.text)} </span>`;
}

function renderPage(pageIndex) {
  if (!pages.length) return;
  currentPage = Math.max(0, Math.min(pageIndex, pages.length - 1));
  const page = pages[currentPage];
  $("text").innerHTML = `
    <article class="book-page">
      <div class="page-kicker">Page ${page.number}</div>
      ${page.blocks.map((block) => block.type === "heading"
        ? `<h2 class="chapter-heading">${block.sentences.map(sentenceHtml).join("")}</h2>`
        : `<p>${block.sentences.map(sentenceHtml).join("")}</p>`).join("")}
    </article>`;
  $("pageCurrent").textContent = page.number;
  $("pageTotal").textContent = pages.length;
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
  if (!playing) {
    const nextIndex = sentenceIndex ?? pages[currentPage].sentenceIndexes[0];
    if (nextIndex === undefined) highlight(-1);
    else { idx = nextIndex; highlight(idx); }
  }
}

// ---- playback: synth current, prefetch next, queue ----
let idx = 0, playing = false, paused = false, currentAudio = null, prefetch = null;

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

async function playFrom(i) {
  if (i >= sentences.length) { stopAll(); return; }
  idx = i; highlight(i);
  let url;
  try {
    url = prefetch && prefetch.i === i ? prefetch.url : await synth(i);
  } catch (e) {
    statusEl.textContent = e.message; statusEl.className = "status warn";
    stopAll(); return;
  }
  prefetch = null;
  if (i + 1 < sentences.length) {
    synth(i + 1).then((u) => (prefetch = { i: i + 1, url: u })).catch(() => {});
  }
  currentAudio = new Audio(url);
  currentAudio.onended = () => { if (playing && !paused) playFrom(i + 1); };
  await currentAudio.play();
}

function highlight(i) {
  if (sentencePages[i] !== undefined && sentencePages[i] !== currentPage) renderPage(sentencePages[i]);
  document.querySelectorAll(".sent.active").forEach((e) => e.classList.remove("active"));
  const el = document.querySelector(`.sent[data-i="${i}"]`);
  if (el) { el.classList.add("active"); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
}

function stopAll() {
  playing = false; paused = false;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  prefetch = null;
  $("play").disabled = false; $("pause").disabled = true; $("stop").disabled = true;
  $("play").textContent = "▶ Play";
}

function resetReader() {
  stopAll();
  clearTimeout(progressTimer);
  progressTimer = null;
  activeBookId = null;
  idx = 0; sentences = []; sentencePages = []; pages = []; chapters = []; currentPage = 0;
  $("reader").classList.remove("show"); $("drop").classList.remove("hidden");
  $("play").disabled = true;
  renderLibrary();
}

// ---- controls ----
$("play").onclick = () => {
  if (paused && currentAudio) { paused = false; currentAudio.play(); }
  else { playing = true; paused = false; playFrom(idx); }
  $("play").disabled = true; $("pause").disabled = false; $("stop").disabled = false;
};
$("pause").onclick = () => {
  paused = true; if (currentAudio) currentAudio.pause();
  $("play").disabled = false; $("pause").disabled = true; $("play").textContent = "▶ Resume";
};
$("stop").onclick = () => { stopAll(); idx = 0; highlight(-1); };
$("new").onclick = resetReader;
$("speed").oninput = (e) => ($("speedVal").textContent = parseFloat(e.target.value).toFixed(1) + "×");
$("prevPage").onclick = () => goToPage(currentPage - 1);
$("nextPage").onclick = () => goToPage(currentPage + 1);
$("chapter").onchange = (e) => {
  if (e.target.value === "") return;
  const chapter = chapters[+e.target.value];
  if (chapter) goToPage(chapter.pageIndex, chapter.sentenceIndex);
};

$("text").onclick = (e) => {
  const s = e.target.closest(".sent"); if (!s) return;
  const i = +s.dataset.i;
  if (playing) { if (currentAudio) currentAudio.pause(); prefetch = null; playFrom(i); }
  else { idx = i; highlight(i); }
};

// ---- drop zone ----
const drop = $("drop"), fileInput = $("file");
const isPDF = (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
drop.onclick = () => fileInput.click();
fileInput.onchange = (e) => {
  if (e.target.files[0]) importPDF(e.target.files[0]);
  e.target.value = "";
};
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (e) => {
  const f = [...e.dataTransfer.files].find(isPDF);
  if (f) importPDF(f);
});

// ---- library sidebar ----
$("addPdf").onclick = () => fileInput.click();
$("bookList").onclick = async (e) => {
  const removeButton = e.target.closest("[data-remove-id]");
  if (removeButton) {
    const id = removeButton.dataset.removeId;
    if (id === activeBookId) resetReader();
    try {
      await removeStoredPDF(id);
      await refreshLibrary();
      statusEl.textContent = "PDF removed from library";
      statusEl.className = "status";
    } catch (error) {
      statusEl.textContent = `Could not remove PDF · ${error.message}`;
      statusEl.className = "status warn";
    }
    return;
  }
  const openButton = e.target.closest("[data-book-id]");
  const book = library.find((candidate) => candidate.id === openButton?.dataset.bookId);
  if (book) openStoredPDF(book);
};

refreshLibrary().catch((error) => {
  console.error("Could not load PDF library:", error);
  statusEl.textContent = "Could not load saved PDF library";
  statusEl.className = "status warn";
});
