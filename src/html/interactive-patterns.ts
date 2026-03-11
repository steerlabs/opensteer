export const NATIVE_INTERACTIVE_TAGS = [
    'a',
    'button',
    'input',
    'select',
    'textarea',
] as const

export const INTERACTIVE_SELECTOR_PARTS = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[role="tab"]',
    '[contenteditable="true"]',
    '[onclick]',
    '[onmousedown]',
    '[onmouseup]',
] as const

export const INTERACTIVE_ROLE_TOKENS = [
    'button',
    'link',
    'menuitem',
    'option',
    'radio',
    'checkbox',
    'tab',
    'textbox',
    'combobox',
    'slider',
    'spinbutton',
    'search',
    'searchbox',
] as const

export function hasNonNegativeTabIndex(
    value: string | null | undefined
): boolean {
    if (value == null) return false
    const parsed = Number.parseInt(String(value), 10)
    return Number.isFinite(parsed) && parsed >= 0
}
