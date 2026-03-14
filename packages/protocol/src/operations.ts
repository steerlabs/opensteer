import type { OpensteerCapability } from "./capabilities.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  literalSchema,
  objectSchema,
  oneOfSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";
import type { CoordinateSpace, Point, Rect, ViewportMetrics } from "./geometry.js";
import {
  coordinateSpaceSchema,
  pointSchema,
  rectSchema,
  viewportMetricsSchema,
} from "./geometry.js";
import type { DocumentRef, FrameRef, NodeLocator, PageRef, SessionRef } from "./identity.js";
import {
  frameRefSchema,
  nodeLocatorSchema,
  documentRefSchema,
  pageRefSchema,
  sessionRefSchema,
} from "./identity.js";
import type { FrameInfo, PageInfo } from "./metadata.js";
import { frameInfoSchema, pageInfoSchema } from "./metadata.js";
import type { BodyPayload, HeaderEntry, NetworkRecord } from "./network.js";
import { bodyPayloadSchema, headerEntrySchema, networkRecordSchema } from "./network.js";
import type { CookieRecord, StorageSnapshot } from "./storage.js";
import { cookieRecordSchema, storageSnapshotSchema } from "./storage.js";
import type {
  DomSnapshot,
  HitTestResult,
  HtmlSnapshot,
  ScreenshotArtifact,
  ScreenshotFormat,
} from "./snapshots.js";
import {
  domSnapshotSchema,
  hitTestResultSchema,
  htmlSnapshotSchema,
  screenshotArtifactSchema,
  screenshotFormatSchema,
} from "./snapshots.js";

export type MouseButton = "left" | "middle" | "right";
export type KeyModifier = "Shift" | "Control" | "Alt" | "Meta";

export interface SessionTransportRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BodyPayload;
  readonly timeoutMs?: number;
  readonly followRedirects?: boolean;
}

export interface SessionTransportResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: BodyPayload;
  readonly redirected: boolean;
}

export interface CreateSessionInput {}
export interface CreateSessionOutput {
  readonly sessionRef: SessionRef;
}

export interface CloseSessionInput {
  readonly sessionRef: SessionRef;
}

export interface CloseSessionOutput {
  readonly closed: true;
  readonly sessionRef: SessionRef;
}

export interface CreatePageInput {
  readonly sessionRef: SessionRef;
  readonly openerPageRef?: PageRef;
  readonly url?: string;
}

export interface CreatePageOutput {
  readonly pageInfo: PageInfo;
  readonly mainFrame: FrameInfo;
}

export interface ClosePageInput {
  readonly pageRef: PageRef;
}

export interface ClosePageOutput {
  readonly closed: true;
  readonly pageRef: PageRef;
}

export interface ActivatePageInput {
  readonly pageRef: PageRef;
}

export interface NavigatePageInput {
  readonly pageRef: PageRef;
  readonly url: string;
  readonly referrer?: string;
  readonly timeoutMs?: number;
}

export interface NavigatePageOutput {
  readonly pageInfo: PageInfo;
  readonly mainFrame: FrameInfo;
}

export interface ReloadPageInput {
  readonly pageRef: PageRef;
  readonly timeoutMs?: number;
}

export interface HistoryNavigationInput {
  readonly pageRef: PageRef;
}

export interface HistoryNavigationOutput {
  readonly navigated: boolean;
}

export interface StopLoadingInput {
  readonly pageRef: PageRef;
}

export interface StopLoadingOutput {
  readonly stopped: true;
}

export interface MouseMoveInput {
  readonly pageRef: PageRef;
  readonly point: Point;
  readonly coordinateSpace: CoordinateSpace;
}

export interface MouseMoveOutput {
  readonly moved: true;
}

export interface MouseClickInput {
  readonly pageRef: PageRef;
  readonly point: Point;
  readonly coordinateSpace: CoordinateSpace;
  readonly button?: MouseButton;
  readonly clickCount?: number;
  readonly modifiers?: readonly KeyModifier[];
}

export interface MouseClickOutput {
  readonly hitTest?: HitTestResult;
}

export interface MouseScrollInput {
  readonly pageRef: PageRef;
  readonly point: Point;
  readonly coordinateSpace: CoordinateSpace;
  readonly delta: Point;
}

export interface MouseScrollOutput {
  readonly scrolled: true;
}

export interface KeyPressInput {
  readonly pageRef: PageRef;
  readonly key: string;
  readonly modifiers?: readonly KeyModifier[];
}

export interface KeyPressOutput {
  readonly pressed: true;
}

export interface TextInputInput {
  readonly pageRef: PageRef;
  readonly text: string;
}

export interface TextInputOutput {
  readonly typed: true;
}

export interface CaptureScreenshotInput {
  readonly pageRef: PageRef;
  readonly format?: ScreenshotFormat;
  readonly clip?: Rect;
  readonly clipSpace?: CoordinateSpace;
  readonly fullPage?: boolean;
  readonly includeCursor?: boolean;
}

export interface SetExecutionStateInput {
  readonly pageRef: PageRef;
  readonly paused?: boolean;
  readonly frozen?: boolean;
}

export interface SetExecutionStateOutput {
  readonly paused: boolean;
  readonly frozen: boolean;
}

export interface ListPagesInput {
  readonly sessionRef: SessionRef;
}

export interface ListPagesOutput {
  readonly pages: readonly PageInfo[];
}

export interface ListFramesInput {
  readonly pageRef: PageRef;
}

export interface ListFramesOutput {
  readonly frames: readonly FrameInfo[];
}

export interface GetPageInfoInput {
  readonly pageRef: PageRef;
}

export interface GetFrameInfoInput {
  readonly frameRef: FrameRef;
}

export type DocumentTargetInput =
  | {
      readonly frameRef: FrameRef;
      readonly documentRef?: never;
    }
  | {
      readonly documentRef: DocumentRef;
      readonly frameRef?: never;
    };

export type GetHtmlSnapshotInput = DocumentTargetInput;

export type GetDomSnapshotInput = DocumentTargetInput;

export interface ReadTextInput extends NodeLocator {}

export interface ReadTextOutput {
  readonly text: string | null;
}

export interface ReadAttributesInput extends NodeLocator {}

export interface AttributeEntry {
  readonly name: string;
  readonly value: string;
}

export interface ReadAttributesOutput {
  readonly attributes: readonly AttributeEntry[];
}

export interface HitTestInput {
  readonly pageRef: PageRef;
  readonly point: Point;
  readonly coordinateSpace: CoordinateSpace;
  readonly ignorePointerEventsNone?: boolean;
  readonly includeUserAgentShadowDom?: boolean;
}

export interface GetViewportMetricsInput {
  readonly pageRef: PageRef;
}

export interface GetNetworkRecordsInput {
  readonly sessionRef: SessionRef;
  readonly pageRef?: PageRef;
  readonly includeBodies?: boolean;
}

export interface GetNetworkRecordsOutput {
  readonly records: readonly NetworkRecord[];
}

export interface GetCookiesInput {
  readonly sessionRef: SessionRef;
  readonly urls?: readonly string[];
}

export interface GetCookiesOutput {
  readonly cookies: readonly CookieRecord[];
}

export interface GetStorageSnapshotInput {
  readonly sessionRef: SessionRef;
  readonly includeSessionStorage?: boolean;
  readonly includeIndexedDb?: boolean;
}

export interface ExecuteSessionRequestInput {
  readonly sessionRef: SessionRef;
  readonly request: SessionTransportRequest;
}

export const opensteerOperationNames = [
  "session.create",
  "session.close",
  "page.create",
  "page.close",
  "page.activate",
  "page.navigate",
  "page.reload",
  "page.go-back",
  "page.go-forward",
  "page.stop-loading",
  "input.mouse-move",
  "input.mouse-click",
  "input.mouse-scroll",
  "input.key-press",
  "input.text-input",
  "artifact.capture-screenshot",
  "execution.set-state",
  "inspect.list-pages",
  "inspect.list-frames",
  "inspect.get-page-info",
  "inspect.get-frame-info",
  "inspect.get-html-snapshot",
  "inspect.get-dom-snapshot",
  "inspect.read-text",
  "inspect.read-attributes",
  "inspect.hit-test",
  "inspect.get-viewport-metrics",
  "inspect.get-network-records",
  "inspect.get-cookies",
  "inspect.get-storage-snapshot",
  "transport.execute-session-request",
] as const;

export type OpensteerOperationName = (typeof opensteerOperationNames)[number];

export interface OpensteerOperationSpec<TInput = unknown, TOutput = unknown> {
  readonly name: OpensteerOperationName;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly requiredCapabilities: readonly OpensteerCapability[];
  resolveRequiredCapabilities?(input: TInput): readonly OpensteerCapability[];
}

function defineOperationSpec<TInput, TOutput>(
  spec: OpensteerOperationSpec<TInput, TOutput>,
): OpensteerOperationSpec<TInput, TOutput> {
  return spec;
}

const mouseButtonSchema: JsonSchema = enumSchema(["left", "middle", "right"] as const, {
  title: "MouseButton",
});

const keyModifierSchema: JsonSchema = enumSchema(["Shift", "Control", "Alt", "Meta"] as const, {
  title: "KeyModifier",
});

const emptyObjectSchema: JsonSchema = objectSchema(
  {},
  {
    title: "EmptyObject",
    required: [],
  },
);

const sessionTransportRequestSchema: JsonSchema = objectSchema(
  {
    method: stringSchema(),
    url: stringSchema(),
    headers: arraySchema(headerEntrySchema),
    body: bodyPayloadSchema,
    timeoutMs: integerSchema({ minimum: 0 }),
    followRedirects: {
      type: "boolean",
    },
  },
  {
    title: "SessionTransportRequest",
    required: ["method", "url"],
  },
);

const sessionTransportResponseSchema: JsonSchema = objectSchema(
  {
    url: stringSchema(),
    status: integerSchema({ minimum: 0 }),
    statusText: stringSchema(),
    headers: arraySchema(headerEntrySchema),
    body: bodyPayloadSchema,
    redirected: {
      type: "boolean",
    },
  },
  {
    title: "SessionTransportResponse",
    required: ["url", "status", "statusText", "headers", "redirected"],
  },
);

const pageOperationResultSchema: JsonSchema = objectSchema(
  {
    pageInfo: pageInfoSchema,
    mainFrame: frameInfoSchema,
  },
  {
    title: "PageOperationResult",
    required: ["pageInfo", "mainFrame"],
  },
);

const attributeEntrySchema: JsonSchema = objectSchema(
  {
    name: stringSchema(),
    value: stringSchema(),
  },
  {
    title: "AttributeEntry",
    required: ["name", "value"],
  },
);

const createSessionInputSchema: JsonSchema = emptyObjectSchema;
const createSessionOutputSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
  },
  {
    title: "CreateSessionOutput",
    required: ["sessionRef"],
  },
);

const closeSessionInputSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
  },
  {
    title: "CloseSessionInput",
    required: ["sessionRef"],
  },
);

const closeSessionOutputSchema: JsonSchema = objectSchema(
  {
    closed: literalSchema(true),
    sessionRef: sessionRefSchema,
  },
  {
    title: "CloseSessionOutput",
    required: ["closed", "sessionRef"],
  },
);

const createPageInputSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    openerPageRef: pageRefSchema,
    url: stringSchema(),
  },
  {
    title: "CreatePageInput",
    required: ["sessionRef"],
  },
);

const closePageInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
  },
  {
    title: "ClosePageInput",
    required: ["pageRef"],
  },
);

const closePageOutputSchema: JsonSchema = objectSchema(
  {
    closed: literalSchema(true),
    pageRef: pageRefSchema,
  },
  {
    title: "ClosePageOutput",
    required: ["closed", "pageRef"],
  },
);

const pageRefInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
  },
  {
    title: "PageRefInput",
    required: ["pageRef"],
  },
);

const navigatePageInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    url: stringSchema(),
    referrer: stringSchema(),
    timeoutMs: integerSchema({ minimum: 0 }),
  },
  {
    title: "NavigatePageInput",
    required: ["pageRef", "url"],
  },
);

const reloadPageInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    timeoutMs: integerSchema({ minimum: 0 }),
  },
  {
    title: "ReloadPageInput",
    required: ["pageRef"],
  },
);

const historyNavigationOutputSchema: JsonSchema = objectSchema(
  {
    navigated: {
      type: "boolean",
    },
  },
  {
    title: "HistoryNavigationOutput",
    required: ["navigated"],
  },
);

const stopLoadingOutputSchema: JsonSchema = objectSchema(
  {
    stopped: literalSchema(true),
  },
  {
    title: "StopLoadingOutput",
    required: ["stopped"],
  },
);

const mouseMoveInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    point: pointSchema,
    coordinateSpace: coordinateSpaceSchema,
  },
  {
    title: "MouseMoveInput",
    required: ["pageRef", "point", "coordinateSpace"],
  },
);

const mouseMoveOutputSchema: JsonSchema = objectSchema(
  {
    moved: literalSchema(true),
  },
  {
    title: "MouseMoveOutput",
    required: ["moved"],
  },
);

const mouseClickInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    point: pointSchema,
    coordinateSpace: coordinateSpaceSchema,
    button: mouseButtonSchema,
    clickCount: integerSchema({ minimum: 1 }),
    modifiers: arraySchema(keyModifierSchema, { uniqueItems: true }),
  },
  {
    title: "MouseClickInput",
    required: ["pageRef", "point", "coordinateSpace"],
  },
);

const mouseClickOutputSchema: JsonSchema = objectSchema(
  {
    hitTest: hitTestResultSchema,
  },
  {
    title: "MouseClickOutput",
  },
);

const mouseScrollInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    point: pointSchema,
    coordinateSpace: coordinateSpaceSchema,
    delta: pointSchema,
  },
  {
    title: "MouseScrollInput",
    required: ["pageRef", "point", "coordinateSpace", "delta"],
  },
);

const mouseScrollOutputSchema: JsonSchema = objectSchema(
  {
    scrolled: literalSchema(true),
  },
  {
    title: "MouseScrollOutput",
    required: ["scrolled"],
  },
);

const keyPressInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    key: stringSchema(),
    modifiers: arraySchema(keyModifierSchema, { uniqueItems: true }),
  },
  {
    title: "KeyPressInput",
    required: ["pageRef", "key"],
  },
);

const keyPressOutputSchema: JsonSchema = objectSchema(
  {
    pressed: literalSchema(true),
  },
  {
    title: "KeyPressOutput",
    required: ["pressed"],
  },
);

const textInputInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    text: stringSchema(),
  },
  {
    title: "TextInputInput",
    required: ["pageRef", "text"],
  },
);

const textInputOutputSchema: JsonSchema = objectSchema(
  {
    typed: literalSchema(true),
  },
  {
    title: "TextInputOutput",
    required: ["typed"],
  },
);

const captureScreenshotInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    format: screenshotFormatSchema,
    clip: rectSchema,
    clipSpace: coordinateSpaceSchema,
    fullPage: {
      type: "boolean",
    },
    includeCursor: {
      type: "boolean",
    },
  },
  {
    title: "CaptureScreenshotInput",
    required: ["pageRef"],
  },
);

const setExecutionStateInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    paused: {
      type: "boolean",
    },
    frozen: {
      type: "boolean",
    },
  },
  {
    title: "SetExecutionStateInput",
    required: ["pageRef"],
  },
);

const setExecutionStateOutputSchema: JsonSchema = objectSchema(
  {
    paused: {
      type: "boolean",
    },
    frozen: {
      type: "boolean",
    },
  },
  {
    title: "SetExecutionStateOutput",
    required: ["paused", "frozen"],
  },
);

const listPagesInputSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
  },
  {
    title: "ListPagesInput",
    required: ["sessionRef"],
  },
);

const listPagesOutputSchema: JsonSchema = objectSchema(
  {
    pages: arraySchema(pageInfoSchema),
  },
  {
    title: "ListPagesOutput",
    required: ["pages"],
  },
);

const listFramesOutputSchema: JsonSchema = objectSchema(
  {
    frames: arraySchema(frameInfoSchema),
  },
  {
    title: "ListFramesOutput",
    required: ["frames"],
  },
);

const frameRefInputSchema: JsonSchema = objectSchema(
  {
    frameRef: frameRefSchema,
  },
  {
    title: "FrameRefInput",
    required: ["frameRef"],
  },
);

const frameDocumentTargetSchema: JsonSchema = objectSchema(
  {
    frameRef: frameRefSchema,
  },
  {
    title: "FrameDocumentTarget",
    required: ["frameRef"],
  },
);

const concreteDocumentTargetSchema: JsonSchema = objectSchema(
  {
    documentRef: documentRefSchema,
  },
  {
    title: "ConcreteDocumentTarget",
    required: ["documentRef"],
  },
);

const documentTargetSchema: JsonSchema = oneOfSchema(
  [frameDocumentTargetSchema, concreteDocumentTargetSchema],
  {
    title: "DocumentTarget",
  },
);

const readTextOutputSchema: JsonSchema = objectSchema(
  {
    text: {
      type: ["string", "null"],
    },
  },
  {
    title: "ReadTextOutput",
    required: ["text"],
  },
);

const readAttributesOutputSchema: JsonSchema = objectSchema(
  {
    attributes: arraySchema(attributeEntrySchema),
  },
  {
    title: "ReadAttributesOutput",
    required: ["attributes"],
  },
);

const hitTestInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    point: pointSchema,
    coordinateSpace: coordinateSpaceSchema,
    ignorePointerEventsNone: {
      type: "boolean",
    },
    includeUserAgentShadowDom: {
      type: "boolean",
    },
  },
  {
    title: "HitTestInput",
    required: ["pageRef", "point", "coordinateSpace"],
  },
);

const getNetworkRecordsInputSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    pageRef: pageRefSchema,
    includeBodies: {
      type: "boolean",
    },
  },
  {
    title: "GetNetworkRecordsInput",
    required: ["sessionRef"],
  },
);

const getNetworkRecordsOutputSchema: JsonSchema = objectSchema(
  {
    records: arraySchema(networkRecordSchema),
  },
  {
    title: "GetNetworkRecordsOutput",
    required: ["records"],
  },
);

const getCookiesInputSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    urls: arraySchema(stringSchema()),
  },
  {
    title: "GetCookiesInput",
    required: ["sessionRef"],
  },
);

const getCookiesOutputSchema: JsonSchema = objectSchema(
  {
    cookies: arraySchema(cookieRecordSchema),
  },
  {
    title: "GetCookiesOutput",
    required: ["cookies"],
  },
);

const getStorageSnapshotInputSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    includeSessionStorage: {
      type: "boolean",
    },
    includeIndexedDb: {
      type: "boolean",
    },
  },
  {
    title: "GetStorageSnapshotInput",
    required: ["sessionRef"],
  },
);

const executeSessionRequestInputSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    request: sessionTransportRequestSchema,
  },
  {
    title: "ExecuteSessionRequestInput",
    required: ["sessionRef", "request"],
  },
);

export function resolveRequiredCapabilities<TInput>(
  spec: Pick<
    OpensteerOperationSpec<TInput, unknown>,
    "requiredCapabilities" | "resolveRequiredCapabilities"
  >,
  input: TInput,
): readonly OpensteerCapability[] {
  return spec.resolveRequiredCapabilities?.(input) ?? spec.requiredCapabilities;
}

export const opensteerOperationSpecifications = [
  defineOperationSpec<CreateSessionInput, CreateSessionOutput>({
    name: "session.create",
    description: "Create a new isolated session boundary.",
    inputSchema: createSessionInputSchema,
    outputSchema: createSessionOutputSchema,
    requiredCapabilities: ["sessions.manage"],
  }),
  defineOperationSpec<CloseSessionInput, CloseSessionOutput>({
    name: "session.close",
    description: "Close a session and release all associated pages.",
    inputSchema: closeSessionInputSchema,
    outputSchema: closeSessionOutputSchema,
    requiredCapabilities: ["sessions.manage"],
  }),
  defineOperationSpec<CreatePageInput, CreatePageOutput>({
    name: "page.create",
    description: "Create a top-level browsing context within a session.",
    inputSchema: createPageInputSchema,
    outputSchema: pageOperationResultSchema,
    requiredCapabilities: ["pages.manage"],
  }),
  defineOperationSpec<ClosePageInput, ClosePageOutput>({
    name: "page.close",
    description: "Close an existing top-level browsing context.",
    inputSchema: closePageInputSchema,
    outputSchema: closePageOutputSchema,
    requiredCapabilities: ["pages.manage"],
  }),
  defineOperationSpec<ActivatePageInput, PageInfo>({
    name: "page.activate",
    description: "Make a page the active top-level browsing context.",
    inputSchema: pageRefInputSchema,
    outputSchema: pageInfoSchema,
    requiredCapabilities: ["pages.manage"],
  }),
  defineOperationSpec<NavigatePageInput, NavigatePageOutput>({
    name: "page.navigate",
    description: "Navigate a page to a new URL.",
    inputSchema: navigatePageInputSchema,
    outputSchema: pageOperationResultSchema,
    requiredCapabilities: ["pages.navigate"],
  }),
  defineOperationSpec<ReloadPageInput, NavigatePageOutput>({
    name: "page.reload",
    description: "Reload the current main frame document.",
    inputSchema: reloadPageInputSchema,
    outputSchema: pageOperationResultSchema,
    requiredCapabilities: ["pages.navigate"],
  }),
  defineOperationSpec<HistoryNavigationInput, HistoryNavigationOutput>({
    name: "page.go-back",
    description: "Navigate backwards in page history.",
    inputSchema: pageRefInputSchema,
    outputSchema: historyNavigationOutputSchema,
    requiredCapabilities: ["pages.navigate"],
  }),
  defineOperationSpec<HistoryNavigationInput, HistoryNavigationOutput>({
    name: "page.go-forward",
    description: "Navigate forwards in page history.",
    inputSchema: pageRefInputSchema,
    outputSchema: historyNavigationOutputSchema,
    requiredCapabilities: ["pages.navigate"],
  }),
  defineOperationSpec<StopLoadingInput, StopLoadingOutput>({
    name: "page.stop-loading",
    description: "Stop the current navigation or resource load.",
    inputSchema: pageRefInputSchema,
    outputSchema: stopLoadingOutputSchema,
    requiredCapabilities: ["pages.navigate"],
  }),
  defineOperationSpec<MouseMoveInput, MouseMoveOutput>({
    name: "input.mouse-move",
    description: "Move the mouse pointer in the requested coordinate space.",
    inputSchema: mouseMoveInputSchema,
    outputSchema: mouseMoveOutputSchema,
    requiredCapabilities: ["input.pointer"],
  }),
  defineOperationSpec<MouseClickInput, MouseClickOutput>({
    name: "input.mouse-click",
    description: "Dispatch a pointer click and optionally return the resolved target.",
    inputSchema: mouseClickInputSchema,
    outputSchema: mouseClickOutputSchema,
    requiredCapabilities: ["input.pointer"],
    resolveRequiredCapabilities: (input) =>
      (input.modifiers?.length ?? 0) > 0 ? ["input.pointer", "input.keyboard"] : ["input.pointer"],
  }),
  defineOperationSpec<MouseScrollInput, MouseScrollOutput>({
    name: "input.mouse-scroll",
    description: "Dispatch a wheel scroll at the given coordinate.",
    inputSchema: mouseScrollInputSchema,
    outputSchema: mouseScrollOutputSchema,
    requiredCapabilities: ["input.pointer"],
  }),
  defineOperationSpec<KeyPressInput, KeyPressOutput>({
    name: "input.key-press",
    description: "Dispatch a key press with optional modifier keys.",
    inputSchema: keyPressInputSchema,
    outputSchema: keyPressOutputSchema,
    requiredCapabilities: ["input.keyboard"],
  }),
  defineOperationSpec<TextInputInput, TextInputOutput>({
    name: "input.text-input",
    description: "Insert raw text into the focused page target.",
    inputSchema: textInputInputSchema,
    outputSchema: textInputOutputSchema,
    requiredCapabilities: ["input.keyboard"],
  }),
  defineOperationSpec<CaptureScreenshotInput, ScreenshotArtifact>({
    name: "artifact.capture-screenshot",
    description: "Capture a screenshot artifact from the current page view.",
    inputSchema: captureScreenshotInputSchema,
    outputSchema: screenshotArtifactSchema,
    requiredCapabilities: ["artifacts.screenshot"],
  }),
  defineOperationSpec<SetExecutionStateInput, SetExecutionStateOutput>({
    name: "execution.set-state",
    description: "Pause, resume, or freeze page execution state.",
    inputSchema: setExecutionStateInputSchema,
    outputSchema: setExecutionStateOutputSchema,
    requiredCapabilities: [],
    resolveRequiredCapabilities: (input) => {
      const required: OpensteerCapability[] = [];

      if (input.paused === true) {
        required.push("execution.pause");
      } else if (input.paused === false) {
        required.push("execution.resume");
      }

      if (input.frozen !== undefined) {
        required.push("execution.freeze");
      }

      return required;
    },
  }),
  defineOperationSpec<ListPagesInput, ListPagesOutput>({
    name: "inspect.list-pages",
    description: "List all pages in the current session.",
    inputSchema: listPagesInputSchema,
    outputSchema: listPagesOutputSchema,
    requiredCapabilities: ["inspect.pages"],
  }),
  defineOperationSpec<ListFramesInput, ListFramesOutput>({
    name: "inspect.list-frames",
    description: "List all frames within a page.",
    inputSchema: pageRefInputSchema,
    outputSchema: listFramesOutputSchema,
    requiredCapabilities: ["inspect.frames"],
  }),
  defineOperationSpec<GetPageInfoInput, PageInfo>({
    name: "inspect.get-page-info",
    description: "Read metadata for a specific page.",
    inputSchema: pageRefInputSchema,
    outputSchema: pageInfoSchema,
    requiredCapabilities: ["inspect.pages"],
  }),
  defineOperationSpec<GetFrameInfoInput, FrameInfo>({
    name: "inspect.get-frame-info",
    description: "Read metadata for a specific frame.",
    inputSchema: frameRefInputSchema,
    outputSchema: frameInfoSchema,
    requiredCapabilities: ["inspect.frames"],
  }),
  defineOperationSpec<GetHtmlSnapshotInput, HtmlSnapshot>({
    name: "inspect.get-html-snapshot",
    description: "Read raw HTML for a frame or concrete document.",
    inputSchema: documentTargetSchema,
    outputSchema: htmlSnapshotSchema,
    requiredCapabilities: ["inspect.html"],
  }),
  defineOperationSpec<GetDomSnapshotInput, DomSnapshot>({
    name: "inspect.get-dom-snapshot",
    description: "Read a structured DOM snapshot for a frame or concrete document.",
    inputSchema: documentTargetSchema,
    outputSchema: domSnapshotSchema,
    requiredCapabilities: ["inspect.domSnapshot"],
  }),
  defineOperationSpec<ReadTextInput, ReadTextOutput>({
    name: "inspect.read-text",
    description: "Read text content for a node locator.",
    inputSchema: nodeLocatorSchema,
    outputSchema: readTextOutputSchema,
    requiredCapabilities: ["inspect.text"],
  }),
  defineOperationSpec<ReadAttributesInput, ReadAttributesOutput>({
    name: "inspect.read-attributes",
    description: "Read ordered attributes for a node locator.",
    inputSchema: nodeLocatorSchema,
    outputSchema: readAttributesOutputSchema,
    requiredCapabilities: ["inspect.attributes"],
  }),
  defineOperationSpec<HitTestInput, HitTestResult>({
    name: "inspect.hit-test",
    description: "Resolve a point into the current DOM target at that coordinate.",
    inputSchema: hitTestInputSchema,
    outputSchema: hitTestResultSchema,
    requiredCapabilities: ["inspect.hitTest"],
  }),
  defineOperationSpec<GetViewportMetricsInput, ViewportMetrics>({
    name: "inspect.get-viewport-metrics",
    description: "Read layout, visual viewport, and scroll metrics for a page.",
    inputSchema: pageRefInputSchema,
    outputSchema: viewportMetricsSchema,
    requiredCapabilities: ["inspect.viewportMetrics"],
  }),
  defineOperationSpec<GetNetworkRecordsInput, GetNetworkRecordsOutput>({
    name: "inspect.get-network-records",
    description: "Read normalized network records for a session or page.",
    inputSchema: getNetworkRecordsInputSchema,
    outputSchema: getNetworkRecordsOutputSchema,
    requiredCapabilities: ["inspect.network"],
    resolveRequiredCapabilities: (input) =>
      input.includeBodies === true
        ? ["inspect.network", "inspect.networkBodies"]
        : ["inspect.network"],
  }),
  defineOperationSpec<GetCookiesInput, GetCookiesOutput>({
    name: "inspect.get-cookies",
    description: "Read cookie state filtered by URL semantics when requested.",
    inputSchema: getCookiesInputSchema,
    outputSchema: getCookiesOutputSchema,
    requiredCapabilities: ["inspect.cookies"],
  }),
  defineOperationSpec<GetStorageSnapshotInput, StorageSnapshot>({
    name: "inspect.get-storage-snapshot",
    description: "Read storage state for origins reachable in the session boundary.",
    inputSchema: getStorageSnapshotInputSchema,
    outputSchema: storageSnapshotSchema,
    requiredCapabilities: ["inspect.localStorage"],
    resolveRequiredCapabilities: (input) => {
      const required: OpensteerCapability[] = ["inspect.localStorage"];

      if (input.includeSessionStorage ?? true) {
        required.push("inspect.sessionStorage");
      }
      if (input.includeIndexedDb ?? true) {
        required.push("inspect.indexedDb");
      }

      return required;
    },
  }),
  defineOperationSpec<ExecuteSessionRequestInput, SessionTransportResponse>({
    name: "transport.execute-session-request",
    description: "Execute an HTTP request within the active browser session boundary.",
    inputSchema: executeSessionRequestInputSchema,
    outputSchema: sessionTransportResponseSchema,
    requiredCapabilities: ["transport.sessionHttp"],
  }),
] as const satisfies readonly OpensteerOperationSpec[];

export const opensteerOperationSpecificationMap = Object.fromEntries(
  opensteerOperationSpecifications.map((spec) => [spec.name, spec]),
) as Record<OpensteerOperationName, OpensteerOperationSpec>;
