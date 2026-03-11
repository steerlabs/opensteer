export const NATIVE_INTERACTIVE_TAGS: readonly string[] = [
    'a',
    'button',
    'input',
    'select',
    'textarea',
]

export const INTERACTIVE_SELECTOR_PARTS: readonly string[] = [
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
]

export const INTERACTIVE_ROLE_TOKENS: readonly string[] = [
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
]

export function hasNonNegativeTabIndex(
    value: string | null | undefined
): boolean {
    if (value == null) return false
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed >= 0
}
