import type { ExtractionFieldPlan } from './types.js'

const CURRENT_URL_SENTINEL = 'CURRENT_URL'
const COUNTER_KEY = '$c'

interface CounterLeafDescriptor {
    $c: number
    $a?: string
}

export function flattenExtractionDataToFieldPlan(
    data: unknown
): Record<string, ExtractionFieldPlan> {
    const fields: Record<string, ExtractionFieldPlan> = {}
    flattenExtractionDataToFieldPlanRecursive(data, '', fields)
    return fields
}

function flattenExtractionDataToFieldPlanRecursive(
    value: unknown,
    prefix: string,
    out: Record<string, ExtractionFieldPlan>
): void {
    if (value == null) return

    if (typeof value === 'number' && Number.isFinite(value)) {
        const key = String(prefix || '').trim()
        if (!key) return
        out[key] = { element: Math.trunc(value) }
        return
    }

    if (
        typeof value === 'string' &&
        value.trim().toUpperCase() === CURRENT_URL_SENTINEL
    ) {
        const key = String(prefix || '').trim()
        if (!key) return
        out[key] = { source: 'current_url' }
        return
    }

    const counterLeaf = parseCounterLeafDescriptor(value)
    if (counterLeaf) {
        const key = String(prefix || '').trim()
        if (!key) return
        out[key] = counterLeaf
        return
    }

    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const nextPrefix = prefix ? `${prefix}[${i}]` : `[${i}]`
            flattenExtractionDataToFieldPlanRecursive(value[i], nextPrefix, out)
        }
        return
    }

    if (typeof value !== 'object') return

    for (const [key, child] of Object.entries(
        value as Record<string, unknown>
    )) {
        const nextPrefix = prefix ? `${prefix}.${key}` : key
        flattenExtractionDataToFieldPlanRecursive(child, nextPrefix, out)
    }
}

function parseCounterLeafDescriptor(
    value: unknown
): ExtractionFieldPlan | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }

    const record = value as Partial<CounterLeafDescriptor>
    if (!Object.hasOwn(record, COUNTER_KEY)) {
        return null
    }

    const counter = record.$c
    if (typeof counter !== 'number' || !Number.isFinite(counter)) {
        return null
    }

    const rawAttribute = record.$a
    const normalizedAttribute =
        typeof rawAttribute === 'string' ? rawAttribute.trim() : ''

    return normalizedAttribute
        ? {
              element: Math.trunc(counter),
              attribute: normalizedAttribute,
          }
        : {
              element: Math.trunc(counter),
          }
}
