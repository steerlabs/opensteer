import type { UserId } from "@opensteer/core";
import { browserPageSite, type BrowserSessionId } from "@opensteer/protocol";
import type { BrowserService } from "./browser-service.js";

export async function browserRows(
  service: BrowserService,
  ownerId: UserId,
  sessionId?: BrowserSessionId,
) {
  const saved = await service.savedPages(ownerId, sessionId);
  const inventory = sessionId ? service.pageInventory(sessionId) : undefined;
  const records = inventory?.records;
  const tabs = saved.length
    ? saved.map((row, order) => {
        const live = records?.get(row.id);
        return {
          documentId: live?.documentId ?? null,
          loading: live?.loading ?? false,
          navigationFailed: live?.navigationFailed ?? false,
          id: row.id,
          sessionId: row.pageBinding?.sessionId,
          title: row.title,
          site: browserPageSite(row.url ?? ""),
          iconRef: row.iconRef,
          order,
          openerId: row.openerTabId,
          state: live?.state ?? "suspended",
          canGoBack: live?.canGoBack ?? false,
          canGoForward: live?.canGoForward ?? false,
          availability: live ? "ready" : "unavailable",
          occupants: sessionId ? service.tabOccupants(ownerId, sessionId, row.id) : [],
        };
      })
    : [...(records?.values() ?? [])].map((row) => ({
        ...row,
        sessionId,
        site: browserPageSite(row.url),
        iconRef: inventory?.iconRef(row.id) ?? null,
        availability: inventory?.ready ? "ready" : "unavailable",
        occupants: sessionId ? service.tabOccupants(ownerId, sessionId, row.id) : [],
      }));
  return { tabs, inventoryRevision: inventory?.inventoryRevision ?? 0 };
}
