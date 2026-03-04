import type { ElementHandle, Page } from 'playwright'
import {
    buildArrayFieldPathCandidates,
    queryAllByElementPath,
} from '../actions/extract.js'
import type { ElementPath } from '../element-path/types.js'
import {
    isPersistedArrayNode,
    isPersistedObjectNode,
    isPersistedValueNode,
    type PersistedExtractArrayNode,
    type PersistedExtractArrayVariantNode,
    type PersistedExtractNode,
    type PersistedExtractObjectNode,
    type PersistedExtractPayload,
} from './array-consolidation.js'

interface ValueNodeRef {
    path: ElementPath
    replacePath: (path: ElementPath) => void
}

interface FieldValidationPlan {
    key: string
    strippedPath: ElementPath
    replacePath: (path: ElementPath) => void
    selectors: FieldSelectorCandidates
}

interface FieldSelectorCandidates {
    withPos: string[]
    withoutPos: string[]
}

type FieldSelectorMap = Record<string, FieldSelectorCandidates>

export async function stripRedundantPositionClauses(
    payload: PersistedExtractPayload,
    page: Page
): Promise<PersistedExtractPayload> {
    const cloned = structuredClone(payload) as PersistedExtractPayload
    await processObjectNode(cloned, page)
    return cloned
}

async function processNode(node: PersistedExtractNode, page: Page): Promise<void> {
    if (isPersistedArrayNode(node)) {
        await processArrayNode(node, page)
        return
    }

    if (isPersistedObjectNode(node)) {
        await processObjectNode(node, page)
    }
}

async function processObjectNode(
    node: PersistedExtractObjectNode,
    page: Page
): Promise<void> {
    for (const child of Object.values(node)) {
        await processNode(child, page)
    }
}

async function processArrayNode(
    node: PersistedExtractArrayNode,
    page: Page
): Promise<void> {
    for (const variant of node.$array.variants) {
        try {
            await pruneVariantPositions(variant, page)
        } catch {
            // Validation is best-effort; keep persisted paths unchanged on failure.
        }
        await processNode(variant.item, page)
    }
}

function collectValueNodes(node: PersistedExtractNode): ValueNodeRef[] {
    if (isPersistedValueNode(node)) {
        return [
            {
                path: node.$path,
                replacePath(path: ElementPath) {
                    node.$path = path
                },
            },
        ]
    }

    if (!isPersistedObjectNode(node)) return []

    const refs: ValueNodeRef[] = []
    const visit = (current: PersistedExtractObjectNode): void => {
        for (const [key, child] of Object.entries(current)) {
            if (isPersistedValueNode(child)) {
                refs.push({
                    path: child.$path,
                    replacePath(path: ElementPath) {
                        const next = current[key]
                        if (!isPersistedValueNode(next)) return
                        next.$path = path
                    },
                })
                continue
            }

            if (isPersistedObjectNode(child)) {
                visit(child)
            }
        }
    }

    visit(node)
    return refs
}

function hasPositionClause(path: ElementPath): boolean {
    return path.nodes.some((node) =>
        (node.match || []).some((clause) => clause.kind === 'position')
    )
}

function areArraysEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) return false
    }
    return true
}

async function pruneVariantPositions(
    variant: PersistedExtractArrayVariantNode,
    page: Page
): Promise<void> {
    const refs = collectValueNodes(variant.item).filter((ref) =>
        hasPositionClause(ref.path)
    )
    if (!refs.length) return

    const plans: FieldValidationPlan[] = refs
        .map((ref, index) => {
            const withPos = buildArrayFieldPathCandidates(ref.path)
            const strippedPath = stripPositionClauses(ref.path)
            const withoutPos = buildArrayFieldPathCandidates(strippedPath)
            if (areArraysEqual(withPos, withoutPos)) return null

            const plan: FieldValidationPlan = {
                key: String(index),
                strippedPath,
                replacePath: ref.replacePath,
                selectors: {
                    withPos,
                    withoutPos,
                },
            }
            return plan
        })
        .filter((plan): plan is FieldValidationPlan => !!plan)

    if (!plans.length) return

    const selectorMap: FieldSelectorMap = {}
    for (const plan of plans) {
        selectorMap[plan.key] = plan.selectors
    }

    const validatedKeys = new Set(plans.map((plan) => plan.key))
    const items = await queryAllByElementPath(page, variant.itemParentPath)
    if (!items.length) return

    try {
        for (const item of items) {
            const results = await validateRowSelectors(item, selectorMap)
            const failedKeys: string[] = []
            for (const key of validatedKeys) {
                if (results[key] === true) continue
                failedKeys.push(key)
            }
            for (const key of failedKeys) {
                validatedKeys.delete(key)
            }

            if (!validatedKeys.size) break
        }
    } finally {
        await Promise.all(
            items.map(async (item) => {
                try {
                    await item.dispose()
                } catch {
                    // ignore cleanup failures
                }
            })
        )
    }

    for (const plan of plans) {
        if (!validatedKeys.has(plan.key)) continue
        plan.replacePath(plan.strippedPath)
    }
}

async function validateRowSelectors(
    item: ElementHandle<Element>,
    fields: FieldSelectorMap
): Promise<Record<string, boolean>> {
    return item.evaluate((element, selectorMap) => {
        const tryFirst = (
            root: Element,
            selectors: string[]
        ): Element | null => {
            let fallback: Element | null = null

            for (const selector of selectors) {
                if (!selector) continue
                let matches: Element[] = []
                try {
                    matches = Array.from(root.querySelectorAll(selector))
                } catch {
                    matches = []
                }

                if (!matches.length) continue

                if (matches.length === 1) {
                    return matches[0]
                }

                if (!fallback) {
                    fallback = matches[0]
                }
            }

            return fallback
        }

        const out: Record<string, boolean> = {}
        for (const [key, selectors] of Object.entries(selectorMap)) {
            const original = tryFirst(element, selectors.withPos)
            if (!original) {
                out[key] = false
                continue
            }

            let strippedUnique: Element | null = null
            for (const selector of selectors.withoutPos) {
                if (!selector) continue
                let matches: Element[] = []
                try {
                    matches = Array.from(element.querySelectorAll(selector))
                } catch {
                    matches = []
                }

                if (matches.length === 1) {
                    strippedUnique = matches[0]
                    break
                }
            }

            out[key] = strippedUnique === original
        }

        return out
    }, fields)
}

function stripPositionClauses(path: ElementPath): ElementPath {
    return {
        context: path.context,
        nodes: path.nodes.map((node) => ({
            ...node,
            match: (node.match || []).filter((clause) => clause.kind !== 'position'),
        })),
    }
}
