import type { DomPath, MatchClause, PathNode } from './types.js'
import {
    escapeCssAttrValue,
    getClauseAttributeValue,
    isValidCssAttributeKey,
} from './match-policy.js'

export function buildPathCandidates(domPath: DomPath): string[] {
    const nodes = Array.isArray(domPath) ? domPath : []
    if (!nodes.length) return []

    const pieces = nodes.map((node) => buildSegmentSelector(node))
    const out: string[] = []
    const seen = new Set<string>()

    for (let start = 0; start < pieces.length; start++) {
        const selector = pieces.slice(start).join(' ')
        if (!selector || seen.has(selector)) continue
        seen.add(selector)
        out.push(selector)
    }

    return out
}

export function buildSegmentSelector(node: PathNode): string {
    const tag = String(node?.tag || '*').toLowerCase()
    const clauses = Array.isArray(node?.match) ? node.match : []
    let selector = tag || '*'

    for (const clause of clauses) {
        selector += buildClauseSelector(node, clause)
    }

    return selector
}

function buildClauseSelector(node: PathNode, clause: MatchClause): string {
    if (!clause || typeof clause !== 'object') return ''

    if (clause.kind === 'position') {
        if (clause.axis === 'nthOfType') {
            return `:nth-of-type(${Math.max(1, Number(node.position?.nthOfType || 1))})`
        }
        return `:nth-child(${Math.max(1, Number(node.position?.nthChild || 1))})`
    }

    const key = String(clause.key || '').trim()
    if (!isValidCssAttributeKey(key)) return ''

    const value = getClauseAttributeValue(node, clause)
    if (!value) return ''

    const op = clause.op || 'exact'
    if (key === 'class' && op === 'exact') {
        const classClauses = buildClassTokenSelectors(value)
        if (classClauses) return classClauses
    }

    if (op === 'startsWith') {
        return `[${key}^="${escapeCssAttrValue(value)}"]`
    }
    if (op === 'contains') {
        return `[${key}*="${escapeCssAttrValue(value)}"]`
    }

    return `[${key}="${escapeCssAttrValue(value)}"]`
}

function buildClassTokenSelectors(value: string): string {
    const tokens = tokenizeClassValue(value)
    if (!tokens.length) {
        return `[class="${escapeCssAttrValue(value)}"]`
    }

    return tokens
        .map((token) => `[class~="${escapeCssAttrValue(token)}"]`)
        .join('')
}

function tokenizeClassValue(value: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []

    for (const token of String(value || '').split(/\s+/)) {
        const normalized = token.trim()
        if (!normalized || seen.has(normalized)) continue
        seen.add(normalized)
        out.push(normalized)
    }

    return out
}
