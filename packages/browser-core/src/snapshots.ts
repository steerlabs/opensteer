import type { DocumentEpoch, DocumentRef, FrameRef, NodeRef, PageRef } from "./identity.js";
import type { BodyPayload } from "./network.js";
import type { CoordinateSpace, Point, Quad, Rect, Size } from "./geometry.js";

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

export function findDomSnapshotNode(
  snapshot: DomSnapshot,
  snapshotNodeId: number,
): DomSnapshotNode | undefined {
  return snapshot.nodes.find((node) => node.snapshotNodeId === snapshotNodeId);
}

export function findDomSnapshotNodeByRef(
  snapshot: DomSnapshot,
  nodeRef: NodeRef,
): DomSnapshotNode | undefined {
  return snapshot.nodes.find((node) => node.nodeRef === nodeRef);
}
