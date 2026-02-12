import type {
    AttributeMatchClause,
    MatchClause,
    MatchOperator,
    PathNode,
} from './types.js'

export const ATTRIBUTE_DENY_KEYS = new Set([
    'style',
    'nonce',
    'integrity',
    'crossorigin',
    'referrerpolicy',
    'autocomplete',
])

export const LAZY_LOADING_MEDIA_TAGS = new Set([
    'img',
    'video',
    'source',
    'iframe',
])

export const VOLATILE_LAZY_LOADING_ATTRS = new Set([
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-lazy',
    'data-image',
    'data-url',
    'data-srcset',
    'data-lazy-srcset',
    'data-was-processed',
])

export const VOLATILE_CLASS_TOKENS = new Set(['text-up', 'text-down'])

export const VOLATILE_LAZY_CLASS_TOKENS = new Set([
    'lazy',
    'loaded',
    'loading',
    'lazyload',
    'lazyloaded',
    'lazyloading',
])

const MATCH_ATTRIBUTE_PRIORITY = [
    'id',
    'class',
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
    'name',
    'for',
    'aria-label',
    'aria-labelledby',
    'role',
    'type',
    'href',
    'title',
    'alt',
    'placeholder',
] as const

const INTERNAL_ATTR_PREFIXES = ['data-ov-', 'data-oversteer-']

export interface AttributeFilterOptions {
    tag?: string
    allowClass?: boolean
}

export function isValidCssAttributeKey(
    key: string | null | undefined
): boolean {
    if (key == null) return false
    const k = String(key).trim()
    if (!k) return false
    if (/[\s"'<>/]/.test(k)) return false
    return /^[A-Za-z_][A-Za-z0-9_:\-.]*$/.test(k)
}

export function isMediaTag(tag: string | null | undefined): boolean {
    if (!tag) return false
    return LAZY_LOADING_MEDIA_TAGS.has(String(tag).toLowerCase())
}

export function shouldKeepAttributeForPath(
    name: string,
    value: string,
    options: AttributeFilterOptions = {}
): boolean {
    const key = String(name || '')
        .trim()
        .toLowerCase()
    if (!key || !value.trim()) return false
    if (!isValidCssAttributeKey(name)) return false
    if (key === 'c') return false
    if (/^on[a-z]/i.test(key)) return false
    if (ATTRIBUTE_DENY_KEYS.has(key)) return false
    if (INTERNAL_ATTR_PREFIXES.some((prefix) => key.startsWith(prefix)))
        return false
    if (options.allowClass === false && key === 'class') return false

    if (isMediaTag(options.tag) && VOLATILE_LAZY_LOADING_ATTRS.has(key)) {
        return false
    }

    return true
}

export function sortAttributeKeys(keys: string[]): string[] {
    return [...keys].sort((a, b) => {
        const ai = MATCH_ATTRIBUTE_PRIORITY.indexOf(
            a as (typeof MATCH_ATTRIBUTE_PRIORITY)[number]
        )
        const bi = MATCH_ATTRIBUTE_PRIORITY.indexOf(
            b as (typeof MATCH_ATTRIBUTE_PRIORITY)[number]
        )
        const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai
        const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi
        if (ar !== br) return ar - br
        return a.localeCompare(b)
    })
}

export function escapeCssAttrValue(value: string): string {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function buildLocalClausePool(node: PathNode): MatchClause[] {
    const attrs = node.attrs || {}
    const pool: MatchClause[] = []

    const idVal = attrs.id
    if (idVal && idVal.trim()) {
        pool.push({ kind: 'attr', key: 'id', op: 'exact' })
    }

    const classVal = String(attrs.class || '').trim()
    if (classVal) {
        pool.push({
            kind: 'attr',
            key: 'class',
            op: 'exact',
            value: classVal,
        })
    }

    const keys = sortAttributeKeys(Object.keys(attrs))
    for (const key of keys) {
        if (key === 'id' || key === 'class') continue
        const value = attrs[key]
        if (!value || !value.trim()) continue
        pool.push({ kind: 'attr', key, op: 'exact' })
    }

    pool.push({ kind: 'position', axis: 'nthOfType' })
    pool.push({ kind: 'position', axis: 'nthChild' })

    return pool
}

export function getClauseAttributeValue(
    node: PathNode,
    clause: AttributeMatchClause
): string | null {
    if (typeof clause.value === 'string') return clause.value
    const raw = node.attrs?.[clause.key]
    if (raw == null) return null
    return String(raw)
}

export function matchAttrValue(
    actual: string | null,
    expected: string,
    op: MatchOperator = 'exact',
    key?: string
): boolean {
    if (actual == null) return false
    const normalized = String(actual)
    if (op === 'startsWith') return normalized.startsWith(expected)
    if (op === 'contains') return normalized.includes(expected)
    return normalized === expected
}
