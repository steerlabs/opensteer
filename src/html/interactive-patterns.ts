export const NATIVE_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
    'a',
    'button',
    'input',
    'select',
    'textarea',
])

const INTERACTIVE_SELECTOR_PARTS: readonly string[] = [
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

export const INTERACTIVE_SELECTOR = INTERACTIVE_SELECTOR_PARTS.join(',')

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

export const INTERACTIVE_ROLE_SET: ReadonlySet<string> = new Set(
    INTERACTIVE_ROLE_TOKENS
)

export const NON_NEGATIVE_TAB_INDEX_MIN = 0

export function hasNonNegativeTabIndex(
    value: string | null | undefined
): boolean {
    if (value == null) return false
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed >= NON_NEGATIVE_TAB_INDEX_MIN
}
