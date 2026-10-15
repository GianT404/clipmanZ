import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const THUMBNAIL_WIDTH = 112;
const THUMBNAIL_HEIGHT = 84;
const DEFAULT_PREVIEW_WIDTH = 880;
const DEFAULT_PREVIEW_HEIGHT = 660;

export class ClipboardImageStore {
    constructor() {
        this._enabled = true;
        this._cacheDir = this._createCacheDirectory();
        this._writeCancellables = new Set();
        this._saveCancellables = new Set();
        this._thumbnailCancellable = new Gio.Cancellable();
        this._previewCancellable = null;
    }

    destroy(entries) {
        this._enabled = false;
        this.cancelPendingWrites();
        for (const cancellable of this._saveCancellables)
            cancellable.cancel();
        this._saveCancellables.clear();
        this._thumbnailCancellable.cancel();
        this.cancelPreview();
        for (const entry of entries)
            this.delete(entry);
        this._clearDirectory(this._cacheDir);
    }

    writeImage(mimeType, metadataMime, bytes, fingerprint, callback) {
        if (!this._enabled || !this._cacheDir) {
            callback(null, new Error('Image cache is unavailable'));
            return;
        }
        const extension = mimeType === 'image/png' ? 'png' : 'jpg';
        const file = this._cacheDir.get_child(`image-${GLib.uuid_string_random()}.${extension}`);
        const entry = {
            type: 'image', mimeType, path: file.get_path(), size: bytes.get_size(), fingerprint,
            metadataMime, thumbnail: null, time: Date.now(),
        };
        const cancellable = new Gio.Cancellable();
        this._writeCancellables.add(cancellable);
        try {
            file.replace_contents_bytes_async(
                bytes,
                null,
                false,
                Gio.FileCreateFlags.PRIVATE,
                cancellable,
                (_file, result) => {
                    let saved = false;
                    let error = null;
                    try {
                        [saved] = file.replace_contents_finish(result);
                        if (!saved)
                            error = new Error('Image cache write did not complete');
                    } catch (writeError) {
                        error = writeError;
                    } finally {
                        this._writeCancellables.delete(cancellable);
                    }

                    if (!saved || !this._enabled) {
                        this.delete(entry);
                        callback(null, error);
                        return;
                    }
                    callback(entry, null);
                },
            );
        } catch (error) {
            this._writeCancellables.delete(cancellable);
            cancellable.cancel();
            this.delete(entry);
            callback(null, error);
        }
    }

    cancelPendingWrites() {
        for (const cancellable of this._writeCancellables)
            cancellable.cancel();
        this._writeCancellables.clear();
    }

    delete(entry) {
        if (!entry?.path)
            return;
        const file = Gio.File.new_for_path(entry.path);
        if (!file.query_exists(null))
            return;
        try {
            file.delete(null);
        } catch (error) {
            logError(error, 'Unable to remove clipboard image cache file');
        }
    }

    save(entry, callback) {
        if (!this._enabled || entry.type !== 'image')
            return false;
        const picturesPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        const directoryPath = picturesPath || GLib.get_home_dir();
        try {
            const result = GLib.mkdir_with_parents(directoryPath, 0o755);
            if (result !== 0)
                throw new Error(`Unable to access save directory (errno ${result})`);

            const extension = entry.mimeType === 'image/jpeg' ? 'jpg' : 'png';
            const rawName = entry.label || `Clipboard image ${new Date(entry.time).toISOString().replace(/[:.]/g, '-')}`;
            const baseName = rawName
                .replace(/\.(?:png|jpe?g)$/i, '')
                .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 120) || 'Clipboard image';
            let destination;
            for (let suffix = 1; suffix <= 1000; suffix++) {
                const name = suffix === 1
                    ? `${baseName}.${extension}`
                    : `${baseName} (${suffix}).${extension}`;
                const candidate = Gio.File.new_for_path(GLib.build_filenamev([directoryPath, name]));
                if (!candidate.query_exists(null)) {
                    destination = candidate;
                    break;
                }
            }
            if (!destination)
                throw new Error('Unable to find an available image filename');

            const source = Gio.File.new_for_path(entry.path);
            const cancellable = new Gio.Cancellable();
            this._saveCancellables.add(cancellable);
            source.copy_async(destination, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT,
                cancellable, null, (file, result) => {
                    let savedPath = null;
                    let error = null;
                    try {
                        file.copy_finish(result);
                        savedPath = destination.get_path();
                    } catch (copyError) {
                        if (!cancellable.is_cancelled())
                            error = copyError;
                    } finally {
                        this._saveCancellables.delete(cancellable);
                    }
                    callback?.(savedPath, error);
                });
            return true;
        } catch (error) {
            callback?.(null, error);
            return false;
        }
    }

    readDimensions(entry, callback) {
        GdkPixbuf.Pixbuf.get_file_info_async(entry.path, null, (_source, result) => {
            try {
                const [, width, height] = GdkPixbuf.Pixbuf.get_file_info_finish(result);
                if (this._enabled && width > 0 && height > 0)
                    callback(width, height);
            } catch {
                // Some image variants do not expose dimensions through GdkPixbuf.
            }
        });
    }

    decodeThumbnail(entry, callback) {
        this._decode(entry, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, this._thumbnailCancellable,
            preview => callback(preview), 'clipboard image thumbnail');
    }

    loadPreview(entry, callback, onError = null, width = DEFAULT_PREVIEW_WIDTH, height = DEFAULT_PREVIEW_HEIGHT) {
        this.cancelPreview();
        if (!this._enabled)
            return;
        const cancellable = new Gio.Cancellable();
        this._previewCancellable = cancellable;
        this._decode(entry, width, height, cancellable, preview => {
            if (this._previewCancellable !== cancellable)
                return;
            this._previewCancellable = null;
            callback(preview);
        }, 'selected clipboard image', () => {
            if (this._previewCancellable === cancellable)
                this._previewCancellable = null;
            onError?.();
        });
    }

    cancelPreview() {
        this._previewCancellable?.cancel();
        this._previewCancellable = null;
    }

    _createCacheDirectory() {
        const rootPath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'clipboard-history@clipmanz']);
        try {
            const result = GLib.mkdir_with_parents(rootPath, 0o700);
            if (result !== 0)
                throw new Error(`mkdir failed with errno ${result}`);
            if (GLib.chmod(rootPath, 0o700) !== 0)
                throw new Error('Unable to set private clipboard cache permissions');
            const root = Gio.File.new_for_path(rootPath);
            const pid = GLib.file_read_link('/proc/self');
            if (!/^\d+$/.test(pid))
                throw new Error('Unable to determine this Shell process ID');
            this._pruneStaleSessions(root, pid);
            const directory = root.get_child(`session-${pid}`);
            if (GLib.mkdir_with_parents(directory.get_path(), 0o700) !== 0 ||
                GLib.chmod(directory.get_path(), 0o700) !== 0)
                throw new Error('Unable to prepare private session image cache');
            this._clearDirectory(directory);
            return directory;
        } catch (error) {
            logError(error, 'Unable to prepare private clipboard image cache');
            return null;
        }
    }

    _pruneStaleSessions(root, currentPid) {
        let children;
        try {
            children = root.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = children.next_file(null))) {
                const match = info.get_name().match(/^session-(\d+)$/);
                if (!match || match[1] === currentPid || Gio.File.new_for_path(`/proc/${match[1]}`).query_exists(null))
                    continue;
                const staleDir = root.get_child(info.get_name());
                this._clearDirectory(staleDir);
                staleDir.delete(null);
            }
            children.close(null);
        } catch (error) {
            logError(error, 'Unable to prune stale clipboard image cache sessions');
        }
    }

    _clearDirectory(directory) {
        if (!directory)
            return;
        let children;
        try {
            children = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = children.next_file(null))) {
                try {
                    directory.get_child(info.get_name()).delete(null);
                } catch (error) {
                    logError(error, 'Unable to remove clipboard image cache file');
                }
            }
            children.close(null);
        } catch (error) {
            logError(error, 'Unable to clean clipboard image cache');
        }
    }

    _decode(entry, width, height, cancellable, onReady, context, onError = null) {
        const file = Gio.File.new_for_path(entry.path);
        try {
            file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                let stream;
                try {
                    stream = source.read_finish(result);
                    GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, width, height, true,
                        cancellable, (_source, decodeResult) => {
                            try {
                                const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(decodeResult);
                                if (this._enabled && !cancellable.is_cancelled())
                                    onReady(pixbuf);
                            } catch (error) {
                                if (!cancellable.is_cancelled()) {
                                    logError(error, `Unable to decode ${context}`);
                                    onError?.();
                                }
                            } finally {
                                try {
                                    stream.close(null);
                                } catch (error) {
                                    logError(error, `Unable to close ${context} stream`);
                                }
                            }
                        });
                } catch (error) {
                    if (!cancellable.is_cancelled()) {
                        logError(error, `Unable to read ${context}`);
                        onError?.();
                    }
                    stream?.close(null);
                }
            });
        } catch (error) {
            if (!cancellable.is_cancelled()) {
                logError(error, `Unable to start reading ${context}`);
                onError?.();
            }
        }
    }
}
