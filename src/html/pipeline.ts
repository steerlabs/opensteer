import * as cheerio from 'cheerio'
import type { Page, Frame } from 'playwright'
import type { Element as DomHandlerElement } from 'domhandler'
import {
    serializePageHTML,
    OS_NODE_ID_ATTR,
    type SerializedNodeMeta,
} from './serializer.js'
import { markInteractiveElements } from './interactivity.js'
import {
    cleanForAction,
    cleanForClickable,
    cleanForExtraction,
    cleanForFull,
    cleanForScrollable,
} from './cleaner.js'
import { cloneElementPath } from '../element-path/build.js'
import type { ElementPath } from '../element-path/types.js'
import type { SnapshotMode, SnapshotOptions } from '../types.js'
import { OS_FRAME_TOKEN_KEY } from './runtime-keys.js'

export interface PreparedSnapshot {
    mode: SnapshotMode
    url: string | null
    rawHtml: string
    processedHtml: string
    reducedHtml: string
    cleanedHtml: string
    counterIndex: Map<number, ElementPath> | null
}

function applyCleaner(mode: SnapshotMode, html: string): string {
    switch (mode) {
        case 'clickable':
            return cleanForClickable(html)
        case 'scrollable':
            return cleanForScrollable(html)
        case 'extraction':
            return cleanForExtraction(html)
        case 'full':
            return cleanForFull(html)
        case 'action':
        default:
            return cleanForAction(html)
    }
}

interface NodeIdOccurrence {
    element: DomHandlerElement
    order: number
}

function canonicalizeDuplicateNodeIds($: cheerio.CheerioAPI): void {
    const occurrencesByNodeId = new Map<string, NodeIdOccurrence[]>()
    let order = 0

    $('*').each(function () {
        const element = this as DomHandlerElement
        const nodeId = $(element).attr(OS_NODE_ID_ATTR)
        if (!nodeId) {
            order += 1
            return
        }

        const list = occurrencesByNodeId.get(nodeId) || []
        list.push({
            element,
            order,
        })
        occurrencesByNodeId.set(nodeId, list)
        order += 1
    })

    for (const occurrences of occurrencesByNodeId.values()) {
        if (occurrences.length <= 1) continue

        const canonical = pickCanonicalNodeIdOccurrence($, occurrences)
        for (const occurrence of occurrences) {
            if (occurrence.element === canonical.element) continue
            $(occurrence.element).removeAttr(OS_NODE_ID_ATTR)
        }
    }
}

function pickCanonicalNodeIdOccurrence(
    $: cheerio.CheerioAPI,
    occurrences: NodeIdOccurrence[]
): NodeIdOccurrence {
    let best = occurrences[0]
    let bestScore = scoreNodeIdOccurrence($, best.element)

    for (let i = 1; i < occurrences.length; i += 1) {
        const candidate = occurrences[i]
        const candidateScore = scoreNodeIdOccurrence($, candidate.element)
        if (
            candidateScore > bestScore ||
            (candidateScore === bestScore && candidate.order < best.order)
        ) {
            best = candidate
            bestScore = candidateScore
        }
    }

    return best
}

function scoreNodeIdOccurrence(
    $: cheerio.CheerioAPI,
    element: DomHandlerElement
): number {
    const el = $(element)
    const descendantCount = el.find('*').length
    const normalizedTextLength = el.text().replace(/\s+/g, ' ').trim().length
    const attributeCount = Object.keys(el.attr() || {}).length

    return (
        descendantCount * 100 +
        normalizedTextLength * 10 +
        attributeCount
    )
}

async function assignCounters(
    page: Page,
    html: string,
    nodePaths: Map<string, ElementPath>,
    nodeMeta: Map<string, SerializedNodeMeta>
): Promise<{
    html: string
    counterIndex: Map<number, ElementPath>
}> {
    const $ = cheerio.load(html, { xmlMode: false })
    canonicalizeDuplicateNodeIds($)
    const counterIndex = new Map<number, ElementPath>()

    let nextCounter = 1
    const assignedByNodeId = new Map<string, number>()

    $('*').each(function () {
        const el = $(this as DomHandlerElement)
        const nodeId = el.attr(OS_NODE_ID_ATTR)
        if (!nodeId) return

        const counter = nextCounter++
        assignedByNodeId.set(nodeId, counter)

        const path = nodePaths.get(nodeId)
        el.attr('c', String(counter))
        el.removeAttr(OS_NODE_ID_ATTR)

        if (path) {
            counterIndex.set(counter, cloneElementPath(path))
        }
    })

    try {
        await syncLiveCounters(page, nodeMeta, assignedByNodeId)
    } catch (error) {
        await clearLiveCounters(page)
        throw error
    }

    $(`[${OS_NODE_ID_ATTR}]`).removeAttr(OS_NODE_ID_ATTR)

    return {
        html: $.html(),
        counterIndex,
    }
}

async function syncLiveCounters(
    page: Page,
    nodeMeta: Map<string, SerializedNodeMeta>,
    assignedByNodeId: Map<string, number>
): Promise<void> {
    await clearLiveCounters(page)
    if (!assignedByNodeId.size) return

    const groupedByFrame = new Map<string, Array<{ nodeId: string; counter: number }>>()
    for (const [nodeId, counter] of assignedByNodeId.entries()) {
        const meta = nodeMeta.get(nodeId)
        if (!meta?.frameToken) continue

        const list = groupedByFrame.get(meta.frameToken) || []
        list.push({
            nodeId,
            counter,
        })
        groupedByFrame.set(meta.frameToken, list)
    }

    if (!groupedByFrame.size) return

    const failures: Array<{
        nodeId: string
        counter: number
        frameToken: string
        reason: 'frame_missing' | 'frame_unavailable' | 'match_count'
        matches?: number
    }> = []

    const framesByToken = await mapFramesByToken(page)
    for (const [frameToken, entries] of groupedByFrame.entries()) {
        const frame = framesByToken.get(frameToken)
        if (!frame) {
            for (const entry of entries) {
                failures.push({
                    nodeId: entry.nodeId,
                    counter: entry.counter,
                    frameToken,
                    reason: 'frame_missing',
                })
            }
            continue
        }

        try {
            const unresolved = await frame.evaluate(
                ({ entries, nodeAttr }) => {
                    const index = new Map<string, Element[]>()
                    const unresolved: Array<{
                        nodeId: string
                        counter: number
                        matches: number
                    }> = []

                    const walk = (root: ParentNode): void => {
                        const children = Array.from(root.children) as Element[]
                        for (const child of children) {
                            const nodeId = child.getAttribute(nodeAttr)
                            if (nodeId) {
                                const list = index.get(nodeId) || []
                                list.push(child)
                                index.set(nodeId, list)
                            }

                            walk(child)
                            if (child.shadowRoot) {
                                walk(child.shadowRoot)
                            }
                        }
                    }

                    walk(document)

                    for (const entry of entries) {
                        const matches = index.get(entry.nodeId) || []
                        if (matches.length !== 1) {
                            unresolved.push({
                                nodeId: entry.nodeId,
                                counter: entry.counter,
                                matches: matches.length,
                            })
                            continue
                        }
                        matches[0].setAttribute('c', String(entry.counter))
                    }

                    return unresolved
                },
                {
                    entries,
                    nodeAttr: OS_NODE_ID_ATTR,
                }
            )
            for (const entry of unresolved) {
                failures.push({
                    nodeId: entry.nodeId,
                    counter: entry.counter,
                    frameToken,
                    reason: 'match_count',
                    matches: entry.matches,
                })
            }
        } catch {
            for (const entry of entries) {
                failures.push({
                    nodeId: entry.nodeId,
                    counter: entry.counter,
                    frameToken,
                    reason: 'frame_unavailable',
                })
            }
        }
    }

    if (failures.length) {
        const preview = failures.slice(0, 3).map((failure) => {
            const base = `counter ${failure.counter} (nodeId "${failure.nodeId}") in frame "${failure.frameToken}"`
            if (failure.reason === 'frame_missing') {
                return `${base} could not be synchronized because the frame is missing.`
            }
            if (failure.reason === 'frame_unavailable') {
                return `${base} could not be synchronized because frame evaluation failed.`
            }
            return `${base} expected exactly one live node but found ${failure.matches ?? 0}.`
        })

        const remaining =
            failures.length > 3 ? ` (+${failures.length - 3} more)` : ''
        throw new Error(
            `Failed to synchronize snapshot counters with the live DOM: ${preview.join(' ')}${remaining}`
        )
    }
}

async function clearLiveCounters(page: Page): Promise<void> {
    for (const frame of page.frames()) {
        try {
            await frame.evaluate(() => {
                const walk = (root: ParentNode): void => {
                    const children = Array.from(root.children) as Element[]
                    for (const child of children) {
                        child.removeAttribute('c')
                        walk(child)
                        if (child.shadowRoot) {
                            walk(child.shadowRoot)
                        }
                    }
                }

                walk(document)
            })
        } catch {
            // Ignore inaccessible or transient frames.
        }
    }
}

async function mapFramesByToken(page: Page): Promise<Map<string, Frame>> {
    const out = new Map<string, Frame>()
    for (const frame of page.frames()) {
        const token = await readFrameToken(frame)
        if (!token) continue
        out.set(token, frame)
    }
    return out
}

async function readFrameToken(frame: Frame): Promise<string | null> {
    try {
        return await frame.evaluate((frameTokenKey) => {
            const win = window as unknown as Record<string, unknown>
            const value = win[frameTokenKey]
            return typeof value === 'string' ? value : null
        }, OS_FRAME_TOKEN_KEY)
    } catch {
        return null
    }
}

function stripNodeIds(html: string): string {
    if (!html.includes(OS_NODE_ID_ATTR)) return html
    const $ = cheerio.load(html, { xmlMode: false })
    $(`[${OS_NODE_ID_ATTR}]`).removeAttr(OS_NODE_ID_ATTR)
    return $.html()
}

function isLiveCounterSyncFailure(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.message.startsWith(
        'Failed to synchronize snapshot counters with the live DOM:'
    )
}

export async function prepareSnapshot(
    page: Page,
    options: SnapshotOptions = {}
): Promise<PreparedSnapshot> {
    const mode = options.mode ?? 'action'
    const withCounters = options.withCounters ?? true
    const shouldMarkInteractive = options.markInteractive ?? true

    if (shouldMarkInteractive) {
        await markInteractiveElements(page)
    }

    const maxAttempts = withCounters ? 4 : 1
    let lastCounterSyncError: unknown = null

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const serialized = await serializePageHTML(page)
        const rawHtml = serialized.html

        const processedHtml = rawHtml
        const reducedHtml = applyCleaner(mode, processedHtml)

        let cleanedHtml = reducedHtml
        let counterIndex: Map<number, ElementPath> | null = null

        if (withCounters) {
            try {
                const counted = await assignCounters(
                    page,
                    reducedHtml,
                    serialized.nodePaths,
                    serialized.nodeMeta
                )
                cleanedHtml = counted.html
                counterIndex = counted.counterIndex
            } catch (error) {
                if (
                    attempt < maxAttempts &&
                    isLiveCounterSyncFailure(error)
                ) {
                    lastCounterSyncError = error
                    continue
                }
                throw error
            }
        } else {
            cleanedHtml = stripNodeIds(cleanedHtml)
        }

        // cleanForExtraction uses a compact serializer that omits html/head/body,
        // but cheerio operations in assignCounters/stripNodeIds re-add them.
        // Strip them again so the final output stays compact.
        if (mode === 'extraction') {
            const $unwrap = cheerio.load(cleanedHtml, { xmlMode: false })
            cleanedHtml = $unwrap('body').html()?.trim() || cleanedHtml
        }

        return {
            mode,
            url: page.url(),
            rawHtml,
            processedHtml,
            reducedHtml,
            cleanedHtml,
            counterIndex,
        }
    }

    throw (
        lastCounterSyncError ||
        new Error('Failed to prepare snapshot after retrying counter sync.')
    )
}
