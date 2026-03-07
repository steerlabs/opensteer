import { describe, expect, it } from 'vitest'
import { stripTrailingSlashes } from '../../src/utils/strip-trailing-slashes.js'

describe('stripTrailingSlashes', () => {
    it('removes trailing slashes without touching the rest of the string', () => {
        expect(stripTrailingSlashes('https://api.opensteer.com///')).toBe(
            'https://api.opensteer.com'
        )
        expect(stripTrailingSlashes('https://api.opensteer.com/path//')).toBe(
            'https://api.opensteer.com/path'
        )
        expect(stripTrailingSlashes('https://api.opensteer.com')).toBe(
            'https://api.opensteer.com'
        )
    })

    it('removes trailing slash runs from long strings', () => {
        const input = `https://api.opensteer.com${'/'.repeat(50_000)}`
        expect(stripTrailingSlashes(input)).toBe('https://api.opensteer.com')
        expect(stripTrailingSlashes('/'.repeat(50_000))).toBe('')
    })
})
