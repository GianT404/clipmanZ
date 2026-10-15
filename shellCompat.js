import Clutter from 'gi://Clutter';

export function getClutterBackend() {
    if (typeof Clutter.get_default_backend === 'function')
        return Clutter.get_default_backend();

    const context = global.stage?.context;
    if (context && typeof context.get_backend === 'function')
        return context.get_backend();

    throw new Error('Unable to access the Clutter backend');
}

export function getCoglContext() {
    const backend = getClutterBackend();
    if (typeof backend.get_cogl_context !== 'function')
        throw new Error('The Clutter backend does not expose a Cogl context');
    return backend.get_cogl_context();
}
