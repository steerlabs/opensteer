export interface CursorPoint {
    x: number
    y: number
}

export type CursorIntent =
    | 'click'
    | 'dblclick'
    | 'rightclick'
    | 'hover'
    | 'input'
    | 'select'
    | 'scroll'
    | 'uploadFile'
    | 'agent'

export interface CursorMotionPlan {
    points: CursorPoint[]
    stepDelayMs: number
}

export type CursorCapabilityReason =
    | 'disabled'
    | 'page_closed'
    | 'cdp_unavailable'
    | 'cdp_detached'
    | 'unsupported'
    | 'renderer_error'

export interface CursorStatus {
    enabled: boolean
    active: boolean
    reason?: string
}
