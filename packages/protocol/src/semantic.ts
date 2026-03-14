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
import type { OpensteerCapability } from "./capabilities.js";
import { documentEpochSchema, documentRefSchema, frameRefSchema, nodeRefSchema, pageRefSchema, sessionRefSchema } from "./identity.js";
import type { DocumentEpoch, DocumentRef, FrameRef, NodeRef, PageRef, SessionRef } from "./identity.js";
import { pointSchema } from "./geometry.js";
import { requestEnvelopeSchema, responseEnvelopeSchema } from "./envelopes.js";
import { OPENSTEER_PROTOCOL_REST_BASE_PATH } from "./version.js";

export type OpensteerSnapshotMode = "action" | "extraction";

export interface OpensteerBrowserLaunchOptions {
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly channel?: string;
  readonly args?: readonly string[];
  readonly chromiumSandbox?: boolean;
  readonly devtools?: boolean;
  readonly downloadsPath?: string;
  readonly slowMo?: number;
  readonly timeoutMs?: number;
}

export interface OpensteerBrowserContextOptions {
  readonly ignoreHTTPSErrors?: boolean;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly userAgent?: string;
  readonly viewport?:
    | {
        readonly width: number;
        readonly height: number;
      }
    | null;
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

export interface OpensteerDomClickInput {
  readonly target: OpensteerTargetInput;
  readonly persistAsDescription?: string;
}

export interface OpensteerDomHoverInput {
  readonly target: OpensteerTargetInput;
  readonly persistAsDescription?: string;
}

export interface OpensteerDomInputInput {
  readonly target: OpensteerTargetInput;
  readonly text: string;
  readonly pressEnter?: boolean;
  readonly persistAsDescription?: string;
}

export interface OpensteerDomScrollInput {
  readonly target: OpensteerTargetInput;
  readonly direction: "up" | "down" | "left" | "right";
  readonly amount: number;
  readonly persistAsDescription?: string;
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

export const opensteerSemanticOperationNames = [
  "session.open",
  "page.goto",
  "page.snapshot",
  "dom.click",
  "dom.hover",
  "dom.input",
  "dom.scroll",
  "dom.extract",
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

const opensteerBrowserLaunchOptionsSchema: JsonSchema = objectSchema(
  {
    headless: { type: "boolean" },
    executablePath: stringSchema(),
    channel: stringSchema(),
    args: arraySchema(stringSchema()),
    chromiumSandbox: { type: "boolean" },
    devtools: { type: "boolean" },
    downloadsPath: stringSchema(),
    slowMo: integerSchema({ minimum: 0 }),
    timeoutMs: integerSchema({ minimum: 0 }),
  },
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

const opensteerDomClickInputSchema: JsonSchema = objectSchema(
  {
    target: opensteerTargetInputSchema,
    persistAsDescription: stringSchema(),
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

export function resolveSemanticRequiredCapabilities<TInput>(
  spec: Pick<
    OpensteerSemanticOperationSpec<TInput, unknown>,
    "requiredCapabilities" | "resolveRequiredCapabilities"
  >,
  input: TInput,
): readonly OpensteerCapability[] {
  return spec.resolveRequiredCapabilities?.(input) ?? spec.requiredCapabilities;
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
    description: "Resolve a DOM target and dispatch directional scrolling through Opensteer semantics.",
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
