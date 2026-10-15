import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FILTERS = [
    {id: 'all', label: 'All'},
    {id: 'text', label: 'Text'},
    {id: 'link', label: 'Links'},
    {id: 'code', label: 'Code'},
    {id: 'color', label: 'Colors'},
    {id: 'image', label: 'Images'},
];
const TYPE_LABELS = {text: 'Text', link: 'Link', code: 'Code', color: 'Color', image: 'Image', secret: 'Secret'};
const TYPE_ICONS = {
    text: 'text-x-generic-symbolic',
    link: 'web-browser-symbolic',
    code: 'utilities-terminal-symbolic',
    image: 'image-x-generic-symbolic',
    secret: 'changes-prevent-symbolic',
};

function classifyEntry(item) {
    if (item.type === 'image')
        return 'image';

    const text = item.text.trim();
    if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text))
        return 'secret';
    if (/^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|(?:rgb|rgba|hsl|hsla)\([\d.%\s,+-]+\))$/i.test(text))
        return 'color';
    if (/^(?:(?:https?|ftp):\/\/|www\.)\S+$/i.test(text) || /^(?:[\da-z-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(text))
        return 'link';
    if (/\b(?:const|let|var|function|class|import|export|return|def|async|await)\b|=>|[{};]|^\$\s|^(?:git|npm|yarn|pnpm|docker|kubectl|cargo|make)\s/m.test(text))
        return 'code';
    return 'text';
}

function formatAge(timestamp) {
    const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000);
    if (minutes < 1)
        return 'Just now';
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function getPreviewText(item) {
    if (item.type === 'image') {
        return item.label || (item.mimeType === 'image/jpeg' ? 'JPEG image' : 'PNG image');
    }
    const token = item.text.match(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/);
    if (token)
        return item.text.replace(token[0], `${token[0].slice(0, 5)}••••••••••••`);
    return item.text.replace(/[\r\n\t]+/g, ' ').trim();
}

function createImageDragActor(item) {
    const actor = new St.Widget({
        style_class: 'clipboard-drag-image',
        width: 72,
        height: 72,
        content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
    });
    if (!item.thumbnail)
        return actor;

    try {
        const imageContent = St.ImageContent.new_with_preferred_size(72, 72);
        const pixbuf = item.thumbnail;
        const loaded = imageContent.set_data(
            Clutter.get_default_backend().get_cogl_context(),
            pixbuf.get_pixels(),
            pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            pixbuf.get_width(),
            pixbuf.get_height(),
            pixbuf.get_rowstride(),
        );
        if (loaded)
            actor.set_content(imageContent);
    } catch (error) {
        logError(error, 'Unable to create clipboard image drag preview');
    }
    return actor;
}

function isTabKeyEvent(event) {
    return event.get_key_symbol() === Clutter.KEY_Tab ||
        event.get_key_symbol() === Clutter.KEY_ISO_Left_Tab ||
        event.get_key_unicode() === 9;
}

export class HistoryPopup {
    constructor(history, onClose, initialState = null, onPaste = null) {
        this._history = history;
        this._onClose = onClose;
        this._onPaste = onPaste;
        this._initialState = initialState;
        this._historyChangedCallback = () => {
            if (this._overlay)
                this._render();
        };
        this._history.onChanged = this._historyChangedCallback;
        this._selected = 0;
        this._filtered = [];
        this._rows = [];
        this._activeFilter = 'all';
        this._filterButtons = new Map();
        this._dragging = false;
        this._imageDragActive = false;
        this._imageDragDroppedOutside = false;
        this._imageDragMonitor = {
            dragMotion: ({x, y}) => {
                if (this._imageDragActive)
                    this._imageDragDroppedOutside = !this._isInsidePanel([x, y]);
                return DND.DragMotionResult.CONTINUE;
            },
        };
        this._previousWindow = global.display.focus_window;
        this._overlay = new St.Widget({
            style_class: 'clipboard-overlay',
            reactive: false,
            can_focus: false,
            track_hover: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        this._panel = new St.BoxLayout({style_class: 'clipboard-panel', vertical: true, reactive: true});
        this._overlay.add_child(this._panel);
        this._build();
        Main.uiGroup.add_child(this._overlay);
        this._position();
        this._keySignal = this._entry.clutter_text.connect('key-press-event', (_text, event) => this._onKey(event));
        this._focusInSignal = this._entry.clutter_text.connect('key-focus-in', () => this._entry.clutter_text.set_cursor_visible(true));
        this._focusOutSignal = this._entry.clutter_text.connect('key-focus-out', () => this._entry.clutter_text.set_cursor_visible(false));
        this._dragPressSignal = this._panel.connect('button-press-event', (_panel, event) => this._beginDrag(event));
        this._stageKeySignal = global.stage.connect('captured-event', (_stage, event) => this._onCapturedEvent(event));
        this._searchSignal = this._entry.clutter_text.connect('text-changed', () => this._render());
        this._entry.grab_key_focus();
        this._render();
    }

    releaseFocusForPaste() {
        global.stage.set_key_focus(null);
    }

    restoreSearchFocus() {
        if (this._overlay && this._entry)
            this._entry.grab_key_focus();
    }

    close(restoreWindow = true) {
        if (!this._overlay)
            return;
        const targetWindow = restoreWindow ? this._previousWindow : null;
        this._closeFullscreen(false);
        this._history.cancelSelectedImagePreview();
        this._entry.clutter_text.disconnect(this._keySignal);
        this._entry.clutter_text.disconnect(this._focusInSignal);
        this._entry.clutter_text.disconnect(this._focusOutSignal);
        this._entry.clutter_text.disconnect(this._searchSignal);
        this._panel.disconnect(this._dragPressSignal);
        if (this._imageDragActive)
            DND.removeDragMonitor(this._imageDragMonitor);
        this._imageDragActive = false;
        this._imageDragDroppedOutside = false;
        global.stage.disconnect(this._stageKeySignal);
        if (this._history.onChanged === this._historyChangedCallback)
            this._history.onChanged = null;
        this._overlay.destroy();
        this._overlay = null;
        this._panel = null;
        this._dragging = false;
        global.stage.set_key_focus(null);
        this._previousWindow = null;
        if (targetWindow) {
            try {
                Main.activateWindow(targetWindow, global.get_current_time());
            } catch (error) {
                logError(error, 'Unable to restore the previous window');
            }
        }
        this._onClose?.(targetWindow);
        this._onClose = null;
        this._onPaste = null;
    }

    _build() {
        const topbar = new St.BoxLayout({style_class: 'clipboard-topbar', vertical: true, x_expand: true});
        const searchRow = new St.BoxLayout({style_class: 'clipboard-search-row', x_expand: true});
        const search = new St.BoxLayout({style_class: 'clipboard-search', x_expand: true});
        search.add_child(new St.Icon({
            icon_name: 'edit-find-symbolic',
            icon_size: 18,
            style_class: 'clipboard-search-icon',
        }));
        this._entry = new St.Entry({
            style_class: 'clipboard-search-entry',
            hint_text: 'Search ...',
            can_focus: true,
            x_expand: true,
        });
        if (this._initialState?.query)
            this._entry.set_text(this._initialState.query);
        search.add_child(this._entry);
        searchRow.add_child(search);

        topbar.add_child(searchRow);

        const filters = new St.BoxLayout({style_class: 'clipboard-filters', x_expand: true});
        for (const filter of FILTERS) {
            const button = new St.Button({
                style_class: `clipboard-filter${filter.id === this._activeFilter ? ' active' : ''}`,
                can_focus: false,
                reactive: true,
            });
            if (filter.id === 'all') {
                const allLabel = new St.BoxLayout({style_class: 'clipboard-filter-all'});
                allLabel.add_child(new St.Label({text: filter.label}));
                this._allFilterCount = new St.Label({style_class: 'clipboard-filter-count'});
                allLabel.add_child(this._allFilterCount);
                button.set_child(allLabel);
            } else {
                button.set_child(new St.Label({text: filter.label}));
            }
            button.connect('clicked', () => {
                this._activeFilter = filter.id;
                this._selected = 0;
                this._render();
                this._entry.grab_key_focus();
            });
            this._filterButtons.set(filter.id, button);
            filters.add_child(button);
        }
        topbar.add_child(filters);
        this._panel.add_child(topbar);

        this._body = new St.BoxLayout({style_class: 'clipboard-body', x_expand: true, y_expand: true});
        this._scroll = new St.ScrollView({style_class: 'clipboard-scroll', overlay_scrollbars: true, enable_mouse_scrolling: true, x_expand: true, y_expand: true});
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.NEVER);
        this._list = new St.BoxLayout({vertical: true, style_class: 'clipboard-list'});
        this._scroll.set_child(this._list);
        this._body.add_child(this._scroll);
        this._imagePreview = new St.Bin({
            style_class: 'clipboard-image-viewer',
            x_expand: false,
            y_expand: true,
            visible: false,
        });
        this._imagePreviewContent = new St.BoxLayout({
            vertical: true,
            style_class: 'clipboard-image-viewer-content',
            x_expand: true,
            y_expand: true,
        });
        this._imageCanvas = new St.Bin({
            style_class: 'clipboard-image-canvas',
            x_expand: true,
            y_expand: true,
        });
        this._imageTitle = new St.Label({
            style_class: 'clipboard-image-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._imageDetails = new St.Label({
            style_class: 'clipboard-image-details',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._imagePreviewContent.add_child(this._imageCanvas);
        this._imagePreviewContent.add_child(this._imageTitle);
        this._imagePreviewContent.add_child(this._imageDetails);
        this._imagePreview.set_child(this._imagePreviewContent);
        this._body.add_child(this._imagePreview);
        this._panel.add_child(this._body);

        this._empty = new St.Label({
            text: 'No matching items',
            style_class: 'clipboard-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._emptyContainer = new St.Bin({
            style_class: 'clipboard-empty-container',
            x_expand: true,
            y_expand: true,
            child: this._empty,
        });
        this._panel.add_child(this._emptyContainer);
        const footer = new St.BoxLayout({style_class: 'clipboard-footer', x_expand: true});
        const hints = new St.Label({
            text: '',
            style_class: 'clipboard-hints',
            x_expand: true,
        });
        hints.clutter_text.set_markup(
            '<span foreground="#ffffff">↵</span> Paste  ·  ' +
            '<span foreground="#ffffff">Alt+1–9</span> Select  ·  ' +
            '<span foreground="#ffffff">Tab</span> Nav  ·  ' +
            '<span foreground="#ffffff">Esc</span> Close  ·  ' +
            '<span foreground="#ffffff">Del</span> Delete'
        );
        footer.add_child(hints);
        this._panel.add_child(footer);
    }

    _updateImagePreview() {
        const item = this._filtered[this._selected];
        if (item?.type !== 'image') {
            this._history.cancelSelectedImagePreview();
            this._previewEntry = null;
            this._previewLoading = false;
            this._imagePreview.visible = false;
            this._imageCanvas.set_child(null);
            return;
        }

        this._imagePreview.visible = true;
        this._imageTitle.set_text(item.label || (item.mimeType === 'image/jpeg' ? 'JPEG image' : 'PNG image'));
        this._imageDetails.set_text(this._getImageDetails(item));
        if (this._previewEntry === item)
            return;

        this._previewEntry = item;
        this._previewLoading = true;
        this._imageCanvas.set_child(new St.Label({
            text: 'Loading image…',
            style_class: 'clipboard-image-loading',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._history.loadSelectedImagePreview(item, preview => {
            if (!this._overlay || this._filtered[this._selected] !== item)
                return;
            this._showSelectedImage(preview);
        }, () => {
            if (!this._overlay || this._filtered[this._selected] !== item)
                return;
            this._previewLoading = false;
            this._imageCanvas.set_child(new St.Label({
                text: 'Image preview unavailable',
                style_class: 'clipboard-image-loading',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        });
    }

    _showSelectedImage(preview) {
        try {
            const item = this._filtered[this._selected];
            const imageContent = St.ImageContent.new_with_preferred_size(
                preview.get_width(), preview.get_height());
            const loaded = imageContent.set_data(
                Clutter.get_default_backend().get_cogl_context(),
                preview.get_pixels(),
                preview.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                preview.get_width(),
                preview.get_height(),
                preview.get_rowstride(),
            );
            if (!loaded)
                throw new Error('St.ImageContent rejected the clipboard preview');

            const image = new St.Widget({
                style_class: 'clipboard-image-full',
                x_expand: true,
                y_expand: true,
                content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
            });
            image.set_content(imageContent);
            this._imageCanvas.set_child(image);
            this._imageDetails.set_text(this._getImageDetails(item));
            this._previewLoading = false;
        } catch (error) {
            logError(error, 'Unable to display selected clipboard image');
            this._previewLoading = false;
            this._imageCanvas.set_child(new St.Label({
                text: 'Image preview unavailable',
                style_class: 'clipboard-image-loading',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
    }

    _getImageDetails(item) {
        const format = item.mimeType === 'image/jpeg' ? 'JPEG' : 'PNG';
        const dimensions = item.width && item.height ? `${item.width} × ${item.height}` : 'Image';
        const size = item.size >= 1024 * 1024
            ? `${(item.size / (1024 * 1024)).toFixed(1)} MB`
            : `${Math.max(1, Math.round(item.size / 1024))} KB`;
        return `${format} · ${dimensions} · ${size}`;
    }

    _position() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._monitor = monitor;
        const width = Math.max(1, Math.min(561, monitor.width - 32));
        const height = Math.max(1, Math.min(484, monitor.height - 32));
        const [savedX, savedY] = this._initialState?.position ?? [-1, -1];
        const x = savedX >= 0 ? Math.min(savedX, monitor.width - width) : (monitor.width - width) / 2;
        const y = savedY >= 0 ? Math.min(savedY, monitor.height - height) : (monitor.height - height) / 2;
        this._panel.set_position(Math.round(x), Math.round(y));
        this._panel.set_size(width, height);
        const bodyWidth = Math.max(1, width - 18 - 9 - 4);
        this._imagePreview.set_width(Math.round(bodyWidth * 2 / 3));
        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
    }

    _onKey(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Delete) {
            const shiftPressed = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
            if (shiftPressed) {
                this._history.clear();
                this._selected = 0;
                return Clutter.EVENT_STOP;
            }
            if (this._entry.get_text().length === 0) {
                const item = this._filtered[this._selected];
                if (item)
                    this._history.remove(item);
                return Clutter.EVENT_STOP;
            }
        }
        if (symbol === Clutter.KEY_Up || symbol === Clutter.KEY_Down) {
            if (this._filtered.length > 0) {
                const delta = symbol === Clutter.KEY_Up ? -1 : 1;
                this._rows[this._selected]?.remove_style_class_name('selected');
                this._selected = (this._selected + delta + this._filtered.length) % this._filtered.length;
                this._rows[this._selected]?.add_style_class_name('selected');
                this._updateImagePreview();
                this._scrollSelectedIntoView();
            }
            return Clutter.EVENT_STOP;
        }
        if (isTabKeyEvent(event)) {
            this._cycleFilter((state & Clutter.ModifierType.SHIFT_MASK) !== 0);
            return Clutter.EVENT_STOP;
        }
        if ((state & Clutter.ModifierType.MOD1_MASK) !== 0 && symbol >= Clutter.KEY_1 && symbol <= Clutter.KEY_9) {
            const index = symbol - Clutter.KEY_1;
            const item = this._filtered[index];
            if (item)
                this._choose(item, true);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            const item = this._filtered[this._selected];
            const shiftPressed = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
            if (item?.type === 'image' && shiftPressed) {
                this._saveSelectedImage(item);
                return Clutter.EVENT_STOP;
            }
            if (item)
                this._choose(item, true);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _beginDrag(event) {
        if (event.get_source() !== this._panel || event.get_button() !== Clutter.BUTTON_PRIMARY || !this._monitor)
            return Clutter.EVENT_PROPAGATE;
        const [pointerX, pointerY] = event.get_coords();
        const [panelX, panelY] = this._panel.get_position();
        this._dragOffsetX = pointerX - this._monitor.x - panelX;
        this._dragOffsetY = pointerY - this._monitor.y - panelY;
        this._dragging = true;
        return Clutter.EVENT_STOP;
    }

    _onCapturedEvent(event) {
        if (this._fullscreenActor) {
            if (event.type() === Clutter.EventType.KEY_PRESS) {
                const symbol = event.get_key_symbol();
                if (symbol === Clutter.KEY_Escape || symbol === Clutter.KEY_space)
                    this._closeFullscreen();
            } else if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                this._closeFullscreen();
            }
            return Clutter.EVENT_STOP;
        }
        if (event.type() === Clutter.EventType.KEY_PRESS) {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_space && this._filtered[this._selected]?.type === 'image') {
                this._openFullscreen(this._filtered[this._selected]);
                return Clutter.EVENT_STOP;
            }
            if (isTabKeyEvent(event)) {
                const reverse = symbol === Clutter.KEY_ISO_Left_Tab ||
                    (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
                this._cycleFilter(reverse);
                return Clutter.EVENT_STOP;
            }
        }
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_PRIMARY &&
            !this._isInsidePanel(event.get_coords())) {
            this.close(false);
            return Clutter.EVENT_PROPAGATE;
        }
        if (event.type() === Clutter.EventType.BUTTON_RELEASE &&
            event.get_button() === Clutter.BUTTON_PRIMARY &&
            this._isInsidePanel(event.get_coords())) {
            this._entry.grab_key_focus();
        }
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;

        if (event.type() === Clutter.EventType.MOTION) {
            const [pointerX, pointerY] = event.get_coords();
            const maxX = Math.max(0, this._monitor.width - this._panel.width);
            const maxY = Math.max(0, this._monitor.height - this._panel.height);
            const x = Math.max(0, Math.min(maxX, pointerX - this._monitor.x - this._dragOffsetX));
            const y = Math.max(0, Math.min(maxY, pointerY - this._monitor.y - this._dragOffsetY));
            this._panel.set_position(Math.round(x), Math.round(y));
            return Clutter.EVENT_STOP;
        }
        if (event.type() === Clutter.EventType.BUTTON_RELEASE && event.get_button() === Clutter.BUTTON_PRIMARY) {
            this._dragging = false;
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _saveSelectedImage(item) {
        this._history.saveImage(item, (path, error) => {
            if (error) {
                logError(error, 'Unable to save clipboard image');
                Main.notify('Clipboard History', 'Unable to save image');
                return;
            }
            if (path)
                Main.notify('Clipboard History', `Image saved to ${path}`);
        });
    }

    _openFullscreen(item) {
        const monitor = this._monitor;
        if (!monitor || item?.type !== 'image' || this._fullscreenActor)
            return;

        this._fullscreenLoading = new St.Label({
            text: 'Loading image…',
            style_class: 'clipboard-image-loading',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fullscreenActor = new St.Bin({
            style_class: 'clipboard-image-fullscreen',
            reactive: true,
            can_focus: true,
            child: this._fullscreenLoading,
        });
        this._fullscreenKeySignal = this._fullscreenActor.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape || symbol === Clutter.KEY_space)
                this._closeFullscreen();
            return Clutter.EVENT_STOP;
        });
        this._fullscreenActor.set_position(monitor.x, monitor.y);
        this._fullscreenActor.set_size(monitor.width, monitor.height);
        Main.uiGroup.add_child(this._fullscreenActor);
        this._fullscreenActor.grab_key_focus();
        this._panel.hide();

        this._history.loadSelectedImagePreview(item, preview => {
            if (!this._overlay || !this._fullscreenActor || this._filtered[this._selected] !== item)
                return;
            try {
                const imageContent = St.ImageContent.new_with_preferred_size(
                    preview.get_width(), preview.get_height());
                const loaded = imageContent.set_data(
                    Clutter.get_default_backend().get_cogl_context(),
                    preview.get_pixels(),
                    preview.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                    preview.get_width(),
                    preview.get_height(),
                    preview.get_rowstride(),
                );
                if (!loaded)
                    throw new Error('St.ImageContent rejected the full-screen image');
                const image = new St.Widget({
                    style_class: 'clipboard-image-fullscreen-content',
                    x_expand: true,
                    y_expand: true,
                    content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
                });
                image.set_content(imageContent);
                this._fullscreenActor.set_child(image);
            } catch (error) {
                logError(error, 'Unable to display full-screen clipboard image');
                this._closeFullscreen();
            }
        }, () => {
            if (this._fullscreenActor) {
                Main.notify('Clipboard History', 'Unable to open image');
                this._closeFullscreen();
            }
        }, monitor.width, monitor.height);
    }

    _closeFullscreen(refreshPreview = true) {
        if (!this._fullscreenActor)
            return;
        this._history.cancelSelectedImagePreview();
        this._fullscreenActor.disconnect(this._fullscreenKeySignal);
        this._fullscreenKeySignal = 0;
        this._fullscreenActor.destroy();
        this._fullscreenActor = null;
        this._fullscreenLoading = null;
        if (this._panel)
            this._panel.show();
        if (this._entry)
            this._entry.grab_key_focus();
        if (refreshPreview && this._overlay)
            this._updateImagePreview();
    }

    _isInsidePanel([x, y]) {
        const [panelX, panelY] = this._panel.get_transformed_position();
        const [panelWidth, panelHeight] = this._panel.get_transformed_size();
        return x >= panelX && x <= panelX + panelWidth &&
            y >= panelY && y <= panelY + panelHeight;
    }

    _scrollSelectedIntoView() {
        const row = this._rows[this._selected];
        const adjustment = this._scroll.get_vadjustment();
        if (!row || adjustment.page_size <= 0)
            return;

        const [, rowY] = row.get_transformed_position();
        const [, viewportY] = this._scroll.get_transformed_position();
        const rowTop = rowY - viewportY;
        const rowBottom = rowTop + row.height;
        let delta = 0;
        if (rowTop < 0)
            delta = rowTop;
        else if (rowBottom > adjustment.page_size)
            delta = rowBottom - adjustment.page_size;

        if (delta !== 0) {
            adjustment.value = Math.max(adjustment.lower,
                Math.min(adjustment.value + delta, adjustment.upper - adjustment.page_size));
        }
    }

    _cycleFilter(reverse = false) {
        const current = FILTERS.findIndex(filter => filter.id === this._activeFilter);
        const offset = reverse ? -1 : 1;
        this._activeFilter = FILTERS[(current + offset + FILTERS.length) % FILTERS.length].id;
        this._selected = 0;
        this._render();
        this._entry.grab_key_focus();
    }

    _render() {
        const query = this._entry.get_text().trim().toLocaleLowerCase();
        this._filtered = this._history.entries.filter(item => {
            const kind = classifyEntry(item);
            const matchesFilter = this._activeFilter === 'all' || kind === this._activeFilter || (this._activeFilter === 'text' && kind === 'secret');
            const searchable = item.type === 'image'
                ? `${kind} ${item.mimeType} ${item.width ?? ''} ${item.height ?? ''} ${item.size}`
                : `${kind} ${item.text}`;
            return matchesFilter && searchable.toLocaleLowerCase().includes(query);
        });
        for (const [filter, button] of this._filterButtons) {
            if (filter === this._activeFilter)
                button.add_style_class_name('active');
            else
                button.remove_style_class_name('active');
        }
        const restoredSelection = this._initialState?.selected
            ? this._filtered.indexOf(this._initialState.selected)
            : -1;
        if (restoredSelection >= 0)
            this._selected = restoredSelection;
        else
            this._selected = Math.min(this._selected, Math.max(0, this._filtered.length - 1));
        this._initialState = null;
        this._list.destroy_all_children();
        this._rows = [];
        this._allFilterCount.set_text(String(this._history.entries.length));
        this._emptyContainer.visible = this._filtered.length === 0;
        this._body.visible = this._filtered.length > 0;
        this._filtered.forEach((item, index) => {
            const kind = classifyEntry(item);
            const row = new St.Button({
                style_class: `clipboard-row${item.type === 'image' ? ' clipboard-row-image' : ''}${index === this._selected ? ' selected' : ''}`,
                x_expand: true,
                can_focus: false,
                reactive: true,
            });
            const content = new St.BoxLayout({style_class: 'clipboard-row-content', x_expand: true});
            if (item.type === 'image') {
                if (item.thumbnail) {
                    try {
                        const imageContent = St.ImageContent.new_with_preferred_size(35, 35);
                        imageContent.set_preferred_width(35);
                        imageContent.set_preferred_height(35);
                        const hasAlpha = item.thumbnail.get_has_alpha();
                        const loaded = imageContent.set_data(
                            Clutter.get_default_backend().get_cogl_context(),
                            item.thumbnail.get_pixels(),
                            hasAlpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                            item.thumbnail.get_width(),
                            item.thumbnail.get_height(),
                            item.thumbnail.get_rowstride(),
                        );
                        if (loaded) {
                            content.add_child(new St.Icon({
                                gicon: imageContent,
                                icon_size: 35,
                                style_class: 'clipboard-image-preview',
                            }));
                        } else {
                            log('Clipboard History: St.ImageContent rejected the thumbnail pixel data');
                        }
                    } catch (error) {
                        logError(error, 'Unable to render clipboard image preview');
                    }
                }
                if (!item.thumbnail || content.get_n_children() === 0) {
                    content.add_child(new St.Icon({icon_name: 'image-x-generic-symbolic', style_class: 'clipboard-image-placeholder', icon_size: 26}));
                }
            } else {
                if (kind === 'color') {
                    content.add_child(new St.Widget({
                        style_class: 'clipboard-color-swatch',
                        style: `background-color: ${item.text.trim()};`,
                    }));
                } else {
                    content.add_child(new St.Icon({icon_name: TYPE_ICONS[kind] ?? TYPE_ICONS.text, style_class: 'clipboard-type-icon', icon_size: 22}));
                }
            }

            const details = new St.BoxLayout({vertical: true, style_class: 'clipboard-row-details', x_expand: true});
            const preview = getPreviewText(item);
            const label = new St.Label({text: preview, style_class: 'clipboard-preview', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            if (kind === 'code' || kind === 'color' || kind === 'secret')
                label.add_style_class_name('clipboard-preview-mono');
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            details.add_child(label);

            const metadata = new St.BoxLayout({style_class: 'clipboard-row-metadata'});
            metadata.add_child(new St.Label({text: TYPE_LABELS[kind] ?? 'Text', style_class: 'clipboard-kind'}));
            metadata.add_child(new St.Label({text: formatAge(item.time), style_class: 'clipboard-age'}));
            if (item.type === 'image')
                row.add_style_class_name('clipboard-row-image');
            details.add_child(metadata);
            content.add_child(details);
            if (index < 9) {
                const badge = new St.Label({text: String(index + 1), style_class: 'clipboard-key-badge'});
                content.add_child(badge);
            }
            row.set_child(content);

            if (item.type === 'image') {
                row._delegate = {
                    getDragActor: () => createImageDragActor(item),
                    getDragActorSource: () => row,
                };
                const draggable = DND.makeDraggable(row, {dragActorMaxSize: 96});
                draggable.connect('drag-begin', () => {
                    this._imageDragActive = true;
                    this._imageDragDroppedOutside = false;
                    DND.addDragMonitor(this._imageDragMonitor);
                });
                draggable.connect('drag-end', () => {
                    if (this._imageDragActive)
                        DND.removeDragMonitor(this._imageDragMonitor);
                    const droppedOutside = this._imageDragDroppedOutside;
                    this._imageDragActive = false;
                    this._imageDragDroppedOutside = false;
                    if (droppedOutside && this._overlay)
                        this._choose(item, true);
                });
            }

            row.connect('clicked', () => {
                this._rows[this._selected]?.remove_style_class_name('selected');
                this._selected = index;
                row.add_style_class_name('selected');
                this._updateImagePreview();
                this._choose(item, true);
            });
            this._rows.push(row);
            this._list.add_child(row);
        });
        this._updateImagePreview();
    }

    _choose(item, shouldPaste = false) {
        if (!this._history.restore(item) || !shouldPaste || !this._previousWindow)
            return;
        this._onPaste?.(this._previousWindow);
    }
}

