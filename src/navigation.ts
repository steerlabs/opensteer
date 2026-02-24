import type { Frame, Page } from 'playwright'

const DEFAULT_TIMEOUT = 30000
const DEFAULT_SETTLE_MS = 750
const FRAME_EVALUATE_GRACE_MS = 200

interface VisualStabilityOptions {
    timeout?: number
    settleMs?: number
}

// String expression to avoid esbuild's __name() transform inside frame/page.evaluate.
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

export async function waitForVisualStability(
    page: Page,
    options: VisualStabilityOptions = {}
): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS

    await waitForFrameVisualStability(page.mainFrame(), {
        timeout,
        settleMs,
    })
}

export async function waitForVisualStabilityAcrossFrames(
    page: Page,
    options: VisualStabilityOptions = {}
): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    const deadline = Date.now() + timeout

    while (true) {
        const remaining = Math.max(0, deadline - Date.now())
        if (remaining === 0) return

        const frames = await collectVisibleFrames(page)
        if (!frames.length) return

        await Promise.all(
            frames.map(async (frame) => {
                try {
                    await waitForFrameVisualStability(frame, {
                        timeout: remaining,
                        settleMs,
                    })
                } catch (error) {
                    if (isIgnorableFrameError(error)) return
                    throw error
                }
            })
        )

        const currentFrames = await collectVisibleFrames(page)
        if (sameFrames(frames, currentFrames)) {
            return
        }
    }
}

async function waitForFrameVisualStability(
    frame: Frame,
    options: VisualStabilityOptions
): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    if (timeout <= 0) return

    await evaluateFrameStabilityWithGuard(
        frame,
        buildStabilityScript(timeout, settleMs),
        timeout
    )
}

type FrameStabilityResult =
    | { kind: 'resolved' }
    | { kind: 'rejected'; error: unknown }
    | { kind: 'timeout' }

async function evaluateFrameStabilityWithGuard(
    frame: Frame,
    script: string,
    timeout: number
): Promise<void> {
    const evaluationPromise = frame.evaluate(script)
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

function sameFrames(before: Frame[], after: Frame[]): boolean {
    if (before.length !== after.length) return false

    for (const frame of before) {
        if (!after.includes(frame)) return false
    }
    return true
}

async function collectVisibleFrames(page: Page): Promise<Frame[]> {
    const visibleFrames: Frame[] = []

    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) {
            visibleFrames.push(frame)
            continue
        }

        try {
            const frameElement = await frame.frameElement()
            try {
                const isVisible = await frameElement.evaluate((node) => {
                    if (!(node instanceof HTMLElement)) return false

                    const rect = node.getBoundingClientRect()
                    if (rect.width <= 0 || rect.height <= 0) return false
                    if (
                        rect.bottom <= 0 ||
                        rect.right <= 0 ||
                        rect.top >= window.innerHeight ||
                        rect.left >= window.innerWidth
                    ) {
                        return false
                    }

                    const style = window.getComputedStyle(node)
                    if (
                        style.display === 'none' ||
                        style.visibility === 'hidden' ||
                        Number(style.opacity) === 0
                    ) {
                        return false
                    }

                    return true
                })

                if (isVisible) {
                    visibleFrames.push(frame)
                }
            } finally {
                await frameElement.dispose()
            }
        } catch (error) {
            if (isIgnorableFrameError(error)) continue
            visibleFrames.push(frame)
        }
    }

    return visibleFrames
}

function isIgnorableFrameError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const message = error.message
    return (
        message.includes('Frame was detached') ||
        message.includes('Execution context was destroyed') ||
        message.includes('Target page, context or browser has been closed')
    )
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}
