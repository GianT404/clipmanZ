#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$ROOT/build}"

if ! command -v gnome-extensions >/dev/null 2>&1; then
  printf 'Missing prerequisite: gnome-extensions (install GNOME Shell tools).\n' >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cd "$ROOT"
gnome-extensions pack . --force --out-dir "$OUT_DIR" \
  --extra-source=clipboardHistory.js \
  --extra-source=historyEntry.js \
  --extra-source=imageStore.js \
  --extra-source=popup.js \
  --extra-source=popupImageViewer.js \
  --extra-source=shellCompat.js \
  --extra-source=LICENSE
