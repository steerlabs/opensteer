import type { UserId } from "@opensteer/core";
import { browserPageSite, type BrowserSessionId } from "@opensteer/protocol";
import { browserSnapshotFromRows } from "@opensteer/client/test-support";
import type { BrowserService } from "./browser-service.js";

export async function browserRows(
  service: BrowserService,
  ownerId: UserId,
  sessionId?: BrowserSessionId,
) {
  const source = service.clientStreams.source;
  const projection = await source.acquire(ownerId);
  try {
    const snapshot = browserSnapshotFromRows({
      groups: { rows: [...projection.groups.values()], complete: true },
      tabs: [...projection.tabs].map(([groupId, rows]) => ({
        groupId,
        rows: [...rows.values()],
        complete: true,
      })),
    });
    const groupId =
      sessionId &&
      [...projection.groups.values()].find(
        (group) => group.sessionId === sessionId || group.id === sessionId,
      )?.id;
    const live = sessionId && source.ports.live(sessionId);
    const tabs = groupId
      ? [...(projection.tabs.get(groupId)?.values() ?? [])]
      : live
        ? [...live.records.values()].map((row) => ({
            ...row,
            site: browserPageSite(row.url),
            iconRef: live.iconRef(row.id),
            availability: live.ready ? ("ready" as const) : ("unavailable" as const),
            occupants: service.tabOccupants(ownerId, sessionId!, row.id),
          }))
        : [];
    return {
      ...snapshot,
      inventoryRevision:
        (groupId
          ? projection.groups.get(groupId)?.inventoryRevision
          : live
            ? live.inventoryRevision
            : 0) ?? 0,
      lineage: snapshot.workspaceTabs?.find(
        (group) => group.id === sessionId || group.session.id === sessionId,
      ),
      tabs,
      groups: [...projection.groups.values()],
    };
  } finally {
    source.release(projection);
  }
}
