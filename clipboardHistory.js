import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import {ClipboardImageStore, MAX_IMAGE_BYTES} from './imageStore.js';

const MAX_ENTRIES = 50;
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_IMAGE_METADATA_BYTES = 16 * 1024;
const MAX_IMAGE_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_ENTRIES = 20;
const CAPTURE_DEBOUNCE_MS = 60;
const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'];

export class ClipboardHistory {
    constructor() {
        this._clipboard = St.Clipboard.get_default();
        this._entries = [];
        this._restoreEcho = null;
        this._captureGeneration = 0;
        this._reading = false;
        this._capturePending = false;
        this._enabled = true;
        this._readCancellable = null;
        this._imageWritePending = false;
        this._metadataCancellables = new Set();
        this._imageStore = new ClipboardImageStore();
        this._selection = global.display.get_selection();
        this._selectionSignal = this._selection.connect('owner-changed', (_selection, selectionType) => {
            if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
                this._captureGeneration++;
                for (const cancellable of this._metadataCancellables)
                    cancellable.cancel();
                this._metadataCancellables.clear();
                this._queueCapture();
            }
        });
        this._capture();
    }

    get entries() {
        return this._entries;
    }

    destroy() {
        this._enabled = false;
        this._captureGeneration++;
        if (this._captureSourceId) {
            GLib.source_remove(this._captureSourceId);
            this._captureSourceId = 0;
        }
        this._selection.disconnect(this._selectionSignal);
        this._selection = null;
        this._readCancellable?.cancel();
        for (const cancellable of this._metadataCancellables)
            cancellable.cancel();
        this._metadataCancellables.clear();
        this._imageStore.destroy(this._entries);
        this._entries = [];
        this.onChanged = null;
    }

    restore(entry) {
        let echo = entry;
        try {
            if (entry.type === 'image') {
                echo = {type: 'image', fingerprint: entry.fingerprint};
                this._restoreEcho = echo;
                const [bytes] = Gio.File.new_for_path(entry.path).load_bytes(null);
                this._clipboard.set_content(St.ClipboardType.CLIPBOARD, entry.mimeType, bytes);
            } else {
                this._restoreEcho = entry;
                this._clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
            }
            return true;
        } catch (error) {
            if (this._restoreEcho === echo)
                this._restoreEcho = null;
            logError(error, 'Unable to restore clipboard content');
            return false;
        }
    }

    saveImage(entry, callback) {
        if (!this._enabled || !this._entries.includes(entry))
            return false;
        return this._imageStore.save(entry, callback);
    }

    remove(entry) {
        const index = this._entries.indexOf(entry);
        if (index < 0)
            return false;
        this._entries.splice(index, 1);
        this._imageStore.delete(entry);
        this.onChanged?.();
        return true;
    }

    clear() {
        if (this._entries.length === 0 && !this._imageWritePending)
            return;
        this._captureGeneration++;
        this._capturePending = false;
        if (this._captureSourceId) {
            GLib.source_remove(this._captureSourceId);
            this._captureSourceId = 0;
        }
        this._readCancellable?.cancel();
        this._imageStore.cancelPendingWrites();
        for (const entry of this._entries)
            this._imageStore.delete(entry);
        this._entries = [];
        this.onChanged?.();
    }

    _queueCapture() {
        if (!this._enabled)
            return;
        this._readCancellable?.cancel();
        if (this._captureSourceId)
            GLib.source_remove(this._captureSourceId);
        this._captureSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CAPTURE_DEBOUNCE_MS, () => {
            this._captureSourceId = 0;
            this._capture();
            return GLib.SOURCE_REMOVE;
        });
    }

    _capture() {
        if (!this._enabled)
            return;
        if (this._reading) {
            this._capturePending = true;
            return;
        }

        this._reading = true;
        const generation = this._captureGeneration;
        try {
            const mimeTypes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
            const imageMime = IMAGE_MIME_TYPES.find(mime => mimeTypes.includes(mime));
            if (imageMime) {
                const metadataMime = ['text/uri-list', 'text/html']
                    .find(mime => mimeTypes.includes(mime)) ?? null;
                this._readImage(imageMime, metadataMime, generation);
            } else {
                this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
                    try {
                        if (this._enabled && generation === this._captureGeneration && typeof text === 'string' && text.length > 0)
                            this._captureText(text);
                    } catch (error) {
                        logError(error, 'Unable to capture clipboard text');
                    } finally {
                        this._finishCapture();
                    }
                });
            }
        } catch (error) {
            this._finishCapture();
            logError(error, 'Unable to read clipboard text');
        }
    }

    _readImage(mimeType, metadataMime, generation) {
        const selection = this._selection;
        const output = Gio.MemoryOutputStream.new_resizable();
        const cancellable = new Gio.Cancellable();
        this._readCancellable = cancellable;
        try {
            selection.transfer_async(
                Meta.SelectionType.SELECTION_CLIPBOARD,
                mimeType,
                // One extra byte lets us reject oversized images without reading them whole.
                MAX_IMAGE_BYTES + 1,
                output,
                cancellable,
                (_selection, result) => {
                    try {
                        const succeeded = selection.transfer_finish(result);
                        if (!this._enabled || generation !== this._captureGeneration || !succeeded)
                            return;
                        output.close(null);
                        const bytes = output.steal_as_bytes();
                        if (bytes.get_size() <= MAX_IMAGE_BYTES)
                            this._captureImage(mimeType, metadataMime, bytes, generation);
                    } catch (error) {
                        if (!cancellable.is_cancelled())
                            logError(error, 'Unable to capture clipboard image');
                    } finally {
                        if (this._readCancellable === cancellable)
                            this._readCancellable = null;
                        if (!output.is_closed()) {
                            try {
                                output.close(null);
                            } catch (error) {
                                logError(error, 'Unable to close clipboard image stream');
                            }
                        }
                        if (!this._imageWritePending)
                            this._finishCapture();
                    }
                },
            );
        } catch (error) {
            this._readCancellable = null;
            cancellable.cancel();
            output.close(null);
            throw error;
        }
    }

    _finishCapture() {
        this._reading = false;
        if (this._capturePending && this._enabled) {
            this._capturePending = false;
            this._queueCapture();
        }
    }

    _captureText(text) {
        if (this._restoreEcho) {
            const wasRestored = this._restoreEcho.type === 'text' && this._restoreEcho.text === text;
            this._restoreEcho = null;
            if (wasRestored)
                return;
        }
        const size = new TextEncoder().encode(text).length;
        if (size > MAX_ENTRY_BYTES || (this._entries[0]?.type === 'text' && this._entries[0].text === text))
            return;
        this._entries.unshift({type: 'text', text, time: Date.now()});
        this._trim();
        this.onChanged?.();
    }

    _captureImage(mimeType, metadataMime, bytes, generation) {
        const fingerprint = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        if (this._restoreEcho) {
            const wasRestored = this._restoreEcho.type === 'image' &&
                this._restoreEcho.fingerprint === fingerprint;
            this._restoreEcho = null;
            if (wasRestored)
                return;
        }
        const size = bytes.get_size();
        if (size === 0 || size > MAX_IMAGE_BYTES)
            return;
        const previous = this._entries[0];
        if (previous?.type === 'image' && previous.fingerprint === fingerprint)
            return;

        this._imageWritePending = true;
        this._imageStore.writeImage(mimeType, metadataMime, bytes, fingerprint, (entry, error) => {
            this._imageWritePending = false;
            if (error && this._enabled && generation === this._captureGeneration)
                logError(error, 'Unable to save clipboard image to cache');
            if (!entry || !this._enabled || generation !== this._captureGeneration) {
                if (entry)
                    this._imageStore.delete(entry);
                this._finishCapture();
                return;
            }

            this._entries.unshift(entry);
            this._trim();
            if (this._entries.includes(entry)) {
                this.onChanged?.();
                this._imageStore.readDimensions(entry, (width, height) => {
                    if (!this._entries.includes(entry))
                        return;
                    entry.width = width;
                    entry.height = height;
                    this.onChanged?.();
                });
                this._imageStore.decodeThumbnail(entry, preview => {
                    if (!this._enabled || !this._entries.includes(entry))
                        return;
                    entry.thumbnail = preview;
                    this.onChanged?.();
                });
                this._readImageMetadata(entry, generation);
            }
            this._finishCapture();
        });
    }

    _readImageMetadata(entry, generation) {
        const metadataMime = entry.metadataMime;
        if (!metadataMime)
            return;

        const selection = this._selection;
        const output = Gio.MemoryOutputStream.new_resizable();
        const cancellable = new Gio.Cancellable();
        this._metadataCancellables.add(cancellable);
        try {
            selection.transfer_async(
                Meta.SelectionType.SELECTION_CLIPBOARD,
                metadataMime,
                MAX_IMAGE_METADATA_BYTES,
                output,
                cancellable,
                (_selection, result) => {
                    try {
                        if (!selection.transfer_finish(result) || !this._enabled ||
                            generation !== this._captureGeneration || !this._entries.includes(entry))
                            return;
                        output.close(null);
                        const bytes = output.steal_as_bytes();
                        const value = new TextDecoder().decode(bytes.toArray()).slice(0, MAX_IMAGE_METADATA_BYTES);
                        const label = metadataMime === 'text/uri-list'
                            ? this._filenameFromUriList(value)
                            : this._titleFromHtml(value);
                        if (label && entry.label !== label) {
                            entry.label = label;
                            this.onChanged?.();
                        }
                    } catch (error) {
                        if (!cancellable.is_cancelled())
                            logError(error, 'Unable to read clipboard image metadata');
                    } finally {
                        this._metadataCancellables.delete(cancellable);
                        if (!output.is_closed())
                            output.close(null);
                    }
                },
            );
        } catch (error) {
            this._metadataCancellables.delete(cancellable);
            cancellable.cancel();
            output.close(null);
            logError(error, 'Unable to start clipboard image metadata read');
        }
    }

    _filenameFromUriList(value) {
        for (const line of value.split(/\r?\n/)) {
            const uri = line.trim();
            if (!uri || uri.startsWith('#'))
                continue;
            try {
                const file = Gio.File.new_for_uri(uri);
                const name = file.get_basename();
                if (name)
                    return name.slice(0, 160);
            } catch {
                // Ignore malformed URI-list entries.
            }
        }
        return null;
    }

    _titleFromHtml(value) {
        const image = value.match(/<img\b[^>]*>/i)?.[0];
        if (!image)
            return null;
        for (const attribute of ['alt', 'title', 'src']) {
            const match = image.match(new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
            const raw = match?.[1] ?? match?.[2] ?? match?.[3];
            if (!raw)
                continue;
            const cleaned = raw.replace(/&(?:amp|quot|#39|lt|gt);/g, entity => ({
                '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>',
            })[entity]).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
            if (!cleaned)
                continue;
            if (attribute === 'src') {
                if (/^data:/i.test(cleaned))
                    continue;
                try {
                    return Gio.File.new_for_uri(cleaned).get_basename()?.slice(0, 160) ?? null;
                } catch {
                    continue;
                }
            }
            return cleaned.slice(0, 160);
        }
        return null;
    }

    loadSelectedImagePreview(entry, callback, onError = null, width, height) {
        if (this._enabled && this._entries.includes(entry))
            this._imageStore.loadPreview(entry, callback, onError, width, height);
    }

    cancelSelectedImagePreview() {
        this._imageStore.cancelPreview();
    }

    _trim() {
        let textBytes = 0;
        let imageBytes = 0;
        let imageCount = 0;
        const kept = [];
        for (const entry of this._entries) {
            if (kept.length >= MAX_ENTRIES)
                break;
            if (entry.type === 'image') {
                const size = entry.size;
                if (imageCount >= MAX_IMAGE_ENTRIES || imageBytes + size > MAX_IMAGE_HISTORY_BYTES)
                    continue;
                imageCount++;
                imageBytes += size;
            } else {
                const size = new TextEncoder().encode(entry.text).length;
                if (size > MAX_ENTRY_BYTES || textBytes + size > MAX_HISTORY_BYTES)
                    continue;
                textBytes += size;
            }
            kept.push(entry);
        }
        for (const entry of this._entries) {
            if (entry.type === 'image' && !kept.includes(entry))
                this._imageStore.delete(entry);
        }
        this._entries = kept;
    }
}
