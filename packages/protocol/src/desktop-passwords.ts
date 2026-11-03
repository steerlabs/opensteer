import { z } from "zod";
import { PasswordsBrokerStatusSchema } from "./passwords-broker.js";

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
