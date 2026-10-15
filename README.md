# Clipboard History

A GNOME Shell clipboard history extension for text, links, code, colors, and images. Text history stays in memory; image data uses a temporary local cache. Nothing is uploaded and there is no telemetry.

## Features

- Search and filter clipboard history.
- Paste entries with Enter, a mouse click, or Alt+1-9.
- Preview images, view them full-screen, save them, and drag them to apps.
- Customize the popup shortcut in Extension Preferences.

## Install

After publication, install **Clipboard History** from [extensions.gnome.org](https://extensions.gnome.org/) using the GNOME Extensions app or a compatible extension manager.

For maintainers: run `./pack.sh` to create `build/clipboard-history@clipmanz.shell-extension.zip`, then upload that archive at [extensions.gnome.org/upload](https://extensions.gnome.org/upload/). The local `install.sh` is only a development helper and is not part of the published extension bundle.

## Key Bindings

| Key | Action |
|-----|--------|
| Configured shortcut | Toggle popup |
| `Enter` | Paste selected entry |
| `Alt + 1-9` | Paste a numbered entry |
| `Tab` / `Shift + Tab` | Switch history filters |
| `Space` | Open selected image full-screen |
| `Delete` / `Shift + Delete` | Delete selected entry / clear history |
| `Escape` | Close popup or image view |
