import type { Page } from 'playwright'
import type { OpensteerCursorStyle } from '../types.js'
import type { CursorPoint, CursorStatus } from './types.js'

export interface CursorRenderer {
    initialize(page: Page): Promise<void>
    move(point: CursorPoint, style: Required<OpensteerCursorStyle>): Promise<void>
    pulse(point: CursorPoint, style: Required<OpensteerCursorStyle>): Promise<void>
    clear(): Promise<void>
    dispose(): Promise<void>
    isActive(): boolean
    status(): CursorStatus
}
