import { describe, expect, it } from 'vitest'
import { normalizeExecuteOptions } from '../../src/agent/client.js'

describe('agent/client normalizeExecuteOptions', () => {
    it('normalizes and trims string instructions', () => {
        expect(normalizeExecuteOptions('  click submit  ')).toEqual({
            instruction: 'click submit',
        })
    })

    it('normalizes object options', () => {
        expect(
            normalizeExecuteOptions({
                instruction: '  fill form  ',
                maxSteps: 12,
                highlightCursor: true,
            })
        ).toEqual({
            instruction: 'fill form',
            maxSteps: 12,
            highlightCursor: true,
        })
    })

    it('throws on invalid runtime input', () => {
        expect(
            () =>
                normalizeExecuteOptions(
                    // @ts-expect-error runtime validation case
                    {}
                )
        ).toThrow('requires a non-empty "instruction" string')
        expect(
            () =>
                normalizeExecuteOptions({
                    instruction: 'run',
                    maxSteps: 0,
                })
        ).toThrow('"maxSteps" must be a positive integer')
        expect(
            () =>
                normalizeExecuteOptions({
                    instruction: 'run',
                    // @ts-expect-error runtime validation case
                    highlightCursor: 'yes',
                })
        ).toThrow('"highlightCursor" must be a boolean')
    })
})
