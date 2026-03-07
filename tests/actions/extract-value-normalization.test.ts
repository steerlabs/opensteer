import { describe, expect, it } from 'vitest'
import {
    normalizeExtractedValue,
    resolveExtractedValueInContext,
} from '../../src/extract-value-normalization.js'

describe('extract-value-normalization', () => {
    it('selects the largest width candidate for srcset', () => {
        const value = normalizeExtractedValue(
            '/img-320.jpg 320w, /img-1280.jpg 1280w, /img-960.jpg 960w',
            'srcset'
        )

        expect(value).toBe('/img-1280.jpg')
    })

    it('selects the largest density candidate for srcset when width is absent', () => {
        const value = normalizeExtractedValue(
            '/img-1x.jpg 1x, /img-2x.jpg 2x, /img-3x.jpg 3x',
            'srcset'
        )

        expect(value).toBe('/img-3x.jpg')
    })

    it('uses the first candidate for srcset entries without descriptors', () => {
        const value = normalizeExtractedValue(
            '/img-primary.jpg, /img-secondary.jpg',
            'srcset'
        )

        expect(value).toBe('/img-primary.jpg')
    })

    it('supports imagesrcset normalization with the same quality rules', () => {
        const value = normalizeExtractedValue(
            '/img-1x.jpg 1x, /img-4x.jpg 4x, /img-2x.jpg 2x',
            'imagesrcset'
        )

        expect(value).toBe('/img-4x.jpg')
    })

    it('falls back to normalized raw text for malformed srcset input', () => {
        const value = normalizeExtractedValue('not-a-srcset', 'srcset')
        expect(value).toBe('not-a-srcset')
    })

    it('handles data-url srcset candidates without splitting on URL commas', () => {
        const value = normalizeExtractedValue(
            'data:image/svg+xml,%3Csvg%3E%3C/svg%3E 1x, /img-2x.jpg 2x',
            'srcset'
        )
        expect(value).toBe('/img-2x.jpg')
    })

    it('returns the first ping url token', () => {
        const value = normalizeExtractedValue(
            'https://tracker.example/ping https://backup.example/ping',
            'ping'
        )

        expect(value).toBe('https://tracker.example/ping')
    })

    it('preserves existing whitespace normalization for unsupported attributes', () => {
        const value = normalizeExtractedValue(
            '  Alpha   Beta   Gamma  ',
            'data-label'
        )

        expect(value).toBe('Alpha Beta Gamma')
    })

    it('resolves iframe-relative href values against the iframe document base url', () => {
        const value = resolveExtractedValueInContext('products/item', {
            attribute: 'href',
            baseURI: 'https://fixtures.opensteer.dev/frame/',
            insideIframe: true,
        })

        expect(value).toBe('https://fixtures.opensteer.dev/frame/products/item')
    })

    it('resolves normalized iframe srcset candidates against the iframe document base url', () => {
        const normalized = normalizeExtractedValue(
            'images/320.jpg 320w, images/1280.jpg 1280w',
            'srcset'
        )

        const value = resolveExtractedValueInContext(normalized, {
            attribute: 'srcset',
            baseURI: 'https://fixtures.opensteer.dev/frame/',
            insideIframe: true,
        })

        expect(value).toBe('https://fixtures.opensteer.dev/frame/images/1280.jpg')
    })

    it('resolves the first iframe ping token against the iframe document base url', () => {
        const normalized = normalizeExtractedValue(
            '../track/ping https://backup.example/ping',
            'ping'
        )

        const value = resolveExtractedValueInContext(normalized, {
            attribute: 'ping',
            baseURI: 'https://fixtures.opensteer.dev/frame/',
            insideIframe: true,
        })

        expect(value).toBe('https://fixtures.opensteer.dev/track/ping')
    })

    it('leaves main-frame values unchanged', () => {
        const value = resolveExtractedValueInContext('/products/item', {
            attribute: 'href',
            baseURI: 'https://fixtures.opensteer.dev/frame/',
            insideIframe: false,
        })

        expect(value).toBe('/products/item')
    })

    it('leaves non-url attributes unchanged inside iframes', () => {
        const value = resolveExtractedValueInContext('Hero image', {
            attribute: 'alt',
            baseURI: 'https://fixtures.opensteer.dev/frame/',
            insideIframe: true,
        })

        expect(value).toBe('Hero image')
    })

    it('falls back to the normalized value when resolution fails', () => {
        const value = resolveExtractedValueInContext('products/item', {
            attribute: 'href',
            baseURI: 'not a valid base url',
            insideIframe: true,
        })

        expect(value).toBe('products/item')
    })

    it('preserves absolute iframe urls unchanged', () => {
        const value = resolveExtractedValueInContext(
            'https://example.com/products/item',
            {
                attribute: 'href',
                baseURI: 'https://fixtures.opensteer.dev/frame/',
                insideIframe: true,
            }
        )

        expect(value).toBe('https://example.com/products/item')
    })

    it('resolves protocol-relative iframe urls with the iframe document scheme', () => {
        const value = resolveExtractedValueInContext(
            '//cdn.example.com/assets/item.png',
            {
                attribute: 'src',
                baseURI: 'https://fixtures.opensteer.dev/frame/',
                insideIframe: true,
            }
        )

        expect(value).toBe('https://cdn.example.com/assets/item.png')
    })

    it('resolves query-only iframe urls against the iframe document base url', () => {
        const value = resolveExtractedValueInContext('?page=2', {
            attribute: 'action',
            baseURI: 'https://fixtures.opensteer.dev/frame/',
            insideIframe: true,
        })

        expect(value).toBe('https://fixtures.opensteer.dev/frame/?page=2')
    })

    it('resolves fragment-only iframe urls against the iframe document base url', () => {
        const value = resolveExtractedValueInContext('#details', {
            attribute: 'formaction',
            baseURI: 'https://fixtures.opensteer.dev/frame/',
            insideIframe: true,
        })

        expect(value).toBe('https://fixtures.opensteer.dev/frame/#details')
    })

    it('preserves data urls for iframe media attributes', () => {
        const value = resolveExtractedValueInContext(
            'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
            {
                attribute: 'src',
                baseURI: 'https://fixtures.opensteer.dev/frame/',
                insideIframe: true,
            }
        )

        expect(value).toBe('data:image/svg+xml,%3Csvg%3E%3C/svg%3E')
    })
})
