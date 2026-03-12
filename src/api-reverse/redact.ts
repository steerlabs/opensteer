import { buildApiRef } from './refs.js'
import type { ApiValueKind, ApiValueLocation, ApiValueRecord } from './types.js'
import { inferValueShape } from './normalize.js'

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const AUTH_NAME_PATTERN =
    /(authorization|token|api[-_]?key|session|csrf|xsrf|secret|cookie)/i
const IDENTIFIER_NAME_PATTERN = /(id|guid|uuid|hash|key|code|account|user)/i

export class ApiValueRegistry {
    private readonly valuesByRaw = new Map<string, ApiValueRecord>()
    private readonly valuesByRef = new Map<string, ApiValueRecord>()
    private nextValueId = 1

    register(
        raw: string,
        location: ApiValueLocation,
        context: { key?: string; requestRef?: string }
    ): ApiValueRecord | null {
        const normalized = raw.trim()
        if (!normalized) return null

        const kind = classifyValueKind(normalized, context.key)
        const shouldLift =
            kind === 'auth' ||
            kind === 'cookie' ||
            kind === 'csrf' ||
            kind === 'opaque' ||
            (kind === 'identifier' && normalized.length >= 8)
        if (!shouldLift) return null

        const existing = this.valuesByRaw.get(normalized)
        if (existing) {
            if (!existing.producerRef && context.requestRef) {
                existing.producerRef = context.requestRef
            }
            return existing
        }

        const record: ApiValueRecord = {
            ref: buildApiRef('value', this.nextValueId++),
            raw: normalized,
            kind,
            shape: inferValueShape(normalized),
            firstSeenAt: Date.now(),
            location,
            producerRef: context.requestRef,
            redactionReason: buildReason(kind, context.key),
        }

        this.valuesByRaw.set(normalized, record)
        this.valuesByRef.set(record.ref, record)
        return record
    }

    getByRaw(raw: string): ApiValueRecord | null {
        return this.valuesByRaw.get(raw.trim()) ?? null
    }

    getByRef(ref: string): ApiValueRecord | null {
        return this.valuesByRef.get(ref) ?? null
    }

    list(): ApiValueRecord[] {
        return [...this.valuesByRef.values()].sort((left, right) =>
            left.ref.localeCompare(right.ref, undefined, { numeric: true })
        )
    }

    redactString(input: string): {
        value: string
        refs: string[]
    } {
        let redacted = input
        const applied: string[] = []
        const values = [...this.valuesByRaw.entries()].sort(
            ([left], [right]) => right.length - left.length
        )

        for (const [raw, record] of values) {
            if (!shouldRedactKind(record.kind)) continue
            if (!redacted.includes(raw)) continue
            redacted = redacted.split(raw).join(record.ref)
            applied.push(record.ref)
        }

        return {
            value: redacted,
            refs: dedupeRefs(applied),
        }
    }
}

export function classifyValueKind(value: string, key?: string): ApiValueKind {
    const shape = inferValueShape(value)
    if (JWT_PATTERN.test(value)) return 'auth'
    if (AUTH_NAME_PATTERN.test(key || '')) {
        if (/csrf|xsrf/i.test(key || '')) return 'csrf'
        if (/cookie/i.test(key || '')) return 'cookie'
        return 'auth'
    }
    if (/^\d+$/.test(value)) return 'number'
    if (value === 'true' || value === 'false') return 'boolean'
    if (IDENTIFIER_NAME_PATTERN.test(key || '') && value.length >= 6) {
        return 'identifier'
    }
    if (shape === 'hex' || shape === 'opaque' || shape === 'uuid' || shape === 'bearer') {
        return 'opaque'
    }
    return 'text'
}

export function redactRecordStrings<T>(value: T, registry: ApiValueRegistry): T {
    if (Array.isArray(value)) {
        return value.map((item) => redactRecordStrings(item, registry)) as T
    }
    if (!value || typeof value !== 'object') {
        if (typeof value === 'string') {
            return registry.redactString(value).value as T
        }
        return value
    }

    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        output[key] = redactRecordStrings(child, registry)
    }
    return output as T
}

function buildReason(kind: ApiValueKind, key?: string): string {
    if (key) {
        return `${kind}:${key}`
    }
    return kind
}

function dedupeRefs(values: string[]): string[] {
    return [...new Set(values)]
}

function shouldRedactKind(kind: ApiValueKind): boolean {
    return (
        kind === 'auth' ||
        kind === 'cookie' ||
        kind === 'csrf' ||
        kind === 'opaque' ||
        kind === 'identifier'
    )
}
