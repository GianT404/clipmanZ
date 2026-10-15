import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class PopupImageViewer {
    constructor(history, restoreFocus) {
        this._history = history;
        this._restoreFocus = restoreFocus;
        this._entry = null;
        this._fullscreenActor = null;
        this._preview = new St.Bin({
            style_class: 'clipboard-image-viewer',
            x_expand: false,
            y_expand: true,
            visible: false,
        });
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'clipboard-image-viewer-content',
            x_expand: true,
            y_expand: true,
        });
        this._canvas = new St.Bin({style_class: 'clipboard-image-canvas', x_expand: true, y_expand: true});
        this._title = new St.Label({
            style_class: 'clipboard-image-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._details = new St.Label({
            style_class: 'clipboard-image-details',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(this._canvas);
        content.add_child(this._title);
        content.add_child(this._details);
        this._preview.set_child(content);
    }

    get actor() {
        return this._preview;
    }

    get isFullscreen() {
        return this._fullscreenActor !== null;
    }

    setWidth(width) {
        this._preview.set_width(width);
    }

    update(entry) {
        if (this.isFullscreen)
            return;
        if (entry?.type !== 'image') {
            this._history.cancelSelectedImagePreview();
            this._entry = null;
            this._preview.hide();
            this._canvas.set_child(null);
            return;
        }

        this._entry = entry;
        this._preview.show();
        this._title.set_text(entry.label || (entry.mimeType === 'image/jpeg' ? 'JPEG image' : 'PNG image'));
        this._details.set_text(this._formatDetails(entry));
        if (this._renderedEntry === entry)
            return;

        this._renderedEntry = entry;
        this._canvas.set_child(new St.Label({
            text: 'Loading image…',
            style_class: 'clipboard-image-loading',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._history.loadSelectedImagePreview(entry, preview => {
            if (!this._preview || this._entry !== entry || this.isFullscreen)
                return;
            this._display(this._canvas, preview, 'Unable to display selected clipboard image');
        }, () => {
            if (this._entry === entry && !this.isFullscreen)
                this._showUnavailable(this._canvas);
        });
    }

    openFullscreen(entry, monitor) {
        if (!monitor || entry?.type !== 'image' || this.isFullscreen)
            return;
        this._entry = entry;
        const loading = new St.Label({
            text: 'Loading image…',
            style_class: 'clipboard-image-loading',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fullscreenActor = new St.Bin({
            style_class: 'clipboard-image-fullscreen',
            reactive: true,
            can_focus: true,
            child: loading,
        });
        this._fullscreenKeySignal = this._fullscreenActor.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape || symbol === Clutter.KEY_space)
                this.closeFullscreen();
            return Clutter.EVENT_STOP;
        });
        this._fullscreenActor.set_position(monitor.x, monitor.y);
        this._fullscreenActor.set_size(monitor.width, monitor.height);
        Main.uiGroup.add_child(this._fullscreenActor);
        this._fullscreenActor.grab_key_focus();
        this._preview.hide();

        this._history.loadSelectedImagePreview(entry, preview => {
            if (!this.isFullscreen || this._entry !== entry)
                return;
            this._display(this._fullscreenActor, preview, 'Unable to display full-screen clipboard image');
        }, () => {
            if (this.isFullscreen && this._entry === entry) {
                Main.notify('Clipboard History', 'Unable to open image');
                this.closeFullscreen();
            }
        }, monitor.width, monitor.height);
    }

    handleCapturedEvent(event) {
        if (!this.isFullscreen)
            return false;
        if (event.type() === Clutter.EventType.KEY_PRESS) {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape || symbol === Clutter.KEY_space)
                this.closeFullscreen();
        } else if (event.type() === Clutter.EventType.BUTTON_PRESS) {
            this.closeFullscreen();
        }
        return true;
    }

    closeFullscreen(restoreFocus = true) {
        if (!this._fullscreenActor)
            return;
        this._history.cancelSelectedImagePreview();
        this._fullscreenActor.disconnect(this._fullscreenKeySignal);
        this._fullscreenKeySignal = 0;
        this._fullscreenActor.destroy();
        this._fullscreenActor = null;
        this._renderedEntry = null;
        this._preview.show();
        if (restoreFocus)
            this._restoreFocus?.();
    }

    destroy() {
        this.closeFullscreen(false);
        this._history.cancelSelectedImagePreview();
        this._preview.destroy();
        this._preview = null;
    }

    _display(container, preview, context) {
        try {
            const imageContent = St.ImageContent.new_with_preferred_size(
                preview.get_width(), preview.get_height());
            const loaded = imageContent.set_data(
                container.get_context().get_backend().get_cogl_context(),
                preview.get_pixels(),
                preview.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                preview.get_width(),
                preview.get_height(),
                preview.get_rowstride(),
            );
            if (!loaded)
                throw new Error('St.ImageContent rejected clipboard preview pixels');

            const image = new St.Widget({
                style_class: context.includes('full-screen')
                    ? 'clipboard-image-fullscreen-content'
                    : 'clipboard-image-full',
                x_expand: true,
                y_expand: true,
                content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
            });
            image.set_content(imageContent);
            container.set_child(image);
        } catch (error) {
            logError(error, context);
            if (this.isFullscreen)
                this.closeFullscreen();
            else
                this._showUnavailable(container);
        }
    }

    _showUnavailable(container) {
        container.set_child(new St.Label({
            text: 'Image preview unavailable',
            style_class: 'clipboard-image-loading',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }

    _formatDetails(entry) {
        const format = entry.mimeType === 'image/jpeg' ? 'JPEG' : 'PNG';
        const dimensions = entry.width && entry.height ? `${entry.width} × ${entry.height}` : 'Image';
        const size = entry.size >= 1024 * 1024
            ? `${(entry.size / (1024 * 1024)).toFixed(1)} MB`
            : `${Math.max(1, Math.round(entry.size / 1024))} KB`;
        return `${format} · ${dimensions} · ${size}`;
    }
}
