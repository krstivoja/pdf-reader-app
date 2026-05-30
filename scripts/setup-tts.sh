#!/usr/bin/env bash
# Fetch the Kokoro TTS model + voice embeddings that are too large to commit.
# Idempotent: skips files that already exist with the expected size.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/resources/tts"

mkdir -p "$DEST"

MODEL_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx"
MODEL_DEST="$DEST/model.onnx"
MODEL_MIN_BYTES=$((150 * 1024 * 1024))

VOICES_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
VOICES_DEST="$DEST/voices.bin"
VOICES_MIN_BYTES=$((20 * 1024 * 1024))

file_size_bytes() {
  if [ ! -f "$1" ]; then echo 0; return; fi
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1"
}

fetch() {
  local url="$1" dest="$2" min_bytes="$3"
  local existing
  existing="$(file_size_bytes "$dest")"
  if [ "$existing" -ge "$min_bytes" ]; then
    printf "✓ %s already present (%s bytes)\n" "$(basename "$dest")" "$existing"
    return
  fi
  printf "→ downloading %s\n" "$(basename "$dest")"
  curl --fail --location --progress-bar -o "$dest" "$url"
  local got
  got="$(file_size_bytes "$dest")"
  if [ "$got" -lt "$min_bytes" ]; then
    echo "✗ $(basename "$dest") downloaded but too small ($got bytes < $min_bytes). Removing." >&2
    rm -f "$dest"
    exit 1
  fi
  printf "✓ %s ready (%s bytes)\n" "$(basename "$dest")" "$got"
}

fetch "$MODEL_URL"  "$MODEL_DEST"  "$MODEL_MIN_BYTES"
fetch "$VOICES_URL" "$VOICES_DEST" "$VOICES_MIN_BYTES"

echo "Voice engine resources are in $DEST"
