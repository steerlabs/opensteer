import type { JsonSchema } from "./json.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  objectSchema,
  oneOfSchema,
  recordSchema,
  stringSchema,
} from "./json.js";

export interface OpensteerScriptBeautifyInput {
  readonly artifactId?: string;
  readonly content?: string;
  readonly persist?: boolean;
}

export interface OpensteerScriptBeautifyOutput {
  readonly content: string;
  readonly artifactId?: string;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export interface OpensteerScriptDeobfuscateInput {
  readonly artifactId?: string;
  readonly content?: string;
  readonly persist?: boolean;
}

export interface OpensteerScriptDeobfuscateOutput {
  readonly content: string;
  readonly artifactId?: string;
  readonly transforms: readonly string[];
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export type SandboxFidelity = "minimal" | "standard" | "full";
export type SandboxAjaxMode = "passthrough" | "capture" | "mock";

export interface SandboxAjaxRoute {
  readonly urlPattern: string;
  readonly mode: SandboxAjaxMode;
  readonly mockResponse?: {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  };
}

export interface OpensteerScriptSandboxInput {
  readonly artifactId?: string;
  readonly content?: string;
  readonly fidelity?: SandboxFidelity;
  readonly ajaxRoutes?: readonly SandboxAjaxRoute[];
  readonly cookies?: Readonly<Record<string, string>>;
  readonly globals?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly clockMode?: "real" | "manual";
}

export interface SandboxCapturedAjaxCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timestamp: number;
}

export interface OpensteerScriptSandboxOutput {
  readonly result?: unknown;
  readonly capturedAjax: readonly SandboxCapturedAjaxCall[];
  readonly errors: readonly string[];
  readonly durationMs: number;
}

const scriptTransformInputSchema = objectSchema(
  {
    artifactId: stringSchema({ minLength: 1 }),
    content: stringSchema(),
    persist: { type: "boolean" },
  },
  {
    title: "OpensteerScriptTransformInput",
  },
);

const scriptTransformOutputSchema = objectSchema(
  {
    content: stringSchema(),
    artifactId: stringSchema({ minLength: 1 }),
    bytesBefore: integerSchema({ minimum: 0 }),
    bytesAfter: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerScriptTransformOutput",
    required: ["content", "bytesBefore", "bytesAfter"],
  },
);

export const opensteerScriptBeautifyInputSchema: JsonSchema = scriptTransformInputSchema;

export const opensteerScriptBeautifyOutputSchema: JsonSchema = scriptTransformOutputSchema;

export const opensteerScriptDeobfuscateInputSchema: JsonSchema = scriptTransformInputSchema;

export const opensteerScriptDeobfuscateOutputSchema: JsonSchema = objectSchema(
  {
    content: stringSchema(),
    artifactId: stringSchema({ minLength: 1 }),
    transforms: arraySchema(stringSchema({ minLength: 1 }), {
      uniqueItems: true,
    }),
    bytesBefore: integerSchema({ minimum: 0 }),
    bytesAfter: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerScriptDeobfuscateOutput",
    required: ["content", "transforms", "bytesBefore", "bytesAfter"],
  },
);

export const sandboxFidelitySchema: JsonSchema = enumSchema(["minimal", "standard", "full"] as const, {
  title: "SandboxFidelity",
});

export const sandboxAjaxModeSchema: JsonSchema = enumSchema(
  ["passthrough", "capture", "mock"] as const,
  {
    title: "SandboxAjaxMode",
  },
);

export const sandboxAjaxRouteSchema: JsonSchema = objectSchema(
  {
    urlPattern: stringSchema({ minLength: 1 }),
    mode: sandboxAjaxModeSchema,
    mockResponse: objectSchema(
      {
        status: integerSchema({ minimum: 100, maximum: 599 }),
        headers: recordSchema(stringSchema(), {
          title: "SandboxAjaxMockHeaders",
        }),
        body: stringSchema(),
      },
      {
        title: "SandboxAjaxMockResponse",
        required: ["status"],
      },
    ),
  },
  {
    title: "SandboxAjaxRoute",
    required: ["urlPattern", "mode"],
  },
);

export const opensteerScriptSandboxInputSchema: JsonSchema = objectSchema(
  {
    artifactId: stringSchema({ minLength: 1 }),
    content: stringSchema(),
    fidelity: sandboxFidelitySchema,
    ajaxRoutes: arraySchema(sandboxAjaxRouteSchema),
    cookies: recordSchema(stringSchema(), {
      title: "SandboxCookies",
    }),
    globals: objectSchema(
      {},
      {
        title: "SandboxGlobals",
        additionalProperties: true,
      },
    ),
    timeoutMs: integerSchema({ minimum: 1 }),
    clockMode: enumSchema(["real", "manual"] as const),
  },
  {
    title: "OpensteerScriptSandboxInput",
  },
);

export const sandboxCapturedAjaxCallSchema: JsonSchema = objectSchema(
  {
    method: stringSchema({ minLength: 1 }),
    url: stringSchema({ minLength: 1 }),
    headers: recordSchema(stringSchema(), {
      title: "SandboxCapturedAjaxHeaders",
    }),
    body: stringSchema(),
    timestamp: integerSchema({ minimum: 0 }),
  },
  {
    title: "SandboxCapturedAjaxCall",
    required: ["method", "url", "headers", "timestamp"],
  },
);

export const opensteerScriptSandboxOutputSchema: JsonSchema = objectSchema(
  {
    result: oneOfSchema(
      [
        objectSchema({}, { additionalProperties: true }),
        arraySchema({}),
        stringSchema(),
        { type: "number" },
        enumSchema([true, false, null] as const),
      ],
      {
        title: "SandboxResult",
      },
    ),
    capturedAjax: arraySchema(sandboxCapturedAjaxCallSchema),
    errors: arraySchema(stringSchema({ minLength: 1 })),
    durationMs: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerScriptSandboxOutput",
    required: ["capturedAjax", "errors", "durationMs"],
  },
);
