import type { Frame, Page } from 'playwright'

const DEFAULT_TIMEOUT = 30000
const DEFAULT_SETTLE_MS = 750

interface VisualStabilityOptions {
    timeout?: number
    settleMs?: number
}

// String expression to avoid esbuild's __name() transform inside frame/page.evaluate.
function buildStabilityScript(timeout: number, settleMs: number): string {
    return `new Promise(function(resolve) {
    var deadline = Date.now() + ${timeout};
    var timer = null;
    var resolved = false;
    var observers = [];
    var observedShadowRoots = [];
    var fonts = document.fonts;
    var fontsReady = !fonts || fonts.status === 'loaded';

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

    function observeMutations(target) {
        if (!target) return;
        var observer = new MutationObserver(function() { settle(); });
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
            var rect = img.getBoundingClientRect();
            var inViewport =
                rect.bottom > 0 &&
                rect.right > 0 &&
                rect.top < window.innerHeight &&
                rect.left < window.innerWidth;
            if (inViewport && !img.complete) return false;
        }
        return true;
    }

    function hasRunningFiniteAnimations() {
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
                return true;
            }
        }

        return false;
    }

    function isVisuallyReady() {
        if (!fontsReady) return false;
        if (!checkViewportImages(document)) return false;
        if (hasRunningFiniteAnimations()) return false;
        return true;
    }

    function settle() {
        if (Date.now() > deadline) { done(); return; }
        if (timer) clearTimeout(timer);
        observeOpenShadowRoots();
        timer = setTimeout(function() {
            if (isVisuallyReady()) {
                done();
            } else {
                settle();
            }
        }, ${settleMs});
    }

    observeMutations(document.documentElement);
    observeOpenShadowRoots();

    if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
        fonts.ready.then(function() {
            fontsReady = true;
            settle();
        });
    }

    var safetyTimer = setTimeout(done, ${timeout});

    settle();
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

        const frames = page.frames()
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

        const currentFrames = page.frames()
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

    await frame.evaluate(buildStabilityScript(timeout, settleMs))
}

function sameFrames(before: Frame[], after: Frame[]): boolean {
    if (before.length !== after.length) return false

    for (const frame of before) {
        if (!after.includes(frame)) return false
    }
    return true
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
