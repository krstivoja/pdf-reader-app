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

// ---- check Kokoro + load voices ----
async function initKokoro() {
  try {
    const r = await http(`${KOKORO_ROOT}/health`);
    if (!r.ok) throw new Error();
    let voices = [];
    try {
      const vr = await http(`${KOKORO}/audio/voices`);
      const j = await vr.json();
      voices = j.voices || j.data || [];
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

// ---- PDF -> sentences ----
let sentences = [];
async function loadPDF(file) {
  statusEl.textContent = "Extracting text…";
  statusEl.className = "status";
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  let full = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    full += content.items.map((i) => i.str).join(" ") + "\n";
    statusEl.textContent = `Extracting… page ${p}/${pdf.numPages}`;
  }
  full = full.replace(/\s+/g, " ").replace(/-\s+/g, ""); // de-hyphenate line breaks
  sentences = (full.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [full])
    .map((s) => s.trim())
    .filter((s) => s.length > 1);

  $("text").innerHTML = sentences
    .map((s, i) => `<span class="sent" data-i="${i}">${escapeHtml(s)} </span>`)
    .join("");
  $("drop").classList.add("hidden");
  $("reader").classList.add("show");
  $("play").disabled = false;
  statusEl.textContent = `Loaded · ${sentences.length} sentences`;
  statusEl.className = "status ok";
}
const escapeHtml = (s) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---- playback: synth current, prefetch next, queue ----
let idx = 0, playing = false, paused = false, currentAudio = null, prefetch = null;

async function synth(i) {
  const r = await http(`${KOKORO}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer not-needed" },
    body: JSON.stringify({
      model: "kokoro",
      input: sentences[i],
      voice: $("voice").value,
      response_format: "mp3",
      speed: parseFloat($("speed").value),
    }),
  });
  if (!r.ok) throw new Error("TTS failed: " + r.status);
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
$("new").onclick = () => {
  stopAll(); idx = 0; sentences = [];
  $("reader").classList.remove("show"); $("drop").classList.remove("hidden");
  $("play").disabled = true;
};
$("speed").oninput = (e) => ($("speedVal").textContent = parseFloat(e.target.value).toFixed(1) + "×");

$("text").onclick = (e) => {
  const s = e.target.closest(".sent"); if (!s) return;
  const i = +s.dataset.i;
  if (playing) { if (currentAudio) currentAudio.pause(); prefetch = null; playFrom(i); }
  else { idx = i; highlight(i); }
};

// ---- drop zone ----
const drop = $("drop"), fileInput = $("file");
drop.onclick = () => fileInput.click();
fileInput.onchange = (e) => { if (e.target.files[0]) loadPDF(e.target.files[0]); };
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (e) => {
  const f = [...e.dataTransfer.files].find((f) => f.type === "application/pdf");
  if (f) loadPDF(f);
});
