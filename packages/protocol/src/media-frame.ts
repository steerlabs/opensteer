import { z } from "zod";
export const displayMaxHeaderBytes = 16 * 1_024;
export const displayMaxFramePayloadBytes = 4 * 1_024 * 1_024;
export const displayMaxEnvelopeBytes = 4 + displayMaxHeaderBytes + displayMaxFramePayloadBytes;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const DisplayStreamIdSchema = z
  .string()
  .regex(new RegExp(`^dsp_${uuid}$`, "i"))
  .brand<"DisplayStreamId">();
export type DisplayStreamId = z.infer<typeof DisplayStreamIdSchema>;
export const DisplayGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const DisplaySequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pictureDimension = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const codec = z.string().regex(/^avc1\.[0-9A-Fa-f]{6}$/);
export const displayFrameHeaderFields = {
  generation: DisplayGenerationSchema,
  sequence: DisplaySequenceSchema,
  ptsUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  key: z.boolean(),
  codec: codec.optional(),
  width: pictureDimension,
  height: pictureDimension,
};
export function displayKeyHasCodec(header: {
  readonly key: boolean;
  readonly codec?: string | undefined;
}): boolean {
  return header.key === (header.codec !== undefined);
}

function validatePayload(payload: Uint8Array): void {
  if (payload.byteLength < 1 || payload.byteLength > displayMaxFramePayloadBytes)
    throw new Error("Invalid display frame payload size.");
}
export function encodeDisplayEnvelope(header: object, payload: Uint8Array): Uint8Array {
  validatePayload(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(header));
  if (bytes.byteLength > displayMaxHeaderBytes)
    throw new Error("Invalid display frame header size.");
  const result = new Uint8Array(4 + bytes.byteLength + payload.byteLength);
  new DataView(result.buffer).setUint32(0, bytes.byteLength, false);
  result.set(bytes, 4);
  result.set(payload, 4 + bytes.byteLength);
  return result;
}
export function decodeDisplayEnvelope(value: Uint8Array): {
  readonly header: unknown;
  readonly payload: Uint8Array;
} {
  if (value.byteLength < 7 || value.byteLength > displayMaxEnvelopeBytes)
    throw new Error("Invalid display frame size.");
  const headerLength = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(
    0,
    false,
  );
  if (
    headerLength < 2 ||
    headerLength > displayMaxHeaderBytes ||
    4 + headerLength >= value.byteLength
  )
    throw new Error("Invalid display frame header size.");
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(4, 4 + headerLength)),
    );
  } catch (cause) {
    throw new Error("Invalid display frame JSON header.", { cause });
  }
  const payload = value.subarray(4 + headerLength);
  validatePayload(payload);
  return { header, payload };
}
