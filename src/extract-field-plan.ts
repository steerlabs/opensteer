import type { ExtractionFieldPlan } from './types.js'

const CURRENT_URL_SENTINEL = 'CURRENT_URL'

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
