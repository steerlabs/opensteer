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
