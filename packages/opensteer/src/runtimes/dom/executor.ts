import {
  createPoint,
  createRect,
  quadBounds,
  rectContainsPoint,
  type BrowserCoreEngine,
  type DocumentRef,
  type DomSnapshot,
  type HitTestResult,
  type PageRef,
  type Point,
  type Quad,
  type Rect,
  type ViewportMetrics,
} from "@opensteer/browser-core";
import { OpensteerProtocolError } from "@opensteer/protocol";

import {
  assertValidActionPosition,
  runWithPolicyTimeout,
  settleWithPolicy,
  type DomActionPolicyOperation,
  type OpensteerPolicy,
  type TimeoutExecutionContext,
} from "../../policy/index.js";
import { resolveDomActionBridge, type DomActionBridge, type DomActionTargetInspection } from "./bridge.js";
import { createSnapshotIndex } from "./path.js";
import { isSameNodeOrDescendant } from "./selectors.js";
import type {
  DomActionOutcome,
  DomClickInput,
  DomDescriptorRecord,
  DomHoverInput,
  DomInputInput,
  DomResolveTargetInput,
  DomScrollInput,
  DomTargetRef,
  DomWriteDescriptorInput,
  ResolvedDomTarget,
} from "./types.js";

interface DomActionResolutionSession {
  getDocument(documentRef: DocumentRef): Promise<DomSnapshot>;
}

interface DomActionExecutorOptions {
  readonly engine: BrowserCoreEngine;
  readonly policy: OpensteerPolicy;
  createResolutionSession(): DomActionResolutionSession;
  resolveTarget(
    session: DomActionResolutionSession,
    input: DomResolveTargetInput & {
      readonly descriptorWriter?: (input: DomWriteDescriptorInput) => Promise<DomDescriptorRecord>;
    },
  ): Promise<ResolvedDomTarget>;
  writeDescriptor(input: DomWriteDescriptorInput): Promise<DomDescriptorRecord>;
}

const MAX_DOM_ACTION_ATTEMPTS = 3;
const DEFAULT_SCROLL_OPTIONS = {
  block: "center",
  inline: "center",
} as const;

export class DomActionExecutor {
  private readonly bridge: DomActionBridge | undefined;

  constructor(private readonly options: DomActionExecutorOptions) {
    this.bridge = resolveDomActionBridge(options.engine);
  }

  async click(input: DomClickInput): Promise<DomActionOutcome> {
    return this.executePointerAction(
      {
        operation: "dom.click",
        pageRef: input.pageRef,
        target: input.target,
        ...(input.position === undefined ? {} : { position: input.position }),
        ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
      },
      async (resolved, point, timeout) => {
        await timeout.runStep(() =>
          this.options.engine.mouseMove({
            pageRef: resolved.pageRef,
            point,
            coordinateSpace: "document-css",
          }),
        );
        await timeout.runStep(() =>
          this.options.engine.mouseClick({
            pageRef: resolved.pageRef,
            point,
            coordinateSpace: "document-css",
            ...(input.button === undefined ? {} : { button: input.button }),
            ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount }),
            ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
          }),
        );
        return { resolved, point };
      },
    );
  }

  async hover(input: DomHoverInput): Promise<DomActionOutcome> {
    return this.executePointerAction(
      {
        operation: "dom.hover",
        pageRef: input.pageRef,
        target: input.target,
        ...(input.position === undefined ? {} : { position: input.position }),
        ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
      },
      async (resolved, point, timeout) => {
        await timeout.runStep(() =>
          this.options.engine.mouseMove({
            pageRef: resolved.pageRef,
            point,
            coordinateSpace: "document-css",
          }),
        );
        return { resolved, point };
      },
    );
  }

  async scroll(input: DomScrollInput): Promise<DomActionOutcome> {
    return this.executePointerAction(
      {
        operation: "dom.scroll",
        pageRef: input.pageRef,
        target: input.target,
        ...(input.position === undefined ? {} : { position: input.position }),
        ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
      },
      async (resolved, point, timeout) => {
        await timeout.runStep(() =>
          this.options.engine.mouseMove({
            pageRef: resolved.pageRef,
            point,
            coordinateSpace: "document-css",
          }),
        );
        await timeout.runStep(() =>
          this.options.engine.mouseScroll({
            pageRef: resolved.pageRef,
            point,
            coordinateSpace: "document-css",
            delta: input.delta,
          }),
        );
        return { resolved, point };
      },
    );
  }

  async input(input: DomInputInput): Promise<ResolvedDomTarget> {
    return this.executeWithinTimeout(input.timeout, "dom.input", async (timeout) => {
      const bridge = this.requireBridge();
      let lastError: unknown;

      for (let attempt = 0; attempt < MAX_DOM_ACTION_ATTEMPTS; attempt += 1) {
        const session = this.options.createResolutionSession();
        try {
          const resolved = await timeout.runStep(() =>
            this.options.resolveTarget(session, {
              pageRef: input.pageRef,
              method: "dom.input",
              target: input.target,
              descriptorWriter: (writeInput) => timeout.runStep(() => this.options.writeDescriptor(writeInput)),
            }),
          );

          const inspectionBeforeScroll = await timeout.runStep(() =>
            bridge.inspectActionTarget(resolved.locator),
          );
          this.assertKeyboardActionable("dom.input", resolved, inspectionBeforeScroll, {
            allowTransientVisibilityFailure: true,
          });

          await timeout.runStep(() =>
            bridge.scrollNodeIntoView(resolved.locator, DEFAULT_SCROLL_OPTIONS),
          );

          const inspectionAfterScroll = await timeout.runStep(() =>
            bridge.inspectActionTarget(resolved.locator),
          );
          this.assertKeyboardActionable("dom.input", resolved, inspectionAfterScroll);

          await timeout.runStep(() => bridge.focusNode(resolved.locator));
          await timeout.runStep(() =>
            this.options.engine.textInput({
              pageRef: resolved.pageRef,
              text: input.text,
            }),
          );
          if (input.pressEnter) {
            await timeout.runStep(() =>
              this.options.engine.keyPress({
                pageRef: resolved.pageRef,
                key: "Enter",
              }),
            );
          }

          await this.settle(resolved.pageRef, "dom.input", timeout);
          return resolved;
        } catch (error) {
          lastError = error;
          if (!this.shouldRetry(error) || attempt === MAX_DOM_ACTION_ATTEMPTS - 1) {
            throw error;
          }
        }
      }

      throw lastError ?? new Error("DOM input exhausted all retries");
    });
  }

  private async executePointerAction<TResult>(
    input: {
      readonly operation: Extract<DomActionPolicyOperation, "dom.click" | "dom.hover" | "dom.scroll">;
      readonly pageRef: PageRef;
      readonly target: DomTargetRef;
      readonly position?: Point;
      readonly timeout?: TimeoutExecutionContext;
    },
    dispatch: (
      resolved: ResolvedDomTarget,
      point: Point,
      timeout: TimeoutExecutionContext,
    ) => Promise<TResult>,
  ): Promise<TResult> {
    return this.executeWithinTimeout(input.timeout, input.operation, async (timeout) => {
      const bridge = this.requireBridge();
      let lastError: unknown;

      for (let attempt = 0; attempt < MAX_DOM_ACTION_ATTEMPTS; attempt += 1) {
        const session = this.options.createResolutionSession();
        try {
          const resolved = await timeout.runStep(() =>
            this.options.resolveTarget(session, {
              pageRef: input.pageRef,
              method: input.operation,
              target: input.target,
              descriptorWriter: (writeInput) => timeout.runStep(() => this.options.writeDescriptor(writeInput)),
            }),
          );

          if (input.position !== undefined) {
            assertValidActionPosition(resolved, input.position);
          }

          const inspectionBeforeScroll = await timeout.runStep(() =>
            bridge.inspectActionTarget(resolved.locator),
          );
          this.assertPointerActionable(input.operation, resolved, inspectionBeforeScroll, {
            allowTransientVisibilityFailure: true,
          });

          await timeout.runStep(() =>
            bridge.scrollNodeIntoView(resolved.locator, DEFAULT_SCROLL_OPTIONS),
          );

          const inspectionAfterScroll = await timeout.runStep(() =>
            bridge.inspectActionTarget(resolved.locator),
          );
          this.assertPointerActionable(input.operation, resolved, inspectionAfterScroll);

          const point = await timeout.runStep(() =>
            this.computeActionPoint(input.operation, resolved, inspectionAfterScroll, input.position),
          );
          if (input.operation !== "dom.scroll") {
            const hit = await timeout.runStep(() =>
              this.tryHitTest(resolved.pageRef, point),
            );
            if (hit !== undefined) {
              this.assertHitTarget(input.operation, resolved, point, hit);
            }
          }

          const outcome = await dispatch(resolved, point, timeout);
          await this.settle(resolved.pageRef, input.operation, timeout);
          return outcome;
        } catch (error) {
          lastError = error;
          if (!this.shouldRetry(error) || attempt === MAX_DOM_ACTION_ATTEMPTS - 1) {
            throw error;
          }
        }
      }

      throw lastError ?? new Error(`${input.operation} exhausted all retries`);
    });
  }

  private async executeWithinTimeout<TResult>(
    timeout: TimeoutExecutionContext | undefined,
    operation: DomActionPolicyOperation,
    execute: (timeout: TimeoutExecutionContext) => Promise<TResult>,
  ): Promise<TResult> {
    if (timeout !== undefined) {
      return execute(timeout);
    }

    return runWithPolicyTimeout(this.options.policy.timeout, { operation }, execute);
  }

  private async settle(
    pageRef: PageRef,
    operation: DomActionPolicyOperation,
    timeout: TimeoutExecutionContext,
  ): Promise<void> {
    const bridge = this.requireBridge();
    await timeout.runStep(() =>
      bridge.settleAfterDomAction(pageRef, {
        signal: timeout.signal,
        remainingMs: () => timeout.remainingMs(),
      }),
    );
    await timeout.runStep(() =>
      settleWithPolicy(this.options.policy.settle, {
        operation,
        trigger: "dom-action",
        engine: this.options.engine,
        pageRef,
        signal: timeout.signal,
      }),
    );
  }

  private requireBridge(): DomActionBridge {
    if (this.bridge !== undefined) {
      return this.bridge;
    }

    throw new OpensteerProtocolError(
      "unsupported-capability",
      "current engine does not expose a DOM action bridge",
      {
        details: {
          operation: "dom.click",
        },
      },
    );
  }

  private async computeActionPoint(
    operation: DomActionPolicyOperation,
    resolved: ResolvedDomTarget,
    inspection: DomActionTargetInspection,
    position: Point | undefined,
  ): Promise<Point> {
    const metrics = await this.options.engine.getViewportMetrics({ pageRef: resolved.pageRef });
    const viewportRect = toViewportRect(metrics);

    if (position !== undefined) {
      const bounds = inspection.bounds;
      if (bounds === undefined) {
        throw this.createActionabilityError(
          operation,
          "not-visible",
          `target ${resolved.nodeRef} does not expose live DOM geometry`,
          undefined,
          true,
        );
      }

      const point = createPoint(bounds.x + position.x, bounds.y + position.y);
      if (!rectContainsPoint(bounds, point) || !pointFallsWithinQuads(point, inspection.contentQuads)) {
        throw this.createActionabilityError(
          operation,
          "obscured",
          `target ${resolved.nodeRef} shifted before the requested action point became actionable`,
          {
            rect: bounds,
            point,
            viewportRect,
          },
          true,
        );
      }
      return point;
    }

    for (const quad of inspection.contentQuads) {
      const candidateRect = intersectRects(quadBounds(quad), viewportRect);
      if (candidateRect === undefined || candidateRect.width === 0 || candidateRect.height === 0) {
        continue;
      }
      return createPoint(
        candidateRect.x + candidateRect.width / 2,
        candidateRect.y + candidateRect.height / 2,
      );
    }

    const rect = inspection.bounds;
    const reason = rect === undefined ? "not-visible" : "not-in-viewport";
    throw this.createActionabilityError(
      operation,
      reason,
      `target ${resolved.nodeRef} has no visible actionable point after scrolling`,
      {
        ...(rect === undefined ? {} : { rect }),
        viewportRect,
      },
      true,
    );
  }

  private assertPointerActionable(
    operation: DomActionPolicyOperation,
    resolved: ResolvedDomTarget,
    inspection: DomActionTargetInspection,
    options: {
      readonly allowTransientVisibilityFailure?: boolean;
    } = {},
  ): void {
    this.assertConnected(resolved, inspection);
    this.assertEnabled(operation, resolved, inspection);

    if (inspection.visible) {
      return;
    }

    const attribute = findSnapshotVisibilityAttribute(resolved);
    throw this.createActionabilityError(
      operation,
      "not-visible",
      attribute === undefined
        ? `target ${resolved.nodeRef} is not visible`
        : `target ${resolved.nodeRef} is hidden`,
      {
        ...(inspection.bounds === undefined ? {} : { rect: inspection.bounds }),
        ...(attribute === undefined ? {} : { attribute }),
      },
      options.allowTransientVisibilityFailure && attribute === undefined,
    );
  }

  private assertKeyboardActionable(
    operation: DomActionPolicyOperation,
    resolved: ResolvedDomTarget,
    inspection: DomActionTargetInspection,
    options: {
      readonly allowTransientVisibilityFailure?: boolean;
    } = {},
  ): void {
    this.assertPointerActionable(operation, resolved, inspection, options);

    if (inspection.editable) {
      return;
    }

    const attribute = findSnapshotEditabilityAttribute(resolved);
    throw this.createActionabilityError(
      operation,
      "disabled",
      `target ${resolved.nodeRef} is not editable`,
      {
        ...(inspection.bounds === undefined ? {} : { rect: inspection.bounds }),
        ...(attribute === undefined ? {} : { attribute }),
      },
    );
  }

  private assertConnected(
    resolved: ResolvedDomTarget,
    inspection: DomActionTargetInspection,
  ): void {
    if (inspection.connected) {
      return;
    }

    throw new OpensteerProtocolError(
      "stale-node-ref",
      `node ${resolved.nodeRef} became detached before ${resolved.source} could be acted on`,
      {
        retriable: true,
        details: {
          nodeRef: resolved.nodeRef,
          documentRef: resolved.documentRef,
          documentEpoch: resolved.documentEpoch,
        },
      },
    );
  }

  private assertEnabled(
    operation: DomActionPolicyOperation,
    resolved: ResolvedDomTarget,
    inspection: DomActionTargetInspection,
  ): void {
    if (inspection.enabled) {
      return;
    }

    const attribute = findSnapshotDisabledAttribute(resolved);
    throw this.createActionabilityError(
      operation,
      "disabled",
      `target ${resolved.nodeRef} is disabled`,
      {
        ...(inspection.bounds === undefined ? {} : { rect: inspection.bounds }),
        ...(attribute === undefined ? {} : { attribute }),
      },
    );
  }

  private assertHitTarget(
    operation: DomActionPolicyOperation,
    resolved: ResolvedDomTarget,
    point: Point,
    hit: HitTestResult,
  ): void {
    const details = {
      ...(resolved.node.layout?.rect === undefined ? {} : { rect: resolved.node.layout.rect }),
      point,
      ...(hit.nodeRef === undefined ? {} : { hitNodeRef: hit.nodeRef }),
      hitDocumentRef: hit.documentRef,
      hitDocumentEpoch: hit.documentEpoch,
      hitObscured: hit.obscured,
      pointerEventsSkipped: hit.pointerEventsSkipped,
    };

    if (hit.documentRef !== resolved.documentRef || hit.documentEpoch !== resolved.documentEpoch) {
      throw this.createActionabilityError(
        operation,
        "obscured",
        `hit test resolved outside ${resolved.documentRef}@${String(resolved.documentEpoch)}`,
        details,
        true,
      );
    }

    if (hit.nodeRef === undefined) {
      throw this.createActionabilityError(
        operation,
        "obscured",
        `hit test did not resolve a live node for ${operation}`,
        details,
        true,
      );
    }

    const index = createSnapshotIndex(resolved.snapshot);
    if (isSameNodeOrDescendant(index, hit.nodeRef, resolved.nodeRef)) {
      return;
    }

    throw this.createActionabilityError(
      operation,
      "obscured",
      `hit test resolved ${hit.nodeRef} outside the target subtree rooted at ${resolved.nodeRef}`,
      details,
      true,
    );
  }

  private createActionabilityError(
    operation: DomActionPolicyOperation,
    reason: "missing-geometry" | "not-visible" | "disabled" | "not-in-viewport" | "obscured",
    message: string,
    details?: Readonly<Record<string, unknown>>,
    retriable = false,
  ): OpensteerProtocolError {
    return new OpensteerProtocolError("operation-failed", message, {
      retriable,
      details: {
        policy: "actionability",
        operation,
        reason,
        ...(details === undefined ? {} : details),
      },
    });
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof OpensteerProtocolError) {
      if (error.code === "stale-node-ref") {
        return true;
      }
      return error.retriable;
    }

    if (error && typeof error === "object" && "code" in error) {
      const candidate = error as { readonly code?: unknown; readonly retriable?: unknown };
      return candidate.code === "stale-node-ref" || candidate.retriable === true;
    }

    return false;
  }

  private async tryHitTest(pageRef: PageRef, point: Point): Promise<HitTestResult | undefined> {
    try {
      return await this.options.engine.hitTest({
        pageRef,
        point,
        coordinateSpace: "document-css",
      });
    } catch (error) {
      if (error instanceof Error && /No node found at given location/i.test(error.message)) {
        return undefined;
      }
      throw error;
    }
  }
}

function findSnapshotVisibilityAttribute(resolved: ResolvedDomTarget): string | undefined {
  if (hasAttribute(resolved, "hidden")) {
    return "hidden";
  }
  if (readAttributeValue(resolved, "aria-hidden") === "true") {
    return "aria-hidden";
  }
  return undefined;
}

function findSnapshotDisabledAttribute(resolved: ResolvedDomTarget): string | undefined {
  if (hasAttribute(resolved, "disabled")) {
    return "disabled";
  }
  if (readAttributeValue(resolved, "aria-disabled") === "true") {
    return "aria-disabled";
  }
  return undefined;
}

function findSnapshotEditabilityAttribute(resolved: ResolvedDomTarget): string | undefined {
  if (hasAttribute(resolved, "readonly")) {
    return "readonly";
  }
  return findSnapshotDisabledAttribute(resolved);
}

function hasAttribute(resolved: ResolvedDomTarget, name: string): boolean {
  return resolved.node.attributes.some((attribute) => attribute.name === name);
}

function readAttributeValue(resolved: ResolvedDomTarget, name: string): string | undefined {
  return resolved.node.attributes.find((attribute) => attribute.name === name)?.value;
}

function pointFallsWithinQuads(point: Point, quads: readonly Quad[]): boolean {
  return quads.some((quad) => rectContainsPoint(quadBounds(quad), point));
}

function toViewportRect(metrics: ViewportMetrics): Rect {
  return createRect(
    metrics.visualViewport.origin.x,
    metrics.visualViewport.origin.y,
    metrics.visualViewport.size.width,
    metrics.visualViewport.size.height,
  );
}

function intersectRects(left: Rect, right: Rect): Rect | undefined {
  const minX = Math.max(left.x, right.x);
  const minY = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);

  if (maxX < minX || maxY < minY) {
    return undefined;
  }

  return createRect(minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY));
}
