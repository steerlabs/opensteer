import * as cheerio from 'cheerio'
import type { Frame, Page } from 'playwright'
import { cloneElementPath, sanitizeElementPath } from '../element-path/build.js'
import {
    DEFERRED_MATCH_ATTR_KEYS,
    MATCH_ATTRIBUTE_PRIORITY,
    STABLE_PRIMARY_ATTR_KEYS,
} from '../element-path/match-policy.js'
import type { ContextHop, ElementPath } from '../element-path/types.js'
import { ENSURE_NAME_SHIM_SCRIPT, OV_FRAME_TOKEN_KEY, OV_INSTANCE_TOKEN_KEY } from './runtime-keys.js'

export const OV_NODE_ID_ATTR = 'data-ov-node-id'
export const OV_BOUNDARY_ATTR = 'data-ov-boundary'
export const OV_UNAVAILABLE_ATTR = 'data-ov-unavailable'
export const OV_IFRAME_BOUNDARY_TAG = 'ov-iframe-root'
export const OV_SHADOW_BOUNDARY_TAG = 'ov-shadow-root'

export interface SerializeOptions {
    detectOverlays?: boolean
}

export interface SerializedPageHTML {
    html: string
    nodePaths: Map<string, ElementPath>
    nodeMeta: Map<string, SerializedNodeMeta>
}

interface BrowserFrameSnapshot {
    html: string
    frameToken: string
    entries: Array<{
        nodeId: string
        path: BrowserSerializedElementPath
        instanceToken: string
    }>
}

interface SerializedPathNode {
    tag: string
    attrs: Record<string, string>
    position: {
        nthChild: number
        nthOfType: number
    }
    match: Array<
        | { kind: 'attr'; key: string; op?: 'exact'; value?: string }
        | { kind: 'position'; axis: 'nthOfType' | 'nthChild' }
    >
}

type SerializedDomPath = SerializedPathNode[]

interface BrowserSerializedElementPath {
    context: Array<{ kind: 'shadow'; host: SerializedDomPath }>
    nodes: SerializedDomPath
}

export interface SerializedNodeMeta {
    frameToken: string
    instanceToken: string
}

interface FrameSerializeResult {
    html: string
    nodePaths: Map<string, ElementPath>
    nodeMeta: Map<string, SerializedNodeMeta>
}

export async function serializePageHTML(
    page: Page,
    _options: SerializeOptions = {}
): Promise<SerializedPageHTML> {
    return serializeFrameRecursive(page.mainFrame(), [], 'f0')
}

async function serializeFrameRecursive(
    frame: Frame,
    baseContext: ContextHop[],
    frameKey: string
): Promise<FrameSerializeResult> {
    await frame.evaluate(ENSURE_NAME_SHIM_SCRIPT)

    const frameSnapshot = await frame.evaluate(
        ({
            frameKey,
            nodeAttr,
            shadowTag,
            boundaryAttr,
            frameTokenKey,
            instanceTokenKey,
            matchAttributePriority,
            stablePrimaryAttrKeys,
            deferredMatchAttrKeys,
        }) => {
            // tsx/esbuild can inject __name(...) helpers into function bodies.
            // Browser-evaluated scripts don't have that helper, so provide a local shim.
            function __name<T>(value: T): T {
                return value
            }

            const ATTRIBUTE_DENY_KEYS = new Set([
                'style',
                'nonce',
                'integrity',
                'crossorigin',
                'referrerpolicy',
                'autocomplete',
            ])

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

            const MAX_ATTRIBUTE_VALUE_LENGTH = 300
            const ATTRIBUTE_PRIORITY: string[] = Array.isArray(
                matchAttributePriority
            )
                ? matchAttributePriority.map((key) => String(key))
                : []
            const STABLE_PRIMARY_ATTR_KEY_SET = new Set<string>(
                (Array.isArray(stablePrimaryAttrKeys)
                    ? stablePrimaryAttrKeys
                    : []
                ).map((key) => String(key))
            )
            const DEFERRED_MATCH_ATTR_KEY_SET = new Set<string>(
                (Array.isArray(deferredMatchAttrKeys)
                    ? deferredMatchAttrKeys
                    : []
                ).map((key) => String(key))
            )

            let counter = 1
            const entries: Array<{
                nodeId: string
                path: BrowserSerializedElementPath
                instanceToken: string
            }> = []

            const helpers = {
                nextToken(): string {
                    const fromCrypto = globalThis.crypto?.randomUUID?.()
                    if (typeof fromCrypto === 'string' && fromCrypto.length) {
                        return `ov_${fromCrypto}`
                    }
                    return `ov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
                },

                escapeHtml(value: string): string {
                    return value
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                },

                escapeAttr(value: string): string {
                    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                },

                isValidAttrKey(key: string): boolean {
                    const normalized = String(key || '').trim()
                    if (!normalized) return false
                    if (/[\s"'<>/]/.test(normalized)) return false
                    return /^[A-Za-z_][A-Za-z0-9_:\-.]*$/.test(normalized)
                },

                isMediaTag(tag: string): boolean {
                    return LAZY_LOADING_MEDIA_TAGS.has(
                        String(tag || '').toLowerCase()
                    )
                },

                shouldKeepPathAttr(
                    tag: string,
                    name: string,
                    value: string
                ): boolean {
                    const key = String(name || '')
                        .trim()
                        .toLowerCase()
                    const val = String(value || '')
                    if (!key || !val.trim()) return false
                    if (val.length > MAX_ATTRIBUTE_VALUE_LENGTH) return false
                    if (!helpers.isValidAttrKey(name)) return false
                    if (key === 'c') return false
                    if (/^on[a-z]/i.test(key)) return false
                    if (ATTRIBUTE_DENY_KEYS.has(key)) return false
                    if (key.startsWith('data-ov-')) return false
                    if (key.startsWith('data-opensteer-')) return false
                    if (
                        helpers.isMediaTag(tag) &&
                        VOLATILE_LAZY_LOADING_ATTRS.has(key)
                    ) {
                        return false
                    }
                    return true
                },

                collectPathAttrs(node: Element): Record<string, string> {
                    const out: Record<string, string> = {}
                    const tag = node.tagName.toLowerCase()
                    for (const attr of Array.from(node.attributes)) {
                        if (
                            !helpers.shouldKeepPathAttr(
                                tag,
                                attr.name,
                                attr.value
                            )
                        ) {
                            continue
                        }
                        out[attr.name] = attr.value
                    }
                    return out
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

                isIdLikeAttributeKey(rawKey: string): boolean {
                    const key = String(rawKey || '').trim().toLowerCase()
                    if (!key) return false
                    if (key === 'id') return true
                    return /(?:^|[-_:])id$/.test(key)
                },

                shouldDeferMatchAttribute(rawKey: string): boolean {
                    const key = String(rawKey || '').trim().toLowerCase()
                    if (!key || key === 'class') return false
                    if (helpers.isIdLikeAttributeKey(key)) return true
                    if (DEFERRED_MATCH_ATTR_KEY_SET.has(key)) return true
                    if (
                        key.startsWith('data-') &&
                        !STABLE_PRIMARY_ATTR_KEY_SET.has(key)
                    )
                        return true
                    return !STABLE_PRIMARY_ATTR_KEY_SET.has(key)
                },

                buildMatchClausePool(
                    attrs: Record<string, string>
                ): SerializedPathNode['match'] {
                    const out: SerializedPathNode['match'] = []
                    const deferred: SerializedPathNode['match'] = []
                    const seen = new Set<string>()

                    const push = (
                        clause: SerializedPathNode['match'][number]
                    ) => {
                        const key = JSON.stringify(clause)
                        if (seen.has(key)) return
                        seen.add(key)
                        out.push(clause)
                    }

                    const classValue = String(attrs.class || '').trim()
                    if (classValue) {
                        push({
                            kind: 'attr',
                            key: 'class',
                            op: 'exact',
                            value: classValue,
                        })
                    }

                    for (const key of helpers.sortAttributeKeys(
                        Object.keys(attrs || {})
                    )) {
                        if (key === 'class') continue
                        const value = String(attrs[key] || '').trim()
                        if (!value) continue
                        const clause = {
                            kind: 'attr',
                            key,
                            op: 'exact',
                        } as const
                        if (helpers.shouldDeferMatchAttribute(key)) {
                            deferred.push(clause)
                            continue
                        }
                        push(clause)
                    }

                    push({
                        kind: 'position',
                        axis: 'nthOfType',
                    })
                    push({
                        kind: 'position',
                        axis: 'nthChild',
                    })

                    const hasPrimary = out.some(
                        (clause) => clause.kind === 'attr'
                    )

                    if (!hasPrimary) {
                        for (const clause of deferred) {
                            push(clause)
                        }
                    }

                    return out
                },

                getSiblings(
                    node: Element,
                    root: Document | ShadowRoot
                ): Element[] {
                    if (node.parentElement) {
                        return Array.from(node.parentElement.children)
                    }
                    if (root instanceof ShadowRoot) {
                        return Array.from(root.children)
                    }
                    return Array.from(root.children)
                },

                toNode(
                    node: Element,
                    root: Document | ShadowRoot
                ): SerializedPathNode {
                    const siblings = helpers.getSiblings(node, root)
                    const tag = node.tagName.toLowerCase()
                    const sameTag = siblings.filter(
                        (el) => el.tagName.toLowerCase() === tag
                    )
                    const position = {
                        nthChild: siblings.indexOf(node) + 1,
                        nthOfType: sameTag.indexOf(node) + 1,
                    }

                    const attrs = helpers.collectPathAttrs(node)
                    const match = helpers.buildMatchClausePool(attrs)

                    return {
                        tag,
                        attrs,
                        position,
                        match,
                    }
                },

                buildDomPath(
                    node: Element,
                    root: Document | ShadowRoot
                ): SerializedDomPath {
                    const chain: Element[] = []
                    let current: Element | null = node
                    while (current) {
                        chain.push(current)
                        const parentEl: Element | null = current.parentElement
                        if (parentEl) {
                            current = parentEl
                            continue
                        }
                        break
                    }
                    chain.reverse()
                    return chain.map((el) => helpers.toNode(el, root))
                },

                buildElementPath(node: Element): BrowserSerializedElementPath {
                    const context: Array<{
                        kind: 'shadow'
                        host: SerializedDomPath
                    }> = []

                    const targetRoot = node.getRootNode()
                    const initialRoot =
                        targetRoot instanceof ShadowRoot ? targetRoot : document
                    const target = helpers.buildDomPath(node, initialRoot)

                    let currentRoot: Document | ShadowRoot = initialRoot
                    while (currentRoot instanceof ShadowRoot) {
                        const host = currentRoot.host
                        const hostRoot = host.getRootNode()
                        const normalizedHostRoot =
                            hostRoot instanceof ShadowRoot ? hostRoot : document
                        const hostPath = helpers.buildDomPath(
                            host,
                            normalizedHostRoot
                        )
                        context.unshift({ kind: 'shadow', host: hostPath })
                        currentRoot = normalizedHostRoot
                    }

                    return {
                        context,
                        nodes: target,
                    }
                },

                ensureNodeId(el: Element): string {
                    const next = `${frameKey}_${counter++}`
                    el.setAttribute(nodeAttr, next)
                    return next
                },

                setInstanceToken(el: Element): string {
                    const token = helpers.nextToken()
                    Object.defineProperty(el, instanceTokenKey, {
                        value: token,
                        writable: true,
                        configurable: true,
                    })
                    return token
                },

                serializeChildren(children: NodeListOf<ChildNode>): string {
                    let html = ''
                    for (const child of Array.from(children)) {
                        if (child.nodeType === Node.TEXT_NODE) {
                            html += helpers.escapeHtml(child.textContent || '')
                            continue
                        }
                        if (child.nodeType !== Node.ELEMENT_NODE) continue
                        html += helpers.serializeElement(child as Element)
                    }
                    return html
                },

                serializeElement(el: Element): string {
                    const nodeId = helpers.ensureNodeId(el)
                    const instanceToken = helpers.setInstanceToken(el)
                    entries.push({
                        nodeId,
                        path: helpers.buildElementPath(el),
                        instanceToken,
                    })

                    const tag = el.tagName.toLowerCase()
                    const attrPairs: string[] = []
                    for (const attr of Array.from(el.attributes)) {
                        attrPairs.push(
                            `${attr.name}="${helpers.escapeAttr(attr.value)}"`
                        )
                    }

                    let out = `<${tag}${attrPairs.length ? ` ${attrPairs.join(' ')}` : ''}>`

                    if (el.shadowRoot) {
                        out += `<${shadowTag} ${boundaryAttr}="shadow">`
                        out += helpers.serializeChildren(
                            el.shadowRoot.childNodes
                        )
                        out += `</${shadowTag}>`
                    }

                    out += helpers.serializeChildren(el.childNodes)
                    out += `</${tag}>`
                    return out
                },
            }

            const win = window as unknown as Record<string, unknown>
            const frameToken =
                (typeof win[frameTokenKey] === 'string'
                    ? (win[frameTokenKey] as string)
                    : '') || helpers.nextToken()
            win[frameTokenKey] = frameToken

            const root = document.documentElement
            if (!root) {
                return { html: '', frameToken, entries }
            }

            return {
                html: helpers.serializeElement(root),
                frameToken,
                entries,
            }
        },
        {
            frameKey,
            nodeAttr: OV_NODE_ID_ATTR,
            shadowTag: OV_SHADOW_BOUNDARY_TAG,
            boundaryAttr: OV_BOUNDARY_ATTR,
            frameTokenKey: OV_FRAME_TOKEN_KEY,
            instanceTokenKey: OV_INSTANCE_TOKEN_KEY,
            matchAttributePriority: [...MATCH_ATTRIBUTE_PRIORITY],
            stablePrimaryAttrKeys: [...STABLE_PRIMARY_ATTR_KEYS],
            deferredMatchAttrKeys: [...DEFERRED_MATCH_ATTR_KEYS],
        }
    )

    const nodePaths = new Map<string, ElementPath>()
    const nodeMeta = new Map<string, SerializedNodeMeta>()
    for (const entry of frameSnapshot.entries) {
        nodePaths.set(entry.nodeId, {
            context: [
                ...baseContext,
                ...(entry.path.context || []),
            ] as ContextHop[],
            nodes: entry.path.nodes,
        })
        nodeMeta.set(entry.nodeId, {
            frameToken: frameSnapshot.frameToken,
            instanceToken: entry.instanceToken,
        })
    }

    const $ = cheerio.load(frameSnapshot.html, { xmlMode: false })

    const childFrames = frame.childFrames()
    for (let i = 0; i < childFrames.length; i++) {
        const child = childFrames[i]

        let hostNodeId: string | null = null
        try {
            const frameEl = await child.frameElement()
            hostNodeId = await frameEl.getAttribute(OV_NODE_ID_ATTR)
            await frameEl.dispose()
        } catch {
            hostNodeId = null
        }

        if (!hostNodeId) continue

        const hostPath = nodePaths.get(hostNodeId)
        if (!hostPath) continue

        const childBaseContext: ContextHop[] = [
            ...hostPath.context,
            {
                kind: 'iframe',
                host: cloneElementPath(hostPath).nodes,
            },
        ]

        const hostEl = $(`[${OV_NODE_ID_ATTR}="${hostNodeId}"]`).first()
        if (!hostEl.length) continue

        try {
            const childResult = await serializeFrameRecursive(
                child,
                childBaseContext,
                `${frameKey}_${i}`
            )

            hostEl.after(
                `<${OV_IFRAME_BOUNDARY_TAG} ${OV_BOUNDARY_ATTR}="iframe">${childResult.html}</${OV_IFRAME_BOUNDARY_TAG}>`
            )

            for (const [nodeId, path] of childResult.nodePaths.entries()) {
                nodePaths.set(nodeId, path)
            }
            for (const [nodeId, meta] of childResult.nodeMeta.entries()) {
                nodeMeta.set(nodeId, meta)
            }
        } catch {
            hostEl.after(
                `<${OV_IFRAME_BOUNDARY_TAG} ${OV_BOUNDARY_ATTR}="iframe" ${OV_UNAVAILABLE_ATTR}="ERR_PATH_IFRAME_UNAVAILABLE"></${OV_IFRAME_BOUNDARY_TAG}>`
            )
        }
    }

    const sanitizedPaths = new Map<string, ElementPath>()
    for (const [nodeId, path] of nodePaths.entries()) {
        sanitizedPaths.set(nodeId, sanitizeElementPath(path))
    }

    return {
        html: $.html(),
        nodePaths: sanitizedPaths,
        nodeMeta,
    }
}
