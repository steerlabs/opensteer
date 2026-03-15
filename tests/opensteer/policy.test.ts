import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createDocumentEpoch,
  createDocumentRef,
  createFrameRef,
  createNodeLocator,
  createNodeRef,
  createPageRef,
  createPoint,
  createRect,
  createScrollOffset,
  createSize,
  createDevicePixelRatio,
  createPageScaleFactor,
  createPageZoomFactor,
  type BrowserCoreEngine,
  type DomSnapshot,
  type DomSnapshotNode,
  type HitTestResult,
} from "../../packages/browser-core/src/index.js";
import {
  checkActionability,
  defaultPolicy,
  delayWithSignal,
  runWithPolicyTimeout,
  settleWithPolicy,
  type ActionabilityCheckInput,
  type SettlePolicy,
  type TimeoutPolicy,
} from "../../packages/opensteer/src/index.js";
import type { ResolvedDomTarget } from "../../packages/opensteer/src/runtimes/dom/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Phase 7 policy actionability", () => {
  test("reports missing geometry", async () => {
    const fixture = createActionabilityFixture({});
    const result = await checkActionability(fixture.input);

    expect(result).toMatchObject({
      actionable: false,
      reason: "missing-geometry",
    });
  });

  test("reports hidden attribute and aria-hidden as not-visible", async () => {
    const hidden = await checkActionability(
      createActionabilityFixture({
        attributes: [{ name: "hidden", value: "" }],
      }).input,
    );
    const ariaHidden = await checkActionability(
      createActionabilityFixture({
        attributes: [{ name: "aria-hidden", value: "true" }],
      }).input,
    );

    expect(hidden).toMatchObject({
      actionable: false,
      reason: "not-visible",
      details: { attribute: "hidden" },
    });
    expect(ariaHidden).toMatchObject({
      actionable: false,
      reason: "not-visible",
      details: { attribute: "aria-hidden" },
    });
  });

  test("folds zero-size geometry into not-visible", async () => {
    const fixture = createActionabilityFixture({
      rect: createRect(10, 20, 0, 24),
    });

    const result = await checkActionability(fixture.input);

    expect(result).toMatchObject({
      actionable: false,
      reason: "not-visible",
    });
  });

  test("reports disabled and aria-disabled", async () => {
    const disabled = await checkActionability(
      createActionabilityFixture({
        rect: createRect(10, 20, 80, 24),
        attributes: [{ name: "disabled", value: "" }],
      }).input,
    );
    const ariaDisabled = await checkActionability(
      createActionabilityFixture({
        rect: createRect(10, 20, 80, 24),
        attributes: [{ name: "aria-disabled", value: "true" }],
      }).input,
    );

    expect(disabled).toMatchObject({
      actionable: false,
      reason: "disabled",
      details: { attribute: "disabled" },
    });
    expect(ariaDisabled).toMatchObject({
      actionable: false,
      reason: "disabled",
      details: { attribute: "aria-disabled" },
    });
  });

  test("reports not-in-viewport when the action point is outside the visual viewport", async () => {
    const fixture = createActionabilityFixture({
      rect: createRect(180, 20, 80, 24),
      viewportWidth: 100,
      viewportHeight: 100,
    });

    const result = await checkActionability(fixture.input);

    expect(result).toMatchObject({
      actionable: false,
      reason: "not-in-viewport",
    });
  });

  test("reports obscured when hit test lands outside the target subtree", async () => {
    const fixture = createActionabilityFixture({
      rect: createRect(10, 20, 80, 24),
      hitNodeRef: createNodeRef("overlay"),
      hitObscured: true,
    });

    const result = await checkActionability(fixture.input);

    expect(result).toMatchObject({
      actionable: false,
      reason: "obscured",
      details: {
        hitNodeRef: fixture.hitNodeRef,
        hitObscured: true,
      },
    });
  });

  test("accepts descendant hits inside the target subtree and returns the resolved page point", async () => {
    const fixture = createActionabilityFixture({
      rect: createRect(10, 20, 80, 24),
      includeDescendant: true,
    });

    const result = await checkActionability(fixture.input);

    expect(result).toEqual({
      actionable: true,
      point: createPoint(50, 32),
    });
  });

  test("accepts wrapping label hits for activation operations", async () => {
    for (const operation of ["dom.click", "dom.input"] as const) {
      const fixture = createActionabilityFixture({
        rect: createRect(10, 20, 80, 24),
        operation,
        labelAssociation: "ancestor",
      });

      const result = await checkActionability(fixture.input);

      expect(result).toEqual({
        actionable: true,
        point: createPoint(50, 32),
      });
    }
  });

  test("accepts external label hits when the label is associated via for", async () => {
    for (const operation of ["dom.click", "dom.input"] as const) {
      const fixture = createActionabilityFixture({
        rect: createRect(10, 20, 80, 24),
        operation,
        labelAssociation: "for",
      });

      const result = await checkActionability(fixture.input);

      expect(result).toEqual({
        actionable: true,
        point: createPoint(50, 32),
      });
    }
  });

  test("keeps associated label hits obscured for non-activation operations", async () => {
    const fixture = createActionabilityFixture({
      rect: createRect(10, 20, 80, 24),
      operation: "dom.hover",
      labelAssociation: "for",
    });

    const result = await checkActionability(fixture.input);

    expect(result).toMatchObject({
      actionable: false,
      reason: "obscured",
      details: {
        hitNodeRef: fixture.hitNodeRef,
      },
    });
  });
});

describe("Phase 7 policy timeout", () => {
  test("returns results that complete before the deadline", async () => {
    vi.useFakeTimers();
    const policy: TimeoutPolicy = {
      resolveTimeoutMs() {
        return 50;
      },
    };

    const promise = runWithPolicyTimeout(policy, { operation: "dom.click" }, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      return "ok";
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(promise).resolves.toBe("ok");
  });

  test("prevents post-timeout continuation when steps use the timeout context", async () => {
    vi.useFakeTimers();
    let sideEffect = false;
    const policy: TimeoutPolicy = {
      resolveTimeoutMs() {
        return 50;
      },
    };

    const promise = runWithPolicyTimeout(policy, { operation: "dom.click" }, async (timeout) => {
      await timeout.runStep(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 60);
          }),
      );
      sideEffect = true;
      return "late";
    });

    const assertion = expect(promise).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    await vi.advanceTimersByTimeAsync(20);
    expect(sideEffect).toBe(false);
  });

  test("throws timeout errors with operation details", async () => {
    vi.useFakeTimers();
    const policy: TimeoutPolicy = {
      resolveTimeoutMs() {
        return 50;
      },
    };

    const promise = runWithPolicyTimeout(policy, { operation: "page.snapshot" }, async () => {
      await new Promise<void>(() => undefined);
      return "never";
    });

    const assertion = expect(promise).rejects.toMatchObject({
      name: "OpensteerProtocolError",
      code: "timeout",
      details: {
        policy: "timeout",
        operation: "page.snapshot",
        budgetMs: 50,
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });
});

describe("Phase 7 policy settle", () => {
  test("exports immutable default policy objects", () => {
    const policy = defaultPolicy();

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.settle)).toBe(true);
    expect(Object.isFrozen(policy.settle.observers)).toBe(true);
    expect(() =>
      Array.prototype.push.call(policy.settle.observers, {
        settle: async () => true,
      }),
    ).toThrow(TypeError);
    expect(defaultPolicy().settle.observers).toHaveLength(0);
  });

  test("skips fixed delays when configured as zero", async () => {
    vi.useFakeTimers();
    const policy: SettlePolicy = {
      observers: [],
      resolveDelayMs() {
        return 0;
      },
    };

    const promise = settleWithPolicy(policy, createSettleContext("dom-action"));
    await expect(promise).resolves.toBeUndefined();
  });

  test("uses dom-action and navigation defaults", async () => {
    vi.useFakeTimers();
    const policy = defaultPolicy().settle;

    const domPromise = settleWithPolicy(policy, createSettleContext("dom-action"));
    await vi.advanceTimersByTimeAsync(99);
    let domSettled = false;
    void domPromise.then(() => {
      domSettled = true;
    });
    expect(domSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await domPromise;

    const navigationPromise = settleWithPolicy(policy, createSettleContext("navigation"));
    await vi.advanceTimersByTimeAsync(499);
    let navigationSettled = false;
    void navigationPromise.then(() => {
      navigationSettled = true;
    });
    expect(navigationSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await navigationPromise;
  });

  test("lets observers short-circuit the fallback delay", async () => {
    vi.useFakeTimers();
    const observer = vi.fn(async () => true);
    const policy: SettlePolicy = {
      observers: [{ settle: observer }],
      resolveDelayMs() {
        return 500;
      },
    };

    const promise = settleWithPolicy(policy, createSettleContext("navigation"));
    await expect(promise).resolves.toBeUndefined();
    expect(observer).toHaveBeenCalledTimes(1);
  });

  test("falls back to fixed delay when observers decline", async () => {
    vi.useFakeTimers();
    const observer = vi.fn(async () => false);
    const policy: SettlePolicy = {
      observers: [{ settle: observer }],
      resolveDelayMs() {
        return 100;
      },
    };

    const promise = settleWithPolicy(policy, createSettleContext("dom-action"));
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(observer).toHaveBeenCalledTimes(1);
  });

  test("aborts settle delays via AbortSignal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = delayWithSignal(100, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });

    setTimeout(() => controller.abort(), 10);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});

function createActionabilityFixture(options: {
  readonly rect?: ReturnType<typeof createRect>;
  readonly attributes?: readonly { readonly name: string; readonly value: string }[];
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  readonly hitNodeRef?: ReturnType<typeof createNodeRef>;
  readonly hitObscured?: boolean;
  readonly includeDescendant?: boolean;
  readonly operation?: ActionabilityCheckInput["operation"];
  readonly labelAssociation?: "ancestor" | "for";
}): {
  readonly input: ActionabilityCheckInput;
  readonly hitNodeRef: ReturnType<typeof createNodeRef>;
} {
  const pageRef = createPageRef("page-1");
  const frameRef = createFrameRef("frame-1");
  const documentRef = createDocumentRef("document-1");
  const documentEpoch = createDocumentEpoch(1);
  const targetNodeRef = createNodeRef("target");
  const labelNodeRef = createNodeRef("label");
  const descendantNodeRef = createNodeRef("child");
  const targetId = "target-input";
  const targetAttributes = [...(options.attributes ?? [])];
  if (
    options.labelAssociation === "for" &&
    !targetAttributes.some((attribute) => attribute.name.toLowerCase() === "id")
  ) {
    targetAttributes.push({ name: "id", value: targetId });
  }
  const hitNodeRef =
    options.hitNodeRef ??
    (options.labelAssociation === undefined
      ? options.includeDescendant
        ? descendantNodeRef
        : targetNodeRef
      : labelNodeRef);
  const rect = options.rect;
  const descendantRect = rect ?? createRect(10, 20, 80, 24);
  const targetSnapshotNodeId = options.labelAssociation === "ancestor" ? 3 : 2;
  const descendantSnapshotNodeId = options.labelAssociation === "ancestor" ? 4 : 3;
  const rootChildSnapshotNodeIds =
    options.labelAssociation === "ancestor"
      ? [2]
      : options.labelAssociation === "for"
        ? [2, 3]
        : [2];

  const targetNode: DomSnapshotNode = {
    snapshotNodeId: targetSnapshotNodeId,
    nodeRef: targetNodeRef,
    parentSnapshotNodeId: options.labelAssociation === "ancestor" ? 2 : 1,
    childSnapshotNodeIds: options.includeDescendant ? [descendantSnapshotNodeId] : [],
    nodeType: 1,
    nodeName: options.labelAssociation === undefined ? "BUTTON" : "INPUT",
    nodeValue: "",
    textContent: options.labelAssociation === undefined ? "Action" : "",
    attributes: targetAttributes,
    ...(rect === undefined ? {} : { layout: { rect } }),
  };

  const nodes: DomSnapshotNode[] = [
    {
      snapshotNodeId: 1,
      childSnapshotNodeIds: rootChildSnapshotNodeIds,
      nodeType: 9,
      nodeName: "#document",
      nodeValue: "",
      attributes: [],
    },
  ];

  if (options.labelAssociation === "ancestor") {
    nodes.push({
      snapshotNodeId: 2,
      nodeRef: labelNodeRef,
      parentSnapshotNodeId: 1,
      childSnapshotNodeIds: [targetSnapshotNodeId],
      nodeType: 1,
      nodeName: "LABEL",
      nodeValue: "",
      textContent: "Label",
      attributes: [],
    });
  }

  nodes.push(targetNode);

  if (options.labelAssociation === "for") {
    nodes.push({
      snapshotNodeId: 3,
      nodeRef: labelNodeRef,
      parentSnapshotNodeId: 1,
      childSnapshotNodeIds: [],
      nodeType: 1,
      nodeName: "LABEL",
      nodeValue: "",
      textContent: "Label",
      attributes: [{ name: "for", value: targetId }],
    });
  }

  if (options.includeDescendant) {
    nodes.push({
      snapshotNodeId: descendantSnapshotNodeId,
      nodeRef: descendantNodeRef,
      parentSnapshotNodeId: targetSnapshotNodeId,
      childSnapshotNodeIds: [],
      nodeType: 1,
      nodeName: "SPAN",
      nodeValue: "",
      textContent: "Label",
      attributes: [],
      layout: {
        rect: createRect(descendantRect.x, descendantRect.y, 40, 24),
      },
    });
  }

  const snapshot: DomSnapshot = {
    pageRef,
    frameRef,
    documentRef,
    documentEpoch,
    url: "https://example.test",
    capturedAt: 0,
    rootSnapshotNodeId: 1,
    shadowDomMode: "flattened",
    geometryCoordinateSpace: "document-css",
    nodes,
  };

  const engine = createStubEngine({
    pageRef,
    frameRef,
    documentRef,
    documentEpoch,
    hitNodeRef,
    hitObscured: options.hitObscured ?? false,
    viewportWidth: options.viewportWidth ?? 500,
    viewportHeight: options.viewportHeight ?? 500,
  });

  return {
    input: {
      engine,
      operation: options.operation ?? "dom.click",
      resolved: {
        source: "selector",
        pageRef,
        frameRef,
        documentRef,
        documentEpoch,
        nodeRef: targetNodeRef,
        locator: createNodeLocator(documentRef, documentEpoch, targetNodeRef),
        snapshot,
        node: targetNode,
        anchor: { resolution: "structural", context: [], nodes: [] },
        selectorUsed: "#target",
      } satisfies ResolvedDomTarget,
      loadDocumentSnapshot: async () => snapshot,
    },
    hitNodeRef,
  };
}

function createStubEngine(input: {
  readonly pageRef: ReturnType<typeof createPageRef>;
  readonly frameRef: ReturnType<typeof createFrameRef>;
  readonly documentRef: ReturnType<typeof createDocumentRef>;
  readonly documentEpoch: ReturnType<typeof createDocumentEpoch>;
  readonly hitNodeRef: ReturnType<typeof createNodeRef>;
  readonly hitObscured: boolean;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): BrowserCoreEngine {
  const hitTestResult: HitTestResult = {
    inputPoint: createPoint(0, 0),
    inputCoordinateSpace: "document-css",
    resolvedPoint: createPoint(0, 0),
    resolvedCoordinateSpace: "document-css",
    pageRef: input.pageRef,
    frameRef: input.frameRef,
    documentRef: input.documentRef,
    documentEpoch: input.documentEpoch,
    nodeRef: input.hitNodeRef,
    obscured: input.hitObscured,
    pointerEventsSkipped: false,
  };

  return {
    capabilities: {} as BrowserCoreEngine["capabilities"],
    async hitTest(args) {
      return {
        ...hitTestResult,
        inputPoint: args.point,
        resolvedPoint: args.point,
      };
    },
    async getViewportMetrics() {
      return {
        layoutViewport: {
          origin: createPoint(0, 0),
          size: createSize(input.viewportWidth, input.viewportHeight),
        },
        visualViewport: {
          origin: createPoint(0, 0),
          offsetWithinLayoutViewport: createScrollOffset(0, 0),
          size: createSize(input.viewportWidth, input.viewportHeight),
        },
        scrollOffset: createScrollOffset(0, 0),
        contentSize: createSize(input.viewportWidth, input.viewportHeight),
        devicePixelRatio: createDevicePixelRatio(1),
        pageScaleFactor: createPageScaleFactor(1),
        pageZoomFactor: createPageZoomFactor(1),
      };
    },
  } as unknown as BrowserCoreEngine;
}

function createSettleContext(trigger: "navigation" | "dom-action") {
  return {
    operation: trigger === "navigation" ? "page.goto" : "dom.click",
    trigger,
    engine: {} as BrowserCoreEngine,
    pageRef: createPageRef(`page-${trigger}`),
    signal: new AbortController().signal,
  } as const;
}
