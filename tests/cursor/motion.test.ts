import { describe, expect, it } from 'vitest'
import { planSnappyCursorMotion } from '../../src/cursor/motion.js'

describe('cursor/motion', () => {
    it('returns a deterministic path for the same input points', () => {
        const from = { x: 12, y: 18 }
        const to = { x: 420, y: 265 }

        const first = planSnappyCursorMotion(from, to)
        const second = planSnappyCursorMotion(from, to)

        expect(first).toEqual(second)
    })

    it('clamps the number of points and step duration', () => {
        const path = planSnappyCursorMotion(
            { x: 0, y: 0 },
            { x: 2000, y: 1200 }
        )

        expect(path.points.length).toBeLessThanOrEqual(14)
        expect(path.stepDelayMs).toBeGreaterThanOrEqual(0)
        expect(path.stepDelayMs).toBeLessThanOrEqual(64)
    })

    it('uses a fast path for tiny movements', () => {
        const path = planSnappyCursorMotion(
            { x: 100, y: 100 },
            { x: 101, y: 101 }
        )

        expect(path.points).toEqual([{ x: 101, y: 101 }])
        expect(path.stepDelayMs).toBe(0)
    })
})
