import type {
  BodyPayload,
  DocumentEpoch,
  DocumentRef,
  FrameRef,
  HeaderEntry,
  NetworkCaptureState,
  NetworkRequestId,
  NetworkResourceType,
  NetworkSourceMetadata,
  NetworkTiming,
  NetworkTransferSizes,
  NodeRef,
  PageLifecycleState,
  PageRef,
  SessionRef,
  StepEvent,
} from "@opensteer/browser-core";
import type { BrowserContext, CDPSession, Frame, Page, Request } from "playwright";

export interface SessionState {
  readonly sessionRef: SessionRef;
  readonly context: BrowserContext;
  readonly pageRefs: Set<PageRef>;
  readonly networkRecords: NetworkRecordState[];
  readonly pendingRegistrations: PendingPageRegistration[];
  readonly pendingPageTasks: Set<Promise<void>>;
  initialPage: Page | undefined;
  readonly closeContextOnSessionClose: boolean;
  activePageRef: PageRef | undefined;
  lifecycleState: "open" | "closing" | "closed";
}

export interface PendingPageRegistration {
  readonly openerPageRef?: PageRef;
  readonly resolve: (controller: PageController) => void;
  readonly reject: (reason: unknown) => void;
}

export interface PageController {
  readonly pageRef: PageRef;
  readonly sessionRef: SessionRef;
  targetId: string | undefined;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly externallyOwned: boolean;
  readonly queuedEvents: StepEvent[];
  readonly framesByCdpId: Map<string, FrameState>;
  readonly frameBindings: WeakMap<Frame, FrameRef>;
  readonly documentsByRef: Map<DocumentRef, DocumentState>;
  readonly networkByRequest: WeakMap<Request, NetworkRecordState>;
  readonly networkByCdpRequestId: Map<string, NetworkRecordState>;
  readonly requestBodyTasks: Map<NetworkRequestId, Promise<void>>;
  readonly responseBodyTasks: Map<NetworkRequestId, Promise<void>>;
  readonly backgroundTasks: Set<Promise<void>>;
  domUpdateTask: Promise<void> | undefined;
  backgroundError: Error | undefined;
  settleTrackerRegistered: boolean;
  openerPageRef: PageRef | undefined;
  mainFrameRef: FrameRef | undefined;
  lifecycleState: PageLifecycleState;
  frozen: boolean;
  explicitCloseInFlight: boolean;
  lastKnownTitle: string;
}

export interface FrameState {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly cdpFrameId: string;
  parentFrameRef: FrameRef | undefined;
  name: string | undefined;
  isMainFrame: boolean;
  currentDocument: DocumentState;
}

export interface DocumentState {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly cdpFrameId: string;
  readonly documentRef: DocumentRef;
  documentEpoch: DocumentEpoch;
  url: string;
  domContentLoadedAt: number | undefined;
  parentDocumentRef: DocumentRef | undefined;
  readonly nodeRefsByBackendNodeId: Map<number, NodeRef>;
  readonly backendNodeIdsByNodeRef: Map<NodeRef, number>;
  domTreeSignature: string | undefined;
}

export interface FrameDescriptor {
  readonly id: string;
  readonly parentId?: string;
  readonly name?: string;
  readonly url: string;
  readonly urlFragment?: string;
}

export interface FrameTreeNode {
  readonly frame: FrameDescriptor;
  readonly childFrames?: readonly FrameTreeNode[];
}

export interface NetworkRecordState {
  readonly kind: "http";
  readonly requestId: NetworkRequestId;
  readonly sessionRef: SessionRef;
  cdpRequestId: string | undefined;
  pageRef: PageRef | undefined;
  frameRef: FrameRef | undefined;
  documentRef: DocumentRef | undefined;
  method: string;
  url: string;
  requestHeaders: HeaderEntry[];
  responseHeaders: HeaderEntry[];
  status: number | undefined;
  statusText: string | undefined;
  resourceType: NetworkResourceType;
  redirectFromRequestId: NetworkRequestId | undefined;
  redirectToRequestId: NetworkRequestId | undefined;
  navigationRequest: boolean;
  timing: NetworkTiming | undefined;
  transfer: NetworkTransferSizes | undefined;
  source: NetworkSourceMetadata | undefined;
  captureState: NetworkCaptureState;
  requestBodyState: NetworkCaptureState;
  responseBodyState: NetworkCaptureState;
  requestBodySkipReason: string | undefined;
  responseBodySkipReason: string | undefined;
  requestBodyError: string | undefined;
  responseBodyError: string | undefined;
  requestBody: BodyPayload | undefined;
  responseBody: BodyPayload | undefined;
}

export interface CapturedDomSnapshot {
  readonly capturedAt: number;
  readonly documents: readonly DomSnapshotDocument[];
  readonly rawDocument: DomSnapshotDocument;
  readonly shadowBoundariesByBackendNodeId: ReadonlyMap<number, ShadowBoundaryInfo>;
  readonly strings: readonly string[];
}

export interface DomSnapshotDocument {
  readonly frameId: number;
  readonly nodes: {
    readonly parentIndex?: readonly number[];
    readonly nodeType?: readonly number[];
    readonly shadowRootType?: RareStringData;
    readonly nodeName?: readonly number[];
    readonly nodeValue?: readonly number[];
    readonly backendNodeId?: readonly number[];
    readonly attributes?: ReadonlyArray<readonly number[]>;
    readonly textValue?: RareStringData;
    readonly inputValue?: RareStringData;
    readonly contentDocumentIndex?: RareIntegerData;
  };
  readonly layout: {
    readonly nodeIndex: readonly number[];
    readonly styles?: ReadonlyArray<readonly number[]>;
    readonly bounds: ReadonlyArray<readonly number[]>;
    readonly text: readonly number[];
    readonly paintOrders?: readonly number[];
  };
}

export interface RareStringData {
  readonly index: readonly number[];
  readonly value: readonly number[];
}

export interface RareIntegerData {
  readonly index: readonly number[];
  readonly value: readonly number[];
}

export interface ShadowBoundaryInfo {
  readonly shadowRootType?: "open" | "closed" | "user-agent";
  readonly shadowHostBackendNodeId?: number;
}

export interface DomTreeNode {
  readonly backendNodeId?: number;
  readonly children?: readonly DomTreeNode[];
  readonly shadowRoots?: readonly DomTreeNode[];
  readonly contentDocument?: DomTreeNode;
  readonly shadowRootType?: "open" | "closed" | "user-agent";
}

export interface NormalizedIndexedDbRecord {
  readonly key?: unknown;
  readonly keyEncoded?: unknown;
  readonly value?: unknown;
  readonly valueEncoded?: unknown;
}

export interface NormalizedIndexedDbIndex {
  readonly name: string;
  readonly keyPath?: string;
  readonly keyPathArray?: readonly string[];
  readonly multiEntry: boolean;
  readonly unique: boolean;
}

export interface NormalizedIndexedDbStore {
  readonly name: string;
  readonly keyPath?: string;
  readonly keyPathArray?: readonly string[];
  readonly autoIncrement: boolean;
  readonly indexes?: readonly NormalizedIndexedDbIndex[];
  readonly records: readonly NormalizedIndexedDbRecord[];
}

export interface NormalizedIndexedDbDatabase {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly NormalizedIndexedDbStore[];
}

export interface ExtendedStorageStateOrigin {
  readonly origin: string;
  readonly localStorage: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
  readonly indexedDB?: readonly NormalizedIndexedDbDatabase[];
}

export interface ExtendedStorageState {
  readonly cookies: readonly {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly expires: number;
    readonly httpOnly: boolean;
    readonly secure: boolean;
    readonly sameSite: "Strict" | "Lax" | "None";
  }[];
  readonly origins: readonly ExtendedStorageStateOrigin[];
}
