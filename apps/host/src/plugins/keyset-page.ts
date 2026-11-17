import { createHash } from "node:crypto";
import { z } from "zod";
import { OpensteerError } from "@opensteer/core";

const pageCursorSchema = z.object({ scope: z.string(), after: z.string() });
/**
 * One page of a list the Host reads whole from the engine, ordered by `key` and continued after
 * the last key sent. A cursor names the listing it came from, so one from another plugin, version
 * or list is refused rather than read as a different list.
 */
export function keysetPage<T>(
  items: readonly T[],
  key: (item: T) => string,
  input: { scope: string; cursor?: string | undefined; max: number; descending?: boolean },
): { items: T[]; cursor: string | null } {
  const scope = createHash("sha256").update(input.scope).digest("base64url").slice(0, 22);
  let after: string | undefined;
  if (input.cursor) {
    const parsed = pageCursorSchema.safeParse(
      (() => {
        try {
          return JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success || parsed.data.scope !== scope)
      throw new OpensteerError({
        code: "bad_request",
        reason: "plugin-cursor-stale",
        message: "This list changed. Open it again.",
      });
    after = parsed.data.after;
  }
  const order = (a: string, b: string) =>
    (input.descending ? -1 : 1) * (a < b ? -1 : a > b ? 1 : 0);
  const rest = items
    .map((item) => [key(item), item] as const)
    .sort(([a], [b]) => order(a, b))
    .filter(([k]) => after === undefined || order(k, after) > 0);
  const page = rest.slice(0, input.max);
  const last = page.at(-1);
  return {
    items: page.map(([, item]) => item),
    cursor:
      rest.length > input.max && last
        ? Buffer.from(JSON.stringify({ scope, after: last[0] })).toString("base64url")
        : null,
  };
}
