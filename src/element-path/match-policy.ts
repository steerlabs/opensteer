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

export const MATCH_ATTRIBUTE_PRIORITY = [
    'class',
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
    'name',
    'role',
    'type',
    'aria-label',
    'title',
    'placeholder',
    'for',
    'aria-controls',
    'aria-labelledby',
    'aria-describedby',
    'id',
    'href',
    'value',
    'src',
    'srcset',
    'imagesrcset',
    'ping',
    'alt',
] as const

export const STABLE_PRIMARY_ATTR_KEYS = [
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
    'name',
    'role',
    'type',
    'aria-label',
    'title',
    'placeholder',
] as const

export const DEFERRED_MATCH_ATTR_KEYS = [
    'href',
    'src',
    'srcset',
    'imagesrcset',
    'ping',
    'value',
    'for',
    'aria-controls',
    'aria-labelledby',
    'aria-describedby',
] as const

const STABLE_PRIMARY_ATTR_KEY_SET = new Set<string>(STABLE_PRIMARY_ATTR_KEYS)
const DEFERRED_MATCH_ATTR_KEY_SET = new Set<string>(DEFERRED_MATCH_ATTR_KEYS)
const MATCH_ATTRIBUTE_PRIORITY_INDEX = new Map<string, number>(
    MATCH_ATTRIBUTE_PRIORITY.map((key, index) => [key, index])
)

const INTERNAL_ATTR_PREFIXES = ['data-os-', 'data-opensteer-']

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
        const ar = MATCH_ATTRIBUTE_PRIORITY_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER
        const br = MATCH_ATTRIBUTE_PRIORITY_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER
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
    const deferred: MatchClause[] = []

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
        if (key === 'class') continue
        const value = attrs[key]
        if (!value || !value.trim()) continue
        const clause: MatchClause = { kind: 'attr', key, op: 'exact' }
        if (shouldDeferMatchAttribute(key)) {
            deferred.push(clause)
            continue
        }
        pool.push(clause)
    }

    pool.push({ kind: 'position', axis: 'nthOfType' })
    pool.push({ kind: 'position', axis: 'nthChild' })

    const hasPrimary = pool.some((clause) => clause.kind === 'attr')
    if (!hasPrimary) {
        pool.push(...deferred)
    }

    return pool
}

export function shouldDeferMatchAttribute(rawKey: string): boolean {
    const key = String(rawKey || '').trim().toLowerCase()
    if (!key || key === 'class') return false
    if (isIdLikeAttributeKey(key)) return true
    if (DEFERRED_MATCH_ATTR_KEY_SET.has(key)) return true
    if (key.startsWith('data-') && !STABLE_PRIMARY_ATTR_KEY_SET.has(key)) {
        return true
    }
    return !STABLE_PRIMARY_ATTR_KEY_SET.has(key)
}

export function isIdLikeAttributeKey(rawKey: string): boolean {
    const key = String(rawKey || '').trim().toLowerCase()
    if (!key) return false
    if (key === 'id') return true
    return /(?:^|[-_:])id$/.test(key)
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
