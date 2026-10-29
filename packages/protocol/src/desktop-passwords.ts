import { BrowserSiteSchema } from "@opensteer/core";
import { z } from "zod";
import {
  PasswordsBrokerAccountsSchema,
  PasswordsBrokerSignInApproveParamsSchema,
  PasswordsBrokerStatusSchema,
} from "./passwords-broker.js";

/**
 * What the Opensteer app on this Mac reports about Opensteer Passwords.
 * `unsupported` is final for this Mac (no Secure Enclave, or a macOS release
 * Passwords has not been qualified on); `unavailable` means the broker could
 * not be reached right now and names why.
 */
export const DesktopPasswordsStatusSchema = z.discriminatedUnion("availability", [
  z.strictObject({
    availability: z.literal("unsupported"),
    reason: z.enum(["platform", "hardware", "os"]),
  }),
  z.strictObject({
    availability: z.literal("unavailable"),
    message: z.string().min(1).max(500),
  }),
  z.strictObject({
    availability: z.literal("available"),
    broker: PasswordsBrokerStatusSchema,
    /** A development build: its vault is separate and holds test data only. */
    development: z.boolean(),
  }),
]);
export type DesktopPasswordsStatus = z.infer<typeof DesktopPasswordsStatusSchema>;

/**
 * The Request card on this Mac reads and drives its sign-in by the Request's
 * runtime operation. Electron main answers only for operations it runs.
 */
export const DesktopPasswordsSignInCardInputSchema = z.strictObject({ operationId: z.uuid() });
export type DesktopPasswordsSignInCardInput = z.infer<typeof DesktopPasswordsSignInCardInputSchema>;

/** The card authorizes a login; the agent handles the website in its own tab. */
export const DesktopPasswordsSignInCardStateSchema = z.discriminatedUnion("stage", [
  z.strictObject({
    accounts: PasswordsBrokerAccountsSchema,
    permissionVersion: z.literal(5).optional(),
    site: BrowserSiteSchema,
    stage: z.literal("approval"),
  }),
  z.strictObject({
    account: z.string().min(1).max(200),
    permissionVersion: z.literal(5).optional(),
    stage: z.literal("authorized"),
  }),
  z.strictObject({ stage: z.literal("gone") }),
]);
export type DesktopPasswordsSignInCardState = z.infer<typeof DesktopPasswordsSignInCardStateSchema>;

/** A card's new state, pushed by Electron main the moment its operation moves on. */
export const DesktopPasswordsSignInCardChangedSchema = z.strictObject({
  operationId: z.uuid(),
  state: DesktopPasswordsSignInCardStateSchema,
});
export type DesktopPasswordsSignInCardChanged = z.infer<
  typeof DesktopPasswordsSignInCardChangedSchema
>;

/** Allow (`remember`) or Only this time, for the login at the revision the card showed. */
export const DesktopPasswordsSignInApproveInputSchema = z.strictObject({
  ...PasswordsBrokerSignInApproveParamsSchema.omit({ transactionId: true }).shape,
  operationId: z.uuid(),
});
export type DesktopPasswordsSignInApproveInput = z.infer<
  typeof DesktopPasswordsSignInApproveInputSchema
>;

/** `ok: false` keeps the card: the authentication was cancelled or the login changed. */
export const DesktopPasswordsSignInApproveResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ message: z.string().min(1).max(2_000), ok: z.literal(false) }),
]);
export type DesktopPasswordsSignInApproveResult = z.infer<
  typeof DesktopPasswordsSignInApproveResultSchema
>;
