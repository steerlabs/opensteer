export type {
  ScreenshotFormat,
  HtmlSnapshot,
  DomSnapshotNode,
  ShadowDomSnapshotMode,
  DomSnapshot,
  HitTestResult,
} from "@opensteer/browser-core";

export { findDomSnapshotNode, findDomSnapshotNodeByRef } from "@opensteer/browser-core";

import type { DocumentEpoch, DocumentRef, FrameRef, PageRef } from "./identity.js";
import {
  documentEpochSchema,
  documentRefSchema,
  frameRefSchema,
  nodeRefSchema,
  pageRefSchema,
} from "./identity.js";
import type { BodyPayload } from "./network.js";
import { bodyPayloadSchema } from "./network.js";
import type { CoordinateSpace, Rect, Size } from "./geometry.js";
import {
  coordinateSpaceSchema,
  pointSchema,
  quadSchema,
  rectSchema,
  sizeSchema,
} from "./geometry.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  objectSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";

export interface ScreenshotArtifact {
  readonly pageRef: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly documentEpoch?: DocumentEpoch;
  readonly payload: BodyPayload;
  readonly format: "png" | "jpeg" | "webp";
  readonly size: Size;
  readonly coordinateSpace: CoordinateSpace;
  readonly clip?: Rect;
}

export const screenshotFormatSchema: JsonSchema = enumSchema(["png", "jpeg", "webp"] as const, {
  title: "ScreenshotFormat",
});

export const screenshotArtifactSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
    payload: bodyPayloadSchema,
    format: screenshotFormatSchema,
    size: sizeSchema,
    coordinateSpace: coordinateSpaceSchema,
    clip: rectSchema,
  },
  {
    title: "ScreenshotArtifact",
    required: ["pageRef", "payload", "format", "size", "coordinateSpace"],
  },
);

export const htmlSnapshotSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
    url: stringSchema(),
    capturedAt: integerSchema({ minimum: 0 }),
    html: stringSchema(),
  },
  {
    title: "HtmlSnapshot",
    required: ["pageRef", "frameRef", "documentRef", "documentEpoch", "url", "capturedAt", "html"],
  },
);

export const domSnapshotNodeSchema: JsonSchema = objectSchema(
  {
    snapshotNodeId: integerSchema({ minimum: 0 }),
    nodeRef: nodeRefSchema,
    parentSnapshotNodeId: integerSchema({ minimum: 0 }),
    childSnapshotNodeIds: arraySchema(integerSchema({ minimum: 0 })),
    shadowRootType: enumSchema(["open", "closed", "user-agent"] as const),
    shadowHostNodeRef: nodeRefSchema,
    contentDocumentRef: documentRefSchema,
    nodeType: integerSchema({ minimum: 0 }),
    nodeName: stringSchema(),
    nodeValue: stringSchema(),
    textContent: stringSchema(),
    attributes: arraySchema(
      objectSchema(
        {
          name: stringSchema(),
          value: stringSchema(),
        },
        {
          required: ["name", "value"],
        },
      ),
    ),
    layout: objectSchema(
      {
        rect: rectSchema,
        quad: quadSchema,
        paintOrder: integerSchema({ minimum: 0 }),
      },
      {
        required: [],
      },
    ),
  },
  {
    title: "DomSnapshotNode",
    required: [
      "snapshotNodeId",
      "childSnapshotNodeIds",
      "nodeType",
      "nodeName",
      "nodeValue",
      "attributes",
    ],
  },
);

export const shadowDomSnapshotModeSchema: JsonSchema = enumSchema(
  ["flattened", "preserved", "unsupported"] as const,
  {
    title: "ShadowDomSnapshotMode",
  },
);

export const domSnapshotSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    parentDocumentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
    url: stringSchema(),
    capturedAt: integerSchema({ minimum: 0 }),
    rootSnapshotNodeId: integerSchema({ minimum: 0 }),
    shadowDomMode: shadowDomSnapshotModeSchema,
    geometryCoordinateSpace: coordinateSpaceSchema,
    nodes: arraySchema(domSnapshotNodeSchema),
  },
  {
    title: "DomSnapshot",
    required: [
      "pageRef",
      "frameRef",
      "documentRef",
      "documentEpoch",
      "url",
      "capturedAt",
      "rootSnapshotNodeId",
      "shadowDomMode",
      "nodes",
    ],
  },
);

export const hitTestResultSchema: JsonSchema = objectSchema(
  {
    inputPoint: pointSchema,
    inputCoordinateSpace: coordinateSpaceSchema,
    resolvedPoint: pointSchema,
    resolvedCoordinateSpace: coordinateSpaceSchema,
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
    nodeRef: nodeRefSchema,
    targetQuad: quadSchema,
    obscured: {
      type: "boolean",
    },
    pointerEventsSkipped: {
      type: "boolean",
    },
  },
  {
    title: "HitTestResult",
    required: [
      "inputPoint",
      "inputCoordinateSpace",
      "resolvedPoint",
      "resolvedCoordinateSpace",
      "pageRef",
      "frameRef",
      "documentRef",
      "documentEpoch",
      "obscured",
      "pointerEventsSkipped",
    ],
  },
);
