import { z } from "zod";

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** Every control-plane identifier is a prefixed UUIDv4-shaped string. */
export function prefixedIdSchema<Prefix extends string>(prefix: Prefix) {
  return z.string().regex(new RegExp(`^${prefix}_${uuidPattern}$`, "i"));
}

/**
 * The Account's own subject. It lives in its own module so schema groups that
 * name an Account — the directory, notification publications — can import it
 * without importing the whole protocol barrel back into themselves.
 */
export const ControlPlaneAccountIdSchema =
  prefixedIdSchema("acct").brand<"ControlPlaneAccountId">();
export type ControlPlaneAccountId = z.infer<typeof ControlPlaneAccountIdSchema>;
