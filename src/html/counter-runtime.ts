import type { ElementHandle, Frame, Page } from 'playwright'
import { normalizeExtractedValue } from '../extract-value-normalization.js'

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

interface CounterReadResult {
    status: 'ok' | 'missing' | 'ambiguous'
    value?: string | null
}

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

    const handle = await resolveUniqueHandleInFrame(entry.frame, normalized)
    const element = handle.asElement() as ElementHandle<Element> | null
    if (!element) {
        await handle.dispose()
        throw buildCounterNotFoundError(counter)
    }

    return element
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

    const valueCache = new Map<string, unknown>()
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

        const read = await readCounterValueInFrame(
            entry.frame,
            normalized,
            request.attribute
        )
        if (read.status === 'ambiguous') {
            throw buildCounterAmbiguousError(normalized)
        }

        if (read.status === 'missing') {
            valueCache.set(cacheKey, null)
            out[request.key] = null
            continue
        }

        const normalizedValue = normalizeExtractedValue(
            read.value ?? null,
            request.attribute
        )
        valueCache.set(cacheKey, normalizedValue)
        out[request.key] = normalizedValue
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

async function resolveUniqueHandleInFrame(
    frame: Frame,
    counter: number
) {
    return frame.evaluateHandle((targetCounter) => {
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
        if (matches.length !== 1) {
            return null
        }
        return matches[0]
    }, String(counter))
}

async function readCounterValueInFrame(
    frame: Frame,
    counter: number,
    attribute?: string
): Promise<CounterReadResult> {
    try {
        return await frame.evaluate(
            ({ targetCounter, attribute }) => {
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
                    return {
                        status: 'missing',
                    }
                }

                if (matches.length > 1) {
                    return {
                        status: 'ambiguous',
                    }
                }

                const target = matches[0]
                const value = attribute
                    ? target.getAttribute(attribute)
                    : target.textContent

                return {
                    status: 'ok',
                    value,
                }
            },
            {
                targetCounter: String(counter),
                attribute,
            }
        )
    } catch {
        return {
            status: 'missing',
        }
    }
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
