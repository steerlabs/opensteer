import { describe, expect, it, vi } from 'vitest'
import { getCommandHandler } from '../../src/cli/commands.js'

describe('cli/commands cursor', () => {
    it('toggles cursor on and off', async () => {
        const handler = getCommandHandler('cursor')
        expect(handler).toBeTypeOf('function')

        const opensteer = {
            setCursorEnabled: vi.fn(),
            getCursorState: vi
                .fn()
                .mockReturnValueOnce({
                    enabled: true,
                    active: true,
                })
                .mockReturnValueOnce({
                    enabled: false,
                    active: false,
                }),
        }

        const onResult = await handler!(opensteer as never, { mode: 'on' })
        const offResult = await handler!(opensteer as never, { mode: 'off' })

        expect(opensteer.setCursorEnabled).toHaveBeenNthCalledWith(1, true)
        expect(opensteer.setCursorEnabled).toHaveBeenNthCalledWith(2, false)
        expect(onResult).toEqual({
            cursor: { enabled: true, active: true },
        })
        expect(offResult).toEqual({
            cursor: { enabled: false, active: false },
        })
    })

    it('returns current cursor status in status mode', async () => {
        const handler = getCommandHandler('cursor')
        const opensteer = {
            setCursorEnabled: vi.fn(),
            getCursorState: vi.fn().mockReturnValue({
                enabled: false,
                active: false,
                reason: 'disabled',
            }),
        }

        const result = await handler!(opensteer as never, { mode: 'status' })
        expect(opensteer.setCursorEnabled).not.toHaveBeenCalled()
        expect(result).toEqual({
            cursor: {
                enabled: false,
                active: false,
                reason: 'disabled',
            },
        })
    })

    it('rejects invalid cursor mode values', async () => {
        const handler = getCommandHandler('cursor')
        const opensteer = {
            setCursorEnabled: vi.fn(),
            getCursorState: vi.fn(),
        }

        await expect(
            handler!(opensteer as never, { mode: 'maybe' })
        ).rejects.toThrow('Invalid cursor mode')
    })
})
