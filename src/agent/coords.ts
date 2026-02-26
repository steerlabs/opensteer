import type { OpensteerAgentProvider } from '../types.js'

export interface ViewportSize {
    width: number
    height: number
}

export const DEFAULT_CUA_VIEWPORT: ViewportSize = {
    width: 1288,
    height: 711,
}

export function normalizeGoogleCoordinates(
    x: number,
    y: number,
    viewport: ViewportSize
): { x: number; y: number } {
    const clampedX = Math.min(999, Math.max(0, x))
    const clampedY = Math.min(999, Math.max(0, y))
    return {
        x: Math.floor((clampedX / 1000) * viewport.width),
        y: Math.floor((clampedY / 1000) * viewport.height),
    }
}

export function maybeNormalizeCoordinates(
    provider: OpensteerAgentProvider,
    x: number,
    y: number,
    viewport: ViewportSize
): { x: number; y: number } {
    if (provider === 'google') {
        return normalizeGoogleCoordinates(x, y, viewport)
    }

    return { x, y }
}
