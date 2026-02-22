import { cloneElementPath, sanitizeElementPath } from '../element-path/build.js'
import {
    VOLATILE_CLASS_TOKENS,
    VOLATILE_LAZY_CLASS_TOKENS,
} from '../element-path/match-policy.js'
import type { ElementPath, MatchClause, PathNode } from '../element-path/types.js'
import { stableStringify } from '../utils/stable-stringify.js'
import {
    encodeDataPath,
    joinDataPath,
    parseDataPath,
} from './data-path.js'

export interface PersistablePathField {
    key: string
    path: ElementPath
    attribute?: string
}

export interface PersistableSourceField {
    key: string
    source: 'current_url'
}

export type PersistableExtractField =
    | PersistablePathField
    | PersistableSourceField

export interface PersistedExtractValueNode {
    $path: ElementPath
    attribute?: string
}

export interface PersistedExtractSourceNode {
    $source: 'current_url'
}

export interface PersistedExtractArrayVariantNode {
    itemParentPath: ElementPath
    item: PersistedExtractNode
}

export interface PersistedExtractArrayNode {
    $array: {
        variants: PersistedExtractArrayVariantNode[]
    }
}

export interface PersistedExtractObjectNode {
    [key: string]: PersistedExtractNode
}

export type PersistedExtractNode =
    | PersistedExtractValueNode
    | PersistedExtractSourceNode
    | PersistedExtractArrayNode
    | PersistedExtractObjectNode

export type PersistedExtractPayload = PersistedExtractObjectNode

export interface ArrayItemPathFieldDescriptor {
    kind: 'path'
    path: string
    selector: {
        elementPath: ElementPath
        attribute?: string
    }
}

export interface ArrayItemSourceFieldDescriptor {
    kind: 'source'
    path: string
    source: 'current_url'
}

export type ArrayItemFieldDescriptor =
    | ArrayItemPathFieldDescriptor
    | ArrayItemSourceFieldDescriptor

interface IndexedArrayField {
    source: PersistableExtractField
    arrayPath: string
    index: number
    fieldPath: string
}

interface ConsolidatedArrayField {
    path: string
    node: PersistedExtractNode
}

interface ConsolidatedArrayVariantDescriptor {
    itemParentPath: ElementPath
    fields: ConsolidatedArrayField[]
}

interface ConsolidatedArrayDescriptor {
    path: string
    variants: ConsolidatedArrayVariantDescriptor[]
}

interface PerIndexDescriptor {
    index: number
    itemRoot: ElementPath
    fields: ConsolidatedArrayField[]
}

const STRUCTURAL_ATTR_KEYS = new Set([
    'class',
    'role',
    'type',
    'name',
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
])

const SINGLE_SAMPLE_DROP_ATTR_KEYS = new Set([
    'id',
    'href',
    'src',
    'srcset',
    'imagesrcset',
    'ping',
    'value',
    'title',
    'alt',
    'placeholder',
    'for',
    'aria-label',
    'aria-labelledby',
])

const DATA_TEST_ATTR_KEYS = new Set([
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
])

const CLUSTER_FALLBACK_PREFIX = 'variant'

export function isPersistablePathField(
    field: PersistableExtractField
): field is PersistablePathField {
    return 'path' in field
}

export function isPersistedValueNode(
    node: unknown
): node is PersistedExtractValueNode {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    const record = node as Record<string, unknown>
    return !!record.$path
}

export function isPersistedSourceNode(
    node: unknown
): node is PersistedExtractSourceNode {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    const record = node as Record<string, unknown>
    return record.$source === 'current_url'
}

export function isPersistedArrayNode(
    node: unknown
): node is PersistedExtractArrayNode {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    const record = node as Record<string, unknown>
    return !!record.$array
}

export function isPersistedObjectNode(
    node: unknown
): node is PersistedExtractObjectNode {
    return (
        !!node &&
        typeof node === 'object' &&
        !Array.isArray(node) &&
        !isPersistedValueNode(node) &&
        !isPersistedSourceNode(node) &&
        !isPersistedArrayNode(node)
    )
}

export function collectArrayItemFieldDescriptors(
    node: PersistedExtractNode,
    prefix = ''
): ArrayItemFieldDescriptor[] {
    if (isPersistedValueNode(node)) {
        return [
            {
                kind: 'path',
                path: prefix,
                selector: {
                    elementPath: cloneElementPath(node.$path),
                    attribute: node.attribute,
                },
            },
        ]
    }

    if (isPersistedSourceNode(node)) {
        return [
            {
                kind: 'source',
                path: prefix,
                source: 'current_url',
            },
        ]
    }

    if (isPersistedArrayNode(node)) {
        throw new Error(
            'Nested array extraction descriptors are not supported in cached array item selectors.'
        )
    }

    const out: ArrayItemFieldDescriptor[] = []
    for (const [key, child] of Object.entries(node)) {
        const nextPath = joinDataPath(prefix, key)
        out.push(...collectArrayItemFieldDescriptors(child, nextPath))
    }

    return out
}

export function buildPersistedExtractPayload(
    fields: PersistableExtractField[]
): PersistedExtractPayload {
    const normalizedFields = normalizePersistableFields(fields)

    const grouped = new Map<string, IndexedArrayField[]>()
    for (const field of normalizedFields) {
        const parsed = parseIndexedArrayFieldKey(field.key)
        if (!parsed) continue

        const list = grouped.get(parsed.arrayPath) || []
        list.push({
            source: field,
            arrayPath: parsed.arrayPath,
            index: parsed.index,
            fieldPath: parsed.fieldPath,
        })
        grouped.set(parsed.arrayPath, list)
    }

    const consumedFieldKeys = new Set<string>()
    const arrays: ConsolidatedArrayDescriptor[] = []

    for (const [arrayPath, entries] of grouped) {
        const descriptor = buildPersistedArrayDescriptor(arrayPath, entries)
        if (!descriptor) continue

        arrays.push(descriptor)
        for (const entry of entries) {
            consumedFieldKeys.add(entry.source.key)
        }
    }

    const root: PersistedExtractObjectNode = {}

    for (const field of normalizedFields) {
        if (!field.key || consumedFieldKeys.has(field.key)) continue
        insertNodeAtPath(root, field.key, createNodeFromPersistableField(field))
    }

    for (const descriptor of arrays.sort((a, b) =>
        a.path.localeCompare(b.path)
    )) {
        if (!descriptor.variants.length) continue
        insertNodeAtPath(root, descriptor.path, {
            $array: {
                variants: descriptor.variants.map((variant) => ({
                    itemParentPath: cloneElementPath(variant.itemParentPath),
                    item: buildArrayItemNode(variant.fields),
                })),
            },
        })
    }

    return root
}

function normalizePersistableFields(
    fields: PersistableExtractField[]
): PersistableExtractField[] {
    return fields.map((field) => {
        const key = String(field.key || '').trim()
        if (!isPersistablePathField(field)) {
            return {
                key,
                source: 'current_url',
            }
        }

        return {
            key,
            path: sanitizeElementPath(field.path),
            attribute: field.attribute,
        }
    })
}

function buildPersistedArrayDescriptor(
    arrayPath: string,
    entries: IndexedArrayField[]
): ConsolidatedArrayDescriptor | null {
    const fieldsByIndex = new Map<number, IndexedArrayField[]>()
    for (const entry of entries) {
        const list = fieldsByIndex.get(entry.index) || []
        list.push(entry)
        fieldsByIndex.set(entry.index, list)
    }

    if (!fieldsByIndex.size) return null

    const perIndexDescriptors: PerIndexDescriptor[] = []
    for (const [index, indexEntries] of fieldsByIndex) {
        const descriptor = buildPerIndexDescriptor(index, indexEntries)
        if (!descriptor) continue
        perIndexDescriptors.push(descriptor)
    }

    if (!perIndexDescriptors.length) return null

    const variantsByCluster = new Map<string, PerIndexDescriptor[]>()
    for (const descriptor of perIndexDescriptors) {
        const clusterKey = buildVariantClusterKey(descriptor)
        const list = variantsByCluster.get(clusterKey) || []
        list.push(descriptor)
        variantsByCluster.set(clusterKey, list)
    }

    const variants: ConsolidatedArrayVariantDescriptor[] = []
    for (const descriptors of variantsByCluster.values()) {
        const variant = buildVariantDescriptorFromCluster(descriptors)
        if (!variant) continue
        variants.push(variant)
    }

    if (!variants.length) return null

    variants.sort((a, b) =>
        buildVariantSortKey(a).localeCompare(buildVariantSortKey(b))
    )

    return {
        path: arrayPath,
        variants,
    }
}

function buildPerIndexDescriptor(
    index: number,
    entries: IndexedArrayField[]
): PerIndexDescriptor | null {
    if (!entries.length) return null

    const root = buildItemRootForArrayIndex(entries)
    if (!root) return null

    const fieldsByPath = new Map<string, ConsolidatedArrayField>()

    for (const entry of entries) {
        if (!entry.fieldPath && !isPersistablePathField(entry.source)) {
            fieldsByPath.set('', {
                path: '',
                node: createSourceNode('current_url'),
            })
            continue
        }

        if (!isPersistablePathField(entry.source)) {
            fieldsByPath.set(entry.fieldPath, {
                path: entry.fieldPath,
                node: createSourceNode('current_url'),
            })
            continue
        }

        const relativePath = toRelativeElementPath(entry.source.path, root)
        if (!relativePath) continue

        fieldsByPath.set(entry.fieldPath, {
            path: entry.fieldPath,
            node: createValueNode({
                elementPath: relativePath,
                attribute: entry.source.attribute,
            }),
        })
    }

    const fields = [...fieldsByPath.values()].sort((a, b) =>
        a.path.localeCompare(b.path)
    )

    if (!fields.length) return null

    return {
        index,
        itemRoot: root,
        fields,
    }
}

function buildVariantClusterKey(descriptor: PerIndexDescriptor): string {
    const rootStructure = buildPathStructureKey(descriptor.itemRoot)
    const fieldStructure = descriptor.fields
        .map((field) => {
            const node = field.node
            if (isPersistedSourceNode(node)) {
                return `${field.path}::source:current_url`
            }
            if (isPersistedValueNode(node)) {
                return `${field.path}::path:${buildPathStructureKey(node.$path)}::attr:${String(node.attribute || '')}`
            }
            return `${field.path}::other:${stableStringify(node)}`
        })
        .sort()

    return `${CLUSTER_FALLBACK_PREFIX}:${rootStructure}::${fieldStructure.join('|')}`
}

function buildVariantDescriptorFromCluster(
    descriptors: PerIndexDescriptor[]
): ConsolidatedArrayVariantDescriptor | null {
    if (!descriptors.length) return null

    const clusterSize = descriptors.length
    const threshold = clusterSize === 1 ? 1 : majorityThreshold(clusterSize)

    const rootPaths = descriptors.map((descriptor) => descriptor.itemRoot)
    const mergedItemPath =
        clusterSize === 1
            ? relaxPathForSingleSample(rootPaths[0]!, 'item-root')
            : mergeElementPathsByMajority(rootPaths) ||
              sanitizeElementPath(rootPaths[0]!)
    const normalizedItemPath = minimizePathMatchClauses(
        mergedItemPath,
        'item-root'
    )

    const keyStats = new Map<
        string,
        {
            indices: Set<number>
            pathNodes: ElementPath[]
            attributes: Array<string | undefined>
            sources: Array<'current_url'>
        }
    >()

    for (const descriptor of descriptors) {
        for (const field of descriptor.fields) {
            const stat = keyStats.get(field.path) || {
                indices: new Set<number>(),
                pathNodes: [],
                attributes: [],
                sources: [],
            }

            stat.indices.add(descriptor.index)
            if (isPersistedValueNode(field.node)) {
                stat.pathNodes.push(field.node.$path)
                stat.attributes.push(field.node.attribute)
            } else if (isPersistedSourceNode(field.node)) {
                stat.sources.push('current_url')
            }

            keyStats.set(field.path, stat)
        }
    }

    const mergedFields: ConsolidatedArrayField[] = []

    for (const [fieldPath, stat] of keyStats) {
        if (stat.indices.size < threshold) continue

        if (stat.pathNodes.length >= threshold) {
            let mergedFieldPath: ElementPath | null = null
            if (stat.pathNodes.length === 1) {
                mergedFieldPath = sanitizeElementPath(stat.pathNodes[0]!)
            } else {
                mergedFieldPath = mergeElementPathsByMajority(stat.pathNodes)
            }

            if (!mergedFieldPath) continue

            if (clusterSize === 1) {
                mergedFieldPath = relaxPathForSingleSample(
                    mergedFieldPath,
                    'field'
                )
            }
            mergedFieldPath = minimizePathMatchClauses(
                mergedFieldPath,
                'field'
            )

            const attrThreshold =
                stat.pathNodes.length === 1
                    ? 1
                    : majorityThreshold(stat.pathNodes.length)

            mergedFields.push({
                path: fieldPath,
                node: createValueNode({
                    elementPath: mergedFieldPath,
                    attribute: pickModeString(stat.attributes, attrThreshold),
                }),
            })
            continue
        }

        const dominantSource = pickModeString(stat.sources, threshold)
        if (dominantSource === 'current_url') {
            mergedFields.push({
                path: fieldPath,
                node: createSourceNode('current_url'),
            })
        }
    }

    if (!mergedFields.length) return null

    mergedFields.sort((a, b) => a.path.localeCompare(b.path))

    return {
        itemParentPath: normalizedItemPath,
        fields: mergedFields,
    }
}

function minimizePathMatchClauses(
    path: ElementPath,
    mode: 'item-root' | 'field'
): ElementPath {
    const normalized = sanitizeElementPath(path)
    const nodes = normalized.nodes.map((node, index) => {
        const isLast = index === normalized.nodes.length - 1
        const attrs = node.attrs || {}

        const attrClauses = dedupeMatchClauses(
            (node.match || [])
                .filter((clause): clause is MatchClause => {
                    return clause?.kind === 'attr'
                })
                .map((clause) =>
                    normalizeAttrClauseForMinimization(clause, attrs)
                )
                .filter((clause): clause is MatchClause => !!clause)
        )

        const positionClauses = (node.match || []).filter(
            (clause): clause is MatchClause => clause?.kind === 'position'
        )

        let keptPositions: MatchClause[] = []
        if (!attrClauses.length) {
            keptPositions = pickMinimalPositionClauses(positionClauses)
        } else if (mode === 'item-root' && !isLast) {
            // Keep ancestry shape stable only when attrs are absent.
            keptPositions = []
        }

        let match = dedupeMatchClauses([...attrClauses, ...keptPositions])
        if (!match.length) {
            const seeded = seedMinimalAttrClause(attrs)
            if (seeded) {
                match = [seeded]
            } else {
                match = pickMinimalPositionClauses(positionClauses)
            }
        }

        return {
            ...node,
            attrs,
            match: match.sort(compareMatchClauses),
        }
    })

    return sanitizeElementPath({
        context: clonePathContext(normalized.context),
        nodes,
    })
}

function normalizeAttrClauseForMinimization(
    clause: MatchClause,
    attrs: Record<string, string>
): MatchClause | null {
    if (clause.kind !== 'attr') return null

    const key = String(clause.key || '').trim().toLowerCase()
    if (!key) return null
    if (!Object.hasOwn(attrs, key)) return null

    if (key === 'class') {
        const classValue = sanitizeClassValueForSelector(String(attrs.class || ''))
        if (!classValue) return null
        return {
            kind: 'attr',
            key: 'class',
            op: 'exact',
            value: classValue,
        }
    }

    return {
        kind: 'attr',
        key,
        op:
            clause.op === 'startsWith' || clause.op === 'contains'
                ? clause.op
                : 'exact',
        value:
            typeof clause.value === 'string' && clause.value.trim()
                ? clause.value
                : undefined,
    }
}

function pickMinimalPositionClauses(clauses: MatchClause[]): MatchClause[] {
    const nthOfType = clauses.find(
        (clause) => clause.kind === 'position' && clause.axis === 'nthOfType'
    )
    if (nthOfType) return [nthOfType]

    const nthChild = clauses.find(
        (clause) => clause.kind === 'position' && clause.axis === 'nthChild'
    )
    return nthChild ? [nthChild] : []
}

function seedMinimalAttrClause(attrs: Record<string, string>): MatchClause | null {
    const id = String(attrs.id || '').trim()
    if (id) {
        return {
            kind: 'attr',
            key: 'id',
            op: 'exact',
        }
    }

    const classValue = sanitizeClassValueForSelector(String(attrs.class || ''))
    if (classValue) {
        return {
            kind: 'attr',
            key: 'class',
            op: 'exact',
            value: classValue,
        }
    }

    for (const key of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
        const value = String(attrs[key] || '').trim()
        if (!value) continue
        return {
            kind: 'attr',
            key,
            op: 'exact',
        }
    }

    return null
}

function relaxPathForSingleSample(
    path: ElementPath,
    mode: 'item-root' | 'field'
): ElementPath {
    const normalized = sanitizeElementPath(path)

    const relaxedNodes = normalized.nodes.map((node, index) => {
        const isLast = index === normalized.nodes.length - 1
        const attrs = normalizeAttrsForSingleSample(node.attrs || {})

        const match = (node.match || [])
            .filter((clause) => {
                if (!clause || typeof clause !== 'object') return false

                if (clause.kind === 'position') {
                    if (mode === 'field') return false
                    return !isLast
                }

                const key = String(clause.key || '').trim().toLowerCase()
                if (!key) return false
                if (!shouldKeepAttrForSingleSample(key)) return false
                if (key === 'class') {
                    return typeof attrs.class === 'string' &&
                        attrs.class.trim().length > 0
                        ? true
                        : false
                }
                return Object.hasOwn(attrs, key)
            })
            .map((clause) => {
                if (clause.kind !== 'attr') return clause
                if (clause.key !== 'class') return clause

                return {
                    kind: 'attr',
                    key: 'class',
                    op: 'exact',
                    value: attrs.class,
                } as MatchClause
            })

        if (!match.length && typeof attrs.class === 'string' && attrs.class) {
            match.push({
                kind: 'attr',
                key: 'class',
                op: 'exact',
                value: attrs.class,
            })
        }

        return {
            ...node,
            attrs,
            match,
        }
    })

    return sanitizeElementPath({
        context: clonePathContext(normalized.context),
        nodes: relaxedNodes,
    })
}

function normalizeAttrsForSingleSample(
    attrs: Record<string, string>
): Record<string, string> {
    const out: Record<string, string> = {}

    for (const [rawKey, rawValue] of Object.entries(attrs || {})) {
        const key = String(rawKey || '').trim().toLowerCase()
        if (!key) continue

        if (!shouldKeepAttrForSingleSample(key)) continue

        let value = String(rawValue || '').trim()
        if (!value) continue

        if (key === 'class') {
            value = sanitizeClassValueForSelector(value)
            if (!value) continue
        }

        out[key] = value
    }

    return out
}

function shouldKeepAttrForSingleSample(key: string): boolean {
    if (!key) return false
    if (SINGLE_SAMPLE_DROP_ATTR_KEYS.has(key)) return false
    if (key.startsWith('data-') && !DATA_TEST_ATTR_KEYS.has(key)) {
        return false
    }
    return true
}

function buildPathStructureKey(path: ElementPath): string {
    const normalized = sanitizeElementPath(path)

    return stableStringify({
        context: (normalized.context || []).map((hop) => ({
            kind: hop.kind,
            host: (hop.host || []).map((node) => buildNodeStructure(node)),
        })),
        nodes: (normalized.nodes || []).map((node) => buildNodeStructure(node)),
    })
}

function buildNodeStructure(node: PathNode): Record<string, unknown> {
    const tag = String(node.tag || '*').toLowerCase()
    const attrs = node.attrs || {}
    const structuralAttrs: Record<string, string> = {}

    for (const [rawKey, rawValue] of Object.entries(attrs)) {
        const key = String(rawKey || '').trim().toLowerCase()
        if (!STRUCTURAL_ATTR_KEYS.has(key)) continue

        let value = String(rawValue || '').trim()
        if (!value) continue

        if (key === 'class') {
            value = normalizeClassValueForStructure(value)
            if (!value) continue
        }

        structuralAttrs[key] = value
    }

    const matchClauses = (node.match || [])
        .map((clause) => {
            if (clause.kind === 'position') {
                return `position:${clause.axis}`
            }
            return `attr:${String(clause.key || '').trim().toLowerCase()}`
        })
        .sort()

    return {
        tag,
        attrs: structuralAttrs,
        match: matchClauses,
        depthHint: Number(node.position?.nthOfType || 0) > 0 ? 'typed' : 'any',
    }
}

function sanitizeClassValueForSelector(value: string): string {
    return tokenizeStableClassValue(value).join(' ')
}

function normalizeClassValueForStructure(value: string): string {
    const tokens = tokenizeStableClassValue(value)
    if (!tokens.length) return ''
    return [...tokens].sort().join(' ')
}

function tokenizeStableClassValue(value: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []

    for (const token of String(value || '').split(/\s+/)) {
        const trimmed = token.trim()
        if (!trimmed) continue

        const normalized = trimmed.toLowerCase()
        if (VOLATILE_CLASS_TOKENS.has(normalized)) continue
        if (VOLATILE_LAZY_CLASS_TOKENS.has(normalized)) continue
        if (seen.has(trimmed)) continue

        seen.add(trimmed)
        out.push(trimmed)
    }

    return out
}

function buildVariantSortKey(descriptor: ConsolidatedArrayVariantDescriptor): string {
    const root = buildPathStructureKey(descriptor.itemParentPath)
    const fields = descriptor.fields
        .map((field) => {
            if (isPersistedSourceNode(field.node)) {
                return `${field.path}:source`
            }
            if (isPersistedValueNode(field.node)) {
                return `${field.path}:path:${buildPathStructureKey(field.node.$path)}:${String(field.node.attribute || '')}`
            }
            return `${field.path}:other`
        })
        .sort()
        .join('|')

    return `${root}::${fields}`
}

function createValueNode(selector: {
    elementPath: ElementPath
    attribute?: string
}): PersistedExtractValueNode {
    return {
        $path: cloneElementPath(selector.elementPath),
        attribute: selector.attribute,
    }
}

function createSourceNode(source: 'current_url'): PersistedExtractSourceNode {
    return {
        $source: source,
    }
}

function createNodeFromPersistableField(
    field: PersistableExtractField
): PersistedExtractNode {
    if (!isPersistablePathField(field)) {
        return createSourceNode('current_url')
    }

    return createValueNode({
        elementPath: field.path,
        attribute: field.attribute,
    })
}

function buildArrayItemNode(fields: ConsolidatedArrayField[]): PersistedExtractNode {
    if (!fields.length) {
        throw new Error(
            'Unable to build persisted array item descriptor: no fields were consolidated.'
        )
    }

    if (fields.length === 1 && String(fields[0]?.path || '').trim() === '') {
        return clonePersistedExtractNode(fields[0]!.node)
    }

    const node: PersistedExtractObjectNode = {}

    for (const field of fields) {
        const fieldPath = String(field.path || '').trim()
        if (!fieldPath) {
            throw new Error(
                'Unable to build persisted array item descriptor: mixed primitive and object field paths.'
            )
        }

        insertNodeAtPath(node, fieldPath, clonePersistedExtractNode(field.node))
    }

    return node
}

function insertNodeAtPath(
    root: PersistedExtractObjectNode,
    path: string,
    node: PersistedExtractNode
): void {
    const tokens = parseDataPath(path)
    if (!tokens || !tokens.length) {
        throw new Error(
            `Invalid persisted extraction path "${path}": expected a non-empty object path.`
        )
    }

    if (tokens.some((token) => token.kind === 'index')) {
        throw new Error(
            `Invalid persisted extraction path "${path}": nested array indices are not supported in cached descriptors.`
        )
    }

    let current: PersistedExtractObjectNode = root
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (token.kind !== 'prop') {
            throw new Error(
                `Invalid persisted extraction path "${path}": expected object segment.`
            )
        }

        const isLast = i === tokens.length - 1
        if (isLast) {
            const existing = current[token.key]
            if (existing) {
                throw new Error(
                    `Conflicting persisted extraction path "${path}" detected while building descriptor tree.`
                )
            }
            current[token.key] = node
            return
        }

        const next = current[token.key]
        if (!next) {
            const created: PersistedExtractObjectNode = {}
            current[token.key] = created
            current = created
            continue
        }

        if (!isPersistedObjectNode(next)) {
            throw new Error(
                `Conflicting persisted extraction path "${path}" detected at "${token.key}".`
            )
        }

        current = next
    }
}

function parseIndexedArrayFieldKey(
    key: string
): { arrayPath: string; index: number; fieldPath: string } | null {
    const tokens = parseDataPath(key)
    if (!tokens || !tokens.length) return null

    const firstArrayIndex = tokens.findIndex((token) => token.kind === 'index')
    if (firstArrayIndex <= 0) return null

    const indexToken = tokens[firstArrayIndex]
    if (!indexToken || indexToken.kind !== 'index') return null

    const arrayPathTokens = tokens.slice(0, firstArrayIndex)
    const arrayPath = encodeDataPath(arrayPathTokens)
    if (!arrayPath) return null

    return {
        arrayPath,
        index: indexToken.index,
        fieldPath: encodeDataPath(tokens.slice(firstArrayIndex + 1)),
    }
}

function buildItemRootForArrayIndex(
    entries: IndexedArrayField[]
): ElementPath | null {
    if (!entries.length) return null

    const paths = entries
        .map((entry) =>
            isPersistablePathField(entry.source)
                ? sanitizeElementPath(entry.source.path)
                : null
        )
        .filter((path): path is ElementPath => !!path)

    if (!paths.length) return null

    const prefixLength = getCommonPathPrefixLength(paths)
    if (prefixLength <= 0) return null

    const base = paths[0]
    if (!base) return null

    return sanitizeElementPath({
        context: clonePathContext(base.context),
        nodes: clonePathNodes(base.nodes.slice(0, prefixLength)),
    })
}

function getCommonPathPrefixLength(paths: ElementPath[]): number {
    if (!paths.length) return 0

    const nodeChains = paths.map((path) => path.nodes)
    const minLength = Math.min(...nodeChains.map((nodes) => nodes.length))
    if (!Number.isFinite(minLength) || minLength <= 0) return 0

    for (let i = 0; i < minLength; i++) {
        const first = nodeChains[0]?.[i]
        if (!first) return i

        for (let j = 1; j < nodeChains.length; j++) {
            const candidate = nodeChains[j]?.[i]
            if (!candidate || !arePathNodesEquivalent(first, candidate)) {
                return i
            }
        }
    }

    return minLength
}

function arePathNodesEquivalent(a: PathNode, b: PathNode): boolean {
    if (
        String(a.tag || '*').toLowerCase() !==
        String(b.tag || '*').toLowerCase()
    ) {
        return false
    }

    if (
        Number(a.position?.nthChild || 0) !== Number(b.position?.nthChild || 0)
    ) {
        return false
    }

    if (
        Number(a.position?.nthOfType || 0) !==
        Number(b.position?.nthOfType || 0)
    ) {
        return false
    }

    const aId = String(a.attrs?.id || '')
    const bId = String(b.attrs?.id || '')
    if ((aId || bId) && aId !== bId) return false

    const aClass = String(a.attrs?.class || '')
    const bClass = String(b.attrs?.class || '')
    if ((aClass || bClass) && aClass !== bClass) return false

    return true
}

function toRelativeElementPath(
    absolute: ElementPath,
    root: ElementPath
): ElementPath | null {
    const normalizedAbsolute = sanitizeElementPath(absolute)
    const normalizedRoot = sanitizeElementPath(root)

    if (
        stableStringify(normalizedAbsolute.context) !==
        stableStringify(normalizedRoot.context)
    ) {
        return null
    }

    const absoluteNodes = normalizedAbsolute.nodes
    const rootNodes = normalizedRoot.nodes
    if (rootNodes.length > absoluteNodes.length) return null

    for (let i = 0; i < rootNodes.length; i++) {
        const absNode = absoluteNodes[i]
        const rootNode = rootNodes[i]
        if (!absNode || !rootNode) return null

        if (!arePathNodesEquivalent(absNode, rootNode)) {
            return null
        }
    }

    return {
        context: [],
        nodes: clonePathNodes(absoluteNodes.slice(rootNodes.length)),
    }
}

function mergeElementPathsByMajority(paths: ElementPath[]): ElementPath | null {
    if (!paths.length) return null

    const normalized = paths.map((path) => sanitizeElementPath(path))
    const contextKey = pickModeString(
        normalized.map((path) => stableStringify(path.context)),
        1
    )
    if (!contextKey) return null

    const sameContext = normalized.filter(
        (path) => stableStringify(path.context) === contextKey
    )
    if (!sameContext.length) return null

    const targetLength =
        pickModeNumber(
            sameContext.map((path) => path.nodes.length),
            1
        ) ??
        sameContext[0]?.nodes.length ??
        0

    const aligned = sameContext.filter(
        (path) => path.nodes.length === targetLength
    )
    if (!aligned.length) return null

    const threshold = majorityThreshold(aligned.length)
    const nodes: PathNode[] = []

    for (let i = 0; i < targetLength; i++) {
        const nodesAtIndex = aligned
            .map((path) => path.nodes[i])
            .filter((node): node is PathNode => !!node)
        if (!nodesAtIndex.length) return null
        nodes.push(mergePathNodeByMajority(nodesAtIndex, threshold))
    }

    return sanitizeElementPath({
        context: clonePathContext(sameContext[0]?.context || []),
        nodes,
    })
}

function mergePathNodeByMajority(nodes: PathNode[], threshold: number): PathNode {
    const tag =
        pickModeString(
            nodes.map((node) => String(node.tag || '*').toLowerCase()),
            threshold
        ) || '*'

    const attrs = mergeAttributesByMajority(
        nodes.map((node) => node.attrs || {}),
        threshold
    )

    const mergedPosition = mergePositionByMajority(
        nodes.map((node) => node.position),
        threshold
    )

    const match = mergeMatchByMajority(
        nodes.map((node) => node.match || []),
        attrs,
        threshold,
        {
            hasNthChild: mergedPosition.hasNthChild,
            hasNthOfType: mergedPosition.hasNthOfType,
        }
    )

    return {
        tag,
        attrs,
        position: mergedPosition.position,
        match,
    }
}

function mergeAttributesByMajority(
    attrsList: Array<Record<string, string>>,
    threshold: number
): Record<string, string> {
    const keys = new Set<string>()
    for (const attrs of attrsList) {
        for (const key of Object.keys(attrs || {})) {
            keys.add(key)
        }
    }

    const out: Record<string, string> = {}
    for (const key of keys) {
        const value = pickModeString(
            attrsList.map((attrs) =>
                attrs && typeof attrs[key] === 'string' ? attrs[key] : undefined
            ),
            threshold
        )
        if (!value) continue
        out[key] = value
    }

    return out
}

function mergePositionByMajority(
    positions: Array<PathNode['position'] | undefined>,
    threshold: number
): {
    position: PathNode['position']
    hasNthChild: boolean
    hasNthOfType: boolean
} {
    const nthChild = pickModeNumber(
        positions.map((position) => position?.nthChild),
        threshold
    )

    const nthOfType = pickModeNumber(
        positions.map((position) => position?.nthOfType),
        threshold
    )

    return {
        position: {
            nthChild: nthChild ?? 1,
            nthOfType: nthOfType ?? 1,
        },
        hasNthChild: nthChild != null,
        hasNthOfType: nthOfType != null,
    }
}

function mergeMatchByMajority(
    matchLists: MatchClause[][],
    attrs: Record<string, string>,
    threshold: number,
    positionFlags: { hasNthChild: boolean; hasNthOfType: boolean } = {
        hasNthChild: true,
        hasNthOfType: true,
    }
): MatchClause[] {
    const counts = new Map<string, number>()

    for (const list of matchLists) {
        const unique = new Set<string>()
        for (const clause of list || []) {
            if (!clause || typeof clause !== 'object') continue
            unique.add(JSON.stringify(clause))
        }
        for (const key of unique) {
            counts.set(key, (counts.get(key) || 0) + 1)
        }
    }

    const merged: MatchClause[] = []

    for (const [encoded, count] of counts) {
        if (count < threshold) continue

        let clause: MatchClause | null = null
        try {
            clause = JSON.parse(encoded) as MatchClause
        } catch {
            clause = null
        }

        if (!clause) continue

        if (clause.kind === 'attr') {
            const key = String(clause.key || '').trim()
            if (!key) continue
            if (clause.value === undefined && attrs[key] === undefined) continue

            merged.push({
                kind: 'attr',
                key,
                op:
                    clause.op === 'startsWith' || clause.op === 'contains'
                        ? clause.op
                        : 'exact',
                value: clause.value,
            })
            continue
        }

        if (clause.axis === 'nthOfType') {
            if (!positionFlags.hasNthOfType) continue
            merged.push({ kind: 'position', axis: 'nthOfType' })
            continue
        }

        if (!positionFlags.hasNthChild) continue
        merged.push({ kind: 'position', axis: 'nthChild' })
    }

    if (!merged.length) {
        if (attrs.id) {
            merged.push({ kind: 'attr', key: 'id', op: 'exact' })
        }
        if (attrs.class) {
            merged.push({
                kind: 'attr',
                key: 'class',
                op: 'exact',
                value: attrs.class,
            })
        }
    }

    merged.sort(compareMatchClauses)
    return dedupeMatchClauses(merged)
}

function compareMatchClauses(a: MatchClause, b: MatchClause): number {
    if (a.kind !== b.kind) {
        return a.kind === 'attr' ? -1 : 1
    }

    if (a.kind === 'position' && b.kind === 'position') {
        if (a.axis === b.axis) return 0
        return a.axis === 'nthOfType' ? -1 : 1
    }

    if (a.kind === 'attr' && b.kind === 'attr') {
        const rank = (key: string): number => {
            if (key === 'id') return 0
            if (key === 'class') return 1
            return 2
        }

        const left = rank(a.key)
        const right = rank(b.key)
        if (left !== right) return left - right
        return a.key.localeCompare(b.key)
    }

    return 0
}

function dedupeMatchClauses(clauses: MatchClause[]): MatchClause[] {
    const seen = new Set<string>()
    const out: MatchClause[] = []

    for (const clause of clauses) {
        const key = JSON.stringify(clause)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(clause)
    }

    return out
}

function majorityThreshold(count: number): number {
    return Math.floor(count / 2) + 1
}

function pickModeString(
    values: Array<string | undefined>,
    minCount: number
): string | undefined {
    const counts = new Map<string, number>()
    let best: string | undefined = undefined
    let bestCount = 0

    for (const value of values) {
        if (value == null || value === '') continue
        const count = (counts.get(value) || 0) + 1
        counts.set(value, count)

        if (count > bestCount) {
            best = value
            bestCount = count
        }
    }

    if (best == null || bestCount < minCount) return undefined
    return best
}

function pickModeNumber(
    values: Array<number | undefined>,
    minCount: number
): number | undefined {
    const counts = new Map<number, number>()
    let best: number | undefined = undefined
    let bestCount = 0

    for (const value of values) {
        if (!Number.isFinite(value) || value == null) continue
        const normalized = Math.trunc(value)
        if (normalized <= 0) continue

        const count = (counts.get(normalized) || 0) + 1
        counts.set(normalized, count)

        if (count > bestCount) {
            best = normalized
            bestCount = count
        }
    }

    if (best == null || bestCount < minCount) return undefined
    return best
}

function clonePathContext(
    context: ElementPath['context']
): ElementPath['context'] {
    return JSON.parse(JSON.stringify(context || [])) as ElementPath['context']
}

function clonePathNodes(nodes: PathNode[]): PathNode[] {
    return JSON.parse(JSON.stringify(nodes || [])) as PathNode[]
}

function clonePersistedExtractNode(
    node: PersistedExtractNode
): PersistedExtractNode {
    return JSON.parse(JSON.stringify(node)) as PersistedExtractNode
}
