import type { ElementHandle, Frame, Page } from 'playwright'
import { readExtractedValueFromHandle } from '../extract-value-reader.js'

export interface CounterRequest {
    key: string
    counter: number
    attribute?: string
}

export type CounterResolutionErrorCode =
    | 'ERR_COUNTER_NOT_FOUND'
    | 'ERR_COUNTER_AMBIGUOUS'

export class CounterResolutionError extends Error {
    readonly code: CounterResolutionErrorCode

    constructor(code: CounterResolutionErrorCode, message: string) {
        super(message)
        this.name = 'CounterResolutionError'
        this.code = code
    }
}

interface CounterScanEntry {
    count: number
    frame: Frame | null
}

type CounterElementResolution =
    | { status: 'missing' }
    | { status: 'ambiguous' }
    | { status: 'resolved'; element: ElementHandle<Element> }

type CounterValueReadResult =
    | { status: 'missing' }
    | { status: 'ok'; value: string | null }

export async function resolveCounterElement(
    page: Page,
    counter: number
): Promise<ElementHandle<Element>> {
    const normalized = normalizeCounter(counter)
    if (normalized == null) {
        throw buildCounterNotFoundError(counter)
    }

    const scan = await scanCounterOccurrences(page, [normalized])
    const entry = scan.get(normalized)
    if (!entry || entry.count <= 0 || !entry.frame) {
        throw buildCounterNotFoundError(counter)
    }
    if (entry.count > 1) {
        throw buildCounterAmbiguousError(counter)
    }

    const resolution = await resolveCounterElementInFrame(entry.frame, normalized)
    if (resolution.status === 'ambiguous') {
        throw buildCounterAmbiguousError(counter)
    }
    if (resolution.status === 'missing') {
        throw buildCounterNotFoundError(counter)
    }

    return resolution.element
}

export async function resolveCountersBatch(
    page: Page,
    requests: CounterRequest[]
): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    if (!requests.length) return out

    const counters = dedupeCounters(requests)
    const scan = await scanCounterOccurrences(page, counters)

    for (const counter of counters) {
        const entry = scan.get(counter)!
        if (entry.count > 1) {
            throw buildCounterAmbiguousError(counter)
        }
    }

    const valueCache = new Map<string, string | null>()
    const elementCache = new Map<number, CounterElementResolution>()

    try {
        for (const request of requests) {
            const normalized = normalizeCounter(request.counter)
            if (normalized == null) {
                out[request.key] = null
                continue
            }

            const entry = scan.get(normalized)
            if (!entry || entry.count <= 0 || !entry.frame) {
                out[request.key] = null
                continue
            }

            const cacheKey = `${normalized}:${request.attribute || ''}`
            if (valueCache.has(cacheKey)) {
                out[request.key] = valueCache.get(cacheKey)
                continue
            }

            if (!elementCache.has(normalized)) {
                elementCache.set(
                    normalized,
                    await resolveCounterElementInFrame(entry.frame, normalized)
                )
            }

            const resolution = elementCache.get(normalized)!
            if (resolution.status === 'ambiguous') {
                throw buildCounterAmbiguousError(normalized)
            }
            if (resolution.status === 'missing') {
                valueCache.set(cacheKey, null)
                out[request.key] = null
                continue
            }

            const value = await readCounterValueFromElement(
                resolution.element,
                request.attribute
            )
            if (value.status === 'missing') {
                await resolution.element.dispose()
                elementCache.set(normalized, {
                    status: 'missing',
                })
                valueCache.set(cacheKey, null)
                out[request.key] = null
                continue
            }

            valueCache.set(cacheKey, value.value)
            out[request.key] = value.value
        }
    } finally {
        await disposeResolvedCounterElements(elementCache.values())
    }

    return out
}

function dedupeCounters(requests: CounterRequest[]): number[] {
    const seen = new Set<number>()
    const out: number[] = []

    for (const request of requests) {
        const normalized = normalizeCounter(request.counter)
        if (normalized == null || seen.has(normalized)) continue
        seen.add(normalized)
        out.push(normalized)
    }

    return out
}

function normalizeCounter(counter: number): number | null {
    if (!Number.isFinite(counter)) return null
    if (!Number.isInteger(counter)) return null
    if (counter <= 0) return null
    return counter
}

async function scanCounterOccurrences(
    page: Page,
    counters: number[]
): Promise<Map<number, CounterScanEntry>> {
    const out = new Map<number, CounterScanEntry>()
    for (const counter of counters) {
        out.set(counter, {
            count: 0,
            frame: null,
        })
    }

    if (!counters.length) return out

    for (const frame of page.frames()) {
        let frameCounts: Record<string, number>
        try {
            frameCounts = await frame.evaluate((candidates) => {
                const keys = new Set(candidates.map((value) => String(value)))
                const counts: Record<string, number> = {}
                for (const key of keys) {
                    counts[key] = 0
                }

                const walk = (root: ParentNode): void => {
                    const children = Array.from(root.children) as Element[]
                    for (const child of children) {
                        const value = child.getAttribute('c')
                        if (value && keys.has(value)) {
                            counts[value] = (counts[value] || 0) + 1
                        }
                        walk(child)
                        if (child.shadowRoot) {
                            walk(child.shadowRoot)
                        }
                    }
                }

                walk(document)
                return counts
            }, counters)
        } catch {
            continue
        }

        for (const [rawCounter, rawCount] of Object.entries(frameCounts)) {
            const counter = Number.parseInt(rawCounter, 10)
            if (!Number.isFinite(counter)) continue

            const count = Number(rawCount || 0)
            if (!Number.isFinite(count) || count <= 0) continue

            const entry = out.get(counter)!
            entry.count += count
            if (!entry.frame) {
                entry.frame = frame
            }
        }
    }

    return out
}

async function resolveCounterElementInFrame(
    frame: Frame,
    counter: number
): Promise<CounterElementResolution> {
    try {
        const handle = await frame.evaluateHandle((targetCounter) => {
            const matches: Element[] = []

            const walk = (root: ParentNode): void => {
                const children = Array.from(root.children) as Element[]
                for (const child of children) {
                    if (child.getAttribute('c') === targetCounter) {
                        matches.push(child)
                    }
                    walk(child)
                    if (child.shadowRoot) {
                        walk(child.shadowRoot)
                    }
                }
            }

            walk(document)
            if (!matches.length) {
                return 'missing'
            }
            if (matches.length > 1) {
                return 'ambiguous'
            }
            return matches[0]
        }, String(counter))

        const element = handle.asElement() as ElementHandle<Element> | null
        if (element) {
            return {
                status: 'resolved',
                element,
            }
        }

        const status = await handle.jsonValue()
        await handle.dispose()
        return status === 'ambiguous'
            ? { status: 'ambiguous' }
            : { status: 'missing' }
    } catch (error) {
        if (isRecoverableCounterReadRace(error)) {
            return {
                status: 'missing',
            }
        }
        throw error
    }
}

async function readCounterValueFromElement(
    element: ElementHandle<Element>,
    attribute?: string
): Promise<CounterValueReadResult> {
    try {
        return {
            status: 'ok',
            value: await readExtractedValueFromHandle(element, {
                attribute,
            }),
        }
    } catch (error) {
        if (isRecoverableCounterReadRace(error)) {
            return {
                status: 'missing',
            }
        }
        throw error
    }
}

async function disposeResolvedCounterElements(
    resolutions: Iterable<CounterElementResolution>
): Promise<void> {
    const disposals: Promise<void>[] = []
    for (const resolution of resolutions) {
        if (resolution.status !== 'resolved') continue
        disposals.push(resolution.element.dispose())
    }
    await Promise.all(disposals)
}

function isRecoverableCounterReadRace(error: unknown): boolean {
    if (!(error instanceof Error)) return false

    const message = error.message
    return (
        message.includes('Execution context was destroyed') ||
        message.includes('Cannot find context with specified id') ||
        message.includes('Cannot find execution context') ||
        message.includes('Frame was detached') ||
        message.includes('Element is not attached to the DOM') ||
        message.includes('Element is detached')
    )
}

function buildCounterNotFoundError(counter: number): CounterResolutionError {
    return new CounterResolutionError(
        'ERR_COUNTER_NOT_FOUND',
        `Counter ${counter} was not found in the live DOM.`
    )
}

function buildCounterAmbiguousError(counter: number): CounterResolutionError {
    return new CounterResolutionError(
        'ERR_COUNTER_AMBIGUOUS',
        `Counter ${counter} matches multiple live elements.`
    )
}
