import {
  type ActionBoundarySnapshot,
  createNodeLocator,
  createPoint,
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
} from "@opensteer/browser-core";
import { OpensteerProtocolError } from "@opensteer/protocol";

import { captureActionBoundarySnapshot } from "../../action-boundary.js";
import {
  runWithPolicyTimeout,
  settleWithPolicy,
  type DomActionPolicyOperation,
  type OpensteerPolicy,
  type TimeoutExecutionContext,
} from "../../policy/index.js";
import {
  resolveDomActionBridge,
  type DomActionBridge,
  type DomActionTargetInspection,
} from "./bridge.js";
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

interface ActionablePointerTarget {
  readonly resolved: ResolvedDomTarget;
  readonly original: ResolvedDomTarget;
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
      async (pointerTarget, point, timeout) => {
        await timeout.runStep(() =>
          this.options.engine.mouseMove({
            pageRef: pointerTarget.resolved.pageRef,
            point,
            coordinateSpace: "document-css",
          }),
        );
        await timeout.runStep(() =>
          this.options.engine.mouseClick({
            pageRef: pointerTarget.resolved.pageRef,
            point,
            coordinateSpace: "document-css",
            ...(input.button === undefined ? {} : { button: input.button }),
            ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount }),
            ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
          }),
        );
        return { resolved: pointerTarget.original, point };
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
      async (pointerTarget, point, timeout) => {
        await timeout.runStep(() =>
          this.options.engine.mouseMove({
            pageRef: pointerTarget.resolved.pageRef,
            point,
            coordinateSpace: "document-css",
          }),
        );
        return { resolved: pointerTarget.original, point };
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
      async (pointerTarget, point, timeout) => {
        await timeout.runStep(() =>
          this.options.engine.mouseMove({
            pageRef: pointerTarget.resolved.pageRef,
            point,
            coordinateSpace: "document-css",
          }),
        );
        await timeout.runStep(() =>
          this.options.engine.mouseScroll({
            pageRef: pointerTarget.resolved.pageRef,
            point,
            coordinateSpace: "document-css",
            delta: input.delta,
          }),
        );
        return { resolved: pointerTarget.original, point };
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
              descriptorWriter: (writeInput) =>
                timeout.runStep(() => this.options.writeDescriptor(writeInput)),
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
          let finalResolved = resolved;
          let finalSnapshot: ActionBoundarySnapshot | undefined;
          if (input.pressEnter) {
            await this.settle(resolved.pageRef, "dom.input", timeout);

            const enterSession = this.options.createResolutionSession();
            const enterResolved = await timeout.runStep(() =>
              this.options.resolveTarget(enterSession, {
                pageRef: input.pageRef,
                method: "dom.input",
                target: input.target,
                descriptorWriter: (writeInput) =>
                  timeout.runStep(() => this.options.writeDescriptor(writeInput)),
              }),
            );
            const inspectionBeforeEnter = await timeout.runStep(() =>
              bridge.inspectActionTarget(enterResolved.locator),
            );
            this.assertKeyboardActionable("dom.input", enterResolved, inspectionBeforeEnter);
            finalSnapshot = await timeout.runStep(() =>
              captureActionBoundarySnapshot(this.options.engine, enterResolved.pageRef),
            );

            await timeout.runStep(() =>
              bridge.pressKey(enterResolved.locator, {
                key: "Enter",
              }),
            );
            finalResolved = enterResolved;
          }

          await this.settle(finalResolved.pageRef, "dom.input", timeout, finalSnapshot);
          return finalResolved;
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
      readonly operation: Extract<
        DomActionPolicyOperation,
        "dom.click" | "dom.hover" | "dom.scroll"
      >;
      readonly pageRef: PageRef;
      readonly target: DomTargetRef;
      readonly position?: Point;
      readonly timeout?: TimeoutExecutionContext;
    },
    dispatch: (
      pointerTarget: ActionablePointerTarget,
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
              descriptorWriter: (writeInput) =>
                timeout.runStep(() => this.options.writeDescriptor(writeInput)),
            }),
          );
          const pointerTarget = await timeout.runStep(() =>
            this.resolveActionablePointerTarget(session, input.operation, resolved),
          );

          if (input.position !== undefined) {
            assertValidResolvedActionPosition(pointerTarget.resolved, input.position);
          }

          const inspectionBeforeScroll = await timeout.runStep(() =>
            bridge.inspectActionTarget(pointerTarget.resolved.locator),
          );
          this.assertPointerActionable(
            input.operation,
            pointerTarget.resolved,
            inspectionBeforeScroll,
            {
              allowTransientVisibilityFailure: true,
            },
          );

          await timeout.runStep(() =>
            bridge.scrollNodeIntoView(pointerTarget.resolved.locator, DEFAULT_SCROLL_OPTIONS),
          );

          const inspectionAfterScroll = await timeout.runStep(() =>
            bridge.inspectActionTarget(pointerTarget.resolved.locator),
          );
          this.assertPointerActionable(
            input.operation,
            pointerTarget.resolved,
            inspectionAfterScroll,
          );

          const point = await timeout.runStep(() =>
            this.computeActionPoint(
              input.operation,
              pointerTarget.resolved,
              inspectionAfterScroll,
              input.position,
            ),
          );
          if (input.operation !== "dom.scroll") {
            const hit = await timeout.runStep(() =>
              this.tryHitTest(pointerTarget.resolved.pageRef, point),
            );
            if (hit !== undefined) {
              await timeout.runStep(() =>
                this.assertHitTarget(input.operation, pointerTarget, point, hit),
              );
            }
          }

          const actionBoundarySnapshot = await timeout.runStep(() =>
            captureActionBoundarySnapshot(this.options.engine, pointerTarget.resolved.pageRef),
          );
          const outcome = await dispatch(pointerTarget, point, timeout);
          await this.settle(
            pointerTarget.resolved.pageRef,
            input.operation,
            timeout,
            actionBoundarySnapshot,
          );
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
    snapshot?: ActionBoundarySnapshot,
  ): Promise<void> {
    const bridge = this.requireBridge();
    await timeout.runStep(() =>
      bridge.finalizeDomAction(pageRef, {
        operation,
        ...(snapshot === undefined ? {} : { snapshot }),
        signal: timeout.signal,
        remainingMs: () => timeout.remainingMs(),
        policySettle: (targetPageRef, trigger) =>
          settleWithPolicy(this.options.policy.settle, {
            operation,
            trigger,
            engine: this.options.engine,
            pageRef: targetPageRef,
            signal: timeout.signal,
            remainingMs: timeout.remainingMs(),
          }),
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
    if (position !== undefined) {
      const bounds = inspection.bounds;
      if (bounds === undefined) {
        throw this.createActionabilityError(
          operation,
          "missing-geometry",
          `target ${resolved.nodeRef} does not expose live DOM geometry`,
          undefined,
          true,
        );
      }

      const point = createPoint(bounds.x + position.x, bounds.y + position.y);
      if (
        !rectContainsPoint(bounds, point) ||
        !pointFallsWithinQuads(point, inspection.contentQuads)
      ) {
        throw this.createActionabilityError(
          operation,
          "obscured",
          `target ${resolved.nodeRef} shifted before the requested action point became actionable`,
          {
            rect: bounds,
            point,
          },
          true,
        );
      }
      return point;
    }

    const quad = inspection.contentQuads[0];
    if (quad) {
      return centerOfQuad(quad);
    }

    throw this.createActionabilityError(
      operation,
      "missing-geometry",
      `target ${resolved.nodeRef} has no live actionable geometry after scrolling`,
      {
        ...(inspection.bounds === undefined ? {} : { rect: inspection.bounds }),
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

  private async assertHitTarget(
    operation: DomActionPolicyOperation,
    pointerTarget: ActionablePointerTarget,
    point: Point,
    hit: HitTestResult,
  ): Promise<void> {
    const bridge = this.requireBridge();
    const resolved = pointerTarget.resolved;
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

    const assessment = await bridge.classifyPointerHit({
      target: resolved.locator,
      hit: createNodeLocator(hit.documentRef, hit.documentEpoch, hit.nodeRef),
      point,
    });
    if (
      assessment.relation !== "outside" ||
      assessment.blocking === false ||
      assessment.ambiguous === true
    ) {
      return;
    }

    throw this.createActionabilityError(
      operation,
      "obscured",
      `hit test resolved ${hit.nodeRef} outside the target subtree rooted at ${resolved.nodeRef}`,
      {
        ...details,
        hitRelation: assessment.relation,
        ...(assessment.ambiguous === undefined ? {} : { hitAmbiguous: assessment.ambiguous }),
        ...(assessment.canonicalTarget === undefined
          ? {}
          : {
              canonicalNodeRef: assessment.canonicalTarget.nodeRef,
              canonicalDocumentRef: assessment.canonicalTarget.documentRef,
              canonicalDocumentEpoch: assessment.canonicalTarget.documentEpoch,
            }),
        ...(assessment.hitOwner === undefined
          ? {}
          : {
              hitOwnerNodeRef: assessment.hitOwner.nodeRef,
              hitOwnerDocumentRef: assessment.hitOwner.documentRef,
              hitOwnerDocumentEpoch: assessment.hitOwner.documentEpoch,
            }),
        hitMissingFromSnapshot: !resolved.snapshot.nodes.some(
          (node) => node.nodeRef === hit.nodeRef,
        ),
      },
      true,
    );
  }

  private async resolveActionablePointerTarget(
    session: DomActionResolutionSession,
    operation: Extract<DomActionPolicyOperation, "dom.click" | "dom.hover" | "dom.scroll">,
    resolved: ResolvedDomTarget,
  ): Promise<ActionablePointerTarget> {
    const canonicalLocator = await this.requireBridge().canonicalizePointerTarget(resolved.locator);
    if (
      canonicalLocator.documentRef === resolved.documentRef &&
      canonicalLocator.documentEpoch === resolved.documentEpoch &&
      canonicalLocator.nodeRef === resolved.nodeRef
    ) {
      return {
        resolved,
        original: resolved,
      };
    }

    const canonicalResolved = await this.options.resolveTarget(session, {
      pageRef: resolved.pageRef,
      method: operation,
      target: {
        kind: "live",
        locator: canonicalLocator,
      },
    });

    return {
      resolved: canonicalResolved,
      original: resolved,
    };
  }

  private createActionabilityError(
    operation: DomActionPolicyOperation,
    reason: "missing-geometry" | "not-visible" | "disabled" | "obscured",
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

function assertValidResolvedActionPosition(target: ResolvedDomTarget, position: Point): void {
  const rect = target.node.layout?.rect;
  if (!rect) {
    return;
  }

  const point = createPoint(rect.x + position.x, rect.y + position.y);
  if (!rectContainsPoint(rect, point)) {
    throw new OpensteerProtocolError(
      "invalid-argument",
      `target point for ${target.nodeRef} falls outside the resolved DOM box`,
      {
        details: {
          position,
          rect,
        },
      },
    );
  }
}

function centerOfQuad(quad: Quad): Point {
  return createPoint(
    (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  );
}

function pointFallsWithinQuads(point: Point, quads: readonly Quad[]): boolean {
  return quads.some((quad) => rectContainsPoint(quadBounds(quad), point));
}
