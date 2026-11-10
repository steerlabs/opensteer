import { z } from "zod";

/**
 * A person filling a saved login into an Opensteer browser page from any
 * viewer. See docs/passwords.md#filling-for-people.
 */

/** The longest one confirmed person fill may be reused, decided by the broker. */
export const personFillTransactionMaxMs = 5 * 60_000;
/** The most accounts one offer lists. */
export const personFillMaxAccounts = 20;

export const PersonFillRoleSchema = z.enum(["username", "password", "code"]);
export type PersonFillRole = z.infer<typeof PersonFillRoleSchema>;

/**
 * `here`: the person activated the field on the vault Mac's own native page,
 * so the broker asks Touch ID itself. `elsewhere`: any other viewer, which is
 * responsible for its own device check.
 */
export const PersonFillPresenceSchema = z.enum(["here", "elsewhere"]);
export type PersonFillPresence = z.infer<typeof PersonFillPresenceSchema>;

/**
 * The bound field's visible box, normalized to the page's viewport: unlike an
 * editing caret it is not mapped to the frame capture, which viewers apply.
 */
export const PersonFillAnchorSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type PersonFillAnchor = z.infer<typeof PersonFillAnchorSchema>;

/**
 * One saved login an offer lists: never a password. `ready` means this viewer
 * already confirmed it on this tab, so it fills without another device check.
 */
export const PersonFillAccountViewSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  username: z.string().max(1_024),
  label: z.string().min(1).max(200).nullable(),
  ready: z.boolean(),
});
export type PersonFillAccountView = z.infer<typeof PersonFillAccountViewSchema>;

/**
 * `cancelled`: the person cancelled the device check. `changed`: the login
 * changed or was deleted since the offer. `denied`: the setting is off.
 * `stale`: the bound field or page changed. `expired`: the offer ended.
 */
export const PersonFillStatusSchema = z.enum([
  "filled",
  "cancelled",
  "changed",
  "denied",
  "stale",
  "expired",
  "unavailable",
]);
export type PersonFillStatus = z.infer<typeof PersonFillStatusSchema>;

/** Where a write lands among the elements bound when the field was activated. */
export const PersonFillSlotSchema = z.enum(["target", "partner", "group"]);
export type PersonFillSlot = z.infer<typeof PersonFillSlotSchema>;
