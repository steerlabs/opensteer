import type { Page, Request } from 'playwright'
import { waitForVisualStabilityAcrossFrames } from './navigation.js'
import type { ActionWaitOptions } from './types.js'

export type PostActionKind =
    | 'click'
    | 'dblclick'
    | 'rightclick'
    | 'hover'
    | 'input'
    | 'select'
    | 'scroll'
    | 'uploadFile'
    | 'pressKey'
    | 'type'

interface ResolvedActionWaitProfile {
    enabled: boolean
    timeout: number
    settleMs: number
    networkQuietMs: number
    includeNetwork: boolean
}

interface PostActionWaitSession {
    wait(): Promise<void>
    dispose(): void
}

const ROBUST_PROFILE: ResolvedActionWaitProfile = {
    enabled: true,
    timeout: 7000,
    settleMs: 750,
    networkQuietMs: 300,
    includeNetwork: true,
}

const SCROLL_PROFILE: ResolvedActionWaitProfile = {
    enabled: true,
    timeout: 7000,
    settleMs: 600,
    networkQuietMs: 400,
    includeNetwork: true,
}

const HOVER_PROFILE: ResolvedActionWaitProfile = {
    enabled: true,
    timeout: 2500,
    settleMs: 200,
    networkQuietMs: 0,
    includeNetwork: false,
}

const ACTION_WAIT_PROFILES: Record<PostActionKind, ResolvedActionWaitProfile> = {
    click: ROBUST_PROFILE,
    dblclick: ROBUST_PROFILE,
    rightclick: ROBUST_PROFILE,
    hover: HOVER_PROFILE,
    input: ROBUST_PROFILE,
    select: ROBUST_PROFILE,
    scroll: SCROLL_PROFILE,
    uploadFile: ROBUST_PROFILE,
    pressKey: ROBUST_PROFILE,
    type: ROBUST_PROFILE,
}

const NETWORK_POLL_MS = 50
const NETWORK_RELAX_AFTER_MS = 1800
const RELAXED_ALLOWED_PENDING = 2
const HEAVY_VISUAL_REQUEST_WINDOW_MS = 5000
const TRACKED_RESOURCE_TYPES = new Set([
    'document',
    'fetch',
    'xhr',
    'stylesheet',
    'image',
    'font',
    'media',
])
const HEAVY_RESOURCE_TYPES = new Set(['document', 'fetch', 'xhr'])
const HEAVY_VISUAL_RESOURCE_TYPES = new Set([
    'stylesheet',
    'image',
    'font',
    'media',
])
const IGNORED_RESOURCE_TYPES = new Set(['websocket', 'eventsource', 'manifest'])

const NOOP_SESSION: PostActionWaitSession = {
    async wait() {},
    dispose() {},
}

export function createPostActionWaitSession(
    page: Page,
    action: PostActionKind,
    override?: false | ActionWaitOptions
): PostActionWaitSession {
    const profile = resolveActionWaitProfile(action, override)
    if (!profile.enabled) return NOOP_SESSION

    const tracker = profile.includeNetwork ? new AdaptiveNetworkTracker(page) : null
    tracker?.start()

    let settled = false

    return {
        async wait() {
            if (settled) return
            settled = true

            const deadline = Date.now() + profile.timeout
            const visualTimeout = profile.includeNetwork
                ? Math.min(
                      profile.timeout,
                      resolveNetworkBackedVisualTimeout(profile.settleMs)
                  )
                : profile.timeout

            try {
                await waitForVisualStabilityAcrossFrames(page, {
                    timeout: visualTimeout,
                    settleMs: profile.settleMs,
                })
            } catch {
            } finally {
                tracker?.freezeCollection()
            }

            try {
                if (tracker) {
                    await tracker.waitForQuiet({
                        deadline,
                        quietMs: profile.networkQuietMs,
                    })
                }
            } catch {
            } finally {
                tracker?.stop()
            }
        },
        dispose() {
            settled = true
            tracker?.stop()
        },
    }
}

function resolveActionWaitProfile(
    action: PostActionKind,
    override?: false | ActionWaitOptions
): ResolvedActionWaitProfile {
    const base = ACTION_WAIT_PROFILES[action]

    if (override === false) {
        return {
            ...base,
            enabled: false,
        }
    }

    if (!override) {
        return { ...base }
    }

    const merged: ResolvedActionWaitProfile = {
        enabled:
            typeof override.enabled === 'boolean'
                ? override.enabled
                : base.enabled,
        timeout: normalizeMs(override.timeout, base.timeout),
        settleMs: normalizeMs(override.settleMs, base.settleMs),
        networkQuietMs: normalizeMs(override.networkQuietMs, base.networkQuietMs),
        includeNetwork:
            typeof override.includeNetwork === 'boolean'
                ? override.includeNetwork
                : base.includeNetwork,
    }

    if (!merged.includeNetwork) {
        merged.networkQuietMs = 0
    }

    return merged
}

function normalizeMs(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback
    }

    return Math.max(0, Math.floor(value))
}

function resolveNetworkBackedVisualTimeout(settleMs: number): number {
    const derived = settleMs * 3 + 300
    return Math.max(1200, Math.min(2500, derived))
}

interface TrackedRequest {
    resourceType: string
    startedAt: number
}

class AdaptiveNetworkTracker {
    private readonly pending = new Map<Request, TrackedRequest>()
    private started = false
    private collecting = false
    private startedAt = 0
    private idleSince = Date.now()

    constructor(private readonly page: Page) {}

    start(): void {
        if (this.started) return
        this.started = true
        this.collecting = true
        this.startedAt = Date.now()
        this.idleSince = this.startedAt

        this.page.on('request', this.handleRequestStarted)
        this.page.on('requestfinished', this.handleRequestFinished)
        this.page.on('requestfailed', this.handleRequestFinished)
    }

    freezeCollection(): void {
        if (!this.started) return
        this.collecting = false
    }

    stop(): void {
        if (!this.started) return
        this.started = false
        this.collecting = false

        this.page.off('request', this.handleRequestStarted)
        this.page.off('requestfinished', this.handleRequestFinished)
        this.page.off('requestfailed', this.handleRequestFinished)

        this.pending.clear()
        this.startedAt = 0
        this.idleSince = Date.now()
    }

    async waitForQuiet(options: {
        deadline: number
        quietMs: number
    }): Promise<void> {
        const quietMs = Math.max(0, options.quietMs)
        if (quietMs === 0) return

        while (Date.now() < options.deadline) {
            const now = Date.now()
            const allowedPending = this.resolveAllowedPending(now)

            if (this.pending.size <= allowedPending) {
                if (this.idleSince === 0) {
                    this.idleSince = now
                }

                const idleFor = now - this.idleSince
                if (idleFor >= quietMs) {
                    return
                }
            } else {
                this.idleSince = 0
            }

            const remaining = Math.max(1, options.deadline - now)
            await sleep(Math.min(NETWORK_POLL_MS, remaining))
        }
    }

    private readonly handleRequestStarted = (request: Request): void => {
        if (!this.started || !this.collecting) return

        const trackedRequest = this.classifyRequest(request)
        if (!trackedRequest) return

        this.pending.set(request, trackedRequest)
        this.idleSince = 0
    }

    private readonly handleRequestFinished = (request: Request): void => {
        if (!this.started) return
        if (!this.pending.delete(request)) return

        if (this.pending.size === 0) {
            this.idleSince = Date.now()
        }
    }

    private classifyRequest(request: Request): TrackedRequest | null {
        const resourceType = request.resourceType().toLowerCase()
        if (IGNORED_RESOURCE_TYPES.has(resourceType)) return null
        if (!TRACKED_RESOURCE_TYPES.has(resourceType)) return null

        const frame = request.frame()
        if (!frame || frame !== this.page.mainFrame()) return null

        return {
            resourceType,
            startedAt: Date.now(),
        }
    }

    private resolveAllowedPending(now: number): number {
        const relaxed =
            now - this.startedAt >= NETWORK_RELAX_AFTER_MS
                ? RELAXED_ALLOWED_PENDING
                : 0

        if (this.hasHeavyPending(now)) return 0
        return relaxed
    }

    private hasHeavyPending(now: number): boolean {
        for (const trackedRequest of this.pending.values()) {
            if (HEAVY_RESOURCE_TYPES.has(trackedRequest.resourceType)) {
                return true
            }

            if (
                HEAVY_VISUAL_RESOURCE_TYPES.has(trackedRequest.resourceType) &&
                now - trackedRequest.startedAt < HEAVY_VISUAL_REQUEST_WINDOW_MS
            ) {
                return true
            }
        }

        return false
    }
}

async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
    })
}
