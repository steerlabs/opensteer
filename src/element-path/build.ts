import type { ElementHandle, Page } from 'playwright'
import { buildSegmentSelector } from './match-selectors.js'
import {
    buildLocalClausePool,
    isValidCssAttributeKey,
    shouldKeepAttributeForPath,
} from './match-policy.js'
import type {
    ElementPath,
    MatchClause,
    PathNode,
    PathNodePosition,
} from './types.js'
import { ENSURE_NAME_SHIM_SCRIPT } from '../html/runtime-keys.js'

const MAX_ATTRIBUTE_VALUE_LENGTH = 300

export function cloneElementPath(path: ElementPath): ElementPath {
    return JSON.parse(JSON.stringify(path)) as ElementPath
}

export function buildPathSelectorHint(path: ElementPath): string {
    const nodes = path?.nodes || []
    const last = nodes[nodes.length - 1]
    if (!last) return '*'
    return buildSegmentSelector(last)
}

export async function buildElementPathFromSelector(
    page: Page,
    selector: string
): Promise<ElementPath | null> {
    try {
        const handle = await page
            .mainFrame()
            .locator(selector)
            .first()
            .elementHandle({ timeout: 1500 })
        if (!handle) return null
        const path = await buildElementPathFromHandle(handle)
        await handle.dispose()
        return path
    } catch {
        return null
    }
}

export async function buildElementPathFromHandle(
    handle: ElementHandle
): Promise<ElementPath | null> {
    const frame = await handle.ownerFrame()
    if (frame) {
        await frame.evaluate(ENSURE_NAME_SHIM_SCRIPT)
    }

    const out = await handle.evaluate((target) => {
        // tsx/esbuild can inject __name(...) into serialized callbacks.
        // Playwright evaluate runs in the page where that helper is absent.
        function __name<T>(value: T): T {
            return value
        }

        // Inline types for code running inside evaluate() where module
        // types are not available.
        interface EvalMatchClause {
            kind: 'attr' | 'position'
            key?: string
            op?: 'exact' | 'startsWith' | 'contains'
            value?: string
            axis?: 'nthOfType' | 'nthChild'
        }

        interface EvalPosition {
            nthChild: number
            nthOfType: number
        }

        interface EvalPathNode {
            tag: string
            attrs: Record<string, string>
            position: EvalPosition
            match: EvalMatchClause[]
        }

        const ATTRIBUTE_DENY_KEYS = new Set([
            'style',
            'nonce',
            'integrity',
            'crossorigin',
            'referrerpolicy',
            'autocomplete',
        ])
        const INTERNAL_ATTR_PREFIXES = ['data-ov-', 'data-opensteer-']
        const LAZY_LOADING_MEDIA_TAGS = new Set([
            'img',
            'video',
            'source',
            'iframe',
        ])
        const VOLATILE_LAZY_LOADING_ATTRS = new Set([
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
        const ATTRIBUTE_PRIORITY = [
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
        ]

        const helpers = {
            isValidAttrKey(key: string): boolean {
                const trimmed = String(key || '').trim()
                if (!trimmed) return false
                if (/[\s"'<>/]/.test(trimmed)) return false
                return /^[A-Za-z_][A-Za-z0-9_:\-.]*$/.test(trimmed)
            },

            isMediaTag(tag: string | null | undefined): boolean {
                if (!tag) return false
                return LAZY_LOADING_MEDIA_TAGS.has(String(tag).toLowerCase())
            },

            shouldKeepAttr(tag: string, key: string, value: string): boolean {
                const normalized = String(key || '')
                    .trim()
                    .toLowerCase()
                if (!normalized || !String(value || '').trim()) return false
                if (!helpers.isValidAttrKey(key)) return false
                if (normalized === 'c') return false
                if (/^on[a-z]/i.test(normalized)) return false
                if (ATTRIBUTE_DENY_KEYS.has(normalized)) return false
                if (
                    INTERNAL_ATTR_PREFIXES.some((prefix) =>
                        normalized.startsWith(prefix)
                    )
                ) {
                    return false
                }
                if (
                    helpers.isMediaTag(tag) &&
                    VOLATILE_LAZY_LOADING_ATTRS.has(normalized)
                ) {
                    return false
                }
                return true
            },

            collectAttrs(node: Element): Record<string, string> {
                const tag = node.tagName.toLowerCase()
                const attrs: Record<string, string> = {}
                for (const attr of Array.from(node.attributes)) {
                    if (!helpers.shouldKeepAttr(tag, attr.name, attr.value)) {
                        continue
                    }
                    const value = String(attr.value || '')
                    if (!value.trim()) continue
                    if (value.length > 300) continue
                    attrs[attr.name] = value
                }
                return attrs
            },

            getSiblings(node: Element, root: Document | ShadowRoot): Element[] {
                if (node.parentElement)
                    return Array.from(node.parentElement.children)
                if (root instanceof ShadowRoot) return Array.from(root.children)
                return Array.from(root.children)
            },

            toPosition(
                node: Element,
                root: Document | ShadowRoot
            ): {
                nthChild: number
                nthOfType: number
            } {
                const siblings = helpers.getSiblings(node, root)
                const tag = node.tagName.toLowerCase()
                const sameTag = siblings.filter(
                    (sibling) => sibling.tagName.toLowerCase() === tag
                )
                return {
                    nthChild: siblings.indexOf(node) + 1,
                    nthOfType: sameTag.indexOf(node) + 1,
                }
            },

            buildChain(node: Element, root: Document | ShadowRoot): Element[] {
                const chain: Element[] = []
                let current: Element | null = node
                while (current) {
                    chain.push(current)
                    const parent: Element | null = current.parentElement
                    if (parent) {
                        current = parent
                        continue
                    }
                    const rootNode = current.getRootNode()
                    if (rootNode === root) break
                    break
                }
                chain.reverse()
                return chain
            },

            sortAttributeKeys(keys: string[]): string[] {
                return [...keys].sort((a, b) => {
                    const ai = ATTRIBUTE_PRIORITY.indexOf(a)
                    const bi = ATTRIBUTE_PRIORITY.indexOf(b)
                    const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai
                    const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi
                    if (ar !== br) return ar - br
                    return a.localeCompare(b)
                })
            },

            tokenizeClassValue(value: string): string[] {
                const seen = new Set<string>()
                const out: string[] = []
                for (const token of String(value || '').split(/\s+/)) {
                    const normalized = token.trim()
                    if (!normalized || seen.has(normalized)) continue
                    seen.add(normalized)
                    out.push(normalized)
                }
                return out
            },

            clauseKey(clause: EvalMatchClause): string {
                return JSON.stringify(clause)
            },

            matchClause(
                node: Element,
                data: EvalPathNode,
                clause: EvalMatchClause,
                root: Document | ShadowRoot
            ): boolean {
                if (!clause || typeof clause !== 'object') return false
                if (clause.kind === 'position') {
                    const pos = helpers.toPosition(node, root)
                    if (clause.axis === 'nthOfType') {
                        return pos.nthOfType === data.position.nthOfType
                    }
                    return pos.nthChild === data.position.nthChild
                }

                const key = String(clause.key || '')
                const expected =
                    typeof clause.value === 'string'
                        ? clause.value
                        : data.attrs?.[key]
                if (!expected) return false

                const actual = node.getAttribute(key)
                if (actual == null) return false

                const op = clause.op || 'exact'
                if (op === 'startsWith') return actual.startsWith(expected)
                if (op === 'contains') return actual.includes(expected)
                return actual === expected
            },

            buildSegmentSelector(data: EvalPathNode): string {
                let selector = String(data.tag || '*').toLowerCase()
                for (const clause of data.match || []) {
                    if (clause.kind === 'position') {
                        if (clause.axis === 'nthOfType') {
                            selector += `:nth-of-type(${Math.max(1, Number(data.position?.nthOfType || 1))})`
                        } else {
                            selector += `:nth-child(${Math.max(1, Number(data.position?.nthChild || 1))})`
                        }
                        continue
                    }

                    const key = String(clause.key || '')
                    const value =
                        typeof clause.value === 'string'
                            ? clause.value
                            : data.attrs?.[key]
                    if (!key || !value) continue
                    const escaped = String(value)
                        .replace(/\\/g, '\\\\')
                        .replace(/"/g, '\\"')
                    const op = clause.op || 'exact'
                    if (key === 'class' && op === 'exact') {
                        const tokens = helpers.tokenizeClassValue(value)
                        if (tokens.length) {
                            for (const token of tokens) {
                                const escapedToken = String(token)
                                    .replace(/\\/g, '\\\\')
                                    .replace(/"/g, '\\"')
                                selector += `[class~="${escapedToken}"]`
                            }
                            continue
                        }
                    }
                    if (op === 'startsWith')
                        selector += `[${key}^="${escaped}"]`
                    else if (op === 'contains')
                        selector += `[${key}*="${escaped}"]`
                    else selector += `[${key}="${escaped}"]`
                }
                return selector
            },

            buildCandidates(nodes: EvalPathNode[]): string[] {
                const parts = nodes.map((node) =>
                    helpers.buildSegmentSelector(node)
                )
                const out: string[] = []
                const seen = new Set<string>()
                for (let start = 0; start < parts.length; start++) {
                    const selector = parts.slice(start).join(' ')
                    if (!selector || seen.has(selector)) continue
                    seen.add(selector)
                    out.push(selector)
                }
                return out
            },

            selectReplayCandidate(
                nodes: EvalPathNode[],
                root: Document | ShadowRoot
            ): {
                element: Element
                selector: string
                count: number
                mode: 'unique' | 'fallback'
            } | null {
                const selectors = helpers.buildCandidates(nodes)
                let fallback: Element | null = null
                let fallbackSelector: string | null = null
                let fallbackCount = 0
                for (const selector of selectors) {
                    let found: NodeListOf<Element> | null = null
                    try {
                        found = root.querySelectorAll(selector)
                    } catch {
                        found = null
                    }
                    if (!found || found.length === 0) continue
                    if (found.length === 1) {
                        return {
                            element: found[0] as Element,
                            selector,
                            count: 1,
                            mode: 'unique',
                        }
                    }
                    if (!fallback) {
                        fallback = found[0] as Element
                        fallbackSelector = selector
                        fallbackCount = found.length
                    }
                }
                if (fallback && fallbackSelector) {
                    return {
                        element: fallback,
                        selector: fallbackSelector,
                        count: fallbackCount,
                        mode: 'fallback',
                    }
                }
                return null
            },

            buildClausePool(data: EvalPathNode): EvalMatchClause[] {
                const attrs = data.attrs || {}
                const pool: EvalMatchClause[] = []
                const used = new Set<string>()

                if (attrs.id) {
                    const clause = {
                        kind: 'attr',
                        key: 'id',
                        op: 'exact',
                    } as const
                    const key = helpers.clauseKey(clause)
                    if (!used.has(key)) {
                        used.add(key)
                        pool.push(clause)
                    }
                }

                const classValue = String(attrs.class || '').trim()
                if (classValue) {
                    const clause = {
                        kind: 'attr',
                        key: 'class',
                        op: 'exact',
                        value: classValue,
                    } as const
                    const key = helpers.clauseKey(clause)
                    if (!used.has(key)) {
                        used.add(key)
                        pool.push(clause)
                    }
                }

                const extraKeys = helpers.sortAttributeKeys(Object.keys(attrs))
                for (const key of extraKeys) {
                    if (key === 'id' || key === 'class') continue
                    const value = attrs[key]
                    if (!value || !String(value).trim()) continue
                    const clause = { kind: 'attr', key, op: 'exact' } as const
                    const clauseKey = helpers.clauseKey(clause)
                    if (used.has(clauseKey)) continue
                    used.add(clauseKey)
                    pool.push(clause)
                }

                const nthOfTypeClause = {
                    kind: 'position',
                    axis: 'nthOfType',
                } as const
                const nthOfTypeKey = helpers.clauseKey(nthOfTypeClause)
                if (!used.has(nthOfTypeKey)) {
                    used.add(nthOfTypeKey)
                    pool.push(nthOfTypeClause)
                }
                const nthChildClause = {
                    kind: 'position',
                    axis: 'nthChild',
                } as const
                const nthChildKey = helpers.clauseKey(nthChildClause)
                if (!used.has(nthChildKey)) {
                    used.add(nthChildKey)
                    pool.push(nthChildClause)
                }

                return pool
            },

            finalizePath(
                elements: Element[],
                root: Document | ShadowRoot
            ): { nodes: EvalPathNode[]; selector: string } | null {
                if (!elements.length) return null
                const nodes: EvalPathNode[] = elements.map((element) => ({
                    tag: element.tagName.toLowerCase(),
                    attrs: helpers.collectAttrs(element),
                    position: helpers.toPosition(element, root),
                    match: [] as EvalMatchClause[],
                }))

                const pools = nodes.map((node) => {
                    node.match = []
                    return [...helpers.buildClausePool(node)]
                })

                const matchesNode = (
                    candidate: Element | null,
                    expected: Element
                ): boolean => {
                    if (!(candidate instanceof Element)) return false
                    return candidate === expected
                }

                const totalRemaining = pools.reduce(
                    (sum, pool) => sum + pool.length,
                    0
                )
                for (let iter = 0; iter <= totalRemaining; iter++) {
                    const chosen = helpers.selectReplayCandidate(nodes, root)
                    if (
                        chosen &&
                        chosen.mode === 'unique' &&
                        matchesNode(
                            chosen.element,
                            elements[elements.length - 1]
                        )
                    ) {
                        return {
                            nodes,
                            selector: chosen.selector,
                        }
                    }

                    let added = false
                    for (let idx = pools.length - 1; idx >= 0; idx--) {
                        const next = pools[idx][0]
                        if (!next) continue
                        nodes[idx].match.push(next)
                        pools[idx].shift()
                        added = true
                        break
                    }
                    if (!added) break
                }

                return null
            },
        }

        if (!(target instanceof Element)) return null

        const context: Array<{ kind: 'shadow'; host: EvalPathNode[] }> = []
        const targetRoot = target.getRootNode()
        const initialRoot =
            targetRoot instanceof ShadowRoot ? targetRoot : document

        const targetChain = helpers.buildChain(target, initialRoot)
        const finalizedTarget = helpers.finalizePath(targetChain, initialRoot)
        if (!finalizedTarget) return null

        let currentRoot: Document | ShadowRoot = initialRoot
        while (currentRoot instanceof ShadowRoot) {
            const host = currentRoot.host
            const hostRoot = host.getRootNode()
            const normalizedHostRoot =
                hostRoot instanceof ShadowRoot ? hostRoot : document
            const hostChain = helpers.buildChain(host, normalizedHostRoot)
            const finalizedHost = helpers.finalizePath(
                hostChain,
                normalizedHostRoot
            )
            if (!finalizedHost) return null
            context.unshift({
                kind: 'shadow',
                host: finalizedHost.nodes,
            })
            currentRoot = normalizedHostRoot
        }

        return {
            context,
            nodes: finalizedTarget.nodes,
        }
    })

    if (!out) return null
    return sanitizeElementPath(out as ElementPath)
}

export function sanitizeElementPath(path: ElementPath): ElementPath {
    const cleanNodes = (nodes: unknown[]): PathNode[] =>
        (Array.isArray(nodes) ? nodes : []).map((raw) =>
            normalizePathNode(raw as Record<string, unknown>)
        )

    const context = (Array.isArray(path?.context) ? path.context : [])
        .filter(
            (hop) => hop && (hop.kind === 'iframe' || hop.kind === 'shadow')
        )
        .map((hop) => ({
            kind: hop.kind,
            host: cleanNodes(hop.host || []),
        }))

    return {
        context,
        nodes: cleanNodes(path?.nodes || []),
    }
}

function normalizePathNode(raw: Record<string, unknown>): PathNode {
    const tag = String(raw?.tag || '*').toLowerCase()

    const attrsIn =
        raw?.attrs && typeof raw.attrs === 'object'
            ? (raw.attrs as Record<string, unknown>)
            : {}
    const attrs: Record<string, string> = {}
    for (const [key, value] of Object.entries(attrsIn)) {
        const k = String(key)
        const v = String(value ?? '')
        if (!v.trim()) continue
        if (v.length > MAX_ATTRIBUTE_VALUE_LENGTH) continue
        if (!shouldKeepAttributeForPath(k, v, { tag })) continue
        attrs[k] = v
    }

    const positionRaw =
        raw?.position && typeof raw.position === 'object'
            ? (raw.position as Record<string, unknown>)
            : {}

    const nthChild = Math.max(1, Number(positionRaw.nthChild || 1))
    const nthOfType = Math.max(1, Number(positionRaw.nthOfType || 1))

    const position: PathNodePosition = {
        nthChild,
        nthOfType,
    }

    const match = normalizeMatch(raw?.match, attrs, position, tag)
    return {
        tag,
        attrs,
        position,
        match,
    }
}

function normalizeMatch(
    rawMatch: unknown,
    attrs: Record<string, string>,
    position: PathNodePosition,
    tag: string
): MatchClause[] {
    const out: MatchClause[] = []
    const seen = new Set<string>()
    const hasExplicitMatchArray = Array.isArray(rawMatch)
    let normalizedLegacyClassClause = false

    const push = (clause: MatchClause): void => {
        const key = JSON.stringify(clause)
        if (seen.has(key)) return
        seen.add(key)
        out.push(clause)
    }

    if (Array.isArray(rawMatch)) {
        for (const clause of rawMatch) {
            if (!clause || typeof clause !== 'object') continue
            const record = clause as Record<string, unknown>
            if (record.kind === 'position') {
                if (record.axis === 'nthOfType' || record.axis === 'nthChild') {
                    push({ kind: 'position', axis: record.axis })
                }
                continue
            }
            if (record.kind === 'attr') {
                const key = String(record.key || '').trim()
                if (!isValidCssAttributeKey(key)) continue
                const op =
                    record.op === 'startsWith' || record.op === 'contains'
                        ? record.op
                        : 'exact'
                const value =
                    typeof record.value === 'string' ? record.value : undefined
                if (
                    key === 'class' &&
                    op === 'exact' &&
                    attrs.class &&
                    !normalizedLegacyClassClause
                ) {
                    push({
                        kind: 'attr',
                        key: 'class',
                        op: 'exact',
                        value: attrs.class,
                    })
                    normalizedLegacyClassClause = true
                    continue
                }
                push({ kind: 'attr', key, op, value })
            }
        }
    }

    if (!out.length && !hasExplicitMatchArray) {
        const seeded: PathNode = {
            tag,
            attrs,
            position,
            match: [],
        }
        for (const clause of buildLocalClausePool(seeded)) {
            push(clause)
        }
    }

    return out
}
