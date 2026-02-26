import type { CDPSession, Page } from 'playwright'

const DEFAULT_TIMEOUT = 30000
const DEFAULT_SETTLE_MS = 750
const FRAME_EVALUATE_GRACE_MS = 200
const TRANSIENT_CONTEXT_RETRY_DELAY_MS = 25
const STEALTH_WORLD_NAME = '__opensteer_wait__'

interface VisualStabilityOptions {
    timeout?: number
    settleMs?: number
}

interface CdpFrameTreeNode {
    frame: {
        id: string
    }
    childFrames?: CdpFrameTreeNode[]
}

interface CdpGetFrameTreeResult {
    frameTree: CdpFrameTreeNode
}

interface CdpCreateIsolatedWorldResult {
    executionContextId: number
}

interface CdpGetFrameOwnerResult {
    backendNodeId?: number
    nodeId?: number
}

interface CdpExceptionDetails {
    text?: string
    exception?: {
        description?: string
    }
}

interface CdpRuntimeObject {
    objectId?: string
    value?: unknown
}

interface CdpResolveNodeResult {
    object?: CdpRuntimeObject
}

interface CdpRuntimeEvaluateResult {
    result: CdpRuntimeObject
    exceptionDetails?: CdpExceptionDetails
}

interface CdpRuntimeCallFunctionResult {
    result: CdpRuntimeObject
    exceptionDetails?: CdpExceptionDetails
}

interface FrameRecord {
    frameId: string
    parentFrameId: string | null
}

type FrameStabilityResult =
    | { kind: 'resolved' }
    | { kind: 'rejected'; error: unknown }
    | { kind: 'timeout' }

export class StealthWaitUnavailableError extends Error {
    constructor(cause?: unknown) {
        super('Stealth visual wait requires Chromium CDP support.', { cause })
        this.name = 'StealthWaitUnavailableError'
    }
}

export function isStealthWaitUnavailableError(
    error: unknown
): error is StealthWaitUnavailableError {
    return error instanceof StealthWaitUnavailableError
}

const FRAME_OWNER_VISIBILITY_FUNCTION = `function() {
    if (!(this instanceof HTMLElement)) return false;

    var rect = this.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= window.innerHeight ||
        rect.left >= window.innerWidth
    ) {
        return false;
    }

    var style = window.getComputedStyle(this);
    if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
    ) {
        return false;
    }

    return true;
}`

// String expression to avoid esbuild's __name() transform inside evaluate calls.
function buildStabilityScript(timeout: number, settleMs: number): string {
    return `new Promise(function(resolve) {
    var deadline = Date.now() + ${timeout};
    var resolved = false;
    var timer = null;
    var observers = [];
    var observedShadowRoots = [];
    var fonts = document.fonts;
    var fontsReady = !fonts || fonts.status === 'loaded';
    var lastRelevantMutationAt = Date.now();

    function clearObservers() {
        for (var i = 0; i < observers.length; i++) {
            observers[i].disconnect();
        }
        observers = [];
    }

    function done() {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        if (safetyTimer) clearTimeout(safetyTimer);
        clearObservers();
        resolve();
    }

    function isElementVisiblyIntersectingViewport(element) {
        if (!(element instanceof Element)) return false;

        var rect = element.getBoundingClientRect();
        var inViewport =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth;

        if (!inViewport) return false;

        var style = window.getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') {
            return false;
        }
        if (Number(style.opacity) === 0) {
            return false;
        }

        return true;
    }

    function resolveRelevantElement(node) {
        if (!node) return null;
        if (node instanceof Element) return node;
        if (typeof ShadowRoot !== 'undefined' && node instanceof ShadowRoot) {
            return node.host instanceof Element ? node.host : null;
        }
        var parentElement = node.parentElement;
        return parentElement instanceof Element ? parentElement : null;
    }

    function isNodeVisiblyRelevant(node) {
        var element = resolveRelevantElement(node);
        if (!element) return false;
        return isElementVisiblyIntersectingViewport(element);
    }

    function hasRelevantMutation(records) {
        for (var i = 0; i < records.length; i++) {
            var record = records[i];
            if (isNodeVisiblyRelevant(record.target)) return true;

            var addedNodes = record.addedNodes;
            for (var j = 0; j < addedNodes.length; j++) {
                if (isNodeVisiblyRelevant(addedNodes[j])) return true;
            }

            var removedNodes = record.removedNodes;
            for (var k = 0; k < removedNodes.length; k++) {
                if (isNodeVisiblyRelevant(removedNodes[k])) return true;
            }
        }

        return false;
    }

    function scheduleCheck() {
        if (resolved) return;
        if (timer) clearTimeout(timer);

        var remaining = deadline - Date.now();
        if (remaining <= 0) {
            done();
            return;
        }

        var checkDelay = Math.min(120, Math.max(16, ${settleMs}));
        timer = setTimeout(checkNow, checkDelay);
    }

    function observeMutations(target) {
        if (!target) return;
        var observer = new MutationObserver(function(records) {
            if (!hasRelevantMutation(records)) return;
            lastRelevantMutationAt = Date.now();
            scheduleCheck();
        });
        observer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
        });
        observers.push(observer);
    }

    function hasObservedShadowRoot(root) {
        for (var i = 0; i < observedShadowRoots.length; i++) {
            if (observedShadowRoots[i] === root) return true;
        }
        return false;
    }

    function observeOpenShadowRoots() {
        if (!document.documentElement || !document.createTreeWalker) return;
        var walker = document.createTreeWalker(
            document.documentElement,
            NodeFilter.SHOW_ELEMENT
        );
        while (walker.nextNode()) {
            var current = walker.currentNode;
            if (!(current instanceof Element)) continue;
            var shadowRoot = current.shadowRoot;
            if (!shadowRoot || shadowRoot.mode !== 'open') continue;
            if (hasObservedShadowRoot(shadowRoot)) continue;
            observedShadowRoots.push(shadowRoot);
            observeMutations(shadowRoot);
        }
    }

    function checkViewportImages(root) {
        var images = root.querySelectorAll('img');
        for (var i = 0; i < images.length; i++) {
            var img = images[i];
            if (!isElementVisiblyIntersectingViewport(img)) continue;
            if (!img.complete) return false;
        }
        return true;
    }

    function getAnimationTarget(effect) {
        if (!effect) return null;
        var target = effect.target;
        if (target instanceof Element) return target;

        if (target && target.element instanceof Element) {
            return target.element;
        }

        return null;
    }

    function hasRunningVisibleFiniteAnimations() {
        if (typeof document.getAnimations !== 'function') return false;
        var animations = document.getAnimations();

        for (var i = 0; i < animations.length; i++) {
            var animation = animations[i];
            if (!animation || animation.playState !== 'running') continue;
            var effect = animation.effect;
            if (!effect || typeof effect.getComputedTiming !== 'function') continue;
            var timing = effect.getComputedTiming();
            var endTime = timing && typeof timing.endTime === 'number'
                ? timing.endTime
                : Number.POSITIVE_INFINITY;
            if (Number.isFinite(endTime) && endTime > 0) {
                var target = getAnimationTarget(effect);
                if (!target) continue;
                if (!isElementVisiblyIntersectingViewport(target)) continue;
                return true;
            }
        }

        return false;
    }

    function isVisuallyReady() {
        if (!fontsReady) return false;
        if (!checkViewportImages(document)) return false;
        if (hasRunningVisibleFiniteAnimations()) return false;
        return true;
    }

    function checkNow() {
        if (Date.now() >= deadline) {
            done();
            return;
        }

        observeOpenShadowRoots();

        if (!isVisuallyReady()) {
            scheduleCheck();
            return;
        }

        if (Date.now() - lastRelevantMutationAt >= ${settleMs}) {
            done();
            return;
        }

        scheduleCheck();
    }

    observeMutations(document.documentElement);
    observeOpenShadowRoots();

    if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
        fonts.ready.then(function() {
            fontsReady = true;
            scheduleCheck();
        }, function() {
            fontsReady = true;
            scheduleCheck();
        });
    }

    var safetyTimer = setTimeout(done, ${timeout});

    scheduleCheck();
})`
}

class StealthCdpRuntime {
    private readonly contextsByFrame = new Map<string, number>()
    private disposed = false

    private constructor(private readonly session: CDPSession) {}

    static async create(page: Page): Promise<StealthCdpRuntime> {
        let session: CDPSession
        try {
            session = await page.context().newCDPSession(page)
        } catch (error) {
            throw new StealthWaitUnavailableError(error)
        }

        const runtime = new StealthCdpRuntime(session)

        try {
            await runtime.initialize()
            return runtime
        } catch (error) {
            await runtime.dispose()
            throw new StealthWaitUnavailableError(error)
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        this.contextsByFrame.clear()
        await this.session.detach().catch(() => undefined)
    }

    async waitForMainFrameVisualStability(options: VisualStabilityOptions): Promise<void> {
        const timeout = options.timeout ?? DEFAULT_TIMEOUT
        const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
        if (timeout <= 0) return

        const frameRecords = await this.getFrameRecords()
        const mainFrame = frameRecords[0]
        if (!mainFrame) return

        await this.waitForFrameVisualStability(
            mainFrame.frameId,
            timeout,
            settleMs,
            true
        )
    }

    async collectVisibleFrameIds(): Promise<string[]> {
        const frameRecords = await this.getFrameRecords()
        if (frameRecords.length === 0) return []

        const visibleFrameIds: string[] = []

        for (const frameRecord of frameRecords) {
            if (!frameRecord.parentFrameId) {
                visibleFrameIds.push(frameRecord.frameId)
                continue
            }

            try {
                const parentContextId = await this.ensureFrameContextId(
                    frameRecord.parentFrameId
                )
                const visible = await this.isFrameOwnerVisible(
                    frameRecord.frameId,
                    parentContextId
                )
                if (visible) {
                    visibleFrameIds.push(frameRecord.frameId)
                }
            } catch (error) {
                if (isIgnorableFrameError(error)) continue
                throw error
            }
        }

        return visibleFrameIds
    }

    async waitForFrameVisualStability(
        frameId: string,
        timeout: number,
        settleMs: number,
        retryTransientContextErrors = true
    ): Promise<void> {
        if (timeout <= 0) return

        const script = buildStabilityScript(timeout, settleMs)

        if (!retryTransientContextErrors) {
            let contextId = await this.ensureFrameContextId(frameId)

            try {
                await this.evaluateWithGuard(contextId, script, timeout)
            } catch (error) {
                if (!isMissingExecutionContextError(error)) {
                    throw error
                }

                this.contextsByFrame.delete(frameId)
                contextId = await this.ensureFrameContextId(frameId)
                await this.evaluateWithGuard(contextId, script, timeout)
            }

            return
        }

        const deadline = Date.now() + timeout

        while (true) {
            const remaining = Math.max(0, deadline - Date.now())
            if (remaining === 0) {
                return
            }

            const contextId = await this.ensureFrameContextId(frameId)
            try {
                await this.evaluateWithGuard(contextId, script, remaining)
                return
            } catch (error) {
                if (!isTransientExecutionContextError(error)) {
                    throw error
                }

                this.contextsByFrame.delete(frameId)

                const retryDelay = Math.min(
                    TRANSIENT_CONTEXT_RETRY_DELAY_MS,
                    Math.max(0, deadline - Date.now())
                )
                await sleep(retryDelay)
            }
        }
    }

    private async initialize(): Promise<void> {
        await this.session.send('Page.enable')
        await this.session.send('Runtime.enable')
        await this.session.send('DOM.enable')
    }

    private async getFrameRecords(): Promise<FrameRecord[]> {
        const treeResult =
            (await this.session.send('Page.getFrameTree')) as CdpGetFrameTreeResult

        const records: FrameRecord[] = []
        walkFrameTree(treeResult.frameTree, null, records)
        return records
    }

    private async ensureFrameContextId(frameId: string): Promise<number> {
        const cached = this.contextsByFrame.get(frameId)
        if (cached != null) {
            return cached
        }

        const world = (await this.session.send('Page.createIsolatedWorld', {
            frameId,
            worldName: STEALTH_WORLD_NAME,
        })) as CdpCreateIsolatedWorldResult

        this.contextsByFrame.set(frameId, world.executionContextId)
        return world.executionContextId
    }

    private async evaluateWithGuard(
        contextId: number,
        script: string,
        timeout: number
    ): Promise<void> {
        const evaluationPromise = this.evaluateScript(contextId, script)
        const settledPromise = evaluationPromise.then(
            () => ({ kind: 'resolved' } as const),
            (error: unknown) => ({ kind: 'rejected', error } as const)
        )
        const timeoutPromise: Promise<FrameStabilityResult> = sleep(
            timeout + FRAME_EVALUATE_GRACE_MS
        ).then(() => ({ kind: 'timeout' } as const))

        const result: FrameStabilityResult = await Promise.race([
            settledPromise,
            timeoutPromise,
        ])

        if (result.kind === 'rejected') {
            throw result.error
        }
    }

    private async evaluateScript(
        contextId: number,
        expression: string
    ): Promise<void> {
        const result = (await this.session.send('Runtime.evaluate', {
            contextId,
            expression,
            awaitPromise: true,
            returnByValue: true,
        })) as CdpRuntimeEvaluateResult

        if (result.exceptionDetails) {
            throw new Error(formatCdpException(result.exceptionDetails))
        }
    }

    private async isFrameOwnerVisible(
        frameId: string,
        parentContextId: number
    ): Promise<boolean> {
        const owner = (await this.session.send('DOM.getFrameOwner', {
            frameId,
        })) as CdpGetFrameOwnerResult

        const resolveParams: {
            executionContextId: number
            backendNodeId?: number
            nodeId?: number
        } = {
            executionContextId: parentContextId,
        }

        if (typeof owner.backendNodeId === 'number') {
            resolveParams.backendNodeId = owner.backendNodeId
        } else if (typeof owner.nodeId === 'number') {
            resolveParams.nodeId = owner.nodeId
        } else {
            return false
        }

        const resolved = (await this.session.send(
            'DOM.resolveNode',
            resolveParams
        )) as CdpResolveNodeResult

        const objectId = resolved.object?.objectId
        if (!objectId) return false

        try {
            const callResult = (await this.session.send('Runtime.callFunctionOn', {
                objectId,
                functionDeclaration: FRAME_OWNER_VISIBILITY_FUNCTION,
                returnByValue: true,
            })) as CdpRuntimeCallFunctionResult

            if (callResult.exceptionDetails) {
                throw new Error(formatCdpException(callResult.exceptionDetails))
            }

            return callResult.result.value === true
        } finally {
            await this.releaseObject(objectId)
        }
    }

    private async releaseObject(objectId: string): Promise<void> {
        await this.session
            .send('Runtime.releaseObject', {
                objectId,
            })
            .catch(() => undefined)
    }
}

export async function waitForVisualStability(
    page: Page,
    options: VisualStabilityOptions = {}
): Promise<void> {
    const runtime = await StealthCdpRuntime.create(page)

    try {
        await runtime.waitForMainFrameVisualStability(options)
    } finally {
        await runtime.dispose()
    }
}

export async function waitForVisualStabilityAcrossFrames(
    page: Page,
    options: VisualStabilityOptions = {}
): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    if (timeout <= 0) return

    const deadline = Date.now() + timeout
    const runtime = await StealthCdpRuntime.create(page)

    try {
        while (true) {
            const remaining = Math.max(0, deadline - Date.now())
            if (remaining === 0) return

            const frameIds = await runtime.collectVisibleFrameIds()
            if (frameIds.length === 0) return

            await Promise.all(
                frameIds.map(async (frameId) => {
                    try {
                        await runtime.waitForFrameVisualStability(
                            frameId,
                            remaining,
                            settleMs,
                            false
                        )
                    } catch (error) {
                        if (isIgnorableFrameError(error)) return
                        throw error
                    }
                })
            )

            const currentFrameIds = await runtime.collectVisibleFrameIds()
            if (sameFrameIds(frameIds, currentFrameIds)) {
                return
            }
        }
    } finally {
        await runtime.dispose()
    }
}

function walkFrameTree(
    node: CdpFrameTreeNode,
    parentFrameId: string | null,
    records: FrameRecord[]
): void {
    const frameId = node.frame?.id
    if (!frameId) return

    records.push({
        frameId,
        parentFrameId,
    })

    for (const child of node.childFrames ?? []) {
        walkFrameTree(child, frameId, records)
    }
}

function sameFrameIds(before: string[], after: string[]): boolean {
    if (before.length !== after.length) return false

    for (const frameId of before) {
        if (!after.includes(frameId)) return false
    }

    return true
}

function formatCdpException(details: CdpExceptionDetails): string {
    return (
        details.exception?.description ||
        details.text ||
        'CDP runtime evaluation failed.'
    )
}

function isTransientExecutionContextError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const message = error.message
    return (
        message.includes('Execution context was destroyed') ||
        message.includes('Cannot find context with specified id') ||
        message.includes('Cannot find execution context')
    )
}

function isMissingExecutionContextError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const message = error.message
    return (
        message.includes('Cannot find context with specified id') ||
        message.includes('Cannot find execution context')
    )
}

function isIgnorableFrameError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const message = error.message

    return (
        message.includes('Frame was detached') ||
        message.includes('Target page, context or browser has been closed') ||
        isTransientExecutionContextError(error) ||
        message.includes('No frame for given id found')
    )
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}
