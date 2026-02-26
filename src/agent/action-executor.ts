import type { Page } from 'playwright'
import type { OpensteerAgentAction } from '../types.js'
import { mapKeyToPlaywright } from './key-mapping.js'
import { OpensteerAgentActionError } from './errors.js'

export async function executeAgentAction(
    page: Page,
    action: OpensteerAgentAction
): Promise<void> {
    const type = normalizeActionType(action.type)

    switch (type) {
        case 'click': {
            const { x, y } = toPoint(action)
            await page.mouse.click(x, y, {
                button: normalizeMouseButton(action.button, 'left'),
                clickCount: normalizeClickCount(action.clickCount, 1),
            })
            return
        }

        case 'doubleclick': {
            const { x, y } = toPoint(action)
            await page.mouse.click(x, y, {
                button: normalizeMouseButton(action.button, 'left'),
                clickCount: 2,
            })
            return
        }

        case 'tripleclick': {
            const { x, y } = toPoint(action)
            await page.mouse.click(x, y, {
                button: normalizeMouseButton(action.button, 'left'),
                clickCount: 3,
            })
            return
        }

        case 'rightclick': {
            const { x, y } = toPoint(action)
            await page.mouse.click(x, y, {
                button: 'right',
                clickCount: normalizeClickCount(action.clickCount, 1),
            })
            return
        }

        case 'type': {
            await maybeFocusPoint(page, action)
            const text = typeof action.text === 'string' ? action.text : ''
            if (action.clearBeforeTyping === true) {
                await pressKeyCombo(page, 'ControlOrMeta+A')
                await page.keyboard.press('Backspace')
            }
            await page.keyboard.type(text)
            if (action.pressEnter === true) {
                await page.keyboard.press('Enter')
            }
            return
        }

        case 'keypress': {
            const combos = normalizeKeyCombos(action.keys)
            for (const combo of combos) {
                await pressKeyCombo(page, combo)
            }
            return
        }

        case 'scroll': {
            const x = numberOr(action.scrollX, action.scroll_x, 0)
            const y = numberOr(action.scrollY, action.scroll_y, 0)
            await page.mouse.wheel(x, y)
            return
        }

        case 'drag': {
            const path = normalizePath(action.path)
            if (!path.length) {
                throw new OpensteerAgentActionError(
                    'Drag action requires a non-empty path.'
                )
            }

            await page.mouse.move(path[0].x, path[0].y)
            await page.mouse.down()
            for (const point of path.slice(1)) {
                await page.mouse.move(point.x, point.y)
            }
            await page.mouse.up()
            return
        }

        case 'move':
        case 'hover': {
            const { x, y } = toPoint(action)
            await page.mouse.move(x, y)
            return
        }

        case 'wait': {
            const ms = numberOr(action.timeMs, action.time_ms, 1000)
            await sleep(ms)
            return
        }

        case 'goto': {
            const url = normalizeRequiredString(action.url, 'Action URL is required for goto.')
            await page.goto(url, { waitUntil: 'load' })
            return
        }

        case 'back': {
            await page.goBack({ waitUntil: 'load' }).catch(() => undefined)
            return
        }

        case 'forward': {
            await page.goForward({ waitUntil: 'load' }).catch(() => undefined)
            return
        }

        case 'screenshot':
        case 'open_web_browser': {
            return
        }

        default:
            throw new OpensteerAgentActionError(
                `Unsupported CUA action type "${String(action.type)}".`
            )
    }
}

export function isMutatingAgentAction(action: OpensteerAgentAction): boolean {
    const type = normalizeActionType(action.type)
    return type !== 'wait' && type !== 'screenshot' && type !== 'open_web_browser'
}

function normalizeActionType(value: unknown): string {
    const raw = typeof value === 'string' ? value : ''
    const normalized = raw.trim().toLowerCase()
    if (!normalized) return ''

    if (normalized === 'double_click' || normalized === 'doubleclick') {
        return 'doubleclick'
    }

    if (normalized === 'triple_click' || normalized === 'tripleclick') {
        return 'tripleclick'
    }

    if (normalized === 'left_click') {
        return 'click'
    }

    if (normalized === 'right_click') {
        return 'rightclick'
    }

    if (normalized === 'openwebbrowser' || normalized === 'open_web_browser') {
        return 'open_web_browser'
    }

    return normalized
}

function toPoint(action: OpensteerAgentAction): { x: number; y: number } {
    const coordinate = Array.isArray(action.coordinate)
        ? action.coordinate
        : Array.isArray(action.coordinates)
          ? action.coordinates
          : null

    const x = numberOr(action.x, coordinate?.[0])
    const y = numberOr(action.y, coordinate?.[1])

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new OpensteerAgentActionError(
            `Action "${String(action.type)}" requires numeric x and y coordinates.`
        )
    }

    return {
        x,
        y,
    }
}

async function maybeFocusPoint(
    page: Page,
    action: OpensteerAgentAction
): Promise<void> {
    const x = action.x
    const y = action.y
    if (typeof x !== 'number' || typeof y !== 'number') {
        return
    }

    await page.mouse.click(x, y, {
        button: normalizeMouseButton(action.button, 'left'),
        clickCount: 1,
    })
}

function normalizePath(
    path: unknown
): Array<{ x: number; y: number }> {
    if (!Array.isArray(path)) return []

    const points: Array<{ x: number; y: number }> = []
    for (const entry of path) {
        if (!entry || typeof entry !== 'object') continue
        const candidate = entry as Record<string, unknown>
        const x = Number(candidate.x)
        const y = Number(candidate.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        points.push({ x, y })
    }

    return points
}

function normalizeMouseButton(
    value: unknown,
    fallback: 'left' | 'right' | 'middle'
): 'left' | 'right' | 'middle' {
    if (value === 'left' || value === 'right' || value === 'middle') {
        return value
    }

    if (typeof value === 'string') {
        const normalized = value.toLowerCase()
        if (normalized === 'left' || normalized === 'right' || normalized === 'middle') {
            return normalized
        }
    }

    return fallback
}

function normalizeClickCount(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value)
    }

    return fallback
}

function normalizeKeyCombos(value: unknown): string[] {
    if (typeof value === 'string') {
        const trimmed = value.trim()
        return trimmed ? [trimmed] : []
    }

    if (!Array.isArray(value)) {
        return []
    }

    const keys = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)

    if (!keys.length) {
        return []
    }

    const hasExplicitComboSyntax = keys.some((entry) => entry.includes('+'))

    // Providers often emit key combinations as arrays like ["Control", "A"].
    // Treat that as a single chord; otherwise we'd press keys sequentially and
    // accidentally type characters into focused inputs.
    if (!hasExplicitComboSyntax && keys.length > 1) {
        return [keys.join('+')]
    }

    return keys
}

function numberOr(...values: unknown[]): number {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value
    }

    return NaN
}

function normalizeRequiredString(value: unknown, errorMessage: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new OpensteerAgentActionError(errorMessage)
    }

    return value.trim()
}

async function pressKeyCombo(page: Page, combo: string): Promise<void> {
    const trimmed = combo.trim()
    if (!trimmed) return

    if (!trimmed.includes('+')) {
        await page.keyboard.press(mapKeyToPlaywright(trimmed))
        return
    }

    const parts = trimmed
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => mapKeyToPlaywright(part))

    if (!parts.length) return

    const modifiers = parts.slice(0, -1)
    const last = parts[parts.length - 1]

    for (const modifier of modifiers) {
        await page.keyboard.down(modifier)
    }

    try {
        await page.keyboard.press(last)
    } finally {
        for (const modifier of modifiers.slice().reverse()) {
            await page.keyboard.up(modifier)
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}
