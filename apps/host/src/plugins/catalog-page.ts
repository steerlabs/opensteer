import { createHash } from "node:crypto";
import { z } from "zod";
import { CatalogPageInputSchema, PluginServiceError } from "./engine-protocol.js";
const cursorSchema = z.strictObject({
  offset: z.number().int().nonnegative(),
  fingerprint: z.string(),
});
export function catalogPage<T extends { id: string; name: string; package: string }>(
  entries: readonly T[],
  input: z.infer<typeof CatalogPageInputSchema>,
) {
  const search = input.search?.trim().toLowerCase() ?? "";
  const matched = entries.filter((entry) =>
    [entry.id, entry.name, entry.package].some((value) => value.toLowerCase().includes(search)),
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([search, matched]))
    .digest("hex");
  let offset = 0;
  if (input.cursor !== undefined) {
    try {
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
      if (cursor.fingerprint !== fingerprint || cursor.offset > matched.length) throw new Error();
      offset = cursor.offset;
    } catch {
      throw new PluginServiceError(
        "invalid",
        "Catalog changed or cursor is invalid; restart the listing",
      );
    }
  }
  const items = matched.slice(offset, offset + (input.limit ?? 30));
  const next = offset + items.length;
  return {
    items,
    cursor:
      next < matched.length
        ? Buffer.from(JSON.stringify({ offset: next, fingerprint })).toString("base64url")
        : null,
  };
}
