import type { ThreadId, WorkspaceId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RealtimeHub } from "@opensteer/orchestration";
import type { BrowserPresence, BrowserSessionId } from "@opensteer/protocol";
import type { BrowserUsageCredit } from "./browser-service.js";

/** The first wait before presence the store could not address is sent again; it doubles to the most. */
const presenceRetryBaseMs = 1_000;
const presenceRetryMaxMs = 30_000;

/**
 * Sends what changed about one browser — its page, whether an agent is acting
 * in it — to the people who may see that browser, by the rule the browser
 * catalog is read with: a profile's owner, or a fresh session's Workspace
 * members. It reaches every socket they hold, whichever Workspace it follows,
 * because the catalog a client patches is the person's, not a Workspace's.
 *
 * Who may see a session is read for each change, so access lost a moment ago
 * stops the next one. Changes to one session go out in order, and a change
 * that arrives while an earlier one is still being addressed replaces it.
 * When the read fails, the newest presence is kept and tried again after a
 * growing wait, since the Host only sends presence when it changes.
 */
export function browserPresencePublisher(options: {
  readonly onError: (error: unknown) => void;
  readonly realtime: Pick<RealtimeHub, "connectedUserIds" | "sendToUsers">;
  readonly retryBaseMs?: number;
  readonly store: Pick<OpensteerStore, "listBrowserSessionViewers">;
}): (change: { readonly presence: BrowserPresence; readonly workspaceId: WorkspaceId }) => void {
  const retryBaseMs = options.retryBaseMs ?? presenceRetryBaseMs;
  const latest = new Map<BrowserSessionId, BrowserPresence>();
  /** Sessions being sent, or waiting to be retried; a change to one only replaces its latest. */
  const sending = new Set<BrowserSessionId>();
  const retryDelays = new Map<BrowserSessionId, number>();
  const send = async (sessionId: BrowserSessionId): Promise<void> => {
    sending.add(sessionId);
    try {
      for (let presence = latest.get(sessionId); presence; presence = latest.get(sessionId)) {
        latest.delete(sessionId);
        const connected = new Set(options.realtime.connectedUserIds());
        if (connected.size === 0) continue;
        let viewers: Awaited<ReturnType<typeof options.store.listBrowserSessionViewers>>;
        try {
          viewers = await options.store.listBrowserSessionViewers(sessionId);
        } catch (error) {
          if (!latest.has(sessionId)) latest.set(sessionId, presence);
          throw error;
        }
        retryDelays.delete(sessionId);
        if (!viewers) continue;
        const audience = viewers.userIds.filter((userId) => connected.has(userId));
        if (audience.length === 0) continue;
        options.realtime.sendToUsers(audience, {
          sessions: [presence],
          type: "host.browser-presence",
          workspaceId: viewers.workspaceId,
        });
      }
      sending.delete(sessionId);
    } catch (error) {
      options.onError(error);
      const delay = Math.min(retryDelays.get(sessionId) ?? retryBaseMs, presenceRetryMaxMs);
      retryDelays.set(sessionId, delay * 2);
      setTimeout(() => void send(sessionId), delay).unref();
    }
  };
  return ({ presence }) => {
    latest.set(presence.sessionId, presence);
    if (!sending.has(presence.sessionId)) void send(presence.sessionId);
  };
}

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
