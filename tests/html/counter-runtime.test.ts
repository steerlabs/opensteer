import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElementHandle, Frame, Page } from 'playwright'

const readerMocks = vi.hoisted(() => ({
    readExtractedValueFromHandle: vi.fn(),
}))

vi.mock('../../src/extract-value-reader.js', () => ({
    readExtractedValueFromHandle: readerMocks.readExtractedValueFromHandle,
}))

import { readExtractedValueFromHandle } from '../../src/extract-value-reader.js'
import {
    resolveCounterElement,
    resolveCountersBatch,
} from '../../src/html/counter-runtime.js'

const mockedReadExtractedValueFromHandle = vi.mocked(readExtractedValueFromHandle)

type MockElementHandle = ElementHandle<Element> & {
    dispose: ReturnType<typeof vi.fn>
}

type MockLookupHandle = {
    asElement: () => ElementHandle<Element> | null
    jsonValue: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
}

type MockFrame = Frame & {
    evaluate: ReturnType<typeof vi.fn>
    evaluateHandle: ReturnType<typeof vi.fn>
}

describe('counter-runtime', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('treats detached-handle reads as missing values without aborting the batch', async () => {
        const element = createMockElementHandle()
        const frame = createMockFrame({
            counts: { '7': 1 },
            lookupHandle: createResolvedLookupHandle(element),
        })

        mockedReadExtractedValueFromHandle.mockRejectedValueOnce(
            new Error('Element is not attached to the DOM')
        )

        const result = await resolveCountersBatch(createMockPage(frame), [
            { key: 'text', counter: 7 },
            { key: 'href', counter: 7, attribute: 'href' },
        ])

        expect(result).toEqual({
            text: null,
            href: null,
        })
        expect(mockedReadExtractedValueFromHandle).toHaveBeenCalledTimes(1)
        expect(frame.evaluateHandle).toHaveBeenCalledTimes(1)
        expect(element.dispose).toHaveBeenCalledTimes(1)
    })

    it('preserves ambiguous-counter errors when lookup becomes duplicated after the scan', async () => {
        const frame = createMockFrame({
            counts: { '7': 1 },
            lookupHandle: createStatusLookupHandle('ambiguous'),
        })

        await expect(
            resolveCountersBatch(createMockPage(frame), [
                { key: 'text', counter: 7 },
            ])
        ).rejects.toMatchObject({
            code: 'ERR_COUNTER_AMBIGUOUS',
        })

        expect(mockedReadExtractedValueFromHandle).not.toHaveBeenCalled()
    })

    it('treats detached-frame lookups as missing values during batch reads', async () => {
        const frame = createMockFrame({
            counts: { '7': 1 },
            lookupError: new Error('Frame was detached'),
        })

        const result = await resolveCountersBatch(createMockPage(frame), [
            { key: 'text', counter: 7 },
        ])

        expect(result).toEqual({
            text: null,
        })
        expect(mockedReadExtractedValueFromHandle).not.toHaveBeenCalled()
    })

    it('keeps non-race read failures as hard errors', async () => {
        const element = createMockElementHandle()
        const frame = createMockFrame({
            counts: { '7': 1 },
            lookupHandle: createResolvedLookupHandle(element),
        })

        mockedReadExtractedValueFromHandle.mockRejectedValueOnce(
            new Error('Unexpected extraction failure')
        )

        await expect(
            resolveCountersBatch(createMockPage(frame), [
                { key: 'text', counter: 7 },
            ])
        ).rejects.toThrow('Unexpected extraction failure')

        expect(element.dispose).toHaveBeenCalledTimes(1)
    })

    it('raises ambiguous errors for direct counter resolution after a post-scan duplicate appears', async () => {
        const frame = createMockFrame({
            counts: { '7': 1 },
            lookupHandle: createStatusLookupHandle('ambiguous'),
        })

        await expect(
            resolveCounterElement(createMockPage(frame), 7)
        ).rejects.toMatchObject({
            code: 'ERR_COUNTER_AMBIGUOUS',
        })
    })
})

function createMockPage(frame: Frame): Page {
    return {
        frames: () => [frame],
    } as unknown as Page
}

function createMockFrame(options: {
    counts: Record<string, number>
    lookupHandle?: MockLookupHandle
    lookupError?: Error
}): MockFrame {
    return {
        evaluate: vi.fn().mockResolvedValue(options.counts),
        evaluateHandle: options.lookupError
            ? vi.fn().mockRejectedValue(options.lookupError)
            : vi.fn().mockResolvedValue(options.lookupHandle),
    } as unknown as MockFrame
}

function createMockElementHandle(): MockElementHandle {
    return {
        dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as MockElementHandle
}

function createResolvedLookupHandle(
    element: ElementHandle<Element>
): MockLookupHandle {
    return {
        asElement: () => element,
        jsonValue: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined),
    }
}

function createStatusLookupHandle(
    status: 'missing' | 'ambiguous'
): MockLookupHandle {
    return {
        asElement: () => null,
        jsonValue: vi.fn().mockResolvedValue(status),
        dispose: vi.fn().mockResolvedValue(undefined),
    }
}
