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
    if (op === 'startsWith') {
        return `[${key}^="${escapeCssAttrValue(value)}"]`
    }
    if (op === 'contains') {
        return `[${key}*="${escapeCssAttrValue(value)}"]`
    }

    return `[${key}="${escapeCssAttrValue(value)}"]`
}
