import {
  HostedBrowserBootstrapSchema,
  HostedBrowserSessionSchema,
  type HostedBrowserBootstrap,
} from "@opensteer/protocol";
import type { BrowserTabCatalog, HostSnapshot, WorkspaceTabLineage } from "../host/client.js";
import {
  BrowserGroupRowSchema,
  BrowserTabRowSchema,
  type BrowserGroupRow,
  type BrowserTabRow,
} from "@opensteer/protocol/browser-tabs";

export type BrowserBootstrapFixture = Omit<
  HostedBrowserBootstrap,
  "groups" | "tabs" | "profiles" | "placements" | "profileGrants"
> & {
  groups?: HostedBrowserBootstrap["groups"];
  tabs?: HostedBrowserBootstrap["tabs"];
  profiles: HostSnapshot["browserProfiles"];
  placements: HostSnapshot["browserPlacements"];
  profileGrants: HostSnapshot["browserProfileGrants"];
  sessions?: Array<WorkspaceTabLineage["session"]>;
  workspaceTabs?: WorkspaceTabLineage[];
};

export function browserSessionFixture<T extends object>(input: T) {
  return {
    ...HostedBrowserSessionSchema.parse(input),
    ...("tabCatalog" in input ? { tabCatalog: input.tabCatalog as BrowserTabCatalog } : {}),
  };
}

export function browserBootstrapWithRows(
  browser: BrowserBootstrapFixture | HostedBrowserBootstrap,
): HostedBrowserBootstrap {
  const { sessions = [], workspaceTabs = [], ...wire } = browser as BrowserBootstrapFixture;
  if (browser.groups && browser.tabs)
    return HostedBrowserBootstrapSchema.parse({
      ...wire,
      groups: browser.groups,
      tabs: browser.tabs,
    });
  const groups = new Map<string, BrowserGroupRow>();
  const tabs = new Map<
    string,
    { groupId: BrowserGroupRow["id"]; rows: BrowserTabRow[]; complete: boolean }
  >();
  const bySession = new Map(sessions.map((session) => [session.id, session]));
  for (const lineage of workspaceTabs) bySession.set(lineage.session.id, lineage.session);
  for (const session of bySession.values()) {
    const lineage = workspaceTabs.find((group) => group.session.id === session.id);
    const id = lineage?.id ?? session.id;
    const catalog = session.tabCatalog;
    const live = new Map(catalog?.tabs.map((tab) => [tab.id, tab]));
    const rows: BrowserTabRow[] = (lineage?.tabs ?? catalog?.tabs ?? []).map((tab) => {
      const record = live.get(tab.id);
      return BrowserTabRowSchema.parse({
        id: tab.id,
        title: tab.title,
        site: tab.site,
        order: tab.order,
        openerId: tab.openerId,
        sessionId: session.id,
        createdAt:
          ("createdAt" in tab ? tab.createdAt : undefined) ??
          lineage?.createdAt ??
          session.createdAt,
        state: "state" in tab ? tab.state : "live",
        iconRef: record?.iconRef ?? tab.iconRef ?? null,
        availability: record?.availability ?? "unavailable",
        loading: record?.loading ?? false,
        navigationFailed: record?.navigationFailed ?? false,
        documentId: record ? (record.documentId ?? `document-${tab.id}`) : null,
        canGoBack: record?.canGoBack ?? false,
        canGoForward: record?.canGoForward ?? false,
        occupants: record?.occupants ?? [],
      });
    });
    groups.set(
      id,
      BrowserGroupRowSchema.parse({
        id,
        createdAt: lineage?.createdAt ?? session.createdAt,
        unavailableReason: lineage?.unavailableReason ?? null,
        tabCount: rows.length,
        inventoryRevision: catalog?.inventoryRevision ?? catalog?.revision ?? 0,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        state: session.state,
        origin: session.origin,
        access: session.access,
        placement: session.placement,
        profileId: session.profileId,
        runtimeId: session.runtimeId,
        opener: session.opener ?? { kind: "unknown" },
        navigation: session.navigationVersion === 1,
        sessionCreatedAt: session.createdAt,
        updatedAt: session.updatedAt,
        acting: session.acting ?? false,
        page: session.page ?? null,
        attachedRunIds: session.attachedRunIds ?? [],
        threadIds: session.threadIds ?? [],
      }),
    );
    tabs.set(id, { groupId: id, rows, complete: lineage ? !!lineage.tabs : !!catalog });
  }
  return HostedBrowserBootstrapSchema.parse({
    ...wire,
    groups: { rows: [...groups.values()], complete: true },
    tabs: [...tabs.values()],
  });
}
