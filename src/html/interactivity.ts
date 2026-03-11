import type { Frame, Page } from 'playwright'

export const OPENSTEER_INTERACTIVE_ATTR = 'data-opensteer-interactive'
export const OPENSTEER_HIDDEN_ATTR = 'data-opensteer-hidden'
export const OPENSTEER_SCROLLABLE_ATTR = 'data-opensteer-scrollable'

export interface MarkInteractivityOptions {
    markAttribute?: string
    skipIfAlreadyMarked?: boolean
}

export async function markInteractiveElements(
    page: Page,
    {
        markAttribute = OPENSTEER_INTERACTIVE_ATTR,
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

                function isExplicitlyHidden(
                    el: HTMLElement,
                    style: CSSStyleDeclaration
                ): boolean {
                    if (el.hasAttribute('hidden')) {
                        return true
                    }

                    if (el.getAttribute('aria-hidden') === 'true') {
                        return true
                    }

                    if (style.display === 'none') {
                        return true
                    }

                    if (
                        style.visibility === 'hidden' ||
                        style.visibility === 'collapse'
                    ) {
                        return true
                    }

                    const opacity = Number.parseFloat(style.opacity)
                    return Number.isFinite(opacity) && opacity <= 0
                }

                function hasVisibleOutOfFlowChild(el: HTMLElement): boolean {
                    const children = el.children
                    for (let i = 0; i < children.length; i++) {
                        const child = children[i] as HTMLElement
                        const childStyle = window.getComputedStyle(child)
                        if (
                            childStyle.position !== 'fixed' &&
                            childStyle.position !== 'absolute'
                        ) {
                            continue
                        }

                        const childRect = child.getBoundingClientRect()
                        if (childRect.width > 0 && childRect.height > 0) {
                            return true
                        }
                    }

                    return false
                }

                function isHiddenByOwnRect(
                    el: HTMLElement,
                    style: CSSStyleDeclaration
                ): boolean {
                    if (style.display === 'contents') {
                        return false
                    }

                    const rect = el.getBoundingClientRect()
                    if (rect.width > 0 && rect.height > 0) {
                        return false
                    }

                    return !hasVisibleOutOfFlowChild(el)
                }

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
                        const hidden =
                            isExplicitlyHidden(el, style) ||
                            isHiddenByOwnRect(el, style)

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
                hiddenAttr: OPENSTEER_HIDDEN_ATTR,
                scrollableAttr: OPENSTEER_SCROLLABLE_ATTR,
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
