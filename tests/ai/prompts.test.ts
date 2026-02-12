import { describe, expect, it } from 'vitest'
import {
    buildResolveSystemPrompt,
    buildResolveUserPrompt,
    buildExtractSystemPrompt,
    buildExtractUserPrompt,
} from '../../src/ai/prompts.js'

describe('ai/prompts', () => {
    describe('buildResolveSystemPrompt', () => {
        it('contains counter attribute instructions', () => {
            const prompt = buildResolveSystemPrompt()
            expect(prompt).toContain('c="N"')
        })

        it('contains JSON response format instructions', () => {
            const prompt = buildResolveSystemPrompt()
            expect(prompt).toContain('"element"')
            expect(prompt).toContain('"confidence"')
            expect(prompt).toContain('"reasoning"')
        })
    })

    describe('buildResolveUserPrompt', () => {
        it('includes action, description, url, and html', () => {
            const prompt = buildResolveUserPrompt({
                action: 'click',
                description: 'Submit button',
                url: 'http://localhost:3000/forms',
                html: '<button c="5">Submit</button>',
            })
            expect(prompt).toContain('Action: click')
            expect(prompt).toContain('Description: Submit button')
            expect(prompt).toContain('URL: http://localhost:3000/forms')
            expect(prompt).toContain('<button c="5">Submit</button>')
        })

        it('omits URL when null', () => {
            const prompt = buildResolveUserPrompt({
                action: 'click',
                description: 'Submit button',
                url: null,
                html: '<button>Submit</button>',
            })
            expect(prompt).not.toContain('URL:')
            expect(prompt).toContain('Action: click')
            expect(prompt).toContain('Description: Submit button')
        })
    })

    describe('buildExtractSystemPrompt', () => {
        it('contains extraction instructions', () => {
            const prompt = buildExtractSystemPrompt()
            expect(prompt).toContain('extract')
            expect(prompt).toContain('contains_data')
            expect(prompt).toContain('counter number')
            expect(prompt).toContain('CURRENT_URL')
        })
    })

    describe('buildExtractUserPrompt', () => {
        it('includes schema, description, url, and html', () => {
            const prompt = buildExtractUserPrompt({
                schema: { name: 'string' },
                description: 'Extract user name',
                url: 'http://localhost:3000/data',
                html: '<div c="1">Alice</div>',
            })
            expect(prompt).toContain('Description: Extract user name')
            expect(prompt).toContain('URL: http://localhost:3000/data')
            expect(prompt).toContain('"name": "string"')
            expect(prompt).toContain('<div c="1">Alice</div>')
        })

        it('includes prompt/instructions when provided', () => {
            const prompt = buildExtractUserPrompt({
                schema: { val: 'number' },
                prompt: 'Only extract visible values',
                url: null,
                html: '<span>42</span>',
            })
            expect(prompt).toContain(
                'Instructions: Only extract visible values'
            )
        })

        it('omits description and url when not provided', () => {
            const prompt = buildExtractUserPrompt({
                schema: { a: 'string' },
                url: null,
                html: '<p>hello</p>',
            })
            expect(prompt).not.toContain('Description:')
            expect(prompt).not.toContain('URL:')
        })
    })
})
