import { z } from "zod";
import { BrowserSourceOriginSchema } from "../frozen/browser-source.js";
import { PersonalAccessRouteGenerationSchema } from "../frozen/personal-access-route.js";
import { BrowserSourceIdSchema } from "../frozen/primitives.js";
import { BrowserSiteSchema, BrowserSourceSnapshotSchema } from "../site.js";
import {
  BrowserSourceExportProblemSchema,
  BrowserSourceStatusSchema,
  type BrowserSourceExportProblem,
  type BrowserSourceStatus,
} from "./v4.js";

/**
 * Readers for wire >= 5 peers. Unknown fields are stripped, an unknown `type`
 * reads as `{ type: "unknown" }` for the caller to ignore, and an unknown
 * status reads as `unsupported`. Signatures, nonces, origins, generations,
 * source IDs (they are signed into challenges), sites, tokens, cookie
 * snapshots and limits stay exact: a frame that breaks one reads as null.
 */
export interface UnknownMessage {
  readonly type: "unknown";
}

const SignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);
const OperationIdSchema = z.string().min(1).max(256);
const TokenSchema = z.string().min(32).max(256);
const StatusSchema = z
  .string()
  .max(256)
  .transform((value): BrowserSourceStatus => {
    const known = BrowserSourceStatusSchema.safeParse(value);
    return known.success ? known.data : "unsupported";
  });
const ExportProblemSchema = z
  .string()
  .max(256)
  .refine((value) => value !== "exported" && value !== "available")
  .transform((value): BrowserSourceExportProblem => {
    const known = BrowserSourceExportProblemSchema.safeParse(value);
    return known.success ? known.data : "unsupported";
  });

const hostMessageSchemas = {
  "source.error": z.discriminatedUnion("code", [
    z.object({
      type: z.literal("source.error"),
      code: z.literal("unsupported-version"),
      supportedVersion: z.number().int().positive(),
    }),
    z.object({
      type: z.literal("source.error"),
      code: z.literal("route-changed"),
      signature: SignatureSchema.optional(),
    }),
    z.object({ type: z.literal("source.error"), code: z.literal("source-unauthorized") }),
  ]),
  "source.proof": z.object({
    type: z.literal("source.proof"),
    nonce: z.uuid(),
    signature: SignatureSchema,
    /** The negotiated wire version; absent from a wire-4 Host. */
    wire: z.number().int().positive().optional(),
  }),
  "source.ready": z.object({ type: z.literal("source.ready"), sourceId: BrowserSourceIdSchema }),
  "source.inspect": z.object({
    type: z.literal("source.inspect"),
    operationId: OperationIdSchema,
    site: BrowserSiteSchema,
  }),
  "source.export": z.object({
    type: z.literal("source.export"),
    operationId: OperationIdSchema,
    site: BrowserSiteSchema,
  }),
  ping: z.object({ type: z.literal("ping"), nonce: z.uuid() }),
};

const clientMessageSchemas = {
  "source.challenge": z.object({
    type: z.literal("source.challenge"),
    origin: BrowserSourceOriginSchema,
    routeGeneration: PersonalAccessRouteGenerationSchema.nullable(),
    sourceId: BrowserSourceIdSchema,
    nonce: z.uuid(),
  }),
  "source.hello": z.object({
    type: z.literal("source.hello"),
    sourceId: BrowserSourceIdSchema,
    token: TokenSchema,
    version: z.number().int().positive(),
  }),
  "source.inspect.result": z.object({
    type: z.literal("source.inspect.result"),
    operationId: OperationIdSchema,
    status: StatusSchema,
  }),
  "source.export.result": z.object({
    type: z.literal("source.export.result"),
    operationId: OperationIdSchema,
    result: z.union([
      z.object({ status: z.literal("exported"), snapshot: BrowserSourceSnapshotSchema }),
      z.object({ status: ExportProblemSchema }),
    ]),
  }),
  pong: z.object({ type: z.literal("pong"), nonce: z.uuid() }),
  "source.disconnect": z.object({ type: z.literal("source.disconnect") }),
};

type Known<Schemas extends Record<string, z.ZodType>> = z.output<Schemas[keyof Schemas]>;
export type BrowserSourceHostFrame = Known<typeof hostMessageSchemas>;
export type BrowserSourceClientFrame = Known<typeof clientMessageSchemas>;

/** One frame a wire >= 5 Host sent, as JSON text. */
export function readHostMessage(raw: string): BrowserSourceHostFrame | UnknownMessage | null {
  return readMessage(raw, hostMessageSchemas);
}

/** One frame a wire >= 5 extension sent, as JSON text. */
export function readClientMessage(raw: string): BrowserSourceClientFrame | UnknownMessage | null {
  return readMessage(raw, clientMessageSchemas);
}

function readMessage<Schemas extends Record<string, z.ZodType>>(
  raw: string,
  schemas: Schemas,
): Known<Schemas> | UnknownMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const type: unknown = "type" in value ? value.type : undefined;
  if (typeof type !== "string") return null;
  if (!Object.hasOwn(schemas, type)) return { type: "unknown" };
  const parsed = schemas[type as keyof Schemas]!.safeParse(value);
  return parsed.success ? (parsed.data as Known<Schemas>) : null;
}
