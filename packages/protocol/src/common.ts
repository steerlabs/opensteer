import { z } from "zod";

export const personalWebBuildId = "opensteer-personal-web-2026-08-24-v4";

// Tool arguments and results become durable Runner events. Keep one shared
// ceiling below the 480 KiB pending-event limit so IDs and event metadata
// always have explicit headroom.
export const agentToolPayloadMaxSerializedBytes = 432 * 1_024;

export const CorrelationIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  .brand<"CorrelationId">();
export const ProtocolErrorSchema = z.strictObject({
  code: z.enum(["bad_message", "conflict", "forbidden", "internal", "not_found"]),
  message: z.string().min(1).max(2_000),
  /**
   * Stable machine-readable discriminator within one `code`, matching the rpc
   * envelope's field of the same name. Only refusals a peer must tell apart
   * carry one, so that a wording change is never a behaviour change.
   */
  reason: z.string().min(1).max(120).optional(),
  retryable: z.boolean(),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

/** All a client may record of a realtime frame it could not read: never its contents. */
export const RealtimeFrameDiagnosticSchema = z.strictObject({
  apiEpoch: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  category: z.enum(["frame", "json", "schema"]),
  envelopeType: z.string().min(1).max(120),
  event: z.enum(["host.realtime.frame-ignored", "host.realtime.frame-rejected"]),
  issuePaths: z.array(z.string().min(1).max(1_024)).max(8),
});
export type RealtimeFrameDiagnostic = z.infer<typeof RealtimeFrameDiagnosticSchema>;

const CodeFramesSchema = z.array(z.string().min(1).max(512)).max(32);

/** All a page may record of what took it down: where in the code, never the error's words. */
export const RendererFailureDiagnosticSchema = z.strictObject({
  componentFrames: CodeFramesSchema,
  errorFrames: CodeFramesSchema,
  errorName: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
});
export type RendererFailureDiagnostic = z.infer<typeof RendererFailureDiagnosticSchema>;

export function parseJsonFrame(schema: z.ZodType, frame: string | Uint8Array): unknown {
  let value: unknown;
  try {
    value = JSON.parse(typeof frame === "string" ? frame : new TextDecoder().decode(frame));
  } catch (error) {
    throw new Error("Protocol frame is not valid JSON", { cause: error });
  }
  return schema.parse(value);
}

export function serializeJsonFrame(value: unknown): string {
  return JSON.stringify(value);
}
