import type { Frame, Page } from 'playwright'

export const OVERSTEER_INTERACTIVE_ATTR = 'data-oversteer-interactive'
export const OVERSTEER_HIDDEN_ATTR = 'data-oversteer-hidden'
export const OVERSTEER_SCROLLABLE_ATTR = 'data-oversteer-scrollable'

export interface MarkInteractivityOptions {
    markAttribute?: string
    skipIfAlreadyMarked?: boolean
}

export async function markInteractiveElements(
    page: Page,
    {
        markAttribute = OVERSTEER_INTERACTIVE_ATTR,
        skipIfAlreadyMarked = true,
    }: MarkInteractivityOptions = {}
): Promise<void> {
    const runInFrame = async (frame: Frame) => {
        await frame.evaluate(
            ({
                markAttribute,
                skipIfAlreadyMarked,
                hiddenAttr,
                scrollableAttr,
            }) => {
                const interactiveSelector = [
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
                    '[tabindex]',
                ].join(',')
                const interactiveRoles = new Set([
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
                ])

                const roots: Array<Document | ShadowRoot> = [document]
                while (roots.length) {
                    const root = roots.pop()
                    if (!root) continue

                    const elements = Array.from(
                        root.querySelectorAll<HTMLElement>('*')
                    )

                    for (const el of elements) {
                        if (
                            skipIfAlreadyMarked &&
                            el.hasAttribute(markAttribute)
                        ) {
                            if (el.shadowRoot) {
                                roots.push(el.shadowRoot)
                            }
                            continue
                        }

                        const style = window.getComputedStyle(el)
                        let hidden = false

                        if (el.hasAttribute('hidden')) {
                            hidden = true
                        } else if (el.getAttribute('aria-hidden') === 'true') {
                            hidden = true
                        } else if (style.display === 'none') {
                            hidden = true
                        } else if (
                            style.visibility === 'hidden' ||
                            style.visibility === 'collapse'
                        ) {
                            hidden = true
                        }

                        if (!hidden) {
                            const opacity = Number.parseFloat(style.opacity)
                            if (Number.isFinite(opacity) && opacity <= 0) {
                                hidden = true
                            }
                        }

                        if (!hidden) {
                            const rect = el.getBoundingClientRect()
                            if (rect.width <= 0 || rect.height <= 0) {
                                hidden = true
                                const children = el.children
                                for (let i = 0; i < children.length; i++) {
                                    const childStyle = window.getComputedStyle(
                                        children[i]
                                    )
                                    if (
                                        childStyle.position !== 'fixed' &&
                                        childStyle.position !== 'absolute'
                                    ) {
                                        continue
                                    }
                                    const childRect = (
                                        children[i] as HTMLElement
                                    ).getBoundingClientRect()
                                    if (
                                        childRect.width > 0 &&
                                        childRect.height > 0
                                    ) {
                                        hidden = false
                                        break
                                    }
                                }
                            }
                        }

                        if (hidden) {
                            el.setAttribute(hiddenAttr, '1')
                            el.removeAttribute(markAttribute)
                            el.removeAttribute(scrollableAttr)
                        } else {
                            el.removeAttribute(hiddenAttr)

                            let interactive = false
                            if (el.matches(interactiveSelector)) {
                                interactive = true
                            } else if (style.cursor === 'pointer') {
                                interactive = true
                            } else {
                                const role = (
                                    el.getAttribute('role') || ''
                                ).toLowerCase()
                                if (interactiveRoles.has(role)) {
                                    interactive = true
                                }
                            }

                            if (interactive) {
                                el.setAttribute(markAttribute, '1')
                            } else {
                                el.removeAttribute(markAttribute)
                            }

                            const canScrollY =
                                (style.overflowY === 'auto' ||
                                    style.overflowY === 'scroll') &&
                                el.scrollHeight > el.clientHeight + 1
                            const canScrollX =
                                (style.overflowX === 'auto' ||
                                    style.overflowX === 'scroll') &&
                                el.scrollWidth > el.clientWidth + 1

                            let scrollDirection: string | null = null
                            if (canScrollX && canScrollY) {
                                scrollDirection = 'xy'
                            } else if (canScrollX) {
                                scrollDirection = 'x'
                            } else if (canScrollY) {
                                scrollDirection = 'y'
                            } else {
                                const inferredY =
                                    el.scrollHeight > el.clientHeight + 5
                                const inferredX =
                                    el.scrollWidth > el.clientWidth + 5
                                if (inferredX && inferredY) {
                                    scrollDirection = 'xy'
                                } else if (inferredX) {
                                    scrollDirection = 'x'
                                } else if (inferredY) {
                                    scrollDirection = 'y'
                                }
                            }

                            if (scrollDirection) {
                                el.setAttribute(scrollableAttr, scrollDirection)
                            } else {
                                el.removeAttribute(scrollableAttr)
                            }
                        }

                        if (el.shadowRoot) {
                            roots.push(el.shadowRoot)
                        }
                    }
                }
            },
            {
                markAttribute,
                skipIfAlreadyMarked,
                hiddenAttr: OVERSTEER_HIDDEN_ATTR,
                scrollableAttr: OVERSTEER_SCROLLABLE_ATTR,
            }
        )
    }

    for (const frame of page.frames()) {
        try {
            await runInFrame(frame)
        } catch {
            // Skip inaccessible frames (e.g. transient/cross-origin evaluation failures).
        }
    }
}
