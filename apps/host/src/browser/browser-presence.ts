import type { ThreadId, WorkspaceId } from "@opensteer/core";
import type { RealtimeHub } from "@opensteer/orchestration";
import type { BrowserUsageCredit } from "./browser-service.js";

/** Tells each credited conversation's Workspace that its visible browser usage changed. */
export function announceBrowserUsage(
  realtime: Pick<RealtimeHub, "publishBrowserUsageChanged">,
  credits: readonly BrowserUsageCredit[],
): void {
  const byWorkspace = new Map<WorkspaceId, ThreadId[]>();
  for (const credit of credits) {
    byWorkspace.set(credit.workspaceId, [
      ...(byWorkspace.get(credit.workspaceId) ?? []),
      credit.threadId,
    ]);
  }
  for (const [workspaceId, threadIds] of byWorkspace) {
    realtime.publishBrowserUsageChanged(workspaceId, threadIds);
  }
}
