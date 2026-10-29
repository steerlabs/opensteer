import { z } from "zod";

/** Internal main/preload envelope; public bridge methods keep their domain results. */
export const PasswordsBridgeResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), message: z.string().min(1).max(2_000) }),
]);
