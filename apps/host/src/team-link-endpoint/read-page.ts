import type { TeamReadResultSchema } from "@opensteer/protocol";
import type { z } from "zod";
import { linkError, teamLinkMaxFrameBytes } from "./contracts.js";

export function boundTeamReadPage(
  value: z.infer<typeof TeamReadResultSchema>,
  direction: "after" | "before" | "newest",
) {
  const result = { ...value, page: { ...value.page, messages: [...value.page.messages] } };
  while (Buffer.byteLength(JSON.stringify(result)) > teamLinkMaxFrameBytes - 8192) {
    if (result.page.messages.length <= 1) throw linkError("resource_exhausted");
    // Retain messages nearest the cursor; throughSeq remains the snapshot fence.
    const farthest = result.page.messages.reduce((a, b) =>
      (direction === "after" ? BigInt(a.id) > BigInt(b.id) : BigInt(a.id) < BigInt(b.id)) ? a : b,
    );
    result.page.messages.splice(result.page.messages.indexOf(farthest), 1);
    result.page.hasMore = true;
  }
  return result;
}
