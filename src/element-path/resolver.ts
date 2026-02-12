import type { ElementHandle, Frame, JSHandle, Page } from 'playwright'
import { buildPathSelectorHint, sanitizeElementPath } from './build.js'
import { ElementPathError } from './errors.js'
import { buildPathCandidates } from './match-selectors.js'
import type { DomPath, ElementPath } from './types.js'

interface ResolveMatch {
    element: ElementHandle<Element>
    selector: string
    mode: 'unique' | 'fallback'
    count: number
}

export interface ResolvedElementPath {
    element: ElementHandle<Element>
    usedSelector: string
}

export async function resolveElementPath(
    page: Page,
    rawPath: ElementPath
): Promise<ResolvedElementPath> {
    const path = sanitizeElementPath(rawPath)

    let frame = page.mainFrame()
    let rootHandle: JSHandle | null = null

    for (const hop of path.context) {
        const host = await resolveDomPath(frame, hop.host, rootHandle)
        if (!host) {
            await disposeHandle(rootHandle)
            throw new ElementPathError(
                'ERR_PATH_CONTEXT_HOST_NOT_FOUND',
                'Unable to resolve context host from stored match selectors.'
            )
        }

        if (hop.kind === 'iframe') {
            const nextFrame = await host.element.contentFrame()
            await host.element.dispose()
            await disposeHandle(rootHandle)
            rootHandle = null

            if (!nextFrame) {
                throw new ElementPathError(
                    'ERR_PATH_IFRAME_UNAVAILABLE',
                    'Iframe is unavailable or inaccessible for this path.'
                )
            }

            frame = nextFrame
            continue
        }

        const shadowRoot = await host.element.evaluateHandle(
            (element) => element.shadowRoot
        )
        await host.element.dispose()

        const isMissing = await shadowRoot.evaluate((value) => value == null)
        if (isMissing) {
            await shadowRoot.dispose()
            await disposeHandle(rootHandle)
            throw new ElementPathError(
                'ERR_PATH_SHADOW_ROOT_UNAVAILABLE',
                'Shadow root is unavailable for this path.'
            )
        }

        await disposeHandle(rootHandle)
        rootHandle = shadowRoot
    }

    const target = await resolveDomPath(frame, path.nodes, rootHandle)
    if (!target) {
        const diagnostics = await collectCandidateDiagnostics(
            frame,
            path.nodes,
            rootHandle
        )
        await disposeHandle(rootHandle)
        throw new ElementPathError(
            'ERR_PATH_TARGET_NOT_FOUND',
            buildTargetNotFoundMessage(path.nodes, diagnostics)
        )
    }

    await disposeHandle(rootHandle)

    if (isPathDebugEnabled()) {
        debugPath('resolved', {
            selector: target.selector,
            mode: target.mode,
            count: target.count,
            targetDepth: path.nodes.length,
        })
    }

    return {
        element: target.element,
        usedSelector: target.selector || buildPathSelectorHint(path),
    }
}

async function resolveDomPath(
    frame: Frame,
    domPath: DomPath,
    rootHandle: JSHandle | null
): Promise<ResolveMatch | null> {
    const candidates = buildPathCandidates(domPath)
    if (!candidates.length) return null

    if (isPathDebugEnabled()) {
        debugPath('trying selectors', { candidates })
    }

    const selected = rootHandle
        ? await rootHandle.evaluate(selectInRoot, candidates)
        : await frame.evaluate(selectInDocument, candidates)

    if (!selected || !selected.selector) return null

    const handle = rootHandle
        ? await rootHandle.evaluateHandle((root, selector) => {
              if (!(root instanceof ShadowRoot)) return null
              return root.querySelector(selector)
          }, selected.selector)
        : await frame.evaluateHandle(
              (selector) => document.querySelector(selector),
              selected.selector
          )

    const element = handle.asElement() as ElementHandle<Element> | null
    if (!element) {
        await handle.dispose()
        return null
    }

    return {
        element,
        selector: selected.selector,
        mode: selected.mode,
        count: selected.count,
    }
}

async function collectCandidateDiagnostics(
    frame: Frame,
    domPath: DomPath,
    rootHandle: JSHandle | null
): Promise<Array<{ selector: string; count: number }>> {
    const candidates = buildPathCandidates(domPath)
    if (!candidates.length) return []

    const diagnostics = rootHandle
        ? await rootHandle.evaluate(countInRoot, candidates)
        : await frame.evaluate(countInDocument, candidates)

    return Array.isArray(diagnostics)
        ? diagnostics
              .map((item) => ({
                  selector: String(item?.selector || ''),
                  count: Number(item?.count || 0),
              }))
              .filter((item) => item.selector)
        : []
}

function buildTargetNotFoundMessage(
    domPath: DomPath,
    diagnostics: Array<{ selector: string; count: number }>
): string {
    const depth = Array.isArray(domPath) ? domPath.length : 0
    const sample = diagnostics
        .slice(0, 4)
        .map((item) => `"${item.selector}" => ${item.count}`)
        .join(', ')
    const base =
        'Element path resolution failed (ERR_PATH_TARGET_NOT_FOUND): no selector candidate matched the current DOM.'
    if (!sample)
        return `${base} Tried ${Math.max(diagnostics.length, 0)} candidates.`
    return `${base} Target depth ${depth}. Candidate counts: ${sample}.`
}

function selectInDocument(
    selectors: string[]
): { selector: string; count: number; mode: 'unique' | 'fallback' } | null {
    let fallback: { selector: string; count: number; mode: 'fallback' } | null =
        null

    for (const selector of selectors) {
        if (!selector) continue
        let count = 0
        try {
            count = document.querySelectorAll(selector).length
        } catch {
            count = 0
        }
        if (count === 1) {
            return {
                selector,
                count,
                mode: 'unique',
            }
        }
        if (count > 1 && !fallback) {
            fallback = {
                selector,
                count,
                mode: 'fallback',
            }
        }
    }

    return fallback
}

function selectInRoot(
    root: unknown,
    selectors: string[]
): { selector: string; count: number; mode: 'unique' | 'fallback' } | null {
    if (!(root instanceof ShadowRoot)) return null
    let fallback: { selector: string; count: number; mode: 'fallback' } | null =
        null

    for (const selector of selectors) {
        if (!selector) continue
        let count = 0
        try {
            count = root.querySelectorAll(selector).length
        } catch {
            count = 0
        }
        if (count === 1) {
            return {
                selector,
                count,
                mode: 'unique',
            }
        }
        if (count > 1 && !fallback) {
            fallback = {
                selector,
                count,
                mode: 'fallback',
            }
        }
    }

    return fallback
}

function countInDocument(
    selectors: string[]
): Array<{ selector: string; count: number }> {
    const out: Array<{ selector: string; count: number }> = []
    for (const selector of selectors) {
        if (!selector) continue
        let count = 0
        try {
            count = document.querySelectorAll(selector).length
        } catch {
            count = 0
        }
        out.push({ selector, count })
    }
    return out
}

function countInRoot(
    root: unknown,
    selectors: string[]
): Array<{ selector: string; count: number }> {
    if (!(root instanceof ShadowRoot)) return []
    const out: Array<{ selector: string; count: number }> = []
    for (const selector of selectors) {
        if (!selector) continue
        let count = 0
        try {
            count = root.querySelectorAll(selector).length
        } catch {
            count = 0
        }
        out.push({ selector, count })
    }
    return out
}

function isPathDebugEnabled(): boolean {
    const value =
        process.env.OVERSTEER_DEBUG_PATH ||
        process.env.OVERSTEER_DEBUG ||
        process.env.DEBUG_SELECTORS
    if (!value) return false
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true'
}

function debugPath(message: string, data?: unknown): void {
    if (!isPathDebugEnabled()) return
    if (data !== undefined) {
        console.log(`[oversteer:path] ${message}`, data)
    } else {
        console.log(`[oversteer:path] ${message}`)
    }
}

async function disposeHandle(handle: JSHandle | null): Promise<void> {
    if (!handle) return
    try {
        await handle.dispose()
    } catch {
        // ignore cleanup failures
    }
}
