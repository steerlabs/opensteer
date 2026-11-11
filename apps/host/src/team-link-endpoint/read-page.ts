import type { TeamReadResultSchema } from "@opensteer/protocol";
import type { z } from "zod";
import { linkError, teamLinkMaxFrameBytes } from "./contracts.js";

export function boundTeamReadPage(value: z.infer<typeof TeamReadResultSchema>) {
  const result = { ...value, page: { ...value.page, messages: [...value.page.messages] } };
  while (Buffer.byteLength(JSON.stringify(result)) > teamLinkMaxFrameBytes - 8192) {
    if (result.page.messages.length <= 1) throw linkError("resource_exhausted");
    // Newest/before pages retain the messages nearest their cursor; throughSeq is the snapshot fence.
    const oldest = result.page.messages.reduce((a, b) => (BigInt(a.id) < BigInt(b.id) ? a : b));
    result.page.messages.splice(result.page.messages.indexOf(oldest), 1);
    result.page.hasMore = true;
  }
  return result;
}
