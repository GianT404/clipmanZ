import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SHORTCUT_KEY = 'toggle-shortcut';
const DEFAULT_SHORTCUT = '<Super>period';

function shortcutLabel(settings) {
    const [accelerator] = settings.get_strv(SHORTCUT_KEY);
    if (!accelerator)
        return 'Disabled';

    const [valid, keyval, modifiers] = Gtk.accelerator_parse(accelerator);
    return valid ? Gtk.accelerator_get_label(keyval, modifiers) : accelerator;
}

export default class ClipboardHistoryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'General'});
        const group = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcut',
            description: 'Choose the shortcut used to open or close clipboard history.',
        });
        const row = new Adw.ActionRow({title: 'Toggle Clipboard History'});
        const button = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            hexpand: false,
        });
        const resetButton = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Restore Super + .',
        });

        let capturing = false;
        let previousShortcut = null;
        const updateLabel = () => {
            button.set_label(capturing ? 'Press shortcut…' : shortcutLabel(settings));
        };
        const setCapturing = active => {
            capturing = active;
            button.set_has_frame(active);
            updateLabel();
        };
        const cancelCapture = () => {
            if (!capturing)
                return;
            settings.set_strv(SHORTCUT_KEY, previousShortcut ?? [DEFAULT_SHORTCUT]);
            previousShortcut = null;
            setCapturing(false);
        };

        button.connect('clicked', () => {
            previousShortcut = settings.get_strv(SHORTCUT_KEY);
            settings.set_strv(SHORTCUT_KEY, []);
            setCapturing(true);
            button.grab_focus();
        });
        resetButton.connect('clicked', () => {
            previousShortcut = null;
            settings.set_strv(SHORTCUT_KEY, [DEFAULT_SHORTCUT]);
            setCapturing(false);
        });
        const settingsChangedId = settings.connect(`changed::${SHORTCUT_KEY}`, updateLabel);
        window.connect('close-request', () => {
            cancelCapture();
            settings.disconnect(settingsChangedId);
            return false;
        });

        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (!capturing)
                return false;

            if (keyval === Gdk.KEY_Escape) {
                cancelCapture();
                return true;
            }

            let modifiers = state & Gtk.accelerator_get_default_mod_mask();
            modifiers &= ~(Gdk.ModifierType.LOCK_MASK | Gdk.ModifierType.MOD2_MASK);
            if (!Gtk.accelerator_valid(keyval, modifiers) || modifiers === 0)
                return true;

            const accelerator = Gtk.accelerator_name(keyval, modifiers);
            settings.set_strv(SHORTCUT_KEY, [accelerator]);
            previousShortcut = null;
            setCapturing(false);
            return true;
        });
        keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        window.add_controller(keyController);

        row.add_suffix(button);
        row.add_suffix(resetButton);
        row.set_activatable_widget(button);
        group.add(row);
        page.add(group);
        window.add(page);

        updateLabel();
    }
}
