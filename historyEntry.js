export const FILTERS = [
    {id: 'all', label: 'All'},
    {id: 'text', label: 'Text'},
    {id: 'link', label: 'Links'},
    {id: 'code', label: 'Code'},
    {id: 'color', label: 'Colors'},
    {id: 'image', label: 'Images'},
];

export const TYPE_LABELS = {
    text: 'Text', link: 'Link', code: 'Code', color: 'Color',
    image: 'Image', secret: 'Secret',
};

export const TYPE_ICONS = {
    text: 'text-x-generic-symbolic',
    link: 'web-browser-symbolic',
    code: 'utilities-terminal-symbolic',
    image: 'image-x-generic-symbolic',
    secret: 'changes-prevent-symbolic',
};

const API_KEY_LABEL = /\b(?:api[_-]?key|api[_-]?token|access[_-]?token|secret[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]/i;
const API_KEY_VALUE = /\b(?:sk-(?:live|test)-|sk-|rk_(?:live|test)_|AIza|AKIA|xox[baprs]-|api[._-]?)[A-Za-z0-9_-]{13,}/i;
const API_KEY_VALUES = /\b(?:sk-(?:live|test)-|sk-|rk_(?:live|test)_|AIza|AKIA|xox[baprs]-|api[._-]?)[A-Za-z0-9_-]{13,}/gi;

export function classifyEntry(item) {
    if (item.type === 'image')
        return 'image';

    const text = item.text.trim();
    if (API_KEY_LABEL.test(text) || API_KEY_VALUE.test(text))
        return 'code';
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

export function formatAge(timestamp) {
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

function maskApiKeys(text) {
    const labeled = text.replace(
        /(\b(?:api[_-]?key|api[_-]?token|access[_-]?token|secret[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*["']?)([A-Za-z0-9._~+\/-]{13,})(["']?)/gi,
        (_match, prefix, key, suffix) => `${prefix}${key.slice(0, 6)}***${key.slice(-6)}${suffix}`,
    );
    return labeled.replace(API_KEY_VALUES, key => `${key.slice(0, 6)}***${key.slice(-6)}`);
}

export function getPreviewText(item) {
    if (item.type === 'image')
        return item.label || (item.mimeType === 'image/jpeg' ? 'JPEG image' : 'PNG image');

    const masked = maskApiKeys(item.text);
    const token = masked.match(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/);
    if (token)
        return masked.replace(token[0], `${token[0].slice(0, 5)}••••••••••••`);
    return masked.replace(/[\r\n\t]+/g, ' ').trim();
}
