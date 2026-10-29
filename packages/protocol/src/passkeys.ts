import { browserBase } from "./browser-message-base.js";
import { z } from "zod";
import { encodeBase64Url, decodeBase64Url } from "@opensteer/shared/base64url";
import {
  NormalizedPasskeyCreationOptionsJSONSchema,
  NormalizedPasskeyRequestOptionsJSONSchema,
} from "./passkey-options.js";
export * from "./passkey-options.js";

type BytesJSON<T> = T extends Uint8Array
  ? string
  : T extends readonly (infer V)[]
    ? BytesJSON<V>[]
    : T extends object
      ? { [K in keyof T]: BytesJSON<T[K]> }
      : T;
/** JSON transport preserves the authenticator's bytes without interpreting them. */
export function passkeyBytesToJSON<T>(value: T): BytesJSON<T>;
export function passkeyBytesToJSON(value: unknown): unknown {
  if (value instanceof Uint8Array) return encodeBase64Url(value);
  if (Array.isArray(value)) return value.map((item: unknown) => passkeyBytesToJSON(item));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, passkeyBytesToJSON(item)]),
    );
  return value;
}
const bytes = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(Math.ceil((maximum * 4) / 3))
    .refine((value) => {
      try {
        const length = decodeBase64Url(value).length;
        return length > 0 && length <= maximum;
      } catch {
        return false;
      }
    });
const attachment = z.enum(["platform", "cross-platform"]).nullable();
const baseOutcome = {
  credentialId: bytes(1023),
  clientDataJSON: bytes(8192),
  authenticatorData: bytes(65_536),
  authenticatorAttachment: attachment,
};
export const PasskeyOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("refused"),
    error: z.enum([
      "NotAllowedError",
      "InvalidStateError",
      "NotSupportedError",
      "SecurityError",
      "AbortError",
      "ConstraintError",
      "UnknownError",
    ]),
  }),
  z.strictObject({
    ...baseOutcome,
    kind: z.literal("created"),
    attestationObject: bytes(131_072),
    publicKey: bytes(16_384).nullable(),
    publicKeyAlgorithm: z.number().int(),
    transports: z.array(z.enum(["usb", "nfc", "ble", "smart-card", "hybrid", "internal"])).max(16),
    discoverable: z.boolean().nullable(),
  }),
  z.strictObject({
    ...baseOutcome,
    kind: z.literal("asserted"),
    signature: bytes(16_384),
    userHandle: bytes(64).nullable(),
  }),
]);
export type PasskeyOutcome = z.infer<typeof PasskeyOutcomeSchema>;
export const PasskeyCauseSchema = z.union([
  z.enum(["agent", "unknown"]),
  z.strictObject({ person: z.uuid() }),
]);
export type PasskeyCause = z.infer<typeof PasskeyCauseSchema>;
export const PasskeyModeSchema = z.enum(["native", "notice"]);
export type PasskeyMode = z.infer<typeof PasskeyModeSchema>;
const requestFields = {
  ...browserBase,
  ceremonyId: z.uuid(),
  surfaceId: z.string().min(1).max(255),
  documentId: z.string().min(1).max(255),
  origin: z.url().max(8192),
  rpId: z.string().min(1).max(253),
  clientDataJSON: bytes(8192),
  cause: PasskeyCauseSchema,
  deadline: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const createFields = {
  op: z.literal("create"),
  options: NormalizedPasskeyCreationOptionsJSONSchema.transform(passkeyBytesToJSON),
};
const getFields = {
  op: z.literal("get"),
  options: NormalizedPasskeyRequestOptionsJSONSchema.transform(passkeyBytesToJSON),
};
export const PasskeyCeremonySchema = z.union([
  z.strictObject({ ...requestFields, ...createFields, type: z.literal("passkey.ceremony") }),
  z.strictObject({ ...requestFields, ...getFields, type: z.literal("passkey.ceremony") }),
]);
export type PasskeyCeremony = z.infer<typeof PasskeyCeremonySchema>;
export const PasskeyRuntimeCancelSchema = z.strictObject({
  ...browserBase,
  type: z.literal("passkey.cancel"),
  ceremonyId: z.uuid(),
});
export const PasskeyResultSchema = z.strictObject({
  ...browserBase,
  type: z.literal("passkey.result"),
  ceremonyId: z.uuid(),
  outcome: PasskeyOutcomeSchema,
});
export const BrowserPasskeyRequestSchema = z.union([
  z.strictObject({
    ...requestFields,
    ...createFields,
    type: z.literal("browser.passkey.request"),
    requestId: z.uuid(),
  }),
  z.strictObject({
    ...requestFields,
    ...getFields,
    type: z.literal("browser.passkey.request"),
    requestId: z.uuid(),
  }),
]);
export type BrowserPasskeyRequest = z.infer<typeof BrowserPasskeyRequestSchema>;
export const BrowserPasskeyOfferSchema = z.strictObject({
  ...browserBase,
  type: z.literal("browser.passkey.offer"),
  requestId: z.uuid(),
  surfaceId: z.string().min(1).max(255),
  rpId: z.string().min(1).max(253),
  op: z.enum(["create", "get"]),
  agent: z.literal(true).optional(),
  deadline: requestFields.deadline,
});
export const BrowserPasskeyWithdrawnSchema = z.strictObject({
  ...browserBase,
  type: z.literal("browser.passkey.withdrawn"),
  requestId: z.uuid(),
});
export const BrowserPasskeyNoticeSchema = z.strictObject({
  ...browserBase,
  type: z.literal("browser.passkey.notice"),
  surfaceId: z.string().min(1).max(255),
});
export const PasskeyClaimSchema = z.strictObject({
  ...browserBase,
  type: z.literal("passkey.claim"),
  requestId: z.uuid(),
});
export const PasskeyRespondSchema = z.strictObject({
  ...browserBase,
  type: z.literal("passkey.respond"),
  requestId: z.uuid(),
  outcome: PasskeyOutcomeSchema,
});
export const PasskeyViewerCancelSchema = z.strictObject({
  ...browserBase,
  type: z.literal("passkey.cancel"),
  requestId: z.uuid(),
});
export const PasskeyCancelSchema = z.union([PasskeyRuntimeCancelSchema, PasskeyViewerCancelSchema]);
export type PasskeyViewerMessage =
  | z.infer<typeof PasskeyClaimSchema>
  | z.infer<typeof PasskeyRespondSchema>
  | z.infer<typeof PasskeyViewerCancelSchema>;
export type BrowserPasskeyMessage =
  | BrowserPasskeyRequest
  | z.infer<typeof BrowserPasskeyOfferSchema>
  | z.infer<typeof BrowserPasskeyWithdrawnSchema>
  | z.infer<typeof BrowserPasskeyNoticeSchema>;
