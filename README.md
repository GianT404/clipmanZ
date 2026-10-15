# Clipboard History

A text-and-image clipboard history extension for GNOME Shell 50. It keeps up to 50 entries in memory while enabled. Text is limited to 64 KiB per entry and 1 MiB total. PNG/JPEG images are limited to 4 MiB each, 20 images, and 64 MiB total. Image data is held in a private temporary cache; the in-memory history keeps only metadata and small thumbnails. History is cleared when the extension is disabled or GNOME Shell exits.

## Install

```sh
./install.sh
gnome-extensions enable clipboard-history@clipmanz
```

`install.sh` copies the current source files to the installed extension directory. It does not hot-reload the main GNOME Shell process. GNOME Shell 50.5/GJS caches loaded extension modules, so disabling and enabling the extension can still leave modified JavaScript stale. There is no supported in-place reload for the main Wayland session; log out and back in to apply code changes there.

For development without logging out of the main desktop, run a separate GNOME Shell Devkit session:

```sh
./devkit.sh
```

On Arch, install the `mutter-devkit` package first if needed. This runs the extension in a separate test desktop; it does not update the extension currently running in the main session. Close and relaunch the Devkit window after code changes.

The default shortcut is `Super + .`. Open its Preferences from GNOME Extensions, or run `gnome-extensions prefs clipboard-history@clipmanz`, to record a different shortcut or reset it. You can also inspect or change the stored value with `gsettings get org.gnome.shell.extensions.clipboardhistory toggle-shortcut` and `gsettings set org.gnome.shell.extensions.clipboardhistory toggle-shortcut "['<Super>period']"`.

## Use

Type to search and use Up and Down to select. Filter chips separate text, links, code, colors, and images. Text classification is a local syntax heuristic. Press Enter or click an entry to restore it and send Ctrl+V to the previously focused app. With an image selected, press Space to view it full-screen, or Shift+Enter to save the original image to Pictures. Escape exits the full-screen view; Space or a click also returns to the popup. The popup remains visible while briefly releasing keyboard focus for the paste, then returns focus to search; press Escape when finished. Drag an image row outside the popup and release to paste it into the previously focused app. This is drag-to-paste rather than native cross-window drag-and-drop, which GNOME Shell extensions cannot reliably source on Wayland. Drag from empty panel padding or gaps to move the popup. Auto-paste uses GNOME Shell's in-process Clutter virtual keyboard with hardware keycodes and monotonic timestamps. PNG and JPEG entries show a small in-memory thumbnail and can be pasted with Enter, click, or drag-out.

## Notes

Clipboard capture is driven by Mutter's `Meta.Selection::owner-changed` signal, debounced by 60 ms; only the current clipboard MIME is read, with one asynchronous read/write in flight. Text and image metadata remain in memory. PNG/JPEG originals are written asynchronously to `$XDG_CACHE_HOME/clipboard-history@clipmanz` (or the user's default cache directory), with private file permissions and a 64 MiB/20-image cap. Small thumbnails decode asynchronously to at most 112x84; only the selected image is decoded for the larger right-side preview, capped at 800x600. Image entries also read at most 16 KiB from `text/uri-list` or `text/html` when offered, to show a clipboard-provided filename or image title. This metadata is optional: screenshots and copied pixels often provide no filename/title, and the extension does not guess whether an image came from a screenshot. Cache files are removed when the extension is disabled and stale files are cleaned on startup. History metadata is not persisted across Shell restarts. Other image formats and non-text, non-image MIME types are ignored.

To inspect status and logs:

```sh
gnome-extensions info clipboard-history@clipmanz
journalctl --user -f -o cat /usr/bin/gnome-shell
```

To create a bundle for distribution:

```sh
gnome-extensions pack . --extra-source=clipboardHistory.js --extra-source=popup.js
```
