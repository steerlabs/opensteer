import { OpensteerError } from "@opensteer/core";
import { z } from "zod";

/**
 * The few OpenCode v1 shapes this driver consumes, written out rather than
 * imported from `@opencode-ai/sdk`: the SDK ships one generated union per API
 * surface and the driver reads a dozen fields of it, so a hand-written schema
 * is both smaller and the place a wire change is caught. Every object is loose,
 * because a provider adding a field is not this driver's failure.
 *
 * All of it was read off the running 1.18.31 server — its own OpenAPI document
 * at `GET /doc` plus live traffic — not from documentation.
 */

export function opencodeProtocolError(
  message: string,
  options: { readonly cause?: unknown; readonly details?: Readonly<Record<string, unknown>> } = {},
): OpensteerError {
  return new OpensteerError({
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    code: "harness_error",
    ...(options.details === undefined ? {} : { details: options.details }),
    message,
  });
}

export function parseOpencode<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw opencodeProtocolError(`OpenCode ${label} did not match the expected shape`, {
      details: { issues: parsed.error.issues.slice(0, 8) },
    });
  }
  return parsed.data;
}

export const OpencodeHealthSchema = z.looseObject({
  healthy: z.boolean().optional(),
  version: z.string().min(1).max(255),
});

/**
 * `variants` is the reasoning-effort knob, keyed by effort name
 * (opencode-facts §5). `capabilities.input.image` is what OpenCode itself
 * decides image support by: `GET /provider` serves its own model shape, built
 * from the models.dev row's `modalities.input`, not the row itself (1.18.31
 * `provider/provider.ts` `fromModelsDevModel`). A model that arrives without
 * it has declared nothing.
 */
export const OpencodeModelSchema = z.looseObject({
  capabilities: z
    .looseObject({
      input: z.looseObject({ image: z.boolean().optional() }).optional(),
    })
    .optional(),
  id: z.string().min(1).max(255),
  limit: z
    .looseObject({
      context: z.number().int().positive().optional(),
      output: z.number().int().positive().optional(),
    })
    .optional(),
  name: z.string().max(255).optional(),
  variants: z.record(z.string(), z.unknown()).optional(),
});

export const OpencodeProviderSchema = z.looseObject({
  id: z.string().min(1).max(255),
  models: z.record(z.string(), OpencodeModelSchema),
  name: z.string().max(255).optional(),
});

export const OpencodeProvidersSchema = z.looseObject({
  all: z.array(OpencodeProviderSchema).max(4_096),
  connected: z.array(z.string()).max(4_096).default([]),
  default: z.record(z.string(), z.string()).default({}),
});

export const OpencodeSessionSchema = z.looseObject({
  directory: z.string().optional(),
  id: z.string().min(1).max(255),
  /** Set on a subagent's child session: the session whose `task` call started it. */
  parentID: z.string().min(1).max(255).optional(),
  title: z.string().max(2_000).optional(),
});

/** `session.created` and `session.updated`. */
export const OpencodeSessionEventSchema = z.looseObject({
  info: OpencodeSessionSchema,
});

/** `permission.replied`, `question.replied` and `question.rejected`: an ask was settled. */
export const OpencodeAskSettledSchema = z.looseObject({
  requestID: z.string().min(1).max(255),
  sessionID: z.string().min(1).max(255),
});

/**
 * One pending permission ask. `patterns` is the concrete resource (the exact
 * bash command, the file path); `metadata` carries `{command}` for bash and
 * `{filepath, diff}` for an edit or write; `always` is the glob an "always"
 * answer would save, which this driver never sends.
 */
export const OpencodePermissionRequestSchema = z.looseObject({
  always: z.array(z.string()).max(256).default([]),
  id: z.string().min(1).max(255),
  metadata: z.record(z.string(), z.unknown()).default({}),
  patterns: z.array(z.string()).max(256).default([]),
  permission: z.string().min(1).max(255),
  sessionID: z.string().min(1).max(255),
  tool: z.looseObject({ callID: z.string().max(255), messageID: z.string().max(255) }).optional(),
});

export const OpencodeQuestionOptionSchema = z.looseObject({
  description: z.string().max(2_000).optional(),
  label: z.string().min(1).max(500),
});

export const OpencodeQuestionInfoSchema = z.looseObject({
  header: z.string().max(255).optional(),
  options: z.array(OpencodeQuestionOptionSchema).max(32).default([]),
  question: z.string().min(1).max(20_000),
});

export const OpencodeQuestionRequestSchema = z.looseObject({
  id: z.string().min(1).max(255),
  questions: z.array(OpencodeQuestionInfoSchema).min(1).max(8),
  sessionID: z.string().min(1).max(255),
  tool: z.looseObject({ callID: z.string().max(255), messageID: z.string().max(255) }).optional(),
});

const OpencodeTokensSchema = z.looseObject({
  cache: z.looseObject({ read: z.number(), write: z.number() }).optional(),
  input: z.number(),
  output: z.number(),
  reasoning: z.number().optional(),
});

/**
 * Every error OpenCode puts on an assistant message or on `session.error`.
 * `APIError.data.statusCode` is the only marker an exhausted plan has: verified
 * live against a provider endpoint answering 429, which OpenCode retried five
 * times and then reported as `{name:"APIError", data:{statusCode:429,
 * isRetryable:true, responseHeaders, responseBody}}`.
 */
export const OpencodeErrorSchema = z.looseObject({
  data: z
    .looseObject({
      isRetryable: z.boolean().optional(),
      message: z.string().max(20_000).optional(),
      statusCode: z.number().optional(),
    })
    .default({}),
  name: z.string().max(255),
});

export const OpencodeMessageInfoSchema = z.looseObject({
  cost: z.number().optional(),
  error: OpencodeErrorSchema.nullish(),
  finish: z.string().max(255).optional(),
  id: z.string().min(1).max(255),
  modelID: z.string().max(255).optional(),
  providerID: z.string().max(255).optional(),
  role: z.string().max(64),
  sessionID: z.string().min(1).max(255),
  tokens: OpencodeTokensSchema.optional(),
});

const OpencodeToolStateSchema = z.looseObject({
  error: z.string().optional(),
  input: z.unknown().optional(),
  /**
   * Each tool's own shape, read only where a field is known: a `task` call's
   * running state names its child session, `{sessionId, model}`.
   */
  metadata: z.unknown().optional(),
  output: z.string().optional(),
  status: z.string().max(64),
  title: z.unknown().optional(),
});

/**
 * A part snapshot. The stream sends an empty snapshot first, then
 * `message.part.delta` events keyed by `partID`, then the finished snapshot
 * carrying `time.end` — so the part's type is known before its first delta.
 */
export const OpencodePartSchema = z.looseObject({
  callID: z.string().max(255).optional(),
  cost: z.number().optional(),
  id: z.string().min(1).max(255),
  messageID: z.string().min(1).max(255),
  reason: z.string().max(255).optional(),
  sessionID: z.string().min(1).max(255),
  state: OpencodeToolStateSchema.optional(),
  text: z.string().optional(),
  time: z.looseObject({ end: z.number().optional(), start: z.number().optional() }).optional(),
  tokens: OpencodeTokensSchema.optional(),
  tool: z.string().max(255).optional(),
  type: z.string().max(64),
});

/** The v1 `GET /event` envelope. v2's durable `{id,type,data}` form is not used. */
export const OpencodeEventSchema = z.looseObject({
  properties: z.unknown().optional(),
  type: z.string().min(1).max(255),
});

export const OpencodeMessageUpdatedSchema = z.looseObject({
  info: OpencodeMessageInfoSchema,
});

export const OpencodePartUpdatedSchema = z.looseObject({
  part: OpencodePartSchema,
  sessionID: z.string().min(1).max(255),
});

export const OpencodePartDeltaSchema = z.looseObject({
  delta: z.string(),
  field: z.string().max(64),
  messageID: z.string().min(1).max(255),
  partID: z.string().min(1).max(255),
  sessionID: z.string().min(1).max(255),
});

export const OpencodeSessionIdleSchema = z.looseObject({
  sessionID: z.string().min(1).max(255),
});

export const OpencodeSessionErrorSchema = z.looseObject({
  error: OpencodeErrorSchema.nullish(),
  sessionID: z.string().min(1).max(255).optional(),
});

/** `GET /api/permission/saved` — the one store an "always" answer can persist into. */
export const OpencodeSavedPermissionsSchema = z.looseObject({
  data: z.array(z.looseObject({ id: z.string().min(1).max(255) })).max(4_096),
});

export type OpencodePart = z.infer<typeof OpencodePartSchema>;
export type OpencodeMessageInfo = z.infer<typeof OpencodeMessageInfoSchema>;
export type OpencodeErrorPayload = z.infer<typeof OpencodeErrorSchema>;
