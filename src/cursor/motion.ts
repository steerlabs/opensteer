import type { CursorMotionPlan, CursorPoint } from './types.js'

interface SnappyMotionOptions {
    minDurationMs?: number
    maxDurationMs?: number
    maxPoints?: number
}

const DEFAULT_SNAPPY_OPTIONS: Required<SnappyMotionOptions> = {
    minDurationMs: 46,
    maxDurationMs: 170,
    maxPoints: 14,
}

export function planSnappyCursorMotion(
    from: CursorPoint,
    to: CursorPoint,
    options: SnappyMotionOptions = {}
): CursorMotionPlan {
    const resolved = {
        ...DEFAULT_SNAPPY_OPTIONS,
        ...options,
    }

    const dx = to.x - from.x
    const dy = to.y - from.y
    const distance = Math.hypot(dx, dy)

    if (distance < 5) {
        return {
            points: [roundPoint(to)],
            stepDelayMs: 0,
        }
    }

    const durationMs = clamp(
        44 + distance * 0.26,
        resolved.minDurationMs,
        resolved.maxDurationMs
    )

    const rawPoints = clamp(
        Math.round(durationMs / 13),
        4,
        resolved.maxPoints
    )

    const sign = deterministicBendSign(from, to)
    const nx = -dy / distance
    const ny = dx / distance
    const bend = clamp(distance * 0.12, 8, 28) * sign

    const c1: CursorPoint = {
        x: from.x + dx * 0.28 + nx * bend,
        y: from.y + dy * 0.28 + ny * bend,
    }
    const c2: CursorPoint = {
        x: from.x + dx * 0.74 + nx * bend * 0.58,
        y: from.y + dy * 0.74 + ny * bend * 0.58,
    }

    const points: CursorPoint[] = []
    for (let i = 1; i <= rawPoints; i += 1) {
        const t = i / rawPoints
        const sampled = cubicBezier(from, c1, c2, to, t)
        if (i !== rawPoints) {
            const previous = points[points.length - 1]
            if (previous && distanceBetween(previous, sampled) < 1.4) {
                continue
            }
        }
        points.push(roundPoint(sampled))
    }

    if (distance > 220) {
        const settle = {
            x: to.x - dx / distance,
            y: to.y - dy / distance,
        }
        const last = points[points.length - 1]
        if (!last || distanceBetween(last, settle) > 1.2) {
            points.splice(Math.max(0, points.length - 1), 0, roundPoint(settle))
        }
    }

    const deduped = dedupeAdjacent(points)
    const stepDelayMs =
        deduped.length > 1 ? Math.round(durationMs / deduped.length) : 0

    return {
        points: deduped.length ? deduped : [roundPoint(to)],
        stepDelayMs,
    }
}

function cubicBezier(
    p0: CursorPoint,
    p1: CursorPoint,
    p2: CursorPoint,
    p3: CursorPoint,
    t: number
): CursorPoint {
    const inv = 1 - t
    const inv2 = inv * inv
    const inv3 = inv2 * inv
    const t2 = t * t
    const t3 = t2 * t

    return {
        x: inv3 * p0.x + 3 * inv2 * t * p1.x + 3 * inv * t2 * p2.x + t3 * p3.x,
        y: inv3 * p0.y + 3 * inv2 * t * p1.y + 3 * inv * t2 * p2.y + t3 * p3.y,
    }
}

function deterministicBendSign(from: CursorPoint, to: CursorPoint): 1 | -1 {
    const seed = Math.sin(
        from.x * 12.9898 +
            from.y * 78.233 +
            to.x * 37.719 +
            to.y * 19.113
    ) * 43758.5453
    const fractional = seed - Math.floor(seed)
    return fractional >= 0.5 ? 1 : -1
}

function roundPoint(point: CursorPoint): CursorPoint {
    return {
        x: Math.round(point.x * 100) / 100,
        y: Math.round(point.y * 100) / 100,
    }
}

function distanceBetween(a: CursorPoint, b: CursorPoint): number {
    return Math.hypot(a.x - b.x, a.y - b.y)
}

function dedupeAdjacent(points: CursorPoint[]): CursorPoint[] {
    const out: CursorPoint[] = []
    for (const point of points) {
        const last = out[out.length - 1]
        if (last && last.x === point.x && last.y === point.y) {
            continue
        }
        out.push(point)
    }
    return out
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}
