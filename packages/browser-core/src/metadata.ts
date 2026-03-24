import type { DocumentEpoch, DocumentRef, FrameRef, PageRef, SessionRef } from "./identity.js";

export type PageLifecycleState = "opening" | "open" | "closing" | "closed" | "crashed";

export interface PageInfo {
  readonly pageRef: PageRef;
  readonly sessionRef: SessionRef;
  readonly openerPageRef?: PageRef;
  readonly url: string;
  readonly title: string;
  readonly lifecycleState: PageLifecycleState;
}

export interface FrameInfo {
  readonly frameRef: FrameRef;
  readonly pageRef: PageRef;
  readonly parentFrameRef?: FrameRef;
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly url: string;
  readonly name?: string;
  readonly isMainFrame: boolean;
}
