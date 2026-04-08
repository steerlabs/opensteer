import {
  createNodeLocator,
  type BrowserCoreEngine,
  type PageRef,
  type Point,
} from "@opensteer/browser-core";
import type {
  OpensteerComputerAction,
  OpensteerComputerTraceEnrichment,
  OpensteerComputerTracePoint,
  OpensteerResolvedTarget,
} from "@opensteer/protocol";

import { buildPathSelectorHint, type DomRuntime, type ResolvedDomTarget } from "../dom/index.js";

export async function enrichComputerUseTrace(input: {
  readonly action: OpensteerComputerAction;
  readonly pageRef: PageRef;
  readonly engine: BrowserCoreEngine;
  readonly dom: DomRuntime;
}): Promise<OpensteerComputerTraceEnrichment | undefined> {
  const tracePoints = toTracePoints(input.action);
  if (tracePoints.length === 0) {
    return undefined;
  }

  const points = await Promise.all(
    tracePoints.map(async ({ role, point }) => {
      const enriched: OpensteerComputerTracePoint = {
        role,
        point,
      };

      try {
        const hitTest = await input.engine.hitTest({
          pageRef: input.pageRef,
          point,
          coordinateSpace: "layout-viewport-css",
        });
        const target = await resolveTraceTarget(input.dom, hitTest).catch(() => undefined);
        return {
          ...enriched,
          hitTest,
          ...(target === undefined ? {} : { target }),
        } satisfies OpensteerComputerTracePoint;
      } catch {
        return enriched;
      }
    }),
  );

  return {
    points,
  };
}

function toTracePoints(action: OpensteerComputerAction): readonly {
  readonly role: OpensteerComputerTracePoint["role"];
  readonly point: Point;
}[] {
  switch (action.type) {
    case "click":
    case "move":
    case "scroll":
      return [
        {
          role: "point",
          point: {
            x: action.x,
            y: action.y,
          },
        },
      ];
    case "drag":
      return [
        {
          role: "start",
          point: action.start,
        },
        {
          role: "end",
          point: action.end,
        },
      ];
    case "key":
    case "screenshot":
    case "type":
    case "wait":
      return [];
  }
}

async function resolveTraceTarget(
  dom: DomRuntime,
  hitTest: Awaited<ReturnType<BrowserCoreEngine["hitTest"]>>,
): Promise<OpensteerResolvedTarget | undefined> {
  if (hitTest.nodeRef === undefined) {
    return undefined;
  }

  const resolved = await dom.resolveTarget({
    pageRef: hitTest.pageRef,
    method: "computer.execute",
    target: {
      kind: "live",
      locator: createNodeLocator(hitTest.documentRef, hitTest.documentEpoch, hitTest.nodeRef),
    },
  });
  return toOpensteerResolvedTarget(resolved);
}

function toOpensteerResolvedTarget(target: ResolvedDomTarget): OpensteerResolvedTarget {
  return {
    pageRef: target.pageRef,
    frameRef: target.frameRef,
    documentRef: target.documentRef,
    documentEpoch: target.documentEpoch,
    nodeRef: target.nodeRef,
    tagName: target.node.nodeName.toUpperCase(),
    pathHint: buildPathSelectorHint(target.replayPath ?? target.anchor),
    ...(target.persist === undefined ? {} : { persist: target.persist }),
    ...(target.selectorUsed === undefined ? {} : { selectorUsed: target.selectorUsed }),
  };
}
