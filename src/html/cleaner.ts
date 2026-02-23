import * as cheerio from 'cheerio'
import type { CheerioAPI, Cheerio } from 'cheerio'
import type { AnyNode, Element } from 'domhandler'
import {
    OPENSTEER_HIDDEN_ATTR,
    OPENSTEER_INTERACTIVE_ATTR,
    OPENSTEER_SCROLLABLE_ATTR,
} from './interactivity.js'
import {
    OS_BOUNDARY_ATTR,
    OS_IFRAME_BOUNDARY_TAG,
    OS_NODE_ID_ATTR,
    OS_SHADOW_BOUNDARY_TAG,
    OS_UNAVAILABLE_ATTR,
} from './serializer.js'

const STRIP_TAGS = new Set([
    'script',
    'style',
    'noscript',
    'meta',
    'link',
    'template',
])
const ROOT_TAGS = new Set(['html', 'body'])
const BOUNDARY_TAGS = new Set([OS_IFRAME_BOUNDARY_TAG, OS_SHADOW_BOUNDARY_TAG])

const TEXT_ATTR_MAX = 150
const URL_ATTR_MAX = 500

const NOISE_SELECTORS = [
    `[${OPENSTEER_HIDDEN_ATTR}]`,
    '[hidden]',
    "[style*='display: none']",
    "[style*='display:none']",
    "[style*='visibility: hidden']",
    "[style*='visibility:hidden']",
]

const VOID_TAGS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
])

interface ClickableContext {
    hasPreMarked: boolean
}

function isBoundaryTag(tag: string): boolean {
    return BOUNDARY_TAGS.has(tag)
}

function compactHtml(html: string): string {
    return html
        .replace(/<!--.*?-->/gs, '')
        .replace(/>\s+</g, '><')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('\n')
        .replace(/\n\s*\n/g, '\n')
        .trim()
}

function truncateValue(value: string, max: number): string {
    if (value.length <= max) return value
    return value.slice(0, max)
}

function removeNoise($: CheerioAPI): void {
    STRIP_TAGS.forEach((tag) => {
        $(tag).remove()
    })

    $(NOISE_SELECTORS.join(', ')).remove()
}

function removeComments($: CheerioAPI): void {
    $('*')
        .contents()
        .each(function (this: AnyNode) {
            if (this.type === 'comment') {
                $(this).remove()
            }
        })
}

function hasDirectText($: CheerioAPI, el: Cheerio<Element>): boolean {
    return (
        el.contents().filter(function (this: AnyNode) {
            return this.type === 'text' && $(this).text().trim() !== ''
        }).length > 0
    )
}

function hasTextDeep(el: Cheerio<Element>): boolean {
    return el.text().trim().length > 0
}

function isClickable(
    $: CheerioAPI,
    el: Cheerio<Element>,
    context: ClickableContext
): boolean {
    if (context.hasPreMarked) {
        return el.attr(OPENSTEER_INTERACTIVE_ATTR) !== undefined
    }

    const tag = ((el[0] as Element | undefined)?.tagName || '').toLowerCase()
    if (!tag || ROOT_TAGS.has(tag)) return false

    if (new Set(['a', 'button', 'input', 'select', 'textarea']).has(tag)) {
        if (tag === 'input') {
            const inputType = String(el.attr('type') || '').toLowerCase()
            if (inputType === 'hidden') return false
        }
        return true
    }

    const attrs = el.attr() || {}

    if (attrs.onclick !== undefined) return true
    if (attrs.onmousedown !== undefined) return true
    if (attrs.onmouseup !== undefined) return true
    if (attrs['data-action'] !== undefined) return true
    if (attrs['data-click'] !== undefined) return true
    if (attrs['data-toggle'] !== undefined) return true

    if (attrs.tabindex !== undefined) {
        const tabIndex = Number.parseInt(String(attrs.tabindex), 10)
        if (!Number.isNaN(tabIndex) && tabIndex >= 0) return true
    }

    const role = String(attrs.role || '').toLowerCase()
    if (
        [
            'button',
            'link',
            'menuitem',
            'option',
            'radio',
            'checkbox',
            'tab',
            'textbox',
            'combobox',
            'slider',
            'spinbutton',
            'search',
            'searchbox',
        ].includes(role)
    ) {
        return true
    }

    const className = String(attrs.class || '').toLowerCase()
    const id = String(attrs.id || '').toLowerCase()
    const searchTokens = [
        'search',
        'magnify',
        'glass',
        'lookup',
        'find',
        'query',
    ]
    if (
        searchTokens.some(
            (token) => className.includes(token) || id.includes(token)
        )
    ) {
        return true
    }

    return false
}

function stripToAttrs(el: Cheerio<Element>, keep: Set<string>): void {
    const attrs = el.attr() || {}
    Object.keys(attrs).forEach((attr) => {
        if (!keep.has(attr)) {
            el.removeAttr(attr)
            return
        }

        const value = el.attr(attr)
        if (typeof value !== 'string') return

        if (attr === 'href' || attr === 'src' || attr === 'srcset') {
            el.attr(attr, truncateValue(value, URL_ATTR_MAX))
            return
        }

        if (
            attr === 'alt' ||
            attr === 'title' ||
            attr === 'aria-label' ||
            attr === 'placeholder' ||
            attr === 'value'
        ) {
            el.attr(attr, truncateValue(value, TEXT_ATTR_MAX))
        }
    })
}

function deduplicateImages(html: string): string {
    const seen = new Set<string>()

    return html.replace(/<img\b([^>]*)>/gi, (full, attrContent) => {
        const srcMatch = attrContent.match(/\bsrc\s*=\s*(["']?)(.*?)\1/)
        const srcsetMatch = attrContent.match(/\bsrcset\s*=\s*(["'])(.*?)\1/)

        let src: string | null = null
        if (srcMatch && srcMatch[2]) {
            src = srcMatch[2].trim()
        } else if (srcsetMatch && srcsetMatch[2]) {
            src = srcsetMatch[2].split(',')[0]?.trim().split(' ')[0] || null
        }

        if (!src) return full
        if (seen.has(src)) return ''
        seen.add(src)
        return full
    })
}

/**
 * Check whether an element should be preserved as an image element during
 * extraction flattening. Matches the server's shouldPreserveImageElement
 * with leaveImage=true.
 */
function isPreservedImageElement(
    $: CheerioAPI,
    el: Cheerio<Element>
): boolean {
    const tag = ((el[0] as Element | undefined)?.tagName || '').toLowerCase()
    if (tag === 'img') return true
    if (tag === 'picture') {
        const hasImg = el.find('img').length > 0
        const hasSource = el.find('source[src], source[srcset]').length > 0
        return hasImg || hasSource
    }
    if (tag === 'source') {
        const inPicture = el.parents('picture').length > 0
        const hasSrc =
            (el.attr('src') != null && el.attr('src')!.trim() !== '') ||
            (el.attr('srcset') != null && el.attr('srcset')!.trim() !== '')
        return inPicture && hasSrc
    }
    return false
}

/**
 * Flatten extraction tree preserving images and links. Matches the server's
 * flattenStructureWithLinks (leaveImage=true, leaveLinks=true).
 *
 * - Image elements (img, picture, source-in-picture) are always preserved.
 * - <a> elements are always preserved (recursively flatten their children).
 * - Other elements with direct text content are kept.
 * - Empty leaf elements are removed.
 * - Wrapper elements without direct text are replaced by their contents.
 */
function flattenExtractionTree($: CheerioAPI): void {
    const flatten = (root: Cheerio<AnyNode>): void => {
        root.find('*').each(function () {
            const el = $(this as Element)
            const node = el[0]
            if (!node) return

            const tag = (node.tagName || '').toLowerCase()
            if (ROOT_TAGS.has(tag)) return
            if (isBoundaryTag(tag)) return

            // Always preserve image elements
            if (isPreservedImageElement($, el)) return

            // Always preserve <a> elements (leaveLinks=true), recurse children
            if (tag === 'a') {
                el.children().each(function () {
                    flatten($(this as Element))
                })
                return
            }

            const hasText = hasDirectText($, el)
            if (hasText) {
                // Keep elements with direct text, recurse into children
            } else if (el.children().length === 0) {
                el.remove()
            } else {
                el.children().each(function () {
                    flatten($(this as Element))
                })
                el.replaceWith(el.contents())
            }
        })
    }

    flatten($.root())
}

/**
 * Compact LLM-friendly serializer. Produces indented output that skips
 * html/head/body wrappers, inlines short single-text children, and
 * collapses whitespace. Ported from the server's serializeCheerioToLlmString.
 */
function serializeForExtraction($: CheerioAPI, root: AnyNode): string {
    const lines: string[] = []

    function escapeHtml(str: string): string {
        if (!str) return ''
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
    }

    function escapeAttribute(value: string): string {
        if (!value) return ''
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
    }

    function traverse(node: AnyNode, depth: number): void {
        if (!node) return

        if (node.type === 'text') {
            const text = ((node as unknown as { data?: string }).data || '')
                .replace(/\s+/g, ' ')
                .trim()
            if (text) {
                lines.push('  '.repeat(depth) + escapeHtml(text))
            }
            return
        }

        if (node.type === 'comment') return

        if (
            node.type === 'tag' ||
            node.type === 'script' ||
            node.type === 'style'
        ) {
            const tagName = (node as Element).tagName || (node as Element).name
            if (!tagName) return

            // Skip html/head/body wrappers, process their children
            if (
                tagName === 'html' ||
                tagName === 'head' ||
                tagName === 'body'
            ) {
                for (const child of (node as Element).children || []) {
                    traverse(child as AnyNode, depth)
                }
                return
            }

            const attributes = (node as Element).attribs || {}
            let attrStr = ''
            const keys = Object.keys(attributes)
            if (keys.length > 0) {
                attrStr =
                    ' ' +
                    keys
                        .map((key) => `${key}="${escapeAttribute(attributes[key] || '')}"`)
                        .join(' ')
            }

            if (VOID_TAGS.has(tagName)) {
                lines.push('  '.repeat(depth) + `<${tagName}${attrStr} />`)
                return
            }

            const childNodes = ((node as Element).children || []).filter(
                (c: AnyNode) =>
                    c.type !== 'comment' &&
                    (c.type !== 'text' ||
                        ((c as unknown as { data?: string }).data || '').trim() !== '')
            )

            if (childNodes.length === 0) {
                lines.push(
                    '  '.repeat(depth) + `<${tagName}${attrStr}></${tagName}>`
                )
                return
            }

            // Inline single short text child for compactness
            if (childNodes.length === 1 && childNodes[0].type === 'text') {
                const text = (
                    (childNodes[0] as unknown as { data?: string }).data || ''
                )
                    .replace(/\s+/g, ' ')
                    .trim()
                if (text.length < 80 && !text.includes('\n')) {
                    lines.push(
                        '  '.repeat(depth) +
                            `<${tagName}${attrStr}>${escapeHtml(text)}</${tagName}>`
                    )
                    return
                }
            }

            lines.push('  '.repeat(depth) + `<${tagName}${attrStr}>`)

            for (const child of childNodes) {
                traverse(child as AnyNode, depth + 1)
            }

            lines.push('  '.repeat(depth) + `</${tagName}>`)
        } else if (node.type === 'root') {
            for (const child of (node as unknown as { children?: AnyNode[] })
                .children || []) {
                traverse(child as AnyNode, depth)
            }
        }
    }

    traverse(root, 0)
    return lines.join('\n')
}

export function cleanForFull(html: string): string {
    if (!html.trim()) return ''
    const $ = cheerio.load(html, { xmlMode: false })

    removeNoise($)
    removeComments($)

    $('*').each(function () {
        const el = $(this as Element)
        el.removeAttr(OPENSTEER_HIDDEN_ATTR)
    })

    return compactHtml($.html())
}

/**
 * Clean HTML for extraction mode. Mirrors the server's cleanHtmlContent()
 * with leaveAttributes=false, leaveImage=true, leaveLinks=true.
 *
 * 1. Remove noise (scripts, styles, hidden elements, comments).
 * 2. Strip ALL attributes, then re-add only:
 *    - `c` and internal pipeline attrs on every element
 *    - `src`, `srcset`, `alt` on <img>
 *    - `src`, `srcset` on <source> inside <picture>
 *    - `href` on <a>
 * 3. Flatten tree (preserve images and links, collapse wrappers).
 * 4. Deduplicate images.
 * 5. Serialize with compact LLM-friendly serializer.
 */
export function cleanForExtraction(html: string): string {
    if (!html.trim()) return ''
    const $ = cheerio.load(html, { xmlMode: false })

    removeNoise($)
    removeComments($)

    // Reload after noise removal to get clean DOM
    let cleanedHtml = $.html().replace(/\n{2,}/g, '\n').trim()
    const $clean = cheerio.load(cleanedHtml, { xmlMode: false })

    // Strip all attributes, then re-add only the minimal set per element.
    // This matches the server's approach: nuke everything, then selectively restore.
    $clean('*').each(function () {
        const el = $clean(this as Element)
        const node = el[0]
        if (!node) return

        const tag = (node.tagName || '').toLowerCase()

        // Save values we may need to restore before wiping
        const cValue = el.attr('c')
        const opensteerNodeId = el.attr(OS_NODE_ID_ATTR)
        const opensteerBoundary = el.attr(OS_BOUNDARY_ATTR)
        const opensteerUnavailable = el.attr(OS_UNAVAILABLE_ATTR)
        const srcValue = el.attr('src')
        const srcsetValue = el.attr('srcset')
        const altValue = el.attr('alt')
        const hrefValue = el.attr('href')

        const isPictureSource =
            tag === 'source' &&
            (srcValue != null || srcsetValue != null) &&
            el.parents('picture').length > 0

        // Remove all attributes
        Object.keys(el.attr() || {}).forEach((attr) => el.removeAttr(attr))

        // Restore internal pipeline attrs
        if (cValue !== undefined) el.attr('c', cValue)
        if (opensteerNodeId !== undefined) {
            el.attr(OS_NODE_ID_ATTR, opensteerNodeId)
        }
        if (opensteerBoundary !== undefined) {
            el.attr(OS_BOUNDARY_ATTR, opensteerBoundary)
        }
        if (opensteerUnavailable !== undefined) {
            el.attr(OS_UNAVAILABLE_ATTR, opensteerUnavailable)
        }

        // Restore content attrs per tag
        if (tag === 'img') {
            if (srcValue) el.attr('src', srcValue)
            if (srcsetValue) el.attr('srcset', srcsetValue)
            if (altValue) {
                el.attr(
                    'alt',
                    altValue.length > TEXT_ATTR_MAX
                        ? altValue.substring(0, TEXT_ATTR_MAX)
                        : altValue
                )
            }
        } else if (isPictureSource) {
            if (srcValue != null && String(srcValue).trim() !== '') {
                el.attr('src', srcValue)
            }
            if (srcsetValue != null && String(srcsetValue).trim() !== '') {
                el.attr('srcset', srcsetValue)
            }
        } else if (tag === 'a') {
            if (hrefValue) el.attr('href', hrefValue)
        }
    })

    flattenExtractionTree($clean)

    // Serialize, then deduplicate images
    let finalHtml = serializeForExtraction(
        $clean,
        $clean.root()[0] as unknown as AnyNode
    )
    finalHtml = deduplicateImages(finalHtml)
    return finalHtml
}

export function cleanForClickable(html: string): string {
    if (!html.trim()) return ''
    const $ = cheerio.load(html, { xmlMode: false })

    removeNoise($)
    removeComments($)

    const context: ClickableContext = {
        hasPreMarked: $(`[${OPENSTEER_INTERACTIVE_ATTR}]`).length > 0,
    }

    const flattenPreserveClickables = (root: Cheerio<AnyNode>): void => {
        root.find('*').each(function () {
            const el = $(this as Element)
            const node = el[0]
            if (!node) return

            const tag = (node.tagName || '').toLowerCase()
            const clickable = isClickable($, el, context)

            if (clickable || ROOT_TAGS.has(tag) || isBoundaryTag(tag)) {
                el.children().each(function () {
                    flattenPreserveClickables($(this as Element))
                })
                return
            }

            const hasText = hasDirectText($, el)
            if (!hasText) {
                if (el.children().length === 0) {
                    el.remove()
                } else {
                    el.children().each(function () {
                        flattenPreserveClickables($(this as Element))
                    })
                    el.replaceWith(el.contents())
                }
                return
            }

            el.children().each(function () {
                flattenPreserveClickables($(this as Element))
            })
        })
    }

    flattenPreserveClickables($.root())

    $('*').each(function () {
        const el = $(this as Element)
        const clickable = isClickable($, el, context)
        const baseKeep = new Set<string>([
            'c',
            OS_NODE_ID_ATTR,
            OS_BOUNDARY_ATTR,
            OS_UNAVAILABLE_ATTR,
        ])

        if (clickable) {
            baseKeep.add('role')
            baseKeep.add('type')
            baseKeep.add('href')
            baseKeep.add('aria-label')
            baseKeep.add('aria-labelledby')
            baseKeep.add('title')
            baseKeep.add('placeholder')
            baseKeep.add('value')
        }

        stripToAttrs(el, baseKeep)

        el.removeAttr(OPENSTEER_INTERACTIVE_ATTR)
        el.removeAttr(OPENSTEER_HIDDEN_ATTR)
        el.removeAttr(OPENSTEER_SCROLLABLE_ATTR)
    })

    const htmlOut = deduplicateImages($.html())
    return compactHtml(htmlOut)
}

export function cleanForScrollable(html: string): string {
    if (!html.trim()) return ''
    const $ = cheerio.load(html, { xmlMode: false })

    removeNoise($)
    removeComments($)

    $('*').each(function () {
        const el = $(this as Element)
        const node = el[0]
        if (!node) return

        const tag = (node.tagName || '').toLowerCase()
        const attrs = (node as Element).attribs || {}
        const isBoundary = isBoundaryTag(tag)
        const scrollable = Object.prototype.hasOwnProperty.call(
            attrs,
            OPENSTEER_SCROLLABLE_ATTR
        )

        if (!scrollable && !isBoundary) {
            el.replaceWith(el.contents())
            return
        }

        const keep = new Set<string>([
            'c',
            OPENSTEER_SCROLLABLE_ATTR,
            OS_NODE_ID_ATTR,
            OS_BOUNDARY_ATTR,
            OS_UNAVAILABLE_ATTR,
        ])
        stripToAttrs(el, keep)
    })

    return compactHtml($.html())
}

export function cleanForAction(html: string): string {
    if (!html.trim()) return ''
    const $ = cheerio.load(html, { xmlMode: false })

    removeNoise($)
    removeComments($)

    const clickableMark = 'data-clickable-marker'
    const indicatorMark = 'data-keep-indicator'

    const context: ClickableContext = {
        hasPreMarked: $(`[${OPENSTEER_INTERACTIVE_ATTR}]`).length > 0,
    }

    $('*').each(function () {
        const el = $(this as Element)
        if (isClickable($, el, context)) {
            el.attr(clickableMark, '1')
        }
    })

    $(`[${clickableMark}]`).each(function () {
        const el = $(this as Element)
        if (hasTextDeep(el)) return

        const wrapperAttrs = el.attr() || {}
        const hasWrapperIndicator =
            (typeof wrapperAttrs['aria-label'] === 'string' &&
                wrapperAttrs['aria-label'].trim() !== '') ||
            (typeof wrapperAttrs.title === 'string' &&
                wrapperAttrs.title.trim() !== '')

        if (hasWrapperIndicator) return

        const imageIndicator = el
            .find('img[alt], img[src], img[srcset]')
            .first()
        if (imageIndicator.length) {
            imageIndicator.attr(indicatorMark, '1')
            return
        }

        const semanticIndicator = el
            .find('[aria-label], [title], [data-icon], [role="img"], svg')
            .first()

        if (semanticIndicator.length) {
            semanticIndicator.attr(indicatorMark, '1')
        }
    })

    let changed = true
    while (changed) {
        changed = false

        const nodes: Cheerio<Element>[] = []
        $('*').each(function () {
            nodes.push($(this as Element))
        })

        nodes.sort((a, b) => b.parents().length - a.parents().length)

        for (const el of nodes) {
            const node = el[0]
            if (!node) continue

            const tag = (node.tagName || '').toLowerCase()
            if (ROOT_TAGS.has(tag)) continue
            if (isBoundaryTag(tag)) continue

            const keepBecauseClickable = el.attr(clickableMark) !== undefined
            const keepBecauseIndicator = el.attr(indicatorMark) !== undefined
            const keepBecauseText = hasDirectText($, el)

            if (
                keepBecauseClickable ||
                keepBecauseIndicator ||
                keepBecauseText
            ) {
                continue
            }

            if (el.children().length === 0) {
                el.remove()
                changed = true
                continue
            }

            el.replaceWith(el.contents())
            changed = true
        }
    }

    $('*').each(function () {
        const el = $(this as Element)
        const node = el[0]
        if (!node) return

        const tag = (node.tagName || '').toLowerCase()
        const clickable = el.attr(clickableMark) !== undefined
        const indicator = el.attr(indicatorMark) !== undefined

        const keep = new Set<string>([
            'c',
            OS_NODE_ID_ATTR,
            OS_BOUNDARY_ATTR,
            OS_UNAVAILABLE_ATTR,
        ])

        if (clickable) {
            ;[
                'href',
                'role',
                'type',
                'title',
                'placeholder',
                'value',
                'aria-label',
                'aria-labelledby',
                'aria-describedby',
                'aria-expanded',
                'aria-pressed',
                'aria-selected',
                'aria-haspopup',
            ].forEach((attr) => keep.add(attr))
        }

        if (indicator) {
            ;[
                'alt',
                'src',
                'srcset',
                'aria-label',
                'title',
                'data-icon',
                'role',
            ].forEach((attr) => keep.add(attr))
        }

        stripToAttrs(el, keep)

        if (tag === 'img' && !indicator) {
            el.remove()
            return
        }

        el.removeAttr(clickableMark)
        el.removeAttr(indicatorMark)
        el.removeAttr(OPENSTEER_INTERACTIVE_ATTR)
        el.removeAttr(OPENSTEER_HIDDEN_ATTR)
        el.removeAttr(OPENSTEER_SCROLLABLE_ATTR)
    })

    const htmlOut = deduplicateImages($.html())
    return compactHtml(htmlOut)
}
