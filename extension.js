import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import {ClipboardHistory} from './clipboardHistory.js';
import {HistoryPopup} from './popup.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.clipboardhistory';
const KEYBINDING = 'toggle-shortcut';
const PASTE_DELAY_MS = 220;
const REFOCUS_DELAY_MS = 120;
const KEY_LEFTCTRL = 29;
const KEY_V = 47;

export default class ClipboardHistoryExtension extends Extension {
    enable() {
        this._enabled = true;
        this._settings = this.getSettings(SCHEMA_ID);
        this._history = new ClipboardHistory();
        this._pasteSourceId = 0;
        this._injectSourceId = 0;
        this._virtualKeyboard = null;
        this._lastInputTime = 0;
        Main.wm.addKeybinding(KEYBINDING, this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, () => this._togglePopup());
    }

    disable() {
        this._enabled = false;
        this._cancelPaste();
        Main.wm.removeKeybinding(KEYBINDING);
        this._popup?.close();
        this._popup = null;
        this._history?.destroy();
        this._history = null;
        this._virtualKeyboard = null;
        this._settings = null;
    }

    _togglePopup() {
        if (this._popup) {
            this._popup.close();
            this._popup = null;
            return;
        }
        this._cancelPaste();
        this._openPopup();
    }

    _openPopup(state = null) {
        if (!this._enabled || this._popup)
            return;
        let popup = null;
        popup = new HistoryPopup(this._history, () => {
            this._popup = null;
            this._cancelPaste();
        }, state, targetWindow => this._schedulePaste(targetWindow, popup));
        this._popup = popup;
    }

    _cancelPaste() {
        for (const property of ['_pasteSourceId', '_injectSourceId']) {
            if (this[property]) {
                GLib.source_remove(this[property]);
                this[property] = 0;
            }
        }
    }

    _schedulePaste(targetWindow, popup) {
        this._cancelPaste();
        popup.releaseFocusForPaste();
        if (targetWindow) {
            try {
                Main.activateWindow(targetWindow, global.get_current_time());
            } catch (error) {
                logError(error, 'Unable to activate the target window for paste');
            }
        }
        this._pasteSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteSourceId = 0;
            if (this._enabled && targetWindow)
                this._injectPaste();
            this._injectSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFOCUS_DELAY_MS, () => {
                this._injectSourceId = 0;
                if (this._enabled && this._popup === popup)
                    popup.restoreSearchFocus();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _injectPaste() {
        try {
            if (!this._virtualKeyboard) {
                const seat = Clutter.get_default_backend().get_default_seat();
                this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }
            if (!this._virtualKeyboard)
                return;

            const notify = (keycode, state) => {
                this._lastInputTime = Math.max(GLib.get_monotonic_time(), this._lastInputTime + 1);
                this._virtualKeyboard.notify_key(this._lastInputTime, keycode, state);
            };
            notify(KEY_LEFTCTRL, Clutter.KeyState.PRESSED);
            notify(KEY_V, Clutter.KeyState.PRESSED);
            notify(KEY_V, Clutter.KeyState.RELEASED);
            notify(KEY_LEFTCTRL, Clutter.KeyState.RELEASED);
        } catch (error) {
            logError(error, 'Unable to send paste shortcut');
        }
    }
}
