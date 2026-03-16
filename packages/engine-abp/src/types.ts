import type {
  BodyPayload,
  DocumentEpoch,
  DocumentRef,
  FrameRef,
  HeaderEntry,
  NetworkResourceType,
  NetworkRequestId,
  NodeRef,
  PageLifecycleState,
  PageRef,
  SessionRef,
  StepEvent,
} from "@opensteer/browser-core";
import type { ChildProcess } from "node:child_process";

import type { CdpClient } from "./cdp-transport.js";

export interface AbpWaitUntil {
  readonly type: "immediate" | "action_complete" | "time";
  readonly timeout_ms?: number;
  readonly duration_ms?: number;
}

export interface AbpScreenshotOptions {
  readonly area?: "none" | "viewport";
  readonly markup?: readonly string[];
  readonly disable_markup?: readonly string[];
  readonly cursor?: boolean;
  readonly format?: string;
}

export interface AbpActionRequest {
  readonly wait_until?: AbpWaitUntil;
  readonly screenshot?: AbpScreenshotOptions;
  readonly network?: {
    readonly tag?: string;
    readonly types?: readonly string[];
  };
}

export interface AbpActionTiming {
  readonly action_started_ms: number;
  readonly action_completed_ms: number;
  readonly wait_completed_ms: number;
  readonly duration_ms: number;
}

export interface AbpActionEvent {
  readonly type: string;
  readonly virtual_time_ms: number;
  readonly data: Record<string, unknown>;
}

export interface AbpScreenshotData {
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly virtual_time_ms: number;
  readonly format: string;
}

export interface AbpActionResponse<TResult = Record<string, unknown>> {
  readonly action_id?: string;
  readonly tab_changed?: boolean;
  readonly original_tab_id?: string;
  readonly result: TResult;
  readonly screenshot_before?: AbpScreenshotData;
  readonly screenshot_after?: AbpScreenshotData;
  readonly scroll?: {
    readonly scrollX?: number;
    readonly scrollY?: number;
    readonly pageWidth?: number;
    readonly pageHeight?: number;
    readonly viewportWidth?: number;
    readonly viewportHeight?: number;
    readonly horizontal_px?: number;
    readonly vertical_px?: number;
    readonly page_width?: number;
    readonly page_height?: number;
    readonly viewport_width?: number;
    readonly viewport_height?: number;
  };
  readonly events?: readonly AbpActionEvent[];
  readonly timing?: AbpActionTiming;
}

export interface AbpBrowserStatus {
  readonly success: boolean;
  readonly data: {
    readonly ready: boolean;
    readonly state: string;
    readonly input_mode?: string;
    readonly message?: string;
    readonly components: {
      readonly http_server: boolean;
      readonly browser_window: boolean;
      readonly devtools: boolean;
    };
  };
}

export interface AbpTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly active?: boolean;
  readonly loading?: boolean;
}

export interface AbpExecutionState {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly virtual_time_base_ms?: number;
}

export interface AbpNetworkCall {
  readonly request_id?: string;
  readonly action_id?: string;
  readonly tab_id?: string;
  readonly url: string;
  readonly url_hostname?: string;
  readonly url_path?: string;
  readonly url_query?: string;
  readonly method: string;
  readonly status?: number;
  readonly resource_type?: string;
  readonly cors_preflight?: boolean;
  readonly request_headers?: string;
  readonly response_headers?: string;
  readonly request_body?: string;
  readonly response_body?: string;
  readonly response_body_encoding?: string;
  readonly redirect_chain?: string;
  readonly started_at_ms?: number;
  readonly completed_at_ms?: number;
  readonly duration_ms?: number;
  readonly virtual_time_ms?: number;
}

export interface AbpNetworkQueryWireResponse {
  readonly requests: readonly AbpNetworkCall[];
}

export interface AbpCurlWireResponse {
  readonly status_code: number;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly body_is_base64: boolean;
  readonly final_url: string;
  readonly redirected: boolean;
}

export interface AbpCurlResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly bodyEncoding?: "text" | "base64";
  readonly url: string;
  readonly redirected: boolean;
}

export interface AbpRequestOptions {
  readonly signal?: AbortSignal;
}

export interface AbpDialogInfo {
  readonly dialogType: string;
  readonly message: string;
  readonly defaultPrompt?: string | undefined;
}

export interface AbpExecuteResult {
  readonly type?: string;
  readonly value: unknown;
}

export interface AbpSelectPopupItem {
  readonly index: number;
  readonly type: string;
  readonly label?: string;
  readonly tool_tip?: string;
  readonly enabled?: boolean;
  readonly checked?: boolean;
}

export interface AbpCdpTargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly attached: boolean;
  readonly openerId?: string;
}

export interface AbpCdpCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
  readonly expires?: number;
  readonly priority?: "Low" | "Medium" | "High";
  readonly partitionKey?: string;
}

export interface AbpStorageKeyResult {
  readonly storageKey: string;
}

export interface AbpDomStorageItemsResult {
  readonly entries: ReadonlyArray<readonly [string, string]>;
}

export interface AbpIndexedDbDatabaseNamesResult {
  readonly databaseNames: readonly string[];
}

export interface AbpIndexedDbObjectStore {
  readonly name: string;
  readonly keyPath?: string;
  readonly keyPathArray?: readonly string[];
  readonly autoIncrement?: boolean;
}

export interface AbpIndexedDbDatabaseResult {
  readonly databaseWithObjectStores: {
    readonly name: string;
    readonly version: number;
    readonly objectStores: readonly AbpIndexedDbObjectStore[];
  };
}

export interface AbpIndexedDbDataEntry {
  readonly key?: unknown;
  readonly primaryKey?: unknown;
  readonly value?: unknown;
}

export interface AbpIndexedDbDataResult {
  readonly objectStoreDataEntries: readonly AbpIndexedDbDataEntry[];
  readonly hasMore: boolean;
}

export interface SessionState {
  readonly sessionRef: SessionRef;
  readonly mode: "launch" | "browser";
  readonly baseUrl: string;
  readonly remoteDebuggingUrl: string;
  readonly browserWebSocketUrl: string;
  readonly closeBrowserOnDispose: boolean;
  readonly rest: AbpRestClientLike;
  readonly browserCdp: CdpClient;
  readonly pageRefs: Set<PageRef>;
  readonly controllersByPageRef: Map<PageRef, PageController>;
  readonly pageRefByTabId: Map<string, PageRef>;
  readonly userDataDir?: string;
  readonly sessionDir?: string;
  readonly ownedUserDataDir: boolean;
  readonly ownedSessionDir: boolean;
  process: ChildProcess | undefined;
  bootstrapTabId: string | undefined;
  activePageRef: PageRef | undefined;
  closed: boolean;
}

export interface PageController {
  readonly sessionRef: SessionRef;
  readonly pageRef: PageRef;
  readonly tabId: string;
  readonly cdp: CdpClient;
  readonly queuedEvents: StepEvent[];
  readonly framesByCdpId: Map<string, FrameState>;
  readonly documentsByRef: Map<DocumentRef, DocumentState>;
  lifecycleState: PageLifecycleState;
  openerPageRef: PageRef | undefined;
  mainFrameRef: FrameRef | undefined;
  lastKnownTitle: string;
  explicitCloseInFlight: boolean;
  domUpdateTask: Promise<void> | undefined;
  backgroundError: Error | undefined;
  executionPaused: boolean;
  settleTrackerRegistered: boolean;
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

export interface NetworkRecordState {
  readonly kind: "http";
  readonly requestId: NetworkRequestId;
  readonly sessionRef: SessionRef;
  readonly pageRef?: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: readonly HeaderEntry[];
  readonly responseHeaders: readonly HeaderEntry[];
  readonly status?: number;
  readonly statusText?: string;
  readonly resourceType: string;
  readonly redirectFromRequestId?: NetworkRequestId;
  readonly redirectToRequestId?: NetworkRequestId;
  readonly navigationRequest: boolean;
  readonly requestBody?: BodyPayload;
  readonly responseBody?: BodyPayload;
}

export interface NormalizedActionResult {
  readonly events: readonly StepEvent[];
}

export interface AbpRestClientLike {
  getBrowserStatus(): Promise<AbpBrowserStatus>;
  shutdownBrowser(): Promise<void>;
  listTabs(): Promise<readonly AbpTab[]>;
  getTab(tabId: string): Promise<AbpTab>;
  createTab(): Promise<AbpTab>;
  closeTab(tabId: string): Promise<void>;
  activateTab(tabId: string): Promise<void>;
  stopTab(tabId: string): Promise<void>;
  navigateTab(
    tabId: string,
    body: {
      readonly url: string;
      readonly referrer?: string;
    } & AbpActionRequest,
  ): Promise<AbpActionResponse>;
  reloadTab(tabId: string, body: AbpActionRequest): Promise<AbpActionResponse>;
  goBack(tabId: string, body: AbpActionRequest): Promise<AbpActionResponse>;
  goForward(tabId: string, body: AbpActionRequest): Promise<AbpActionResponse>;
  clickTab(
    tabId: string,
    body: {
      readonly x: number;
      readonly y: number;
      readonly button?: string;
      readonly click_count?: number;
      readonly modifiers?: readonly string[];
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse>;
  moveTab(
    tabId: string,
    body: {
      readonly x: number;
      readonly y: number;
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse>;
  scrollTab(
    tabId: string,
    body: {
      readonly x: number;
      readonly y: number;
      readonly scrolls: readonly {
        readonly delta_px: number;
        readonly direction: "x" | "y";
      }[];
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse>;
  dragTab(
    tabId: string,
    body: {
      readonly start_x: number;
      readonly start_y: number;
      readonly end_x: number;
      readonly end_y: number;
      readonly steps?: number;
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse>;
  keyPressTab(
    tabId: string,
    body: {
      readonly key: string;
      readonly modifiers?: readonly string[];
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse>;
  typeTab(
    tabId: string,
    body: {
      readonly text: string;
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse>;
  waitTab(
    tabId: string,
    body: {
      readonly duration_ms: number;
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse>;
  screenshotTab(
    tabId: string,
    body: AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse>;
  executeScript<TResult = unknown>(
    tabId: string,
    script: string,
    options?: AbpActionRequest,
  ): Promise<TResult>;
  getExecutionState(tabId: string): Promise<AbpExecutionState>;
  setExecutionState(
    tabId: string,
    body: {
      readonly paused: boolean;
    },
  ): Promise<AbpExecutionState>;
  queryNetwork(input: {
    readonly tabId?: string;
    readonly includeBodies: boolean;
    readonly url?: string;
    readonly hostname?: string;
    readonly path?: string;
    readonly method?: string;
    readonly status?: string;
    readonly resourceType?: NetworkResourceType;
  }): Promise<readonly AbpNetworkCall[]>;
  curlTab(
    tabId: string,
    body: {
      readonly url: string;
      readonly method: string;
      readonly headers?: Record<string, string>;
      readonly body?: string;
    },
  ): Promise<AbpCurlResponse>;
  getDialog(tabId: string): Promise<AbpDialogInfo | undefined>;
  acceptDialog(tabId: string): Promise<void>;
  dismissDialog(tabId: string): Promise<void>;
}
