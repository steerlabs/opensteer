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

    await syncLiveCounters(page, nodeMeta, assignedByNodeId)

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

    const framesByToken = await mapFramesByToken(page)
    for (const [frameToken, entries] of groupedByFrame.entries()) {
        const frame = framesByToken.get(frameToken)
        if (!frame) continue

        try {
            await frame.evaluate(
                ({ entries, nodeAttr }) => {
                    const index = new Map<string, Element[]>()

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
                        if (matches.length !== 1) continue
                        matches[0].setAttribute('c', String(entry.counter))
                    }
                },
                {
                    entries,
                    nodeAttr: OS_NODE_ID_ATTR,
                }
            )
        } catch {
            // Ignore inaccessible or transient frames.
        }
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

    const serialized = await serializePageHTML(page)
    const rawHtml = serialized.html

    const processedHtml = rawHtml
    const reducedHtml = applyCleaner(mode, processedHtml)

    let cleanedHtml = reducedHtml
    let counterIndex: Map<number, ElementPath> | null = null

    if (withCounters) {
        const counted = await assignCounters(
            page,
            reducedHtml,
            serialized.nodePaths,
            serialized.nodeMeta
        )
        cleanedHtml = counted.html
        counterIndex = counted.counterIndex
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
