import { describe, expect, it } from 'vitest'
import { normalizeExtractedValue } from '../../src/extract-value-normalization.js'

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
})
