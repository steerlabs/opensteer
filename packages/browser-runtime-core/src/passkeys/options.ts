import { z } from "zod";
import { decodeBase64Url } from "@opensteer/shared/base64url";

// WebAuthn requires these members but lets them be empty, such as a display name
// the relying party doesn't know.
const text = z.string().max(1024);
const binary = (max: number) =>
  z
    .string()
    .max(Math.ceil((max * 4) / 3))
    .transform((value, ctx) => {
      try {
        const bytes = decodeBase64Url(value);
        if (bytes.length >= 1 && bytes.length <= max) return bytes;
      } catch {
        /* Report as an option validation error. */
      }
      ctx.addIssue({ code: "custom", message: `Expected 1–${max} canonical base64url bytes` });
      return z.NEVER;
    });
/**
 * A WebIDL enumeration carried as a DOMString: values this client doesn't know
 * count as absent (L3 §2.1.1), so a newer relying party still gets a ceremony.
 */
const known = <const Values extends readonly [string, ...string[]]>(values: Values) =>
  z
    .string()
    .max(64)
    .optional()
    .transform((value): Values[number] | undefined =>
      values.includes(value as Values[number]) ? (value as Values[number]) : undefined,
    );
const transports = ["usb", "nfc", "ble", "smart-card", "hybrid", "internal"] as const;
export type PasskeyTransport = (typeof transports)[number];
/**
 * Descriptors of an unknown type stay in the list, so a non-empty allow list
 * never turns into a request for any credential; authenticators skip them.
 */
export const PasskeyDescriptorSchema = z.object({
  type: z.string().max(64),
  id: binary(1023),
  transports: z
    .array(z.string().max(64))
    .max(16)
    .optional()
    .transform((values) =>
      values?.filter((value): value is PasskeyTransport =>
        transports.includes(value as PasskeyTransport),
      ),
    ),
});
const descriptors = z.array(PasskeyDescriptorSchema).max(64).default([]);
const extensions = z.object({ credProps: z.boolean().optional() }).default({});
const userVerification = known(["required", "preferred", "discouraged"] as const).transform(
  (value) => value ?? "preferred",
);
export const UserVerificationSchema = z.enum(["required", "preferred", "discouraged"]);
export const ResidentKeySchema = z.enum(["discouraged", "preferred", "required"]);
/** ES256 and RS256, which L3 asks for when a relying party lists no algorithm. */
const defaultAlgorithms = [
  { type: "public-key", alg: -7 },
  { type: "public-key", alg: -257 },
] as const;
/** L3 JSON boundary; unknown WebIDL dictionary members and extensions are ignored. */
export const PublicKeyCredentialCreationOptionsJSONSchema = z
  .object({
    rp: z.object({ id: z.string().min(1).max(253).optional(), name: text }),
    user: z.object({ id: binary(64), name: text, displayName: text }),
    challenge: binary(1024),
    pubKeyCredParams: z
      .array(
        z.object({
          type: z.string().max(64),
          alg: z.number().int().min(-2147483648).max(2147483647),
        }),
      )
      .max(64)
      .transform((parameters) =>
        parameters.length === 0
          ? defaultAlgorithms.map((parameter) => ({ ...parameter }))
          : parameters.filter((parameter) => parameter.type === "public-key"),
      ),
    timeout: z.number().finite().nonnegative().optional(),
    excludeCredentials: descriptors,
    authenticatorSelection: z
      .object({
        authenticatorAttachment: known(["platform", "cross-platform"] as const),
        residentKey: known(["discouraged", "preferred", "required"] as const),
        requireResidentKey: z.boolean().default(false),
        userVerification,
      })
      .default({
        authenticatorAttachment: undefined,
        residentKey: undefined,
        requireResidentKey: false,
        userVerification: "preferred",
      }),
    attestation: known(["none", "indirect", "direct", "enterprise"] as const).transform(
      (value) => value ?? "none",
    ),
    extensions,
  })
  .transform(({ authenticatorSelection, ...options }) => ({
    ...options,
    authenticatorSelection: {
      ...authenticatorSelection,
      residentKey:
        authenticatorSelection.residentKey ??
        (authenticatorSelection.requireResidentKey ? "required" : "discouraged"),
    },
  }));
export const PublicKeyCredentialRequestOptionsJSONSchema = z.object({
  challenge: binary(1024),
  rpId: z.string().min(1).max(253).optional(),
  timeout: z.number().finite().nonnegative().optional(),
  allowCredentials: descriptors,
  userVerification,
  extensions,
});
export type PasskeyCreationOptions = z.infer<typeof PublicKeyCredentialCreationOptionsJSONSchema>;
export type PasskeyRequestOptions = z.infer<typeof PublicKeyCredentialRequestOptionsJSONSchema>;
