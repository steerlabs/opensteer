import { describe, expect, it } from 'vitest'
import { parseCapturedBody } from '../../src/api-reverse/body-parser.js'

describe('api-reverse/body-parser', () => {
    it('prefers valid JSON payloads over misleading form headers', () => {
        const parsed = parseCapturedBody(
            JSON.stringify({ query: 'OpenAI', limit: 6 }),
            'application/x-www-form-urlencoded'
        )

        expect(parsed.format).toBe('json')
        expect(parsed.parsedJson).toEqual({
            query: 'OpenAI',
            limit: 6,
        })
    })

    it('infers form payloads from body shape when the header is generic', () => {
        const parsed = parseCapturedBody('query=OpenAI&limit=6', 'text/plain')

        expect(parsed.format).toBe('form')
        expect(parsed.parsedForm).toEqual({
            query: 'OpenAI',
            limit: '6',
        })
    })

    it('falls back to form parsing when a JSON header is wrong but the payload is form data', () => {
        const parsed = parseCapturedBody('query=OpenAI&limit=6', 'application/json')

        expect(parsed.format).toBe('form')
        expect(parsed.parsedForm).toEqual({
            query: 'OpenAI',
            limit: '6',
        })
    })

    it('does not invent form fields from opaque token payloads', () => {
        const parsed = parseCapturedBody(
            'ZXlKaGJHY2lPaUpJVXpJMU5pSjkuZXlKemRXSWlPaUl4TWpNME5UWTNPRGt3SW4wPQ==',
            'application/x-www-form-urlencoded'
        )

        expect(parsed.format).toBe('text')
        expect(parsed.parsedForm).toBeUndefined()
        expect(parsed.parsedJson).toBeUndefined()
    })
})
