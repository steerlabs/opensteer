import type { JsonSchema, JsonValue } from "./json.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  literalSchema,
  objectSchema,
  oneOfSchema,
  recordSchema,
  stringSchema,
  numberSchema,
} from "./json.js";
import { OpensteerProtocolError } from "./errors.js";
import type { OpensteerCapability } from "./capabilities.js";
import {
  documentEpochSchema,
  documentRefSchema,
  frameRefSchema,
  nodeRefSchema,
  pageRefSchema,
  sessionRefSchema,
} from "./identity.js";
import type {
  DocumentEpoch,
  DocumentRef,
  FrameRef,
  NodeRef,
  PageRef,
  SessionRef,
} from "./identity.js";
import { pointSchema, viewportMetricsSchema } from "./geometry.js";
import type { Point, ViewportMetrics } from "./geometry.js";
import { opensteerEventSchema, type OpensteerEvent } from "./events.js";
import { requestEnvelopeSchema, responseEnvelopeSchema } from "./envelopes.js";
import {
  hitTestResultSchema,
  screenshotArtifactSchema,
  type HitTestResult,
  type ScreenshotArtifact,
  type ScreenshotFormat,
} from "./snapshots.js";
import {
  cookieRecordSchema,
  storageSnapshotSchema,
  type CookieRecord,
  type StorageSnapshot,
} from "./storage.js";
import {
  opensteerGetAuthRecipeInputSchema,
  opensteerListAuthRecipesInputSchema,
  opensteerListAuthRecipesOutputSchema,
  opensteerGetRequestPlanInputSchema,
  opensteerRunAuthRecipeInputSchema,
  opensteerRunAuthRecipeOutputSchema,
  opensteerListRequestPlansInputSchema,
  opensteerListRequestPlansOutputSchema,
  opensteerNetworkClearInputSchema,
  opensteerNetworkClearOutputSchema,
  opensteerNetworkQueryInputSchema,
  opensteerNetworkQueryOutputSchema,
  opensteerNetworkSaveInputSchema,
  opensteerNetworkSaveOutputSchema,
  opensteerInferRequestPlanInputSchema,
  opensteerRawRequestInputSchema,
  opensteerRawRequestOutputSchema,
  opensteerRequestExecuteInputSchema,
  opensteerRequestExecuteOutputSchema,
  opensteerAuthRecipeRecordSchema,
  opensteerRequestPlanRecordSchema,
  opensteerWriteAuthRecipeInputSchema,
  opensteerWriteRequestPlanInputSchema,
  type OpensteerGetAuthRecipeInput,
  type OpensteerGetRequestPlanInput,
  type OpensteerListAuthRecipesInput,
  type OpensteerListAuthRecipesOutput,
  type OpensteerListRequestPlansInput,
  type OpensteerListRequestPlansOutput,
  type OpensteerInferRequestPlanInput,
  type OpensteerNetworkClearInput,
  type OpensteerNetworkClearOutput,
  type OpensteerNetworkQueryInput,
  type OpensteerNetworkQueryOutput,
  type OpensteerNetworkSaveInput,
  type OpensteerNetworkSaveOutput,
  type OpensteerRawRequestInput,
  type OpensteerRawRequestOutput,
  type OpensteerRequestExecuteInput,
  type OpensteerRequestExecuteOutput,
  type OpensteerAuthRecipeRecord,
  type OpensteerRunAuthRecipeInput,
  type OpensteerRunAuthRecipeOutput,
  type OpensteerRequestPlanRecord,
  type OpensteerWriteAuthRecipeInput,
  type OpensteerWriteRequestPlanInput,
} from "./requests.js";
import { validateJsonSchema } from "./validation.js";
import { OPENSTEER_PROTOCOL_REST_BASE_PATH } from "./version.js";

export type OpensteerSnapshotMode = "action" | "extraction";

export interface OpensteerManagedBrowserLaunchOptions {
  readonly kind?: "managed";
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface OpensteerProfileBrowserLaunchOptions {
  readonly kind: "profile";
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly userDataDir: string;
  readonly profileDirectory?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface OpensteerCdpBrowserLaunchOptions {
  readonly kind: "cdp";
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly freshTab?: boolean;
}

export interface OpensteerAutoConnectBrowserLaunchOptions {
  readonly kind: "auto-connect";
  readonly freshTab?: boolean;
}

export type OpensteerBrowserLaunchOptions =
  | OpensteerManagedBrowserLaunchOptions
  | OpensteerProfileBrowserLaunchOptions
  | OpensteerCdpBrowserLaunchOptions
  | OpensteerAutoConnectBrowserLaunchOptions;

export interface OpensteerBrowserContextOptions {
  readonly ignoreHTTPSErrors?: boolean;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly userAgent?: string;
  readonly viewport?: {
    readonly width: number;
    readonly height: number;
  } | null;
  readonly javaScriptEnabled?: boolean;
  readonly bypassCSP?: boolean;
  readonly reducedMotion?: "reduce" | "no-preference";
  readonly colorScheme?: "light" | "dark" | "no-preference";
}

export interface OpensteerTargetByElement {
  readonly kind: "element";
  readonly element: number;
}

export interface OpensteerTargetByDescription {
  readonly kind: "description";
  readonly description: string;
}

export interface OpensteerTargetBySelector {
  readonly kind: "selector";
  readonly selector: string;
}

export type OpensteerTargetInput =
  | OpensteerTargetByElement
  | OpensteerTargetByDescription
  | OpensteerTargetBySelector;

export interface OpensteerResolvedTarget {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly nodeRef: NodeRef;
  readonly tagName: string;
  readonly pathHint: string;
  readonly description?: string;
  readonly selectorUsed?: string;
}

export interface OpensteerActionResult {
  readonly target: OpensteerResolvedTarget;
  readonly point?: {
    readonly x: number;
    readonly y: number;
  };
  readonly persistedDescription?: string;
}

export interface OpensteerSnapshotCounter {
  readonly element: number;
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly nodeRef?: NodeRef;
  readonly tagName: string;
  readonly pathHint: string;
  readonly text?: string;
  readonly attributes?: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly iframeDepth: number;
  readonly shadowDepth: number;
  readonly interactive: boolean;
}

export interface OpensteerSessionState {
  readonly sessionRef: SessionRef;
  readonly pageRef: PageRef;
  readonly url: string;
  readonly title: string;
}

export interface OpensteerSessionOpenInput {
  readonly url?: string;
  readonly name?: string;
  readonly browser?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
}

export interface OpensteerSessionOpenOutput extends OpensteerSessionState {}

export interface OpensteerPageGotoInput {
  readonly url: string;
  readonly networkTag?: string;
}

export interface OpensteerPageGotoOutput extends OpensteerSessionState {}

export interface OpensteerPageSnapshotInput {
  readonly mode?: OpensteerSnapshotMode;
}

export interface OpensteerPageSnapshotOutput {
  readonly url: string;
  readonly title: string;
  readonly mode: OpensteerSnapshotMode;
  readonly html: string;
  readonly counters: readonly OpensteerSnapshotCounter[];
}

export interface OpensteerInspectCookiesInput {
  readonly urls?: readonly string[];
}

export interface OpensteerInspectStorageInput {
  readonly includeSessionStorage?: boolean;
  readonly includeIndexedDb?: boolean;
}

export interface OpensteerDomClickInput {
  readonly target: OpensteerTargetInput;
  readonly persistAsDescription?: string;
  readonly networkTag?: string;
}

export interface OpensteerDomHoverInput {
  readonly target: OpensteerTargetInput;
  readonly persistAsDescription?: string;
  readonly networkTag?: string;
}

export interface OpensteerDomInputInput {
  readonly target: OpensteerTargetInput;
  readonly text: string;
  readonly pressEnter?: boolean;
  readonly persistAsDescription?: string;
  readonly networkTag?: string;
}

export interface OpensteerDomScrollInput {
  readonly target: OpensteerTargetInput;
  readonly direction: "up" | "down" | "left" | "right";
  readonly amount: number;
  readonly persistAsDescription?: string;
  readonly networkTag?: string;
}

export interface OpensteerDomExtractInput {
  readonly description: string;
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface OpensteerDomExtractOutput {
  readonly data: JsonValue;
}

export interface OpensteerSessionCloseInput {}

export interface OpensteerSessionCloseOutput {
  readonly closed: true;
}

export const opensteerComputerAnnotationNames = [
  "clickable",
  "typeable",
  "scrollable",
  "grid",
  "selected",
] as const;

export type OpensteerComputerAnnotation = (typeof opensteerComputerAnnotationNames)[number];

export type OpensteerComputerMouseButton = "left" | "middle" | "right";
export type OpensteerComputerKeyModifier = "Shift" | "Control" | "Alt" | "Meta";

export interface OpensteerComputerClickAction {
  readonly type: "click";
  readonly x: number;
  readonly y: number;
  readonly button?: OpensteerComputerMouseButton;
  readonly clickCount?: number;
  readonly modifiers?: readonly OpensteerComputerKeyModifier[];
}

export interface OpensteerComputerMoveAction {
  readonly type: "move";
  readonly x: number;
  readonly y: number;
}

export interface OpensteerComputerScrollAction {
  readonly type: "scroll";
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface OpensteerComputerTypeAction {
  readonly type: "type";
  readonly text: string;
}

export interface OpensteerComputerKeyAction {
  readonly type: "key";
  readonly key: string;
  readonly modifiers?: readonly OpensteerComputerKeyModifier[];
}

export interface OpensteerComputerDragAction {
  readonly type: "drag";
  readonly start: Point;
  readonly end: Point;
  readonly steps?: number;
}

export interface OpensteerComputerScreenshotAction {
  readonly type: "screenshot";
}

export interface OpensteerComputerWaitAction {
  readonly type: "wait";
  readonly durationMs: number;
}

export type OpensteerComputerAction =
  | OpensteerComputerClickAction
  | OpensteerComputerMoveAction
  | OpensteerComputerScrollAction
  | OpensteerComputerTypeAction
  | OpensteerComputerKeyAction
  | OpensteerComputerDragAction
  | OpensteerComputerScreenshotAction
  | OpensteerComputerWaitAction;

export interface OpensteerComputerScreenshotOptions {
  readonly format?: ScreenshotFormat;
  readonly includeCursor?: boolean;
  readonly disableAnnotations?: readonly OpensteerComputerAnnotation[];
}

export interface OpensteerComputerExecuteInput {
  readonly action: OpensteerComputerAction;
  readonly screenshot?: OpensteerComputerScreenshotOptions;
  readonly networkTag?: string;
}

export interface OpensteerComputerDisplayScale {
  readonly x: number;
  readonly y: number;
}

export interface OpensteerComputerTracePoint {
  readonly role: "point" | "start" | "end";
  readonly point: Point;
  readonly hitTest?: HitTestResult;
  readonly target?: OpensteerResolvedTarget;
}

export interface OpensteerComputerTraceEnrichment {
  readonly points: readonly OpensteerComputerTracePoint[];
}

export interface OpensteerComputerExecuteTiming {
  readonly actionMs: number;
  readonly waitMs: number;
  readonly totalMs: number;
}

export interface OpensteerComputerExecuteOutput {
  readonly action: OpensteerComputerAction;
  readonly pageRef: PageRef;
  readonly screenshot: ScreenshotArtifact;
  readonly displayViewport: ViewportMetrics;
  readonly nativeViewport: ViewportMetrics;
  readonly displayScale: OpensteerComputerDisplayScale;
  readonly events: readonly OpensteerEvent[];
  readonly timing: OpensteerComputerExecuteTiming;
  readonly trace?: OpensteerComputerTraceEnrichment;
}

export const opensteerSemanticOperationNames = [
  "session.open",
  "page.goto",
  "page.snapshot",
  "dom.click",
  "dom.hover",
  "dom.input",
  "dom.scroll",
  "dom.extract",
  "network.query",
  "network.save",
  "network.clear",
  "inspect.cookies",
  "inspect.storage",
  "request.raw",
  "request-plan.infer",
  "request-plan.write",
  "request-plan.get",
  "request-plan.list",
  "auth-recipe.write",
  "auth-recipe.get",
  "auth-recipe.list",
  "auth-recipe.run",
  "request.execute",
  "computer.execute",
  "session.close",
] as const;

export type OpensteerSemanticOperationName = (typeof opensteerSemanticOperationNames)[number];

export interface OpensteerSemanticOperationSpec<TInput = unknown, TOutput = unknown> {
  readonly name: OpensteerSemanticOperationName;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly requiredCapabilities: readonly OpensteerCapability[];
  resolveRequiredCapabilities?(input: TInput): readonly OpensteerCapability[];
}

export interface OpensteerSemanticRestEndpointDescriptor {
  readonly name: OpensteerSemanticOperationName;
  readonly method: "POST";
  readonly path: string;
  readonly description: string;
  readonly requestSchema: JsonSchema;
  readonly responseSchema: JsonSchema;
}

function defineSemanticOperationSpec<TInput, TOutput>(
  spec: OpensteerSemanticOperationSpec<TInput, TOutput>,
): OpensteerSemanticOperationSpec<TInput, TOutput> {
  return spec;
}

const snapshotModeSchema: JsonSchema = enumSchema(["action", "extraction"] as const, {
  title: "OpensteerSnapshotMode",
});

const viewportSchema: JsonSchema = oneOfSchema(
  [
    objectSchema(
      {
        width: integerSchema({ minimum: 1 }),
        height: integerSchema({ minimum: 1 }),
      },
      {
        title: "OpensteerViewport",
        required: ["width", "height"],
      },
    ),
    literalSchema(null),
  ],
  {
    title: "OpensteerViewportOrNull",
  },
);

const managedBrowserLaunchOptionsSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["managed"] as const),
    headless: { type: "boolean" },
    executablePath: stringSchema(),
    args: arraySchema(stringSchema()),
    timeoutMs: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerManagedBrowserLaunchOptions",
  },
);

const profileBrowserLaunchOptionsSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["profile"] as const),
    headless: { type: "boolean" },
    executablePath: stringSchema(),
    userDataDir: stringSchema(),
    profileDirectory: stringSchema(),
    args: arraySchema(stringSchema()),
    timeoutMs: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerProfileBrowserLaunchOptions",
    required: ["kind", "userDataDir"],
  },
);

const cdpBrowserLaunchOptionsSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["cdp"] as const),
    endpoint: stringSchema(),
    headers: recordSchema(stringSchema(), {
      title: "OpensteerCdpBrowserHeaders",
    }),
    freshTab: { type: "boolean" },
  },
  {
    title: "OpensteerCdpBrowserLaunchOptions",
    required: ["kind", "endpoint"],
  },
);

const autoConnectBrowserLaunchOptionsSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["auto-connect"] as const),
    freshTab: { type: "boolean" },
  },
  {
    title: "OpensteerAutoConnectBrowserLaunchOptions",
    required: ["kind"],
  },
);

const opensteerBrowserLaunchOptionsSchema: JsonSchema = oneOfSchema(
  [
    managedBrowserLaunchOptionsSchema,
    profileBrowserLaunchOptionsSchema,
    cdpBrowserLaunchOptionsSchema,
    autoConnectBrowserLaunchOptionsSchema,
  ],
  {
    title: "OpensteerBrowserLaunchOptions",
  },
);

const opensteerBrowserContextOptionsSchema: JsonSchema = objectSchema(
  {
    ignoreHTTPSErrors: { type: "boolean" },
    locale: stringSchema(),
    timezoneId: stringSchema(),
    userAgent: stringSchema(),
    viewport: viewportSchema,
    javaScriptEnabled: { type: "boolean" },
    bypassCSP: { type: "boolean" },
    reducedMotion: enumSchema(["reduce", "no-preference"] as const),
    colorScheme: enumSchema(["light", "dark", "no-preference"] as const),
  },
  {
    title: "OpensteerBrowserContextOptions",
  },
);

const targetByElementSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["element"] as const),
    element: integerSchema({ minimum: 1 }),
  },
  {
    title: "OpensteerTargetByElement",
    required: ["kind", "element"],
  },
);

const targetByDescriptionSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["description"] as const),
    description: stringSchema(),
  },
  {
    title: "OpensteerTargetByDescription",
    required: ["kind", "description"],
  },
);

const targetBySelectorSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["selector"] as const),
    selector: stringSchema(),
  },
  {
    title: "OpensteerTargetBySelector",
    required: ["kind", "selector"],
  },
);

const opensteerTargetInputSchema: JsonSchema = oneOfSchema(
  [targetByElementSchema, targetByDescriptionSchema, targetBySelectorSchema],
  {
    title: "OpensteerTargetInput",
  },
);

const opensteerResolvedTargetSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
    nodeRef: nodeRefSchema,
    tagName: stringSchema(),
    pathHint: stringSchema(),
    description: stringSchema(),
    selectorUsed: stringSchema(),
  },
  {
    title: "OpensteerResolvedTarget",
    required: [
      "pageRef",
      "frameRef",
      "documentRef",
      "documentEpoch",
      "nodeRef",
      "tagName",
      "pathHint",
    ],
  },
);

const opensteerActionResultSchema: JsonSchema = objectSchema(
  {
    target: opensteerResolvedTargetSchema,
    point: pointSchema,
    persistedDescription: stringSchema(),
  },
  {
    title: "OpensteerActionResult",
    required: ["target"],
  },
);

const opensteerSnapshotCounterSchema: JsonSchema = objectSchema(
  {
    element: integerSchema({ minimum: 1 }),
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
    nodeRef: nodeRefSchema,
    tagName: stringSchema(),
    pathHint: stringSchema(),
    text: stringSchema(),
    attributes: arraySchema(
      objectSchema(
        {
          name: stringSchema(),
          value: stringSchema(),
        },
        {
          title: "OpensteerSnapshotCounterAttribute",
          required: ["name", "value"],
        },
      ),
    ),
    iframeDepth: integerSchema({ minimum: 0 }),
    shadowDepth: integerSchema({ minimum: 0 }),
    interactive: { type: "boolean" },
  },
  {
    title: "OpensteerSnapshotCounter",
    required: [
      "element",
      "pageRef",
      "frameRef",
      "documentRef",
      "documentEpoch",
      "tagName",
      "pathHint",
      "iframeDepth",
      "shadowDepth",
      "interactive",
    ],
  },
);

const opensteerSessionStateSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    pageRef: pageRefSchema,
    url: stringSchema(),
    title: stringSchema(),
  },
  {
    title: "OpensteerSessionState",
    required: ["sessionRef", "pageRef", "url", "title"],
  },
);

const opensteerSessionOpenInputSchema: JsonSchema = objectSchema(
  {
    url: stringSchema(),
    name: stringSchema(),
    browser: opensteerBrowserLaunchOptionsSchema,
    context: opensteerBrowserContextOptionsSchema,
  },
  {
    title: "OpensteerSessionOpenInput",
  },
);

const opensteerPageGotoInputSchema: JsonSchema = objectSchema(
  {
    url: stringSchema(),
    networkTag: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerPageGotoInput",
    required: ["url"],
  },
);

const opensteerPageSnapshotInputSchema: JsonSchema = objectSchema(
  {
    mode: snapshotModeSchema,
  },
  {
    title: "OpensteerPageSnapshotInput",
  },
);

const opensteerPageSnapshotOutputSchema: JsonSchema = objectSchema(
  {
    url: stringSchema(),
    title: stringSchema(),
    mode: snapshotModeSchema,
    html: stringSchema(),
    counters: arraySchema(opensteerSnapshotCounterSchema),
  },
  {
    title: "OpensteerPageSnapshotOutput",
    required: ["url", "title", "mode", "html", "counters"],
  },
);

const opensteerInspectCookiesInputSchema: JsonSchema = objectSchema(
  {
    urls: arraySchema(stringSchema({ minLength: 1 })),
  },
  {
    title: "OpensteerInspectCookiesInput",
  },
);

const opensteerInspectCookiesOutputSchema: JsonSchema = arraySchema(cookieRecordSchema, {
  title: "OpensteerInspectCookiesOutput",
});

const opensteerInspectStorageInputSchema: JsonSchema = objectSchema(
  {
    includeSessionStorage: { type: "boolean" },
    includeIndexedDb: { type: "boolean" },
  },
  {
    title: "OpensteerInspectStorageInput",
  },
);

const opensteerDomClickInputSchema: JsonSchema = objectSchema(
  {
    target: opensteerTargetInputSchema,
    persistAsDescription: stringSchema(),
    networkTag: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerDomClickInput",
    required: ["target"],
  },
);

const opensteerDomHoverInputSchema = objectSchema(
  {
    target: opensteerTargetInputSchema,
    persistAsDescription: stringSchema(),
    networkTag: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerDomHoverInput",
    required: ["target"],
  },
);

const opensteerDomInputInputSchema: JsonSchema = objectSchema(
  {
    target: opensteerTargetInputSchema,
    text: stringSchema(),
    pressEnter: { type: "boolean" },
    persistAsDescription: stringSchema(),
    networkTag: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerDomInputInput",
    required: ["target", "text"],
  },
);

const opensteerDomScrollInputSchema: JsonSchema = objectSchema(
  {
    target: opensteerTargetInputSchema,
    direction: enumSchema(["up", "down", "left", "right"] as const),
    amount: integerSchema({ minimum: 1 }),
    persistAsDescription: stringSchema(),
    networkTag: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerDomScrollInput",
    required: ["target", "direction", "amount"],
  },
);

const opensteerExtractSchemaSchema: JsonSchema = objectSchema(
  {},
  {
    title: "OpensteerExtractSchema",
    additionalProperties: true,
  },
);

const opensteerDomExtractInputSchema: JsonSchema = objectSchema(
  {
    description: stringSchema(),
    schema: opensteerExtractSchemaSchema,
  },
  {
    title: "OpensteerDomExtractInput",
    required: ["description"],
  },
);

const jsonValueSchema: JsonSchema = recordSchema({}, { title: "JsonValueRecord" });

const opensteerDomExtractOutputSchema: JsonSchema = objectSchema(
  {
    data: oneOfSchema(
      [
        jsonValueSchema,
        arraySchema({}),
        stringSchema(),
        numberSchema(),
        enumSchema([true, false, null] as const),
      ],
      {
        title: "OpensteerExtractedJsonValue",
      },
    ),
  },
  {
    title: "OpensteerDomExtractOutput",
    required: ["data"],
  },
);

const opensteerSessionCloseInputSchema: JsonSchema = objectSchema(
  {},
  {
    title: "OpensteerSessionCloseInput",
    required: [],
  },
);

const opensteerSessionCloseOutputSchema: JsonSchema = objectSchema(
  {
    closed: literalSchema(true),
  },
  {
    title: "OpensteerSessionCloseOutput",
    required: ["closed"],
  },
);

const opensteerComputerMouseButtonSchema: JsonSchema = enumSchema(
  ["left", "middle", "right"] as const,
  {
    title: "OpensteerComputerMouseButton",
  },
);

const opensteerComputerKeyModifierSchema: JsonSchema = enumSchema(
  ["Shift", "Control", "Alt", "Meta"] as const,
  {
    title: "OpensteerComputerKeyModifier",
  },
);

const opensteerComputerAnnotationSchema: JsonSchema = enumSchema(opensteerComputerAnnotationNames, {
  title: "OpensteerComputerAnnotation",
});

const opensteerComputerClickActionSchema: JsonSchema = objectSchema(
  {
    type: enumSchema(["click"] as const),
    x: numberSchema(),
    y: numberSchema(),
    button: opensteerComputerMouseButtonSchema,
    clickCount: integerSchema({ minimum: 1 }),
    modifiers: arraySchema(opensteerComputerKeyModifierSchema, {
      uniqueItems: true,
    }),
  },
  {
    title: "OpensteerComputerClickAction",
    required: ["type", "x", "y"],
  },
);

const opensteerComputerMoveActionSchema: JsonSchema = objectSchema(
  {
    type: enumSchema(["move"] as const),
    x: numberSchema(),
    y: numberSchema(),
  },
  {
    title: "OpensteerComputerMoveAction",
    required: ["type", "x", "y"],
  },
);

const opensteerComputerScrollActionSchema: JsonSchema = objectSchema(
  {
    type: enumSchema(["scroll"] as const),
    x: numberSchema(),
    y: numberSchema(),
    deltaX: numberSchema(),
    deltaY: numberSchema(),
  },
  {
    title: "OpensteerComputerScrollAction",
    required: ["type", "x", "y", "deltaX", "deltaY"],
  },
);

const opensteerComputerTypeActionSchema: JsonSchema = objectSchema(
  {
    type: enumSchema(["type"] as const),
    text: stringSchema(),
  },
  {
    title: "OpensteerComputerTypeAction",
    required: ["type", "text"],
  },
);

const opensteerComputerKeyActionSchema: JsonSchema = objectSchema(
  {
    type: enumSchema(["key"] as const),
    key: stringSchema(),
    modifiers: arraySchema(opensteerComputerKeyModifierSchema, {
      uniqueItems: true,
    }),
  },
  {
    title: "OpensteerComputerKeyAction",
    required: ["type", "key"],
  },
);

const opensteerComputerDragActionSchema: JsonSchema = objectSchema(
  {
    type: enumSchema(["drag"] as const),
    start: pointSchema,
    end: pointSchema,
    steps: integerSchema({ minimum: 1 }),
  },
  {
    title: "OpensteerComputerDragAction",
    required: ["type", "start", "end"],
  },
);

const opensteerComputerScreenshotActionSchema: JsonSchema = objectSchema(
  {
    type: enumSchema(["screenshot"] as const),
  },
  {
    title: "OpensteerComputerScreenshotAction",
    required: ["type"],
  },
);

const opensteerComputerWaitActionSchema: JsonSchema = objectSchema(
  {
    type: enumSchema(["wait"] as const),
    durationMs: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerComputerWaitAction",
    required: ["type", "durationMs"],
  },
);

const opensteerComputerActionSchema: JsonSchema = oneOfSchema(
  [
    opensteerComputerClickActionSchema,
    opensteerComputerMoveActionSchema,
    opensteerComputerScrollActionSchema,
    opensteerComputerTypeActionSchema,
    opensteerComputerKeyActionSchema,
    opensteerComputerDragActionSchema,
    opensteerComputerScreenshotActionSchema,
    opensteerComputerWaitActionSchema,
  ],
  {
    title: "OpensteerComputerAction",
  },
);

const opensteerComputerScreenshotOptionsSchema: JsonSchema = objectSchema(
  {
    format: enumSchema(["png", "jpeg", "webp"] as const),
    includeCursor: { type: "boolean" },
    disableAnnotations: arraySchema(opensteerComputerAnnotationSchema, {
      uniqueItems: true,
    }),
  },
  {
    title: "OpensteerComputerScreenshotOptions",
  },
);

const opensteerComputerExecuteInputSchema: JsonSchema = objectSchema(
  {
    action: opensteerComputerActionSchema,
    screenshot: opensteerComputerScreenshotOptionsSchema,
    networkTag: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerComputerExecuteInput",
    required: ["action"],
  },
);

const opensteerComputerTracePointSchema: JsonSchema = objectSchema(
  {
    role: enumSchema(["point", "start", "end"] as const),
    point: pointSchema,
    hitTest: hitTestResultSchema,
    target: opensteerResolvedTargetSchema,
  },
  {
    title: "OpensteerComputerTracePoint",
    required: ["role", "point"],
  },
);

const opensteerComputerTraceEnrichmentSchema: JsonSchema = objectSchema(
  {
    points: arraySchema(opensteerComputerTracePointSchema),
  },
  {
    title: "OpensteerComputerTraceEnrichment",
    required: ["points"],
  },
);

const opensteerComputerExecuteTimingSchema: JsonSchema = objectSchema(
  {
    actionMs: integerSchema({ minimum: 0 }),
    waitMs: integerSchema({ minimum: 0 }),
    totalMs: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerComputerExecuteTiming",
    required: ["actionMs", "waitMs", "totalMs"],
  },
);

const opensteerComputerDisplayScaleSchema: JsonSchema = objectSchema(
  {
    x: numberSchema({ exclusiveMinimum: 0 }),
    y: numberSchema({ exclusiveMinimum: 0 }),
  },
  {
    title: "OpensteerComputerDisplayScale",
    required: ["x", "y"],
  },
);

const opensteerComputerExecuteOutputSchema: JsonSchema = objectSchema(
  {
    action: opensteerComputerActionSchema,
    pageRef: pageRefSchema,
    screenshot: screenshotArtifactSchema,
    displayViewport: viewportMetricsSchema,
    nativeViewport: viewportMetricsSchema,
    displayScale: opensteerComputerDisplayScaleSchema,
    events: arraySchema(opensteerEventSchema),
    timing: opensteerComputerExecuteTimingSchema,
    trace: opensteerComputerTraceEnrichmentSchema,
  },
  {
    title: "OpensteerComputerExecuteOutput",
    required: [
      "action",
      "pageRef",
      "screenshot",
      "displayViewport",
      "nativeViewport",
      "displayScale",
      "events",
      "timing",
    ],
  },
);

export function resolveSemanticRequiredCapabilities<TInput>(
  spec: Pick<
    OpensteerSemanticOperationSpec<TInput, unknown>,
    "requiredCapabilities" | "resolveRequiredCapabilities"
  >,
  input: TInput,
): readonly OpensteerCapability[] {
  return spec.resolveRequiredCapabilities?.(input) ?? spec.requiredCapabilities;
}

export function assertValidSemanticOperationInput(
  name: OpensteerSemanticOperationName,
  input: unknown,
): void {
  const spec = opensteerSemanticOperationSpecificationMap[name];
  const issues = validateJsonSchema(spec.inputSchema, input);
  if (issues.length === 0) {
    return;
  }

  const firstIssue = issues[0]!;
  throw new OpensteerProtocolError(
    "invalid-request",
    `invalid ${name} input at ${firstIssue.path}: ${firstIssue.message}`,
    {
      details: {
        operation: name,
        issues,
      },
    },
  );
}

export const opensteerSemanticOperationSpecifications = [
  defineSemanticOperationSpec<OpensteerSessionOpenInput, OpensteerSessionOpenOutput>({
    name: "session.open",
    description: "Open or resume the current Opensteer session and primary page.",
    inputSchema: opensteerSessionOpenInputSchema,
    outputSchema: opensteerSessionStateSchema,
    requiredCapabilities: ["sessions.manage", "pages.manage"],
    resolveRequiredCapabilities: (input) =>
      input.url === undefined
        ? ["sessions.manage", "pages.manage"]
        : ["sessions.manage", "pages.manage", "pages.navigate"],
  }),
  defineSemanticOperationSpec<OpensteerPageGotoInput, OpensteerPageGotoOutput>({
    name: "page.goto",
    description: "Navigate the current Opensteer page to a new URL.",
    inputSchema: opensteerPageGotoInputSchema,
    outputSchema: opensteerSessionStateSchema,
    requiredCapabilities: ["pages.navigate"],
  }),
  defineSemanticOperationSpec<OpensteerPageSnapshotInput, OpensteerPageSnapshotOutput>({
    name: "page.snapshot",
    description: "Compile an HTML-first agent snapshot for the current page.",
    inputSchema: opensteerPageSnapshotInputSchema,
    outputSchema: opensteerPageSnapshotOutputSchema,
    requiredCapabilities: ["inspect.pages", "inspect.html", "inspect.domSnapshot"],
  }),
  defineSemanticOperationSpec<OpensteerDomClickInput, OpensteerActionResult>({
    name: "dom.click",
    description: "Resolve and click a DOM target using Opensteer semantics.",
    inputSchema: opensteerDomClickInputSchema,
    outputSchema: opensteerActionResultSchema,
    requiredCapabilities: ["input.pointer", "inspect.domSnapshot", "inspect.hitTest"],
  }),
  defineSemanticOperationSpec<OpensteerDomHoverInput, OpensteerActionResult>({
    name: "dom.hover",
    description: "Resolve and hover a DOM target using Opensteer semantics.",
    inputSchema: opensteerDomHoverInputSchema,
    outputSchema: opensteerActionResultSchema,
    requiredCapabilities: ["input.pointer", "inspect.domSnapshot", "inspect.hitTest"],
  }),
  defineSemanticOperationSpec<OpensteerDomInputInput, OpensteerActionResult>({
    name: "dom.input",
    description: "Resolve a DOM target, focus it, and type text through Opensteer semantics.",
    inputSchema: opensteerDomInputInputSchema,
    outputSchema: opensteerActionResultSchema,
    requiredCapabilities: [
      "input.pointer",
      "input.keyboard",
      "inspect.domSnapshot",
      "inspect.hitTest",
    ],
  }),
  defineSemanticOperationSpec<OpensteerDomScrollInput, OpensteerActionResult>({
    name: "dom.scroll",
    description:
      "Resolve a DOM target and dispatch directional scrolling through Opensteer semantics.",
    inputSchema: opensteerDomScrollInputSchema,
    outputSchema: opensteerActionResultSchema,
    requiredCapabilities: ["input.pointer", "inspect.domSnapshot", "inspect.hitTest"],
  }),
  defineSemanticOperationSpec<OpensteerDomExtractInput, OpensteerDomExtractOutput>({
    name: "dom.extract",
    description: "Run structured DOM extraction with persisted Opensteer extraction descriptors.",
    inputSchema: opensteerDomExtractInputSchema,
    outputSchema: opensteerDomExtractOutputSchema,
    requiredCapabilities: ["inspect.domSnapshot", "inspect.text", "inspect.attributes"],
  }),
  defineSemanticOperationSpec<OpensteerNetworkQueryInput, OpensteerNetworkQueryOutput>({
    name: "network.query",
    description: "Query live or saved network records for reverse engineering workflows.",
    inputSchema: opensteerNetworkQueryInputSchema,
    outputSchema: opensteerNetworkQueryOutputSchema,
    requiredCapabilities: [],
    resolveRequiredCapabilities: (input) =>
      input.source === "saved"
        ? []
        : input.includeBodies === true
          ? ["inspect.network", "inspect.networkBodies"]
          : ["inspect.network"],
  }),
  defineSemanticOperationSpec<OpensteerNetworkSaveInput, OpensteerNetworkSaveOutput>({
    name: "network.save",
    description:
      "Persist filtered live network records into the saved network registry under a tag.",
    inputSchema: opensteerNetworkSaveInputSchema,
    outputSchema: opensteerNetworkSaveOutputSchema,
    requiredCapabilities: ["inspect.network"],
  }),
  defineSemanticOperationSpec<OpensteerNetworkClearInput, OpensteerNetworkClearOutput>({
    name: "network.clear",
    description: "Clear saved network records globally or for a specific tag.",
    inputSchema: opensteerNetworkClearInputSchema,
    outputSchema: opensteerNetworkClearOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerInspectCookiesInput, readonly CookieRecord[]>({
    name: "inspect.cookies",
    description: "Read cookies from the current browser session.",
    inputSchema: opensteerInspectCookiesInputSchema,
    outputSchema: opensteerInspectCookiesOutputSchema,
    requiredCapabilities: ["inspect.cookies"],
  }),
  defineSemanticOperationSpec<OpensteerInspectStorageInput, StorageSnapshot>({
    name: "inspect.storage",
    description: "Read browser storage state from the current browser session.",
    inputSchema: opensteerInspectStorageInputSchema,
    outputSchema: storageSnapshotSchema,
    requiredCapabilities: ["inspect.localStorage"],
    resolveRequiredCapabilities: (input) => {
      const capabilities: OpensteerCapability[] = ["inspect.localStorage"];
      if (input.includeSessionStorage ?? false) {
        capabilities.push("inspect.sessionStorage");
      }
      if (input.includeIndexedDb ?? false) {
        capabilities.push("inspect.indexedDb");
      }
      return capabilities;
    },
  }),
  defineSemanticOperationSpec<OpensteerRawRequestInput, OpensteerRawRequestOutput>({
    name: "request.raw",
    description: "Execute a raw HTTP request through either the current browser session or a direct HTTP transport.",
    inputSchema: opensteerRawRequestInputSchema,
    outputSchema: opensteerRawRequestOutputSchema,
    requiredCapabilities: [],
    resolveRequiredCapabilities: (input) =>
      (input.transport ?? "session-http") === "direct-http" ? [] : ["transport.sessionHttp"],
  }),
  defineSemanticOperationSpec<OpensteerInferRequestPlanInput, OpensteerRequestPlanRecord>({
    name: "request-plan.infer",
    description: "Infer and persist a request plan from a selected network record.",
    inputSchema: opensteerInferRequestPlanInputSchema,
    outputSchema: opensteerRequestPlanRecordSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerWriteRequestPlanInput, OpensteerRequestPlanRecord>({
    name: "request-plan.write",
    description: "Validate and persist a reusable request plan in the local registry.",
    inputSchema: opensteerWriteRequestPlanInputSchema,
    outputSchema: opensteerRequestPlanRecordSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerGetRequestPlanInput, OpensteerRequestPlanRecord>({
    name: "request-plan.get",
    description: "Resolve a request plan by key and optional version.",
    inputSchema: opensteerGetRequestPlanInputSchema,
    outputSchema: opensteerRequestPlanRecordSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerListRequestPlansInput, OpensteerListRequestPlansOutput>({
    name: "request-plan.list",
    description: "List request plans from the local registry.",
    inputSchema: opensteerListRequestPlansInputSchema,
    outputSchema: opensteerListRequestPlansOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerWriteAuthRecipeInput, OpensteerAuthRecipeRecord>({
    name: "auth-recipe.write",
    description: "Validate and persist a reusable auth recovery recipe in the local registry.",
    inputSchema: opensteerWriteAuthRecipeInputSchema,
    outputSchema: opensteerAuthRecipeRecordSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerGetAuthRecipeInput, OpensteerAuthRecipeRecord>({
    name: "auth-recipe.get",
    description: "Resolve an auth recipe by key and optional version.",
    inputSchema: opensteerGetAuthRecipeInputSchema,
    outputSchema: opensteerAuthRecipeRecordSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerListAuthRecipesInput, OpensteerListAuthRecipesOutput>({
    name: "auth-recipe.list",
    description: "List auth recovery recipes from the local registry.",
    inputSchema: opensteerListAuthRecipesInputSchema,
    outputSchema: opensteerListAuthRecipesOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerRunAuthRecipeInput, OpensteerRunAuthRecipeOutput>({
    name: "auth-recipe.run",
    description: "Run a stored auth recovery recipe deterministically against the current runtime.",
    inputSchema: opensteerRunAuthRecipeInputSchema,
    outputSchema: opensteerRunAuthRecipeOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerRequestExecuteInput, OpensteerRequestExecuteOutput>({
    name: "request.execute",
    description: "Execute a request plan through its configured transport and deterministic auth recovery policy.",
    inputSchema: opensteerRequestExecuteInputSchema,
    outputSchema: opensteerRequestExecuteOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerComputerExecuteInput, OpensteerComputerExecuteOutput>({
    name: "computer.execute",
    description:
      "Execute a computer-use action in canonical computer-display-css coordinates and return the post-action screenshot in that same model-visible space.",
    inputSchema: opensteerComputerExecuteInputSchema,
    outputSchema: opensteerComputerExecuteOutputSchema,
    requiredCapabilities: ["artifacts.screenshot", "inspect.viewportMetrics"],
    resolveRequiredCapabilities: (input) => {
      const base: OpensteerCapability[] = ["artifacts.screenshot", "inspect.viewportMetrics"];
      switch (input.action.type) {
        case "click":
          if ((input.action.modifiers?.length ?? 0) > 0) {
            base.unshift("input.keyboard");
          }
          base.unshift("input.pointer");
          break;
        case "move":
        case "scroll":
        case "drag":
          base.unshift("input.pointer");
          break;
        case "type":
        case "key":
          base.unshift("input.keyboard");
          break;
        case "screenshot":
        case "wait":
          break;
      }
      return base;
    },
  }),
  defineSemanticOperationSpec<OpensteerSessionCloseInput, OpensteerSessionCloseOutput>({
    name: "session.close",
    description: "Close the current Opensteer session and release browser resources.",
    inputSchema: opensteerSessionCloseInputSchema,
    outputSchema: opensteerSessionCloseOutputSchema,
    requiredCapabilities: ["sessions.manage"],
  }),
] as const satisfies readonly OpensteerSemanticOperationSpec[];

export const opensteerSemanticOperationSpecificationMap = Object.fromEntries(
  opensteerSemanticOperationSpecifications.map((spec) => [spec.name, spec]),
) as Record<OpensteerSemanticOperationName, OpensteerSemanticOperationSpec>;

const semanticRestBasePath = `${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic`;

export const opensteerSemanticRestEndpoints: readonly OpensteerSemanticRestEndpointDescriptor[] =
  opensteerSemanticOperationSpecifications.map((spec) => ({
    name: spec.name,
    method: "POST",
    path: `${semanticRestBasePath}/operations/${spec.name.replaceAll(".", "/")}`,
    description: spec.description,
    requestSchema: requestEnvelopeSchema(spec.inputSchema, spec.name),
    responseSchema: responseEnvelopeSchema(spec.outputSchema, spec.name),
  }));
