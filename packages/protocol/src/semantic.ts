import type { JsonSchema, JsonValue } from "./json.js";
import {
  arraySchema,
  defineSchema,
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
import { pageInfoSchema } from "./metadata.js";
import { opensteerEventSchema, type OpensteerEvent } from "./events.js";
import { requestEnvelopeSchema, responseEnvelopeSchema } from "./envelopes.js";
import {
  hitTestResultSchema,
  screenshotArtifactSchema,
  type HitTestResult,
  type ScreenshotArtifact,
  type ScreenshotFormat,
} from "./snapshots.js";
import type {
  OpensteerArtifactReadInput,
  OpensteerArtifactReadOutput,
  ScriptSourceArtifactData,
} from "./artifacts.js";
import {
  opensteerArtifactReadInputSchema,
  opensteerArtifactReadOutputSchema,
} from "./artifacts.js";
import {
  opensteerCookieQueryInputSchema,
  opensteerCookieQueryOutputSchema,
  opensteerNetworkDetailOutputSchema,
  opensteerNetworkQueryInputSchema,
  opensteerNetworkQueryOutputSchema,
  opensteerNetworkReplayInputSchema,
  opensteerNetworkReplayOutputSchema,
  opensteerSessionFetchInputSchema,
  opensteerSessionFetchOutputSchema,
  opensteerStateQueryInputSchema,
  opensteerStateQueryOutputSchema,
  opensteerStorageQueryInputSchema,
  opensteerStorageQueryOutputSchema,
  type OpensteerCookieQueryInput,
  type OpensteerCookieQueryOutput,
  type OpensteerNetworkDetailOutput,
  type OpensteerNetworkQueryInput,
  type OpensteerNetworkQueryOutput,
  type OpensteerNetworkReplayInput,
  type OpensteerNetworkReplayOutput,
  type OpensteerSessionFetchInput,
  type OpensteerSessionFetchOutput,
  type OpensteerStateQueryInput,
  type OpensteerStateQueryOutput,
  type OpensteerStorageQueryInput,
  type OpensteerStorageQueryOutput,
} from "./requests.js";
import {
  opensteerScriptBeautifyInputSchema,
  opensteerScriptBeautifyOutputSchema,
  opensteerScriptDeobfuscateInputSchema,
  opensteerScriptDeobfuscateOutputSchema,
  opensteerScriptSandboxInputSchema,
  opensteerScriptSandboxOutputSchema,
  type OpensteerScriptBeautifyInput,
  type OpensteerScriptBeautifyOutput,
  type OpensteerScriptDeobfuscateInput,
  type OpensteerScriptDeobfuscateOutput,
  type OpensteerScriptSandboxInput,
  type OpensteerScriptSandboxOutput,
} from "./scripts.js";
import {
  opensteerCaptchaSolveInputSchema,
  opensteerCaptchaSolveOutputSchema,
  type OpensteerCaptchaSolveInput,
  type OpensteerCaptchaSolveOutput,
} from "./captcha.js";
import {
  opensteerInteractionCaptureInputSchema,
  opensteerInteractionCaptureOutputSchema,
  opensteerInteractionDiffInputSchema,
  opensteerInteractionDiffOutputSchema,
  opensteerInteractionGetInputSchema,
  opensteerInteractionGetOutputSchema,
  opensteerInteractionReplayInputSchema,
  opensteerInteractionReplayOutputSchema,
  type OpensteerInteractionCaptureInput,
  type OpensteerInteractionCaptureOutput,
  type OpensteerInteractionDiffInput,
  type OpensteerInteractionDiffOutput,
  type OpensteerInteractionGetInput,
  type OpensteerInteractionGetOutput,
  type OpensteerInteractionReplayInput,
  type OpensteerInteractionReplayOutput,
} from "./interaction.js";
import { validateJsonSchema } from "./validation.js";
import { OPENSTEER_PROTOCOL_REST_BASE_PATH } from "./version.js";

export type OpensteerSnapshotMode = "action" | "extraction";

export interface OpensteerBrowserLaunchOptions {
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface OpensteerAttachBrowserOptions {
  readonly mode: "attach";
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly freshTab?: boolean;
}

export type OpensteerBrowserMode = "temporary" | "persistent";

export type OpensteerBrowserOptions = OpensteerBrowserMode | OpensteerAttachBrowserOptions;

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
  readonly stealthProfile?: OpensteerStealthProfileInput;
}

export interface OpensteerStealthProfileInput {
  readonly id?: string;
  readonly platform?: "macos" | "windows" | "linux";
  readonly browserBrand?: "chrome" | "edge";
  readonly browserVersion?: string;
  readonly userAgent?: string;
  readonly viewport?: {
    readonly width: number;
    readonly height: number;
  };
  readonly screenResolution?: {
    readonly width: number;
    readonly height: number;
  };
  readonly devicePixelRatio?: number;
  readonly maxTouchPoints?: number;
  readonly webglVendor?: string;
  readonly webglRenderer?: string;
  readonly fonts?: readonly string[];
  readonly canvasNoiseSeed?: number;
  readonly audioNoiseSeed?: number;
  readonly locale?: string;
  readonly timezoneId?: string;
}

export interface OpensteerTargetByElement {
  readonly kind: "element";
  readonly element: number;
}

export interface OpensteerTargetByPersist {
  readonly kind: "persist";
  readonly persist: string;
}

export interface OpensteerTargetBySelector {
  readonly kind: "selector";
  readonly selector: string;
}

export type OpensteerTargetInput =
  | OpensteerTargetByElement
  | OpensteerTargetByPersist
  | OpensteerTargetBySelector;

export interface OpensteerResolvedTarget {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly nodeRef: NodeRef;
  readonly tagName: string;
  readonly pathHint: string;
  readonly persist?: string;
  readonly selectorUsed?: string;
}

export interface OpensteerActionResult {
  readonly target: OpensteerResolvedTarget;
  readonly point?: {
    readonly x: number;
    readonly y: number;
  };
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

export interface OpensteerOpenInput {
  readonly url?: string;
  readonly workspace?: string;
  readonly browser?: OpensteerBrowserOptions;
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
}

export interface OpensteerOpenOutput extends OpensteerSessionState {}

export interface OpensteerPageListInput {}

export interface OpensteerPageListOutput {
  readonly activePageRef?: PageRef;
  readonly pages: readonly import("./metadata.js").PageInfo[];
}

export interface OpensteerPageNewInput {
  readonly url?: string;
  readonly openerPageRef?: PageRef;
}

export interface OpensteerPageNewOutput extends OpensteerSessionState {}

export interface OpensteerPageActivateInput {
  readonly pageRef: PageRef;
}

export interface OpensteerPageActivateOutput extends OpensteerSessionState {}

export interface OpensteerPageCloseInput {
  readonly pageRef?: PageRef;
}

export interface OpensteerPageCloseOutput {
  readonly closedPageRef: PageRef;
  readonly activePageRef?: PageRef;
  readonly pages: readonly import("./metadata.js").PageInfo[];
}

export interface OpensteerPageGotoInput {
  readonly url: string;
  readonly captureNetwork?: string;
}

export interface OpensteerPageGotoOutput extends OpensteerSessionState {}

export interface OpensteerPageEvaluateInput {
  readonly script: string;
  readonly args?: readonly JsonValue[];
  readonly pageRef?: PageRef;
}

export interface OpensteerPageEvaluateOutput {
  readonly pageRef: PageRef;
  readonly value: JsonValue;
}

export interface OpensteerAddInitScriptInput {
  readonly script: string;
  readonly args?: readonly JsonValue[];
  readonly pageRef?: PageRef;
}

export interface OpensteerAddInitScriptOutput {
  readonly registrationId: string;
  readonly sessionRef: SessionRef;
  readonly pageRef?: PageRef;
}

export interface OpensteerCaptureScriptsInput {
  readonly pageRef?: PageRef;
  readonly includeInline?: boolean;
  readonly includeExternal?: boolean;
  readonly includeDynamic?: boolean;
  readonly includeWorkers?: boolean;
  readonly urlFilter?: string;
  readonly persist?: boolean;
}

export interface OpensteerCapturedScript extends ScriptSourceArtifactData {
  readonly artifactId?: string;
}

export interface OpensteerCaptureScriptsOutput {
  readonly pageRef: PageRef;
  readonly scripts: readonly OpensteerCapturedScript[];
}

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
  readonly button?: OpensteerComputerMouseButton;
  readonly clickCount?: number;
  readonly modifiers?: readonly OpensteerComputerKeyModifier[];
  readonly persist?: string;
  readonly captureNetwork?: string;
}

export interface OpensteerDomHoverInput {
  readonly target: OpensteerTargetInput;
  readonly persist?: string;
  readonly captureNetwork?: string;
}

export interface OpensteerDomInputInput {
  readonly target: OpensteerTargetInput;
  readonly text: string;
  readonly pressEnter?: boolean;
  readonly persist?: string;
  readonly captureNetwork?: string;
}

export interface OpensteerDomScrollInput {
  readonly target: OpensteerTargetInput;
  readonly direction: "up" | "down" | "left" | "right";
  readonly amount: number;
  readonly persist?: string;
  readonly captureNetwork?: string;
}

export interface OpensteerDomExtractInput {
  readonly persist?: string;
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
  readonly captureNetwork?: string;
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
  "page.list",
  "page.new",
  "page.activate",
  "page.close",
  "page.goto",
  "page.evaluate",
  "page.add-init-script",
  "page.snapshot",
  "dom.click",
  "dom.hover",
  "dom.input",
  "dom.scroll",
  "dom.extract",
  "network.query",
  "network.detail",
  "network.replay",
  "interaction.capture",
  "interaction.get",
  "interaction.diff",
  "interaction.replay",
  "artifact.read",
  "session.cookies",
  "session.storage",
  "session.state",
  "session.fetch",
  "scripts.capture",
  "scripts.beautify",
  "scripts.deobfuscate",
  "scripts.sandbox",
  "captcha.solve",
  "computer.execute",
  "session.close",
] as const;

export type OpensteerSemanticOperationName = (typeof opensteerSemanticOperationNames)[number];

export const opensteerExposedSemanticOperationNames = [
  "session.open",
  "page.list",
  "page.new",
  "page.activate",
  "page.close",
  "page.goto",
  "page.evaluate",
  "page.add-init-script",
  "page.snapshot",
  "dom.click",
  "dom.hover",
  "dom.input",
  "dom.scroll",
  "dom.extract",
  "network.query",
  "network.detail",
  "network.replay",
  "interaction.capture",
  "interaction.get",
  "interaction.diff",
  "interaction.replay",
  "artifact.read",
  "session.cookies",
  "session.storage",
  "session.state",
  "session.fetch",
  "scripts.capture",
  "scripts.beautify",
  "scripts.deobfuscate",
  "scripts.sandbox",
  "captcha.solve",
  "computer.execute",
  "session.close",
] as const satisfies readonly OpensteerSemanticOperationName[];

export interface OpensteerSemanticOperationSpec<TInput = unknown, TOutput = unknown> {
  readonly name: OpensteerSemanticOperationName;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema & { readonly __output?: TOutput };
  readonly requiredCapabilities: readonly OpensteerCapability[];
  readonly packageRunnable?: boolean;
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

const opensteerPackageRunnableSemanticOperationNames = new Set<OpensteerSemanticOperationName>([
  "page.list",
  "page.new",
  "page.activate",
  "page.close",
  "page.goto",
  "page.evaluate",
  "page.add-init-script",
  "page.snapshot",
  "dom.click",
  "dom.hover",
  "dom.input",
  "dom.scroll",
  "dom.extract",
  "network.query",
  "network.detail",
  "network.replay",
  "interaction.capture",
  "interaction.get",
  "interaction.diff",
  "interaction.replay",
  "artifact.read",
  "session.cookies",
  "session.storage",
  "session.state",
  "session.fetch",
  "scripts.capture",
  "scripts.beautify",
  "scripts.deobfuscate",
  "scripts.sandbox",
  "captcha.solve",
  "computer.execute",
]);

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

const opensteerBrowserLaunchOptionsSchema: JsonSchema = objectSchema(
  {
    headless: { type: "boolean" },
    executablePath: stringSchema(),
    args: arraySchema(stringSchema()),
    timeoutMs: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerBrowserLaunchOptions",
  },
);

const attachBrowserOptionsSchema: JsonSchema = objectSchema(
  {
    mode: enumSchema(["attach"] as const),
    endpoint: stringSchema(),
    headers: recordSchema(stringSchema(), {
      title: "OpensteerAttachBrowserHeaders",
    }),
    freshTab: { type: "boolean" },
  },
  {
    title: "OpensteerAttachBrowserOptions",
    required: ["mode"],
  },
);

const opensteerBrowserOptionsSchema: JsonSchema = oneOfSchema(
  [enumSchema(["temporary", "persistent"] as const), attachBrowserOptionsSchema],
  {
    title: "OpensteerBrowserOptions",
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
    stealthProfile: objectSchema(
      {
        id: stringSchema(),
        platform: enumSchema(["macos", "windows", "linux"] as const),
        browserBrand: enumSchema(["chrome", "edge"] as const),
        browserVersion: stringSchema(),
        userAgent: stringSchema(),
        viewport: viewportSchema,
        screenResolution: viewportSchema,
        devicePixelRatio: { type: "number", minimum: 0.5 },
        maxTouchPoints: integerSchema({ minimum: 0 }),
        webglVendor: stringSchema(),
        webglRenderer: stringSchema(),
        fonts: arraySchema(stringSchema()),
        canvasNoiseSeed: integerSchema({ minimum: 0 }),
        audioNoiseSeed: integerSchema({ minimum: 0 }),
        locale: stringSchema(),
        timezoneId: stringSchema(),
      },
      {
        title: "OpensteerStealthProfileInput",
      },
    ),
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

const targetByPersistSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["persist"] as const),
    persist: stringSchema(),
  },
  {
    title: "OpensteerTargetByPersist",
    required: ["kind", "persist"],
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
  [targetByElementSchema, targetByPersistSchema, targetBySelectorSchema],
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
    persist: stringSchema(),
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

const opensteerOpenInputSchema: JsonSchema = objectSchema(
  {
    url: stringSchema(),
    workspace: stringSchema(),
    browser: opensteerBrowserOptionsSchema,
    launch: opensteerBrowserLaunchOptionsSchema,
    context: opensteerBrowserContextOptionsSchema,
  },
  {
    title: "OpensteerOpenInput",
  },
);

const opensteerPageListInputSchema: JsonSchema = objectSchema(
  {},
  {
    title: "OpensteerPageListInput",
  },
);

const opensteerPageListOutputSchema: JsonSchema = objectSchema(
  {
    activePageRef: pageRefSchema,
    pages: arraySchema(pageInfoSchema),
  },
  {
    title: "OpensteerPageListOutput",
    required: ["pages"],
  },
);

const opensteerPageNewInputSchema: JsonSchema = objectSchema(
  {
    url: stringSchema(),
    openerPageRef: pageRefSchema,
  },
  {
    title: "OpensteerPageNewInput",
  },
);

const opensteerPageActivateInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
  },
  {
    title: "OpensteerPageActivateInput",
    required: ["pageRef"],
  },
);

const opensteerPageCloseInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
  },
  {
    title: "OpensteerPageCloseInput",
  },
);

const opensteerPageCloseOutputSchema: JsonSchema = objectSchema(
  {
    closedPageRef: pageRefSchema,
    activePageRef: pageRefSchema,
    pages: arraySchema(pageInfoSchema),
  },
  {
    title: "OpensteerPageCloseOutput",
    required: ["closedPageRef", "pages"],
  },
);

const opensteerPageGotoInputSchema: JsonSchema = objectSchema(
  {
    url: stringSchema(),
    captureNetwork: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerPageGotoInput",
    required: ["url"],
  },
);

const opensteerPageEvaluateInputSchema: JsonSchema = objectSchema(
  {
    script: stringSchema({ minLength: 1 }),
    args: arraySchema(
      defineSchema({
        title: "JsonValue",
      }),
    ),
    pageRef: pageRefSchema,
  },
  {
    title: "OpensteerPageEvaluateInput",
    required: ["script"],
  },
);

const opensteerPageEvaluateOutputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    value: oneOfSchema(
      [
        defineSchema({
          title: "JsonValue",
        }),
        arraySchema({}),
        stringSchema(),
        numberSchema(),
        enumSchema([true, false, null] as const),
      ],
      {
        title: "OpensteerPageEvaluateValue",
      },
    ),
  },
  {
    title: "OpensteerPageEvaluateOutput",
    required: ["pageRef", "value"],
  },
);

const opensteerAddInitScriptInputSchema: JsonSchema = objectSchema(
  {
    script: stringSchema({ minLength: 1 }),
    args: arraySchema(defineSchema({ title: "OpensteerInitScriptArg" })),
    pageRef: pageRefSchema,
  },
  {
    title: "OpensteerAddInitScriptInput",
    required: ["script"],
  },
);

const opensteerAddInitScriptOutputSchema: JsonSchema = objectSchema(
  {
    registrationId: stringSchema({ minLength: 1 }),
    sessionRef: sessionRefSchema,
    pageRef: pageRefSchema,
  },
  {
    title: "OpensteerAddInitScriptOutput",
    required: ["registrationId", "sessionRef"],
  },
);

const opensteerCapturedScriptSchema: JsonSchema = objectSchema(
  {
    source: enumSchema(["inline", "external", "dynamic", "worker"] as const),
    url: stringSchema({ minLength: 1 }),
    type: stringSchema({ minLength: 1 }),
    hash: stringSchema({ minLength: 1 }),
    loadOrder: integerSchema({ minimum: 0 }),
    content: stringSchema(),
    artifactId: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerCapturedScript",
    required: ["source", "hash", "loadOrder", "content"],
  },
);

const opensteerCaptureScriptsInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    includeInline: { type: "boolean" },
    includeExternal: { type: "boolean" },
    includeDynamic: { type: "boolean" },
    includeWorkers: { type: "boolean" },
    urlFilter: stringSchema({ minLength: 1 }),
    persist: { type: "boolean" },
  },
  {
    title: "OpensteerCaptureScriptsInput",
  },
);

const opensteerCaptureScriptsOutputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    scripts: arraySchema(opensteerCapturedScriptSchema),
  },
  {
    title: "OpensteerCaptureScriptsOutput",
    required: ["pageRef", "scripts"],
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

const opensteerNetworkDetailInputSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerNetworkDetailInput",
    required: ["recordId"],
  },
);

const opensteerComputerMouseButtonSchema: JsonSchema = enumSchema(["left", "middle", "right"] as const, {
  title: "OpensteerComputerMouseButton",
});

const opensteerComputerKeyModifierSchema: JsonSchema = enumSchema(
  ["Shift", "Control", "Alt", "Meta"] as const,
  {
    title: "OpensteerComputerKeyModifier",
  },
);

const opensteerDomClickInputSchema: JsonSchema = objectSchema(
  {
    target: opensteerTargetInputSchema,
    button: opensteerComputerMouseButtonSchema,
    clickCount: integerSchema({ minimum: 1 }),
    modifiers: arraySchema(opensteerComputerKeyModifierSchema, {
      uniqueItems: true,
    }),
    persist: stringSchema(),
    captureNetwork: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerDomClickInput",
    required: ["target"],
  },
);

const opensteerDomHoverInputSchema = objectSchema(
  {
    target: opensteerTargetInputSchema,
    persist: stringSchema(),
    captureNetwork: stringSchema({ minLength: 1 }),
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
    persist: stringSchema(),
    captureNetwork: stringSchema({ minLength: 1 }),
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
    persist: stringSchema(),
    captureNetwork: stringSchema({ minLength: 1 }),
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

const opensteerDomExtractInputSchema: JsonSchema = defineSchema({
  ...objectSchema(
    {
      persist: stringSchema(),
      schema: opensteerExtractSchemaSchema,
    },
    {
      title: "OpensteerDomExtractInput",
    },
  ),
  anyOf: [
    defineSchema({ required: ["persist"] }),
    defineSchema({ required: ["schema"] }),
  ],
});

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
    captureNetwork: stringSchema({ minLength: 1 }),
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

const opensteerSemanticOperationSpecificationsBase = [
  defineSemanticOperationSpec<OpensteerOpenInput, OpensteerOpenOutput>({
    name: "session.open",
    description: "Open or resume the current Opensteer session and primary page.",
    inputSchema: opensteerOpenInputSchema,
    outputSchema: opensteerSessionStateSchema,
    requiredCapabilities: ["sessions.manage", "pages.manage"],
    resolveRequiredCapabilities: (input) =>
      input.url === undefined
        ? ["sessions.manage", "pages.manage"]
        : ["sessions.manage", "pages.manage", "pages.navigate"],
  }),
  defineSemanticOperationSpec<OpensteerPageListInput, OpensteerPageListOutput>({
    name: "page.list",
    description: "List top-level pages for the current Opensteer session.",
    inputSchema: opensteerPageListInputSchema,
    outputSchema: opensteerPageListOutputSchema,
    requiredCapabilities: ["inspect.pages"],
  }),
  defineSemanticOperationSpec<OpensteerPageNewInput, OpensteerPageNewOutput>({
    name: "page.new",
    description: "Create and optionally navigate a new top-level page in the current session.",
    inputSchema: opensteerPageNewInputSchema,
    outputSchema: opensteerSessionStateSchema,
    requiredCapabilities: ["pages.manage"],
    resolveRequiredCapabilities: (input) =>
      input.url === undefined ? ["pages.manage"] : ["pages.manage", "pages.navigate"],
  }),
  defineSemanticOperationSpec<OpensteerPageActivateInput, OpensteerPageActivateOutput>({
    name: "page.activate",
    description: "Activate an existing top-level page in the current session.",
    inputSchema: opensteerPageActivateInputSchema,
    outputSchema: opensteerSessionStateSchema,
    requiredCapabilities: ["pages.manage", "inspect.pages"],
  }),
  defineSemanticOperationSpec<OpensteerPageCloseInput, OpensteerPageCloseOutput>({
    name: "page.close",
    description: "Close a top-level page in the current session.",
    inputSchema: opensteerPageCloseInputSchema,
    outputSchema: opensteerPageCloseOutputSchema,
    requiredCapabilities: ["pages.manage", "inspect.pages"],
  }),
  defineSemanticOperationSpec<OpensteerPageGotoInput, OpensteerPageGotoOutput>({
    name: "page.goto",
    description: "Navigate the current Opensteer page to a new URL.",
    inputSchema: opensteerPageGotoInputSchema,
    outputSchema: opensteerSessionStateSchema,
    requiredCapabilities: ["pages.navigate"],
  }),
  defineSemanticOperationSpec<OpensteerPageEvaluateInput, OpensteerPageEvaluateOutput>({
    name: "page.evaluate",
    description: "Execute JavaScript in the live page context and return a structured result.",
    inputSchema: opensteerPageEvaluateInputSchema,
    outputSchema: opensteerPageEvaluateOutputSchema,
    requiredCapabilities: ["pages.manage"],
  }),
  defineSemanticOperationSpec<OpensteerAddInitScriptInput, OpensteerAddInitScriptOutput>({
    name: "page.add-init-script",
    description: "Register a script that runs before page scripts in the current browser session.",
    inputSchema: opensteerAddInitScriptInputSchema,
    outputSchema: opensteerAddInitScriptOutputSchema,
    requiredCapabilities: ["instrumentation.initScripts"],
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
    description:
      "Run structured DOM extraction and optionally persist the extraction descriptor for replay.",
    inputSchema: opensteerDomExtractInputSchema,
    outputSchema: opensteerDomExtractOutputSchema,
    requiredCapabilities: ["inspect.domSnapshot", "inspect.text", "inspect.attributes"],
  }),
  defineSemanticOperationSpec<OpensteerNetworkQueryInput, OpensteerNetworkQueryOutput>({
    name: "network.query",
    description:
      "Query captured network traffic with chronological summaries optimized for agent inspection.",
    inputSchema: opensteerNetworkQueryInputSchema,
    outputSchema: opensteerNetworkQueryOutputSchema,
    requiredCapabilities: ["inspect.network"],
  }),
  defineSemanticOperationSpec<
    {
      readonly recordId: string;
    },
    OpensteerNetworkDetailOutput
  >({
    name: "network.detail",
    description:
      "Inspect one captured network record with parsed headers, cookies, redirects, and truncated bodies.",
    inputSchema: opensteerNetworkDetailInputSchema,
    outputSchema: opensteerNetworkDetailOutputSchema,
    requiredCapabilities: ["inspect.network", "inspect.networkBodies"],
  }),
  defineSemanticOperationSpec<OpensteerNetworkReplayInput, OpensteerNetworkReplayOutput>({
    name: "network.replay",
    description:
      "Replay a captured request through the transport ladder and report the transport that worked.",
    inputSchema: opensteerNetworkReplayInputSchema,
    outputSchema: opensteerNetworkReplayOutputSchema,
    requiredCapabilities: ["inspect.network", "inspect.cookies", "pages.manage"],
  }),
  defineSemanticOperationSpec<OpensteerInteractionCaptureInput, OpensteerInteractionCaptureOutput>({
    name: "interaction.capture",
    description:
      "Capture a guarded interaction window, including event properties, state changes, and downstream network.",
    inputSchema: opensteerInteractionCaptureInputSchema,
    outputSchema: opensteerInteractionCaptureOutputSchema,
    requiredCapabilities: ["pages.manage", "inspect.cookies", "inspect.localStorage"],
  }),
  defineSemanticOperationSpec<OpensteerInteractionGetInput, OpensteerInteractionGetOutput>({
    name: "interaction.get",
    description:
      "Read a captured interaction trace by ID for package inspection, diffing, and replay editing.",
    inputSchema: opensteerInteractionGetInputSchema,
    outputSchema: opensteerInteractionGetOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerInteractionDiffInput, OpensteerInteractionDiffOutput>({
    name: "interaction.diff",
    description:
      "Compare two captured interaction traces by event sequence, event properties, state deltas, and downstream network.",
    inputSchema: opensteerInteractionDiffInputSchema,
    outputSchema: opensteerInteractionDiffOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerInteractionReplayInput, OpensteerInteractionReplayOutput>({
    name: "interaction.replay",
    description:
      "Replay a captured interaction trace against a live page and report how many events were reproduced.",
    inputSchema: opensteerInteractionReplayInputSchema,
    outputSchema: opensteerInteractionReplayOutputSchema,
    requiredCapabilities: ["pages.manage"],
  }),
  defineSemanticOperationSpec<OpensteerArtifactReadInput, OpensteerArtifactReadOutput>({
    name: "artifact.read",
    description:
      "Read a persisted artifact by ID so agents can inspect captured scripts, storage, cookies, or snapshots linked from reverse packages and reports.",
    inputSchema: opensteerArtifactReadInputSchema,
    outputSchema: opensteerArtifactReadOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerCaptureScriptsInput, OpensteerCaptureScriptsOutput>({
    name: "scripts.capture",
    description: "Capture inline and external script sources from the current page and run.",
    inputSchema: opensteerCaptureScriptsInputSchema,
    outputSchema: opensteerCaptureScriptsOutputSchema,
    requiredCapabilities: ["inspect.html", "inspect.network", "inspect.networkBodies"],
  }),
  defineSemanticOperationSpec<OpensteerScriptBeautifyInput, OpensteerScriptBeautifyOutput>({
    name: "scripts.beautify",
    description:
      "Beautify captured or inline JavaScript through Prettier and optionally persist the transformed artifact.",
    inputSchema: opensteerScriptBeautifyInputSchema,
    outputSchema: opensteerScriptBeautifyOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerScriptDeobfuscateInput, OpensteerScriptDeobfuscateOutput>({
    name: "scripts.deobfuscate",
    description:
      "Deobfuscate captured or inline JavaScript through webcrack and optionally persist the transformed artifact.",
    inputSchema: opensteerScriptDeobfuscateInputSchema,
    outputSchema: opensteerScriptDeobfuscateOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerScriptSandboxInput, OpensteerScriptSandboxOutput>({
    name: "scripts.sandbox",
    description:
      "Execute captured or inline JavaScript inside a controlled VM sandbox with browser-style shims and AJAX interception.",
    inputSchema: opensteerScriptSandboxInputSchema,
    outputSchema: opensteerScriptSandboxOutputSchema,
    requiredCapabilities: [],
  }),
  defineSemanticOperationSpec<OpensteerCaptchaSolveInput, OpensteerCaptchaSolveOutput>({
    name: "captcha.solve",
    description:
      "Detect, solve, and inject a supported CAPTCHA token into the current page through a pluggable solver provider.",
    inputSchema: opensteerCaptchaSolveInputSchema,
    outputSchema: opensteerCaptchaSolveOutputSchema,
    requiredCapabilities: ["pages.manage"],
  }),
  defineSemanticOperationSpec<OpensteerCookieQueryInput, OpensteerCookieQueryOutput>({
    name: "session.cookies",
    description: "Read browser cookies for the active page domain or an explicitly selected domain.",
    inputSchema: opensteerCookieQueryInputSchema,
    outputSchema: opensteerCookieQueryOutputSchema,
    requiredCapabilities: ["inspect.cookies"],
  }),
  defineSemanticOperationSpec<OpensteerStorageQueryInput, OpensteerStorageQueryOutput>({
    name: "session.storage",
    description:
      "Read localStorage and sessionStorage grouped by domain for the active browser session.",
    inputSchema: opensteerStorageQueryInputSchema,
    outputSchema: opensteerStorageQueryOutputSchema,
    requiredCapabilities: ["inspect.localStorage", "inspect.sessionStorage"],
  }),
  defineSemanticOperationSpec<OpensteerStateQueryInput, OpensteerStateQueryOutput>({
    name: "session.state",
    description:
      "Read browser cookies, storage, hidden fields, and selected page globals grouped by domain.",
    inputSchema: opensteerStateQueryInputSchema,
    outputSchema: opensteerStateQueryOutputSchema,
    requiredCapabilities: [
      "inspect.cookies",
      "inspect.localStorage",
      "inspect.sessionStorage",
      "pages.manage",
    ],
  }),
  defineSemanticOperationSpec<OpensteerSessionFetchInput, OpensteerSessionFetchOutput>({
    name: "session.fetch",
    description:
      "Execute a session-aware HTTP request with browser cookies and automatic transport selection.",
    inputSchema: opensteerSessionFetchInputSchema,
    outputSchema: opensteerSessionFetchOutputSchema,
    requiredCapabilities: [],
    resolveRequiredCapabilities: (input) => {
      switch (input.transport ?? "auto") {
        case "direct":
          return [];
        case "matched-tls":
          return ["inspect.cookies"];
        case "page":
          return ["pages.manage"];
        case "auto":
          return ["inspect.cookies", "pages.manage"];
      }
    },
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

const exposedSemanticOperationNameSet = new Set<OpensteerSemanticOperationName>(
  opensteerExposedSemanticOperationNames,
);

const opensteerSemanticOperationSpecificationsInternal =
  opensteerSemanticOperationSpecificationsBase.map((spec) => ({
    ...spec,
    packageRunnable: opensteerPackageRunnableSemanticOperationNames.has(spec.name),
  })) as readonly OpensteerSemanticOperationSpec[];

export const opensteerSemanticOperationSpecifications =
  opensteerSemanticOperationSpecificationsInternal.filter((spec) =>
    exposedSemanticOperationNameSet.has(spec.name),
  ) as readonly OpensteerSemanticOperationSpec[];

export const opensteerSemanticOperationSpecificationMap = Object.fromEntries(
  opensteerSemanticOperationSpecificationsInternal.map((spec) => [spec.name, spec]),
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
