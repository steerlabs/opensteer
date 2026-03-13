import type { DocumentEpoch, DocumentRef, FrameRef, NodeRef, PageRef } from "./identity.js";
import {
  documentEpochSchema,
  documentRefSchema,
  frameRefSchema,
  nodeRefSchema,
  pageRefSchema,
} from "./identity.js";
import type { BodyPayload } from "./network.js";
import { bodyPayloadSchema } from "./network.js";
import type { CoordinateSpace, Point, Quad, Rect, Size } from "./geometry.js";
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

export type ScreenshotFormat = "png" | "jpeg" | "webp";

export interface ScreenshotArtifact {
  readonly pageRef: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly documentEpoch?: DocumentEpoch;
  readonly payload: BodyPayload;
  readonly format: ScreenshotFormat;
  readonly size: Size;
  readonly coordinateSpace: CoordinateSpace;
  readonly clip?: Rect;
}

export interface HtmlSnapshot {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly url: string;
  readonly capturedAt: number;
  readonly html: string;
}

export interface DomSnapshotNode {
  readonly snapshotNodeId: number;
  readonly nodeRef?: NodeRef;
  readonly parentSnapshotNodeId?: number;
  readonly childSnapshotNodeIds: readonly number[];
  readonly shadowRootType?: "open" | "closed" | "user-agent";
  readonly shadowHostNodeRef?: NodeRef;
  readonly contentDocumentRef?: DocumentRef;
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string;
  readonly textContent?: string;
  readonly attributes: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly layout?: {
    readonly rect?: Rect;
    readonly quad?: Quad;
    readonly paintOrder?: number;
  };
}

export type ShadowDomSnapshotMode = "flattened" | "preserved" | "unsupported";

export interface DomSnapshot {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly documentRef: DocumentRef;
  readonly parentDocumentRef?: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly url: string;
  readonly capturedAt: number;
  readonly rootSnapshotNodeId: number;
  readonly shadowDomMode: ShadowDomSnapshotMode;
  readonly geometryCoordinateSpace?: CoordinateSpace;
  readonly nodes: readonly DomSnapshotNode[];
}

export interface HitTestResult {
  readonly inputPoint: Point;
  readonly inputCoordinateSpace: CoordinateSpace;
  readonly resolvedPoint: Point;
  readonly resolvedCoordinateSpace: CoordinateSpace;
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly nodeRef?: NodeRef;
  readonly targetQuad?: Quad;
  readonly obscured: boolean;
  readonly pointerEventsSkipped: boolean;
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
