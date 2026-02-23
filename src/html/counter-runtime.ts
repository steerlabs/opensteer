import type { ElementHandle, Frame, Page } from 'playwright'
import type { SerializedNodeMeta } from './serializer.js'
import { OS_NODE_ID_ATTR } from './serializer.js'
import { normalizeExtractedValue } from '../extract-value-normalization.js'
import {
    OS_COUNTER_NEXT_KEY,
    OS_COUNTER_OWNER_KEY,
    OS_COUNTER_VALUE_KEY,
    OS_FRAME_TOKEN_KEY,
    OS_INSTANCE_TOKEN_KEY,
} from './runtime-keys.js'

export interface CounterBinding {
    sessionId: string
    frameToken: string
    nodeId: string
    instanceToken: string
}

export interface CounterRequest {
    key: string
    counter: number
    attribute?: string
}

export interface CounterSnapshotLike {
    snapshotSessionId: string
    counterBindings: Map<number, CounterBinding> | null
}

export type CounterResolutionErrorCode =
    | 'ERR_COUNTER_NOT_FOUND'
    | 'ERR_COUNTER_FRAME_UNAVAILABLE'
    | 'ERR_COUNTER_STALE_OR_NOT_FOUND'
    | 'ERR_COUNTER_AMBIGUOUS'

export class CounterResolutionError extends Error {
    readonly code: CounterResolutionErrorCode

    constructor(code: CounterResolutionErrorCode, message: string) {
        super(message)
        this.name = 'CounterResolutionError'
        this.code = code
    }
}

interface FrameCounterEntry {
    nodeId: string
    instanceToken: string
}

interface FrameCounterResult {
    assigned: Array<{ nodeId: string; counter: number }>
    failures: Array<{
        nodeId: string
        reason: 'missing' | 'ambiguous' | 'instance_mismatch'
    }>
    nextCounter: number
}

export async function ensureLiveCounters(
    page: Page,
    nodeMeta: Map<string, SerializedNodeMeta>,
    nodeIds: string[]
): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (!nodeIds.length) return out

    const grouped = new Map<string, FrameCounterEntry[]>()
    for (const nodeId of nodeIds) {
        const meta = nodeMeta.get(nodeId)
        if (!meta) {
            throw new CounterResolutionError(
                'ERR_COUNTER_STALE_OR_NOT_FOUND',
                `Missing metadata for node ${nodeId}. Run snapshot() again.`
            )
        }

        const list = grouped.get(meta.frameToken) || []
        list.push({
            nodeId,
            instanceToken: meta.instanceToken,
        })
        grouped.set(meta.frameToken, list)
    }

    const framesByToken = await mapFramesByToken(page)
    let nextCounter = await readGlobalNextCounter(page)
    const usedCounters = new Map<number, string>()

    for (const [frameToken, entries] of grouped.entries()) {
        const frame = framesByToken.get(frameToken)
        if (!frame) {
            throw new CounterResolutionError(
                'ERR_COUNTER_FRAME_UNAVAILABLE',
                `Counter frame ${frameToken} is unavailable. Run snapshot() again.`
            )
        }

        const result = await frame.evaluate(
            ({
                entries,
                nodeAttr,
                instanceTokenKey,
                counterOwnerKey,
                counterValueKey,
                startCounter,
            }) => {
                const helpers = {
                    pushNode(map: Map<string, Element[]>, node: Element): void {
                        const nodeId = node.getAttribute(nodeAttr)
                        if (!nodeId) return
                        const list = map.get(nodeId) || []
                        list.push(node)
                        map.set(nodeId, list)
                    },

                    walk(map: Map<string, Element[]>, root: ParentNode): void {
                        const children = Array.from(root.children) as Element[]
                        for (const child of children) {
                            helpers.pushNode(map, child)
                            helpers.walk(map, child)
                            if (child.shadowRoot) {
                                helpers.walk(map, child.shadowRoot)
                            }
                        }
                    },

                    buildNodeIndex(): Map<string, Element[]> {
                        const map = new Map<string, Element[]>()
                        helpers.walk(map, document)
                        return map
                    },
                }

                const index = helpers.buildNodeIndex()
                const assigned: Array<{ nodeId: string; counter: number }> = []
                const failures: Array<{
                    nodeId: string
                    reason: 'missing' | 'ambiguous' | 'instance_mismatch'
                }> = []

                let next = Math.max(1, Number(startCounter || 1))
                for (const entry of entries) {
                    const matches = index.get(entry.nodeId) || []
                    if (!matches.length) {
                        failures.push({
                            nodeId: entry.nodeId,
                            reason: 'missing',
                        })
                        continue
                    }
                    if (matches.length !== 1) {
                        failures.push({
                            nodeId: entry.nodeId,
                            reason: 'ambiguous',
                        })
                        continue
                    }

                    const target = matches[0] as Element &
                        Record<string, unknown>
                    if (
                        target[instanceTokenKey] !==
                        (entry.instanceToken as unknown)
                    ) {
                        failures.push({
                            nodeId: entry.nodeId,
                            reason: 'instance_mismatch',
                        })
                        continue
                    }

                    const owned = target[counterOwnerKey] === true
                    const runtimeCounter = Number(target[counterValueKey] || 0)

                    if (
                        owned &&
                        Number.isFinite(runtimeCounter) &&
                        runtimeCounter > 0
                    ) {
                        target.setAttribute('c', String(runtimeCounter))
                        assigned.push({
                            nodeId: entry.nodeId,
                            counter: runtimeCounter,
                        })
                        continue
                    }

                    const counter = next++
                    target.setAttribute('c', String(counter))
                    Object.defineProperty(target, counterOwnerKey, {
                        value: true,
                        writable: true,
                        configurable: true,
                    })
                    Object.defineProperty(target, counterValueKey, {
                        value: counter,
                        writable: true,
                        configurable: true,
                    })
                    assigned.push({ nodeId: entry.nodeId, counter })
                }

                return {
                    assigned,
                    failures,
                    nextCounter: next,
                } as FrameCounterResult
            },
            {
                entries,
                nodeAttr: OS_NODE_ID_ATTR,
                instanceTokenKey: OS_INSTANCE_TOKEN_KEY,
                counterOwnerKey: OS_COUNTER_OWNER_KEY,
                counterValueKey: OS_COUNTER_VALUE_KEY,
                startCounter: nextCounter,
            }
        )

        if (result.failures.length) {
            const first = result.failures[0]
            throw buildCounterFailureError(first.nodeId, first.reason)
        }

        nextCounter = result.nextCounter
        for (const item of result.assigned) {
            const existingNode = usedCounters.get(item.counter)
            if (existingNode && existingNode !== item.nodeId) {
                throw new CounterResolutionError(
                    'ERR_COUNTER_AMBIGUOUS',
                    `Counter ${item.counter} is assigned to multiple nodes (${existingNode}, ${item.nodeId}). Run snapshot() again.`
                )
            }
            usedCounters.set(item.counter, item.nodeId)
            out.set(item.nodeId, item.counter)
        }
    }

    await writeGlobalNextCounter(page, nextCounter)
    return out
}

export async function resolveCounterElement(
    page: Page,
    snapshot: CounterSnapshotLike,
    counter: number
): Promise<ElementHandle<Element>> {
    const binding = readBinding(snapshot, counter)
    const framesByToken = await mapFramesByToken(page)
    const frame = framesByToken.get(binding.frameToken)
    if (!frame) {
        throw new CounterResolutionError(
            'ERR_COUNTER_FRAME_UNAVAILABLE',
            `Counter ${counter} frame is unavailable. Run snapshot() again.`
        )
    }

    const status = await frame.evaluate(
        ({
            nodeId,
            instanceToken,
            counter,
            nodeAttr,
            instanceTokenKey,
            counterOwnerKey,
            counterValueKey,
        }) => {
            const helpers = {
                walk(map: Map<string, Element[]>, root: ParentNode): void {
                    const children = Array.from(root.children) as Element[]
                    for (const child of children) {
                        const id = child.getAttribute(nodeAttr)
                        if (id) {
                            const list = map.get(id) || []
                            list.push(child)
                            map.set(id, list)
                        }
                        helpers.walk(map, child)
                        if (child.shadowRoot) {
                            helpers.walk(map, child.shadowRoot)
                        }
                    }
                },

                buildNodeIndex(): Map<string, Element[]> {
                    const map = new Map<string, Element[]>()
                    helpers.walk(map, document)
                    return map
                },
            }

            const matches = helpers.buildNodeIndex().get(nodeId) || []
            if (!matches.length) return 'missing'
            if (matches.length !== 1) return 'ambiguous'

            const target = matches[0] as Element & Record<string, unknown>
            if (target[instanceTokenKey] !== (instanceToken as unknown)) {
                return 'instance_mismatch'
            }
            if (target[counterOwnerKey] !== true) {
                return 'instance_mismatch'
            }
            if (Number(target[counterValueKey] || 0) !== counter) {
                return 'instance_mismatch'
            }
            if (target.getAttribute('c') !== String(counter)) {
                return 'instance_mismatch'
            }
            return 'ok'
        },
        {
            nodeId: binding.nodeId,
            instanceToken: binding.instanceToken,
            counter,
            nodeAttr: OS_NODE_ID_ATTR,
            instanceTokenKey: OS_INSTANCE_TOKEN_KEY,
            counterOwnerKey: OS_COUNTER_OWNER_KEY,
            counterValueKey: OS_COUNTER_VALUE_KEY,
        }
    )

    if (status !== 'ok') {
        throw buildCounterFailureError(binding.nodeId, status)
    }

    const handle = await frame.evaluateHandle(
        ({ nodeId, nodeAttr }) => {
            const helpers = {
                walk(matches: Element[], root: ParentNode): void {
                    const children = Array.from(root.children) as Element[]
                    for (const child of children) {
                        if (child.getAttribute(nodeAttr) === nodeId) {
                            matches.push(child)
                        }
                        helpers.walk(matches, child)
                        if (child.shadowRoot) {
                            helpers.walk(matches, child.shadowRoot)
                        }
                    }
                },

                findUniqueNode(): Element | null {
                    const matches: Element[] = []
                    helpers.walk(matches, document)
                    if (matches.length !== 1) return null
                    return matches[0]
                },
            }

            return helpers.findUniqueNode()
        },
        {
            nodeId: binding.nodeId,
            nodeAttr: OS_NODE_ID_ATTR,
        }
    )

    const element = handle.asElement() as ElementHandle<Element> | null
    if (!element) {
        await handle.dispose()
        throw new CounterResolutionError(
            'ERR_COUNTER_STALE_OR_NOT_FOUND',
            `Counter ${counter} became stale. Run snapshot() again.`
        )
    }

    return element
}

export async function resolveCountersBatch(
    page: Page,
    snapshot: CounterSnapshotLike,
    requests: CounterRequest[]
): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    if (!requests.length) return out

    const grouped = new Map<string, Array<CounterRequest & CounterBinding>>()
    for (const request of requests) {
        const binding = readBinding(snapshot, request.counter)
        const list = grouped.get(binding.frameToken) || []
        list.push({
            ...request,
            ...binding,
        })
        grouped.set(binding.frameToken, list)
    }

    const framesByToken = await mapFramesByToken(page)
    for (const [frameToken, entries] of grouped.entries()) {
        const frame = framesByToken.get(frameToken)
        if (!frame) {
            throw new CounterResolutionError(
                'ERR_COUNTER_FRAME_UNAVAILABLE',
                `Counter frame ${frameToken} is unavailable. Run snapshot() again.`
            )
        }

        const result = await frame.evaluate(
            ({
                entries,
                nodeAttr,
                instanceTokenKey,
                counterOwnerKey,
                counterValueKey,
            }) => {
                const values: Array<{ key: string; value: unknown }> = []
                const failures: Array<{
                    nodeId: string
                    reason: 'missing' | 'ambiguous' | 'instance_mismatch'
                }> = []

                const helpers = {
                    walk(map: Map<string, Element[]>, root: ParentNode): void {
                        const children = Array.from(root.children) as Element[]
                        for (const child of children) {
                            const id = child.getAttribute(nodeAttr)
                            if (id) {
                                const list = map.get(id) || []
                                list.push(child)
                                map.set(id, list)
                            }
                            helpers.walk(map, child)
                            if (child.shadowRoot) {
                                helpers.walk(map, child.shadowRoot)
                            }
                        }
                    },

                    buildNodeIndex(): Map<string, Element[]> {
                        const map = new Map<string, Element[]>()
                        helpers.walk(map, document)
                        return map
                    },

                    readRawValue(
                        element: Element,
                        attribute?: string | null
                    ): string | null {
                        if (attribute) {
                            return element.getAttribute(attribute)
                        }

                        return element.textContent
                    },
                }

                const index = helpers.buildNodeIndex()
                for (const entry of entries) {
                    const matches = index.get(entry.nodeId) || []
                    if (!matches.length) {
                        failures.push({
                            nodeId: entry.nodeId,
                            reason: 'missing',
                        })
                        continue
                    }
                    if (matches.length !== 1) {
                        failures.push({
                            nodeId: entry.nodeId,
                            reason: 'ambiguous',
                        })
                        continue
                    }

                    const target = matches[0] as Element &
                        Record<string, unknown>
                    if (
                        target[instanceTokenKey] !==
                            (entry.instanceToken as unknown) ||
                        target[counterOwnerKey] !== true ||
                        Number(target[counterValueKey] || 0) !==
                            entry.counter ||
                        target.getAttribute('c') !== String(entry.counter)
                    ) {
                        failures.push({
                            nodeId: entry.nodeId,
                            reason: 'instance_mismatch',
                        })
                        continue
                    }

                    values.push({
                        key: entry.key,
                        value: helpers.readRawValue(target, entry.attribute),
                    })
                }

                return {
                    values,
                    failures,
                }
            },
            {
                entries,
                nodeAttr: OS_NODE_ID_ATTR,
                instanceTokenKey: OS_INSTANCE_TOKEN_KEY,
                counterOwnerKey: OS_COUNTER_OWNER_KEY,
                counterValueKey: OS_COUNTER_VALUE_KEY,
            }
        )

        if (result.failures.length) {
            const first = result.failures[0]
            throw buildCounterFailureError(first.nodeId, first.reason)
        }

        const attributeByKey = new Map(
            entries.map((entry) => [entry.key, entry.attribute])
        )
        for (const item of result.values) {
            out[item.key] = normalizeExtractedValue(
                item.value,
                attributeByKey.get(item.key)
            )
        }
    }

    return out
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

async function readGlobalNextCounter(page: Page): Promise<number> {
    const current = await page
        .mainFrame()
        .evaluate((counterNextKey) => {
            const win = window as unknown as Record<string, unknown>
            return Number(win[counterNextKey] || 0)
        }, OS_COUNTER_NEXT_KEY)
        .catch(() => 0)

    if (Number.isFinite(current) && current > 0) {
        return current
    }

    let max = 0
    for (const frame of page.frames()) {
        try {
            const frameMax = await frame.evaluate(
                ({ nodeAttr, counterOwnerKey, counterValueKey }) => {
                    let localMax = 0

                    const helpers = {
                        walk(root: ParentNode): void {
                            const children = Array.from(
                                root.children
                            ) as Element[]
                            for (const child of children) {
                                const candidate = child as Element &
                                    Record<string, unknown>
                                const hasNodeId = child.hasAttribute(nodeAttr)
                                const owned =
                                    candidate[counterOwnerKey] === true
                                if (hasNodeId && owned) {
                                    const value = Number(
                                        candidate[counterValueKey] || 0
                                    )
                                    if (
                                        Number.isFinite(value) &&
                                        value > localMax
                                    ) {
                                        localMax = value
                                    }
                                }
                                helpers.walk(child)
                                if (child.shadowRoot) {
                                    helpers.walk(child.shadowRoot)
                                }
                            }
                        },
                    }

                    helpers.walk(document)
                    return localMax
                },
                {
                    nodeAttr: OS_NODE_ID_ATTR,
                    counterOwnerKey: OS_COUNTER_OWNER_KEY,
                    counterValueKey: OS_COUNTER_VALUE_KEY,
                }
            )
            if (frameMax > max) {
                max = frameMax
            }
        } catch {
            // Ignore inaccessible frames.
        }
    }

    const next = max + 1
    await writeGlobalNextCounter(page, next)
    return next
}

async function writeGlobalNextCounter(
    page: Page,
    nextCounter: number
): Promise<void> {
    await page
        .mainFrame()
        .evaluate(
            ({ counterNextKey, nextCounter }) => {
                const win = window as unknown as Record<string, unknown>
                win[counterNextKey] = nextCounter
            },
            {
                counterNextKey: OS_COUNTER_NEXT_KEY,
                nextCounter,
            }
        )
        .catch(() => undefined)
}

function readBinding(
    snapshot: CounterSnapshotLike,
    counter: number
): CounterBinding {
    if (!snapshot.counterBindings) {
        throw new CounterResolutionError(
            'ERR_COUNTER_NOT_FOUND',
            `Counter ${counter} is unavailable because this snapshot has no counter bindings. Run snapshot() with counters first.`
        )
    }

    const binding = snapshot.counterBindings.get(counter)
    if (!binding) {
        throw new CounterResolutionError(
            'ERR_COUNTER_NOT_FOUND',
            `Counter ${counter} was not found in the current snapshot. Run snapshot() again.`
        )
    }
    if (binding.sessionId !== snapshot.snapshotSessionId) {
        throw new CounterResolutionError(
            'ERR_COUNTER_STALE_OR_NOT_FOUND',
            `Counter ${counter} is stale for this snapshot session. Run snapshot() again.`
        )
    }
    return binding
}

function buildCounterFailureError(
    nodeId: string,
    reason: 'missing' | 'ambiguous' | 'instance_mismatch' | string
): CounterResolutionError {
    if (reason === 'ambiguous') {
        return new CounterResolutionError(
            'ERR_COUNTER_AMBIGUOUS',
            `Counter target is ambiguous for node ${nodeId}. Run snapshot() again.`
        )
    }
    return new CounterResolutionError(
        'ERR_COUNTER_STALE_OR_NOT_FOUND',
        `Counter target is stale or missing for node ${nodeId}. Run snapshot() again.`
    )
}
