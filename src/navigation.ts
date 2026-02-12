import type { Page } from 'playwright'

const DEFAULT_TIMEOUT = 30000
const DEFAULT_SETTLE_MS = 750

// String expression to avoid esbuild's __name() transform inside page.evaluate.
function buildStabilityScript(timeout: number, settleMs: number): string {
    return `new Promise(function(resolve) {
    var deadline = Date.now() + ${timeout};
    var timer = null;
    var fontsReady = document.fonts.status === 'loaded';
    var resolved = false;

    function done() {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        if (timer) clearTimeout(timer);
        if (safetyTimer) clearTimeout(safetyTimer);
        resolve();
    }

    function checkViewportImages() {
        var images = document.querySelectorAll('img');
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

    function settle() {
        if (Date.now() > deadline) { done(); return; }
        if (timer) clearTimeout(timer);
        timer = setTimeout(function() {
            if (checkViewportImages() && fontsReady) {
                done();
            } else {
                settle();
            }
        }, ${settleMs});
    }

    var observer = new MutationObserver(function() { settle(); });
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
    });

    document.fonts.ready.then(function() {
        fontsReady = true;
        settle();
    });

    var safetyTimer = setTimeout(done, ${timeout});

    settle();
})`
}

export async function waitForVisualStability(
    page: Page,
    options: { timeout?: number; settleMs?: number } = {}
): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS

    await page.evaluate(buildStabilityScript(timeout, settleMs))
}
