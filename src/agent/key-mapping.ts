const KEY_MAP: Record<string, string> = {
    ENTER: 'Enter',
    RETURN: 'Enter',
    ESCAPE: 'Escape',
    ESC: 'Escape',
    BACKSPACE: 'Backspace',
    TAB: 'Tab',
    SPACE: ' ',
    DELETE: 'Delete',
    DEL: 'Delete',
    ARROWUP: 'ArrowUp',
    ARROWDOWN: 'ArrowDown',
    ARROWLEFT: 'ArrowLeft',
    ARROWRIGHT: 'ArrowRight',
    ARROW_UP: 'ArrowUp',
    ARROW_DOWN: 'ArrowDown',
    ARROW_LEFT: 'ArrowLeft',
    ARROW_RIGHT: 'ArrowRight',
    UP: 'ArrowUp',
    DOWN: 'ArrowDown',
    LEFT: 'ArrowLeft',
    RIGHT: 'ArrowRight',
    SHIFT: 'Shift',
    CONTROL: 'Control',
    CTRL: 'Control',
    ALT: 'Alt',
    OPTION: 'Alt',
    META: 'Meta',
    COMMAND: 'Meta',
    CMD: 'Meta',
    SUPER: 'Meta',
    WINDOWS: 'Meta',
    WIN: 'Meta',
    HOME: 'Home',
    END: 'End',
    PAGEUP: 'PageUp',
    PAGEDOWN: 'PageDown',
    PAGE_UP: 'PageUp',
    PAGE_DOWN: 'PageDown',
    PGUP: 'PageUp',
    PGDN: 'PageDown',
    CONTROLORMETA: process.platform === 'darwin' ? 'Meta' : 'Control',
}

export function mapKeyToPlaywright(key: string): string {
    const normalized = key.trim()
    if (!normalized) return normalized

    const mapped = KEY_MAP[normalized.toUpperCase()]
    return mapped || normalized
}
