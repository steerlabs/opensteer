import * as cheerio from 'cheerio'
import { randomUUID } from 'crypto'
import type { Page } from 'playwright'
import type { Element } from 'domhandler'
import {
    serializePageHTML,
    OV_NODE_ID_ATTR,
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
import { ensureLiveCounters, type CounterBinding } from './counter-runtime.js'

export interface PreparedSnapshot {
    snapshotSessionId: string
    mode: SnapshotMode
    url: string | null
    rawHtml: string
    processedHtml: string
    reducedHtml: string
    cleanedHtml: string
    counterIndex: Map<number, ElementPath> | null
    counterBindings: Map<number, CounterBinding> | null
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
    nodeMeta: Map<string, SerializedNodeMeta>,
    snapshotSessionId: string
): Promise<{
    html: string
    counterIndex: Map<number, ElementPath>
    counterBindings: Map<number, CounterBinding>
}> {
    const $ = cheerio.load(html, { xmlMode: false })
    const counterIndex = new Map<number, ElementPath>()
    const counterBindings = new Map<number, CounterBinding>()

    const orderedNodeIds: string[] = []
    $('*').each(function () {
        const el = $(this as Element)
        const nodeId = el.attr(OV_NODE_ID_ATTR)
        if (!nodeId) return
        orderedNodeIds.push(nodeId)
    })

    const countersByNodeId = await ensureLiveCounters(
        page,
        nodeMeta,
        orderedNodeIds
    )

    $('*').each(function () {
        const el = $(this as Element)
        const nodeId = el.attr(OV_NODE_ID_ATTR)
        if (!nodeId) return

        const path = nodePaths.get(nodeId)
        const meta = nodeMeta.get(nodeId)
        const counter = countersByNodeId.get(nodeId)
        if (counter == null || !Number.isFinite(counter)) {
            throw new Error(
                `Counter assignment failed for node ${nodeId}. Run snapshot() again.`
            )
        }
        if (
            counterBindings.has(counter) &&
            counterBindings.get(counter)?.nodeId !== nodeId
        ) {
            throw new Error(
                `Counter ${counter} was assigned to multiple nodes. Run snapshot() again.`
            )
        }

        el.attr('c', String(counter))
        el.removeAttr(OV_NODE_ID_ATTR)

        if (path) {
            counterIndex.set(counter, cloneElementPath(path))
        }
        if (meta) {
            counterBindings.set(counter, {
                sessionId: snapshotSessionId,
                frameToken: meta.frameToken,
                nodeId,
                instanceToken: meta.instanceToken,
            })
        }
    })

    $(`[${OV_NODE_ID_ATTR}]`).removeAttr(OV_NODE_ID_ATTR)

    return {
        html: $.html(),
        counterIndex,
        counterBindings,
    }
}

function stripNodeIds(html: string): string {
    if (!html.includes(OV_NODE_ID_ATTR)) return html
    const $ = cheerio.load(html, { xmlMode: false })
    $(`[${OV_NODE_ID_ATTR}]`).removeAttr(OV_NODE_ID_ATTR)
    return $.html()
}

export async function prepareSnapshot(
    page: Page,
    options: SnapshotOptions = {}
): Promise<PreparedSnapshot> {
    const snapshotSessionId = randomUUID()
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
    let counterBindings: Map<number, CounterBinding> | null = null

    if (withCounters) {
        const counted = await assignCounters(
            page,
            reducedHtml,
            serialized.nodePaths,
            serialized.nodeMeta,
            snapshotSessionId
        )
        cleanedHtml = counted.html
        counterIndex = counted.counterIndex
        counterBindings = counted.counterBindings
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
        snapshotSessionId,
        mode,
        url: page.url(),
        rawHtml,
        processedHtml,
        reducedHtml,
        cleanedHtml,
        counterIndex,
        counterBindings,
    }
}
