import { createHash } from 'crypto'
import { stableStringify } from '../utils/stable-stringify.js'
import type { ApiGraphqlMetadata } from './types.js'

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX_PATTERN = /^[0-9a-f]{16,}$/i
const BASE64ISH_PATTERN = /^[A-Za-z0-9+/_=-]{16,}$/
const INTEGER_PATTERN = /^-?\d+$/
const FLOAT_PATTERN = /^-?\d+\.\d+$/

export function hashText(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

export function safeJsonParse<T = unknown>(value: string | null | undefined): T | null {
    if (!value) return null
    try {
        return JSON.parse(value) as T
    } catch {
        return null
    }
}

export function getOrigin(value: string | null | undefined): string | null {
    if (!value) return null
    try {
        return new URL(value).origin
    } catch {
        return null
    }
}

export function buildUrlTemplate(input: string): string {
    let url: URL
    try {
        url = new URL(input)
    } catch {
        return input
    }

    const normalizedPath = url.pathname
        .split('/')
        .map((segment) => normalizePathSegment(segment))
        .join('/')

    const queryKeys = [...url.searchParams.keys()].sort()
    if (!queryKeys.length) {
        return `${url.origin}${normalizedPath}`
    }

    const normalizedQuery = queryKeys
        .map((key) => `${key}=${normalizePrimitive(url.searchParams.get(key))}`)
        .join('&')

    return `${url.origin}${normalizedPath}?${normalizedQuery}`
}

export function canonicalizeBodyShape(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalizeBodyShape(item))
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonicalizeBodyShape(child)] as const)
        return Object.fromEntries(entries)
    }

    return normalizePrimitive(value)
}

export function normalizePrimitive(value: unknown): string {
    if (value == null) return '<null>'
    if (typeof value === 'boolean') return '<boolean>'
    if (typeof value === 'number') {
        return Number.isInteger(value) ? '<int>' : '<float>'
    }

    const text = String(value)
    if (!text.length) return '<empty>'
    if (UUID_PATTERN.test(text)) return '<uuid>'
    if (INTEGER_PATTERN.test(text)) return '<int>'
    if (FLOAT_PATTERN.test(text)) return '<float>'
    if (HEX_PATTERN.test(text)) return '<hex>'
    if (BASE64ISH_PATTERN.test(text)) return '<opaque>'
    if (text.length > 40) return '<long-string>'
    return '<string>'
}

export function inferValueShape(value: string): string {
    if (UUID_PATTERN.test(value)) return 'uuid'
    if (INTEGER_PATTERN.test(value)) return 'integer'
    if (FLOAT_PATTERN.test(value)) return 'float'
    if (HEX_PATTERN.test(value)) return 'hex'
    if (BASE64ISH_PATTERN.test(value)) return 'opaque'
    if (value.startsWith('Bearer ')) return 'bearer'
    return 'string'
}

export function normalizeRequestSignature(options: {
    method: string
    url: string
    resourceType: string | null
    body: unknown
    graphql: ApiGraphqlMetadata
}): string {
    return stableStringify({
        method: options.method.toUpperCase(),
        urlTemplate: buildUrlTemplate(options.url),
        resourceType: options.resourceType ?? null,
        graphql: {
            operationName: options.graphql.operationName,
            persistedQueryHash: options.graphql.persistedQueryHash,
        },
        bodyShape: canonicalizeBodyShape(options.body),
    })
}

export function inferGraphqlMetadata(body: unknown): ApiGraphqlMetadata {
    if (!body || typeof body !== 'object') {
        return {
            operationName: null,
            persistedQueryHash: null,
        }
    }

    const record = body as Record<string, unknown>
    const operationName =
        typeof record.operationName === 'string' && record.operationName.trim()
            ? record.operationName.trim()
            : null

    const extensions =
        record.extensions && typeof record.extensions === 'object'
            ? (record.extensions as Record<string, unknown>)
            : null
    const persistedQuery =
        extensions?.persistedQuery &&
        typeof extensions.persistedQuery === 'object'
            ? (extensions.persistedQuery as Record<string, unknown>)
            : null
    const persistedQueryHash =
        typeof persistedQuery?.sha256Hash === 'string' &&
        persistedQuery.sha256Hash.trim()
            ? persistedQuery.sha256Hash.trim()
            : null

    return {
        operationName,
        persistedQueryHash,
    }
}

export function summarizeMime(mime: string | null | undefined): string | null {
    if (!mime) return null
    return mime.split(';', 1)[0].trim().toLowerCase() || null
}

function normalizePathSegment(segment: string): string {
    if (!segment) return segment
    if (UUID_PATTERN.test(segment)) return ':uuid'
    if (INTEGER_PATTERN.test(segment)) return ':int'
    if (HEX_PATTERN.test(segment)) return ':hex'
    if (BASE64ISH_PATTERN.test(segment)) return ':opaque'
    return segment
}
