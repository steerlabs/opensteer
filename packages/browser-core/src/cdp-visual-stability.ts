import type { VisualStabilityScope } from "./snapshots.js";

export const DEFAULT_VISUAL_STABILITY_TIMEOUT_MS = 30_000;
export const DEFAULT_VISUAL_STABILITY_SETTLE_MS = 750;

const FRAME_EVALUATE_GRACE_MS = 200;
const TRANSIENT_CONTEXT_RETRY_DELAY_MS = 25;
const STEALTH_WORLD_NAME = "__opensteer_wait__";

interface CdpSessionLike {
  send(method: string, params?: object): Promise<unknown>;
}

interface VisualStabilityOptions {
  readonly timeoutMs?: number;
  readonly settleMs?: number;
  readonly initialQuietMs?: number;
  readonly scope?: VisualStabilityScope;
}

interface CdpFrameTreeNode {
  readonly frame?: {
    readonly id?: string;
  };
  readonly childFrames?: readonly CdpFrameTreeNode[];
}

interface CdpGetFrameTreeResult {
  readonly frameTree: CdpFrameTreeNode;
}

interface CdpCreateIsolatedWorldResult {
  readonly executionContextId: number;
}

interface CdpGetFrameOwnerResult {
  readonly backendNodeId?: number;
}

interface CdpExceptionDetails {
  readonly text?: string;
  readonly exception?: {
    readonly description?: string;
  };
}

interface CdpRuntimeObject {
  readonly objectId?: string;
  readonly value?: unknown;
}

interface CdpResolveNodeResult {
  readonly object?: CdpRuntimeObject;
}

interface CdpRuntimeEvaluateResult {
  readonly result: CdpRuntimeObject;
  readonly exceptionDetails?: CdpExceptionDetails;
}

interface CdpRuntimeCallFunctionResult {
  readonly result: CdpRuntimeObject;
  readonly exceptionDetails?: CdpExceptionDetails;
}

interface FrameRecord {
  readonly frameId: string;
  readonly parentFrameId: string | null;
}

type FrameStabilityResult =
  | { readonly kind: "resolved" }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "timeout" };

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
}`;

export async function waitForCdpVisualStability(
  cdp: CdpSessionLike,
  options: VisualStabilityOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VISUAL_STABILITY_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_VISUAL_STABILITY_SETTLE_MS;
  const initialQuietMs = Math.max(0, options.initialQuietMs ?? 0);
  const scope = options.scope ?? "main-frame";

  if (timeoutMs <= 0) {
    return;
  }

  const runtime = new StealthCdpRuntime(cdp);
  if (scope === "visible-frames") {
    await runtime.waitForVisibleFramesVisualStability(timeoutMs, settleMs, initialQuietMs);
    return;
  }

  await runtime.waitForMainFrameVisualStability(timeoutMs, settleMs, initialQuietMs);
}

function buildStabilityScript(timeout: number, settleMs: number, initialQuietMs: number): string {
  return `new Promise(function(resolve) {
    var deadline = Date.now() + ${timeout};
    var resolved = false;
    var timer = null;
    var observers = [];
    var observedShadowRoots = [];
    var fonts = document.fonts;
    var fontsReady = !fonts || fonts.status === 'loaded';
    var viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    var minorMutationAreaPx = Math.max(900, Math.min(6000, viewportArea * 0.0025));
    var compactActionAreaPx = Math.max(196, Math.min(2500, viewportArea * 0.0008));
    var blockingImageAreaPx = Math.max(50000, Math.min(200000, viewportArea * 0.15));
    var blockingAnimationAreaPx = Math.max(14000, Math.min(90000, viewportArea * 0.02));
    var lastRelevantMutationAt = Date.now() - ${initialQuietMs};

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

    function getVisibleArea(element) {
        if (!(element instanceof Element)) return 0;

        var rect = element.getBoundingClientRect();
        var width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
        var height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        return width * height;
    }

    function elementContainsViewportCenter(element) {
        if (!(element instanceof Element)) return false;

        var rect = element.getBoundingClientRect();
        var centerX = window.innerWidth / 2;
        var centerY = window.innerHeight / 2;
        return (
            rect.left <= centerX &&
            rect.right >= centerX &&
            rect.top <= centerY &&
            rect.bottom >= centerY
        );
    }

    function isInteractiveElement(element) {
        if (!(element instanceof Element) || typeof element.closest !== 'function') return false;
        return !!element.closest(
            'a[href],button,input,select,textarea,summary,' +
            '[role="button"],[role="link"],[role="checkbox"],[role="radio"],' +
            '[role="menuitem"],[role="option"],[role="dialog"],[role="menu"],' +
            '[role="listbox"],[contenteditable=""],[contenteditable="true"]'
        );
    }

    function hasSubstantialVisibleText(element) {
        if (!(element instanceof Element)) return false;

        var text = element.textContent;
        return typeof text === 'string' && text.trim().length >= 16;
    }

    function isElementVisuallySignificant(element) {
        if (!isElementVisiblyIntersectingViewport(element)) return false;

        var visibleArea = getVisibleArea(element);
        if (visibleArea >= minorMutationAreaPx) return true;
        if (visibleArea >= compactActionAreaPx && elementContainsViewportCenter(element)) return true;
        if (visibleArea >= compactActionAreaPx && isInteractiveElement(element)) return true;
        if (visibleArea >= compactActionAreaPx && hasSubstantialVisibleText(element)) return true;
        return false;
    }

    function isPotentiallyVisualAttribute(attributeName) {
        if (!attributeName) return true;
        if (attributeName === 'class' || attributeName === 'style') return true;
        if (
            attributeName === 'hidden' ||
            attributeName === 'open' ||
            attributeName === 'value' ||
            attributeName === 'checked' ||
            attributeName === 'selected' ||
            attributeName === 'disabled' ||
            attributeName === 'src' ||
            attributeName === 'srcset' ||
            attributeName === 'sizes' ||
            attributeName === 'poster'
        ) {
            return true;
        }
        if (attributeName.startsWith('data-')) return false;
        if (attributeName.startsWith('aria-')) {
            return (
                attributeName === 'aria-hidden' ||
                attributeName === 'aria-expanded' ||
                attributeName === 'aria-modal' ||
                attributeName === 'aria-pressed' ||
                attributeName === 'aria-selected' ||
                attributeName === 'aria-checked' ||
                attributeName === 'aria-current'
            );
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
        return isElementVisuallySignificant(element);
    }

    function hasRelevantMutation(records) {
        for (var i = 0; i < records.length; i++) {
            var record = records[i];

            if (record.type === 'attributes') {
                if (
                    isPotentiallyVisualAttribute(record.attributeName) &&
                    isNodeVisiblyRelevant(record.target)
                ) {
                    return true;
                }
                continue;
            }

            if (record.type === 'characterData') {
                if (isNodeVisiblyRelevant(record.target)) return true;
                continue;
            }

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
            var visibleArea = getVisibleArea(img);
            if (
                visibleArea < blockingImageAreaPx &&
                !(elementContainsViewportCenter(img) && visibleArea >= compactActionAreaPx)
            ) {
                continue;
            }
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
                var visibleArea = getVisibleArea(target);
                var remaining = Number.POSITIVE_INFINITY;
                if (typeof animation.currentTime === 'number') {
                    remaining = Math.max(0, endTime - animation.currentTime);
                }
                if (remaining <= 150) continue;
                if (
                    visibleArea < blockingAnimationAreaPx &&
                    !(visibleArea >= compactActionAreaPx && isInteractiveElement(target)) &&
                    !(visibleArea >= compactActionAreaPx && elementContainsViewportCenter(target))
                ) {
                    continue;
                }
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
})`;
}

class StealthCdpRuntime {
  private readonly contextsByFrame = new Map<string, number>();

  constructor(private readonly session: CdpSessionLike) {}

  async waitForMainFrameVisualStability(
    timeoutMs: number,
    settleMs: number,
    initialQuietMs: number,
  ): Promise<void> {
    const frameRecords = await this.getFrameRecords();
    const mainFrame = frameRecords[0];
    if (!mainFrame) {
      return;
    }

    await this.waitForFrameVisualStability(
      mainFrame.frameId,
      timeoutMs,
      settleMs,
      initialQuietMs,
      true,
    );
  }

  async waitForVisibleFramesVisualStability(
    timeoutMs: number,
    settleMs: number,
    initialQuietMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) {
        return;
      }

      const frameIds = await this.collectVisibleFrameIds();
      if (frameIds.length === 0) {
        return;
      }

      await Promise.all(
        frameIds.map(async (frameId) => {
          try {
            await this.waitForFrameVisualStability(
              frameId,
              remaining,
              settleMs,
              initialQuietMs,
              false,
            );
          } catch (error) {
            if (isIgnorableFrameError(error)) {
              return;
            }
            throw error;
          }
        }),
      );

      const currentFrameIds = await this.collectVisibleFrameIds();
      if (sameFrameIds(frameIds, currentFrameIds)) {
        return;
      }
    }
  }

  private async getFrameRecords(): Promise<FrameRecord[]> {
    const treeResult = (await this.session.send("Page.getFrameTree")) as CdpGetFrameTreeResult;
    const records: FrameRecord[] = [];
    walkFrameTree(treeResult.frameTree, null, records);
    return records;
  }

  private async collectVisibleFrameIds(): Promise<string[]> {
    const frameRecords = await this.getFrameRecords();
    if (frameRecords.length === 0) {
      return [];
    }

    const visibleFrameIds: string[] = [];
    for (const frameRecord of frameRecords) {
      if (!frameRecord.parentFrameId) {
        visibleFrameIds.push(frameRecord.frameId);
        continue;
      }

      try {
        const parentContextId = await this.ensureFrameContextId(frameRecord.parentFrameId);
        if (await this.isFrameOwnerVisible(frameRecord.frameId, parentContextId)) {
          visibleFrameIds.push(frameRecord.frameId);
        }
      } catch (error) {
        if (isIgnorableFrameError(error)) {
          continue;
        }
        throw error;
      }
    }

    return visibleFrameIds;
  }

  private async ensureFrameContextId(frameId: string): Promise<number> {
    const existing = this.contextsByFrame.get(frameId);
    if (existing !== undefined) {
      return existing;
    }

    const world = (await this.session.send("Page.createIsolatedWorld", {
      frameId,
      worldName: STEALTH_WORLD_NAME,
    })) as CdpCreateIsolatedWorldResult;
    this.contextsByFrame.set(frameId, world.executionContextId);
    return world.executionContextId;
  }

  private async waitForFrameVisualStability(
    frameId: string,
    timeoutMs: number,
    settleMs: number,
    initialQuietMs: number,
    retryTransientContextErrors: boolean,
  ): Promise<void> {
    if (timeoutMs <= 0) {
      return;
    }

    const script = buildStabilityScript(timeoutMs, settleMs, initialQuietMs);

    if (!retryTransientContextErrors) {
      let contextId = await this.ensureFrameContextId(frameId);
      try {
        await this.evaluateWithGuard(contextId, script, timeoutMs);
      } catch (error) {
        if (!isMissingExecutionContextError(error)) {
          throw error;
        }
        this.contextsByFrame.delete(frameId);
        contextId = await this.ensureFrameContextId(frameId);
        await this.evaluateWithGuard(contextId, script, timeoutMs);
      }
      return;
    }

    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) {
        return;
      }

      const contextId = await this.ensureFrameContextId(frameId);
      try {
        await this.evaluateWithGuard(contextId, script, remaining);
        return;
      } catch (error) {
        if (!isTransientExecutionContextError(error)) {
          throw error;
        }
        this.contextsByFrame.delete(frameId);
        await sleep(Math.min(TRANSIENT_CONTEXT_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())));
      }
    }
  }

  private async evaluateWithGuard(
    contextId: number,
    script: string,
    timeoutMs: number,
  ): Promise<void> {
    const guardedPromise = this.evaluateScript(contextId, script)
      .then<FrameStabilityResult>(() => ({ kind: "resolved" }))
      .catch<FrameStabilityResult>((error) => ({ kind: "rejected", error }));
    const timeoutPromise = new Promise<FrameStabilityResult>((resolve) => {
      setTimeout(() => resolve({ kind: "timeout" }), timeoutMs + FRAME_EVALUATE_GRACE_MS);
    });
    const outcome = await Promise.race([guardedPromise, timeoutPromise]);
    if (outcome.kind === "rejected") {
      throw outcome.error;
    }
  }

  private async evaluateScript(contextId: number, script: string): Promise<void> {
    const evaluated = (await this.session.send("Runtime.evaluate", {
      contextId,
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    })) as CdpRuntimeEvaluateResult;
    if (evaluated.exceptionDetails) {
      throw new Error(formatCdpException(evaluated.exceptionDetails));
    }
  }

  private async isFrameOwnerVisible(frameId: string, executionContextId: number): Promise<boolean> {
    const frameOwner = (await this.session.send("DOM.getFrameOwner", {
      frameId,
    })) as CdpGetFrameOwnerResult;
    if (frameOwner.backendNodeId === undefined) {
      return false;
    }

    const resolved = (await this.session.send("DOM.resolveNode", {
      backendNodeId: frameOwner.backendNodeId,
      executionContextId,
    })) as CdpResolveNodeResult;
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      return false;
    }

    try {
      const callResult = (await this.session.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: FRAME_OWNER_VISIBILITY_FUNCTION,
        returnByValue: true,
      })) as CdpRuntimeCallFunctionResult;
      if (callResult.exceptionDetails) {
        throw new Error(formatCdpException(callResult.exceptionDetails));
      }
      return callResult.result.value === true;
    } finally {
      await this.releaseObject(objectId);
    }
  }

  private async releaseObject(objectId: string): Promise<void> {
    await this.session
      .send("Runtime.releaseObject", {
        objectId,
      })
      .catch(() => undefined);
  }
}

function walkFrameTree(
  node: CdpFrameTreeNode,
  parentFrameId: string | null,
  records: FrameRecord[],
): void {
  const frameId = node.frame?.id;
  if (!frameId) {
    return;
  }

  records.push({
    frameId,
    parentFrameId,
  });

  for (const child of node.childFrames ?? []) {
    walkFrameTree(child, frameId, records);
  }
}

function sameFrameIds(before: readonly string[], after: readonly string[]): boolean {
  if (before.length !== after.length) {
    return false;
  }
  return before.every((frameId) => after.includes(frameId));
}

function formatCdpException(details: CdpExceptionDetails): string {
  return details.exception?.description || details.text || "CDP runtime evaluation failed.";
}

function isIgnorableFrameError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    message.includes("Frame with the given id was not found") ||
    message.includes("No frame for given id found") ||
    isTransientExecutionContextError(error)
  );
}

function isTransientExecutionContextError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("Cannot find context with specified id") ||
    message.includes("Cannot find execution context")
  );
}

function isMissingExecutionContextError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    message.includes("Cannot find context with specified id") ||
    message.includes("Cannot find execution context")
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
