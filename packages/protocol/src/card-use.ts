import { z } from "zod";
import { BrowserSiteSchema, RequestIdSchema } from "@opensteer/core";

export const cardUseLifetimeMs = 30 * 60_000;
export const CardRefSchema = z.string().regex(/^crd_[0-9a-f]{32}$/u);
export const CardFieldSchema = z.enum([
  "number",
  "expiry",
  "expiry-month",
  "expiry-year",
  "cvc",
  "name",
  "billing-postal-code",
]);
export type CardField = z.infer<typeof CardFieldSchema>;
export const CardPublicSchema = z.strictObject({
  brand: z.string().min(1).max(64),
  lastFour: z.string().regex(/^\d{4}$/u),
});
export const CardChoiceSchema = z.strictObject({
  ...CardPublicSchema.shape,
  id: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  label: z.string().min(1).max(200).nullable(),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(1000).max(9999),
});
export type CardChoice = z.infer<typeof CardChoiceSchema>;
export const CardChoicesSchema = z.array(CardChoiceSchema).max(100);
export const CardAvailabilitySchema = z.enum([
  "has-card",
  "no-card",
  "off",
  "not-set-up",
  "unavailable",
]);
export type CardAvailability = z.infer<typeof CardAvailabilitySchema>;
export const CardApprovalSchema = z.strictObject({
  cardId: z.uuid(),
  revision: CardChoiceSchema.shape.revision,
  permissionVersion: z.literal(7),
});
export const CardChooserSchema = z.strictObject({
  stage: z.literal("card-approval"),
  cards: CardChoicesSchema,
  permissionVersion: z.literal(7),
});
export const CardChooserViewSchema = z.object({
  ...CardChooserSchema.shape,
  cards: z.array(z.object(CardChoiceSchema.shape)).max(100),
});
export const CardAuthorizationOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("authorized"),
    cardRef: CardRefSchema,
    ...CardPublicSchema.shape,
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({ kind: z.literal("declined") }),
  z.strictObject({ kind: z.literal("expired") }),
  z.strictObject({ kind: z.literal("busy") }),
  z.strictObject({
    kind: z.literal("cancelled"),
    reason: z.enum(["declined", "withdrawn", "expired", "authority-lost"]),
  }),
  z.strictObject({
    kind: z.literal("unavailable"),
    reason: z.enum(["passwords-off", "not-set-up", "not-responding", "no-saved-card"]),
  }),
]);
export type CardAuthorizationOutcome = z.infer<typeof CardAuthorizationOutcomeSchema>;

export const UseCardResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    site: BrowserSiteSchema,
    cardRef: CardRefSchema,
    ...CardPublicSchema.shape,
  }),
  z.strictObject({
    status: z.literal("pending"),
    site: BrowserSiteSchema,
    requestId: RequestIdSchema,
  }),
  z.strictObject({
    status: z.enum(["resolved", "declined", "needs-approval"]),
    site: BrowserSiteSchema,
    guidance: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    site: BrowserSiteSchema,
    reason: z.enum([
      "unsupported",
      "runtime-outdated",
      "main-browser-required",
      "session-closed",
      "not-allowed",
      "rate-limited",
      "busy",
      "stopped",
      "expired",
      "interrupted",
      "no-saved-card",
      "passwords-off",
      "passwords-not-set-up",
      "passwords-not-responding",
    ]),
  }),
]);
export type UseCardResult = z.infer<typeof UseCardResultSchema>;
