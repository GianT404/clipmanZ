#!/usr/bin/env bash
set -euo pipefail

UUID="clipboard-history@clipmanz"
SCHEMA="org.gnome.shell.extensions.clipboardhistory"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
DEST="${DATA_HOME}/gnome-shell/extensions/${UUID}"

for tool in glib-compile-schemas; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s\n' "$tool" >&2
    exit 1
  fi
done

if [[ ! -r "$ROOT/metadata.json" || ! -r "$ROOT/extension.js" || ! -r "$ROOT/prefs.js" ]]; then
  printf 'Extension files not found in %s\n' "$ROOT" >&2
  exit 1
fi

mkdir -p "$DEST/schemas"
cp "$ROOT/metadata.json" "$ROOT/extension.js" "$ROOT/prefs.js" "$ROOT/clipboardHistory.js" "$ROOT/popup.js" "$ROOT/stylesheet.css" "$DEST/"
cp "$ROOT/schemas/${SCHEMA}.gschema.xml" "$DEST/schemas/"
glib-compile-schemas --strict "$DEST/schemas"
printf 'Installed %s to %s\n' "$UUID" "$DEST"
printf 'Enable with: gnome-extensions enable %s\n' "$UUID"
