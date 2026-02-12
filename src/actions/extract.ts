import type { ElementHandle, Frame, JSHandle, Page } from 'playwright'
import type { ElementPath } from '../element-path/types.js'
import { sanitizeElementPath } from '../element-path/build.js'
import { buildPathCandidates } from '../element-path/match-selectors.js'
import { resolveElementPath } from '../element-path/resolver.js'

export interface FieldSelector {
    key: string
    path: ElementPath
    attribute?: string
}

export interface ArraySelector {
    itemParentPath: ElementPath
    fields: FieldSelector[]
}

async function readFieldValueFromHandle(
    element: ElementHandle<Element>,
    options: { attribute?: string }
): Promise<string | null> {
    return element.evaluate(
        (target, payload) => {
            const normalizeWhitespace = (
                value: string | null | undefined
            ): string =>
                String(value || '')
                    .replace(/\s+/g, ' ')
                    .trim()

            if (payload.attribute) {
                const raw = target.getAttribute(payload.attribute)
                const text = normalizeWhitespace(raw)
                return text || null
            }

            const text = normalizeWhitespace(target.textContent)
            return text || null
        },
        {
            attribute: options.attribute,
        }
    )
}

export async function extractWithPaths(
    page: Page,
    fields: FieldSelector[]
): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {}

    for (const field of fields) {
        let resolved
        try {
            resolved = await resolveElementPath(page, field.path)
        } catch {
            result[field.key] = null
            continue
        }

        try {
            result[field.key] = await readFieldValueFromHandle(
                resolved.element,
                {
                    attribute: field.attribute,
                }
            )
        } finally {
            await resolved.element.dispose()
        }
    }

    return result
}

export async function extractArrayWithPaths(
    page: Page,
    array: ArraySelector
): Promise<Array<Record<string, unknown>>> {
    const itemParentPath = sanitizeElementPath(array.itemParentPath)
    const fieldPlans = array.fields.map((field) => {
        const normalized = sanitizeElementPath(field.path)
        return {
            key: field.key,
            attribute: field.attribute,
            candidates:
                normalized.nodes.length > 0
                    ? buildPathCandidates(normalized.nodes)
                    : [],
        }
    })

    const itemHandles = await queryAllByElementPath(page, itemParentPath)
    if (!itemHandles.length) return []

    const result: Array<Record<string, unknown>> = []
    for (const item of itemHandles) {
        try {
            const row: Record<string, unknown> = {}

            for (const field of fieldPlans) {
                const key = String(field.key || '')
                const target =
                    field.candidates.length > 0
                        ? await resolveFirstWithinElement(
                              item,
                              field.candidates
                          )
                        : item

                try {
                    const value = target
                        ? await readFieldValueFromHandle(target, {
                              attribute: field.attribute,
                          })
                        : null

                    if (key) {
                        row[key] = value
                    } else {
                        row.value = value
                    }
                } finally {
                    if (target && target !== item) {
                        await target.dispose()
                    }
                }
            }

            result.push(row)
        } finally {
            await item.dispose()
        }
    }

    return result
}

export async function countArrayItemsWithPath(
    page: Page,
    itemParentPath: ElementPath
): Promise<number> {
    const items = await queryAllByElementPath(page, itemParentPath)
    const count = items.length
    await Promise.all(items.map((item) => item.dispose()))
    return count
}

async function queryAllByElementPath(
    page: Page,
    path: ElementPath
): Promise<ElementHandle<Element>[]> {
    const normalized = sanitizeElementPath(path)
    const scope = await resolvePathScope(page, normalized.context)
    if (!scope) return []

    try {
        return await queryAllByDomPath(
            scope.frame,
            normalized.nodes,
            scope.root
        )
    } finally {
        await disposeHandle(scope.root)
    }
}

async function resolvePathScope(
    page: Page,
    context: ElementPath['context']
): Promise<{ frame: Frame; root: JSHandle | null } | null> {
    let frame = page.mainFrame()
    let root: JSHandle | null = null

    for (const hop of context || []) {
        const host = await resolveFirstByDomPath(frame, hop.host, root)
        if (!host) {
            await disposeHandle(root)
            return null
        }

        if (hop.kind === 'iframe') {
            const nextFrame = await host.contentFrame()
            await host.dispose()
            await disposeHandle(root)
            root = null
            if (!nextFrame) return null
            frame = nextFrame
            continue
        }

        const shadowRoot = await host.evaluateHandle(
            (element) => element.shadowRoot
        )
        await host.dispose()

        const missingShadowRoot = await shadowRoot.evaluate(
            (value) => value == null
        )
        if (missingShadowRoot) {
            await shadowRoot.dispose()
            await disposeHandle(root)
            return null
        }

        await disposeHandle(root)
        root = shadowRoot
    }

    return { frame, root }
}

async function resolveFirstByDomPath(
    frame: Frame,
    domPath: ElementPath['nodes'],
    root: JSHandle | null
): Promise<ElementHandle<Element> | null> {
    const selectors = buildPathCandidates(domPath)
    return queryFirstByCandidates(selectors, (selector) =>
        queryBySelector(frame, selector, root)
    )
}

async function queryAllByDomPath(
    frame: Frame,
    domPath: ElementPath['nodes'],
    root: JSHandle | null
): Promise<ElementHandle<Element>[]> {
    const selectors = buildPathCandidates(domPath)
    return queryAllByCandidates(selectors, (selector) =>
        queryBySelector(frame, selector, root)
    )
}

async function queryBySelector(
    frame: Frame,
    selector: string,
    root: JSHandle | null
): Promise<ElementHandle<Element>[]> {
    if (!selector) return []

    if (!root) {
        try {
            return await frame.$$(selector)
        } catch {
            return []
        }
    }

    return queryBySelectorInShadowRoot(root, selector)
}

async function queryBySelectorInShadowRoot(
    root: JSHandle,
    selector: string
): Promise<ElementHandle<Element>[]> {
    const handle = await root.evaluateHandle((value, query) => {
        if (!(value instanceof ShadowRoot)) return []
        try {
            return Array.from(value.querySelectorAll(query))
        } catch {
            return []
        }
    }, selector)

    const properties = await handle.getProperties()
    const elements: ElementHandle<Element>[] = []
    const indexedEntries = [...properties.entries()].sort((a, b) => {
        const left = Number.parseInt(a[0], 10)
        const right = Number.parseInt(b[0], 10)
        if (Number.isNaN(left) && Number.isNaN(right)) return 0
        if (Number.isNaN(left)) return 1
        if (Number.isNaN(right)) return -1
        return left - right
    })

    for (const [key, value] of indexedEntries) {
        if (!/^\d+$/.test(key)) {
            await value.dispose()
            continue
        }
        const element = value.asElement() as ElementHandle<Element> | null
        if (!element) {
            await value.dispose()
            continue
        }
        elements.push(element)
    }

    await handle.dispose()
    return elements
}

async function resolveFirstWithinElement(
    root: ElementHandle<Element>,
    selectors: string[]
): Promise<ElementHandle<Element> | null> {
    return queryFirstByCandidates(selectors, async (selector) => {
        try {
            return await root.$$(selector)
        } catch {
            return []
        }
    })
}

async function queryFirstByCandidates(
    selectors: string[],
    query: (
        selector: string
    ) => Promise<Array<ElementHandle<Element> | undefined>>
): Promise<ElementHandle<Element> | null> {
    if (!selectors.length) return null

    let fallback: ElementHandle<Element> | null = null
    for (const selector of selectors) {
        if (!selector) continue

        const matches = (await query(selector)).filter(
            (match): match is ElementHandle<Element> => !!match
        )
        if (!matches.length) continue

        if (matches.length === 1) {
            if (fallback) await fallback.dispose()
            return matches[0]
        }

        if (!fallback) {
            fallback = matches[0]
            await disposeHandles(matches.slice(1))
            continue
        }

        await disposeHandles(matches)
    }

    return fallback
}

async function queryAllByCandidates(
    selectors: string[],
    query: (
        selector: string
    ) => Promise<Array<ElementHandle<Element> | undefined>>
): Promise<ElementHandle<Element>[]> {
    if (!selectors.length) return []

    for (const selector of selectors) {
        if (!selector) continue
        const matches = (await query(selector)).filter(
            (match): match is ElementHandle<Element> => !!match
        )
        if (matches.length) return matches
    }

    return []
}

async function disposeHandles(
    handles: Array<ElementHandle<Element> | undefined>
): Promise<void> {
    await Promise.all(
        handles
            .filter((handle): handle is ElementHandle<Element> => !!handle)
            .map(async (handle) => {
                try {
                    await handle.dispose()
                } catch {
                    // ignore cleanup failures
                }
            })
    )
}

async function disposeHandle(handle: JSHandle | null): Promise<void> {
    if (!handle) return
    try {
        await handle.dispose()
    } catch {
        // ignore cleanup failures
    }
}
