import { describe, expect, it, vi } from 'vitest'
import {
    executeAgentAction,
    isMutatingAgentAction,
} from '../../src/agent/action-executor.js'
import { mapKeyToPlaywright } from '../../src/agent/key-mapping.js'

function createMockPage() {
    return {
        mouse: {
            click: vi.fn().mockResolvedValue(undefined),
            move: vi.fn().mockResolvedValue(undefined),
            down: vi.fn().mockResolvedValue(undefined),
            up: vi.fn().mockResolvedValue(undefined),
            wheel: vi.fn().mockResolvedValue(undefined),
        },
        keyboard: {
            press: vi.fn().mockResolvedValue(undefined),
            type: vi.fn().mockResolvedValue(undefined),
            down: vi.fn().mockResolvedValue(undefined),
            up: vi.fn().mockResolvedValue(undefined),
        },
        goto: vi.fn().mockResolvedValue(undefined),
        goBack: vi.fn().mockResolvedValue(undefined),
        goForward: vi.fn().mockResolvedValue(undefined),
    }
}

describe('agent/action-executor', () => {
    it('executes click coordinates', async () => {
        const page = createMockPage()

        await executeAgentAction(page as never, {
            type: 'click',
            x: 10,
            y: 20,
            button: 'left',
        })

        expect(page.mouse.click).toHaveBeenCalledWith(10, 20, {
            button: 'left',
            clickCount: 1,
        })
    })

    it('executes type with clear and enter', async () => {
        const page = createMockPage()

        await executeAgentAction(page as never, {
            type: 'type',
            x: 25,
            y: 40,
            text: 'hello',
            clearBeforeTyping: true,
            pressEnter: true,
        })

        expect(page.mouse.click).toHaveBeenCalledWith(25, 40, {
            button: 'left',
            clickCount: 1,
        })
        expect(page.keyboard.down).toHaveBeenCalled()
        expect(page.keyboard.type).toHaveBeenCalledWith('hello')
        expect(page.keyboard.press).toHaveBeenCalledWith('Enter')
    })

    it('executes scroll wheel', async () => {
        const page = createMockPage()

        await executeAgentAction(page as never, {
            type: 'scroll',
            scrollX: 0,
            scrollY: 500,
        })

        expect(page.mouse.move).not.toHaveBeenCalled()
        expect(page.mouse.wheel).toHaveBeenCalledWith(0, 500)
    })

    it('moves to scroll coordinates before scrolling', async () => {
        const page = createMockPage()

        await executeAgentAction(page as never, {
            type: 'scroll',
            x: 120,
            y: 240,
            scrollX: -100,
            scrollY: 300,
        })

        expect(page.mouse.move).toHaveBeenCalledWith(120, 240)
        expect(page.mouse.wheel).toHaveBeenCalledWith(-100, 300)

        const [moveCallOrder] = page.mouse.move.mock.invocationCallOrder
        const [wheelCallOrder] = page.mouse.wheel.mock.invocationCallOrder
        expect(moveCallOrder).toBeLessThan(wheelCallOrder)
    })

    it('treats key array combos as a single chord', async () => {
        const page = createMockPage()

        await executeAgentAction(page as never, {
            type: 'keypress',
            keys: ['ControlOrMeta', 'A'],
        })

        expect(page.keyboard.down).toHaveBeenCalledTimes(1)
        expect(page.keyboard.down).toHaveBeenCalledWith(
            mapKeyToPlaywright('ControlOrMeta')
        )
        expect(page.keyboard.press).toHaveBeenCalledTimes(1)
        expect(page.keyboard.press).toHaveBeenCalledWith('A')
        expect(page.keyboard.up).toHaveBeenCalledTimes(1)
        expect(page.keyboard.up).toHaveBeenCalledWith(
            mapKeyToPlaywright('ControlOrMeta')
        )
    })

    it('marks mutating and non-mutating actions correctly', () => {
        expect(isMutatingAgentAction({ type: 'click' })).toBe(true)
        expect(isMutatingAgentAction({ type: 'wait' })).toBe(false)
        expect(isMutatingAgentAction({ type: 'screenshot' })).toBe(false)
    })

    it('throws on unsupported action', async () => {
        const page = createMockPage()

        await expect(
            executeAgentAction(page as never, {
                type: 'unsupported_action',
            })
        ).rejects.toThrow('Unsupported CUA action type')
    })
})
