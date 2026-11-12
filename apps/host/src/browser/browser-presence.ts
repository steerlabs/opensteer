import type { ThreadId } from "@opensteer/core";
import type { BrowserUsageCredit } from "./browser-service.js";

export function announceBrowserUsage(
  realtime: { publishBrowserUsageChanged(threadIds: readonly ThreadId[]): void },
  credits: readonly BrowserUsageCredit[],
): void {
  if (credits.length)
    realtime.publishBrowserUsageChanged([...new Set(credits.map((credit) => credit.threadId))]);
}
