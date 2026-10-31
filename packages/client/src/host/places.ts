import { resolveBrowserTabOrder, type BrowserTabOrderTab } from "@opensteer/core";
import { browserIdentity, displayAddress, type PlaceBrowserIdentity } from "./start-page-model.js";
import { searchText, type SearchField } from "./search.js";
import {
  type BrowserSessionOpener,
  type ComputerView,
  type ComputerViewRef,
  computerAppIdentityKey,
  type BrowserTabCatalog,
  type ComputerAppIdentity,
  type PlaceOccupant,
} from "@opensteer/protocol";
import type { BrowserSessionSummary, HostSnapshot } from "./client.js";
import type { WorkspaceSurfaceDestination as SurfaceDestination } from "./surfaces.js";
export type { PlaceOccupant } from "@opensteer/protocol";

export function browserPlaceUnavailableReason(
  identity: PlaceBrowserIdentity | null,
  rowReason: string | undefined,
  placementReason: string | undefined,
): string | null {
  return identity?.kind === "profile" && !identity.available
    ? "This browser profile is no longer available."
    : (rowReason ?? placementReason ?? null);
}

export type PlaceKind = "browser" | "app" | "phone";
export type PlaceIcon =
  | { readonly kind: "site"; readonly ref: string | null; readonly sessionId: string }
  | { readonly kind: "app"; readonly app: ComputerAppIdentity; readonly machineId: string }
  | { readonly kind: "phone" };
export interface PlaceItem {
  readonly workspaceTab?: BrowserTabOrderTab & {
    readonly lineageId: string;
    readonly unavailableReason?: string | undefined;
    readonly state: "suspended" | "restoring" | "live";
  };
  readonly identity: PlaceBrowserIdentity | null;
  readonly browser: {
    readonly sessionId: string;
    readonly opener: BrowserSessionOpener;
    /** The document the tab shows now, new with each page it loads; null without a live tab. */
    readonly documentId: string | null;
  } | null;
  readonly ownerView: ComputerView | null;
  readonly ownerClose: ComputerViewRef | null;
  readonly key: string;
  readonly destination: SurfaceDestination;
  /**
   * Where a task's own picture of this place is live now: its tab, or its
   * task session on the app or phone. Owner views have independent rows.
   * Null while no task binding here can be shown.
   */
  readonly taskDestination: SurfaceDestination | null;
  readonly kind: PlaceKind;
  readonly title: string;
  readonly site: string | null;
  readonly icon: PlaceIcon;
  readonly device: { readonly machineId: string; readonly name: string } | null;
  readonly occupants: readonly PlaceOccupant[];
  readonly availability: "ready" | "starting" | "unavailable";
  /** A browser restoring or loading its page; never for a Mac app or phone. */
  readonly loading: boolean;
  readonly closable: boolean;
}
/**
 * A task or Chat is in the place: it holds it, or worked there moments ago.
 * These are the places that wear task marks, and what "Tabs with agents" shows.
 */
export function placeHasAgents(place: Pick<PlaceItem, "occupants">): boolean {
  return place.occupants.length > 0;
}
/**
 * What a tab, app or phone is found by: its title most (part of a word will
 * do), then its site, its group, who it browses as and the computer it is on.
 */
export function placeSearchFields(place: PlaceItem, groupTitle: string | null): SearchField[] {
  return [
    { text: searchText(place.title), weight: 1, inside: true, name: "title" },
    { text: searchText(place.site ? displayAddress(place.site) : ""), weight: 0.8, name: "site" },
    { text: searchText(groupTitle ?? ""), weight: 0.6, name: "group" },
    { text: searchText(place.identity?.name ?? ""), weight: 0.5, name: "profile" },
    { text: searchText(place.device?.name ?? ""), weight: 0.5, name: "computer" },
  ];
}
const sourceKeys = [
  "browserTabGroups",
  "workspaceTabs",
  "workspaceTabRestoreVersion",
  "activatingWorkspaceTabs",
  "browserSessions",
  "browserProfiles",
  "browserPlacements",
  "machines",
] as const;
export type PlaceListSource = Pick<HostSnapshot, (typeof sourceKeys)[number]>;
export function samePlaceListSource(a: PlaceListSource, b: PlaceListSource): boolean {
  return sourceKeys.every((key) => a[key] === b[key]);
}
export function newerBrowserTabCatalog(
  previous: BrowserTabCatalog | undefined,
  next: BrowserTabCatalog | undefined,
): BrowserTabCatalog | undefined {
  if (!next) return previous;
  if (
    !previous ||
    next.generation > previous.generation ||
    (next.generation === previous.generation && next.revision > previous.revision)
  )
    return next;
  return previous;
}
function occupants(values: readonly PlaceOccupant[]): PlaceOccupant[] {
  values = values.filter((value) => value.holding || value.acting);
  const unique = new Map<string, PlaceOccupant>();
  for (const value of values) {
    const held = unique.get(value.threadId);
    if (!held || value.lastActiveAt > held.lastActiveAt) unique.set(value.threadId, value);
  }
  return [...unique.values()].sort(
    (a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || a.threadId.localeCompare(b.threadId),
  );
}
/** Uses only the reader-authorized catalog, never historical lineage or viewer selection. */
export function placeList(source: PlaceListSource): readonly PlaceItem[] {
  const result: { item: PlaceItem; openedAt: string; order: number }[] = [];
  for (const group of source.workspaceTabs ?? []) {
    const session = source.browserSessions.find((session) => session.id === group.session.id);
    const identity = browserIdentity(group.session.profileId, source.browserProfiles);
    const placement = source.browserPlacements.find(
      (placement) => placement.runnerId === group.session.placement.runnerId,
    );
    const machine = source.machines.find(
      (machine) => machine.id === group.session.placement.runnerId,
    );
    const lastingReason = browserPlaceUnavailableReason(
      identity,
      group.unavailableReason,
      placement?.unavailableReason,
    );
    const rows = group.tabs ?? [];
    const inserted = new Set<string>();
    const append = (row: (typeof rows)[number]) => {
      if (inserted.has(row.id)) return;
      inserted.add(row.id);
      const live =
        session?.state === "ready" && row.sessionId === session.id
          ? session.tabCatalog?.tabs.find((tab) => tab.id === row.id)
          : undefined;
      const destination: SurfaceDestination = {
        kind: "browser",
        sessionId: row.sessionId,
        tabId: row.id,
      };
      const availability: PlaceItem["availability"] = lastingReason
        ? "unavailable"
        : live
          ? live.availability
          : placement?.available
            ? "ready"
            : "starting";
      result.push({
        openedAt: group.createdAt,
        order: result.length,
        item: {
          workspaceTab: {
            id: row.id,
            openerId: row.openerId,
            createdAt: row.createdAt ?? group.createdAt,
            lineageCreatedAt: group.createdAt,
            order: row.order,
            lineageId: group.id,
            unavailableReason: group.unavailableReason,
            state: live ? "live" : row.state === "live" ? "suspended" : row.state,
          },
          key: `browser:${row.sessionId}:${row.id}`,
          destination,
          taskDestination: live ? destination : null,
          kind: "browser",
          identity,
          browser: {
            sessionId: row.sessionId,
            opener: group.session.opener ?? { kind: "unknown" },
            documentId: live?.documentId ?? null,
          },
          ownerView: null,
          ownerClose: null,
          title: (live?.title ?? row.title).trim() || row.site || "New tab",
          site: live?.site ?? row.site,
          icon: {
            kind: "site",
            sessionId: row.sessionId,
            ref: live ? live.iconRef : (row.iconRef ?? null),
          },
          device: {
            machineId: group.session.placement.runnerId,
            name: placement?.label ?? machine?.name ?? "Computer unavailable",
          },
          occupants: occupants(live?.occupants ?? []),
          availability,
          loading:
            !lastingReason &&
            (source.activatingWorkspaceTabs?.includes(row.id) === true ||
              row.state === "restoring" ||
              (session?.tabs.find((tab) => tab.id === row.id)?.loading ?? live?.loading) === true),
          closable: true,
        },
      });
      for (const child of rows) if (child.openerId === row.id) append(child);
    };
    for (const row of rows)
      if (!row.openerId || !rows.some((parent) => parent.id === row.openerId)) append(row);
    for (const row of rows) append(row);
  }
  for (const session of source.browserSessions) {
    if (
      source.workspaceTabRestoreVersion === 1 &&
      (session.workspaceTabRestoreVersion === 1 ||
        source.workspaceTabs?.some((group) => group.session.id === session.id))
    )
      continue;
    const identity = browserIdentity(session.profileId, source.browserProfiles);
    const placement = source.browserPlacements.find(
      (placement) => placement.runnerId === session.placement.runnerId,
    );
    const machine = source.machines.find((machine) => machine.id === session.placement.runnerId);
    const tabs = session.tabCatalog?.tabs ?? [];
    const ordered = [...tabs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const inserted = new Set<string>();
    const append = (tab: (typeof tabs)[number]) => {
      if (inserted.has(tab.id)) return;
      inserted.add(tab.id);
      const destination: SurfaceDestination = {
        kind: "browser",
        sessionId: session.id,
        tabId: tab.id,
      };
      const availability: PlaceItem["availability"] =
        (identity.kind === "profile" && !identity.available) ||
        placement?.available === false ||
        session.state === "closed" ||
        session.state === "failed" ||
        session.state === "closing"
          ? "unavailable"
          : session.state === "starting"
            ? "starting"
            : tab.availability;
      result.push({
        openedAt: session.createdAt ?? "",
        order: result.length,
        item: {
          key: `browser:${session.id}:${tab.id}`,
          destination,
          taskDestination: availability === "ready" ? destination : null,
          kind: "browser",
          title: tab.title.trim() || tab.site || "New tab",
          site: tab.site || null,
          icon: { kind: "site", sessionId: session.id, ref: tab.iconRef },
          identity,
          browser: {
            sessionId: session.id,
            opener: session.opener ?? { kind: "unknown" },
            documentId: tab.documentId ?? null,
          },
          ownerView: null,
          ownerClose: null,
          device: {
            machineId: session.placement.runnerId,
            name: placement?.label ?? machine?.name ?? "Computer unavailable",
          },
          occupants: occupants(tab.occupants),
          availability,
          loading:
            !browserPlaceUnavailableReason(identity, undefined, placement?.unavailableReason) &&
            (session.tabs.find((value) => value.id === tab.id)?.loading ?? tab.loading) === true,
          closable: true,
        },
      });
      for (const child of ordered) if (child.openerId === tab.id) append(child);
    };
    for (const tab of ordered)
      if (!tab.openerId || !tabs.some(({ id }) => id === tab.openerId)) append(tab);
    for (const tab of ordered) append(tab);
  }
  const native = new Map<string, { item: PlaceItem; openedAt: string; lastActiveAt: string }>();
  for (const machine of source.machines) {
    for (const session of machine.computerUse?.sessions ?? []) {
      const values: PlaceOccupant[] = session.actor
        ? [{ ...session.actor, holding: true, acting: false, lastActiveAt: session.openedAt }]
        : [];
      const bindings = session.display
        ? [{ key: "main", app: null }]
        : session.apps.map((app) => ({ key: computerAppIdentityKey(app), app }));
      for (const { key, app } of bindings) {
        const kind = app ? "app" : "phone";
        const placeKey = `${kind}:${machine.id}:${key}:task:${session.sessionId}`;
        const acting = app ? session.actingAppKeys.includes(key) : session.actingDisplay === true;
        const own = values.map((occupant) => ({
          ...occupant,
          acting,
        }));
        const at = own.reduce(
          (at, value) => (value.lastActiveAt > at ? value.lastActiveAt : at),
          session.openedAt,
        );
        const held = native.get(placeKey);
        const destination: SurfaceDestination = app
          ? {
              kind: "app",
              appKey: key,
              machineId: machine.id,
              computerSessionId: session.sessionId,
              source: { kind: "task-session", sessionId: session.sessionId },
            }
          : {
              kind: "phone",
              machineId: machine.id,
              display: key,
              computerSessionId: session.sessionId,
              source: { kind: "task-session", sessionId: session.sessionId },
            };
        const availability: PlaceItem["availability"] =
          machine.status === "online" && machine.computerUse?.state === "ready"
            ? "ready"
            : "unavailable";
        const item: PlaceItem = {
          identity: null,
          browser: null,
          ownerView: null,
          ownerClose: null,
          key: placeKey,
          kind,
          destination,
          taskDestination: availability === "ready" ? destination : null,
          title: app
            ? [app.displayName, session.windows?.find((window) => window.appKey === key)?.title]
                .filter(Boolean)
                .join(" — ")
            : machine.name,
          site: null,
          icon: app ? { kind: "app", app, machineId: machine.id } : { kind: "phone" },
          device: { machineId: machine.id, name: machine.name },
          occupants: occupants([...(held?.item.occupants ?? []), ...own]),
          availability,
          loading: false,
          closable: false,
        };
        native.set(placeKey, {
          item: held && held.lastActiveAt > at ? { ...held.item, occupants: item.occupants } : item,
          openedAt: held && held.openedAt < session.openedAt ? held.openedAt : session.openedAt,
          lastActiveAt: held && held.lastActiveAt > at ? held.lastActiveAt : at,
        });
      }
    }
  }
  for (const machine of source.machines) {
    for (const view of machine.computerUse?.ownerViews ?? []) {
      if (view.state === "closed") continue;
      const app = view.target.kind === "app" ? view.target.app : null;
      const key = app
        ? computerAppIdentityKey(app)
        : view.target.kind === "phone"
          ? view.target.display
          : "main";
      const kind = app ? "app" : "phone";
      const windowId =
        view.window?.id ?? (view.target.kind === "app" ? view.target.window : undefined);
      const placeKey = `${kind}:${machine.id}:${key}:${app ? (windowId ?? view.viewId) : `owner:${view.viewId}`}`;
      const held = native.get(placeKey);
      const ownerView = { viewId: view.viewId, generation: view.generation };
      const item: PlaceItem = {
        identity: null,
        browser: null,
        ownerView: view,
        ownerClose: { viewId: view.viewId, generation: view.generation },
        key: placeKey,
        kind,
        destination: app
          ? {
              kind: "app",
              machineId: machine.id,
              appKey: key,
              ...(windowId === undefined ? {} : { windowId }),
              source: { kind: "owner-view", ...ownerView },
            }
          : {
              kind: "phone",
              machineId: machine.id,
              display: key,
              source: { kind: "owner-view", ...ownerView },
            },
        taskDestination: null,
        title: app
          ? [app.displayName, view.window?.title].filter(Boolean).join(" — ")
          : machine.name,
        site: null,
        icon: app ? { kind: "app", machineId: machine.id, app } : { kind: "phone" },
        device: { machineId: machine.id, name: machine.name },
        occupants: [],
        availability:
          machine.status === "online" &&
          machine.computerUse?.state === "ready" &&
          view.state === "ready"
            ? "ready"
            : view.state === "opening"
              ? "starting"
              : "unavailable",
        loading: false,
        closable: true,
      };
      native.set(placeKey, {
        item,
        openedAt: held?.openedAt ?? view.openedAt,
        lastActiveAt: held?.lastActiveAt ?? view.openedAt,
      });
    }
  }
  for (const value of native.values()) result.push({ ...value, order: 0 });
  const sorted = result
    .sort(
      (a, b) =>
        Number(a.item.kind !== "browser") - Number(b.item.kind !== "browser") ||
        ((source.workspaceTabs?.length ?? 0) > 0 && a.item.kind === "browser"
          ? b.openedAt.localeCompare(a.openedAt)
          : a.openedAt.localeCompare(b.openedAt)) ||
        a.order - b.order ||
        a.item.key.localeCompare(b.item.key),
    )
    .map(({ item }) => item);
  // A Host that keeps each person's order has the last word on the saved tabs;
  // live tabs no browser saves follow them, then the Mac apps and phones.
  const layout = source.browserTabGroups;
  if (layout?.order === undefined) return sorted;
  const saved = new Map(
    sorted.flatMap((item) => (item.workspaceTab ? [[item.workspaceTab.id, item] as const] : [])),
  );
  const groupOf = new Map(
    layout.groups.flatMap((group) => group.tabIds.map((id) => [id, group.id] as const)),
  );
  return [
    ...resolveBrowserTabOrder(
      layout.order,
      [...saved.values()].map((item) => item.workspaceTab!),
      groupOf,
    ).map((id) => saved.get(id)!),
    ...sorted.filter((item) => !item.workspaceTab),
  ];
}
/**
 * Whether the exact place a destination names has ended, by its identity and
 * lifecycle alone: a tab its browser no longer lists (a closed or failed
 * browser lists none), a task's computer session no longer holding that app
 * or display, the person's view closed or replaced by a newer one. Readiness
 * never decides it — a Mac asking for permission, offline or unreachable, a
 * profile or placement unavailable — and a computer whose computer use is not
 * reported at all proves nothing either way.
 */
export function placeDestinationEnded(
  source: PlaceListSource,
  destination: SurfaceDestination,
): boolean {
  if (destination.kind === "browser") {
    const session = source.browserSessions.find((item) => item.id === destination.sessionId);
    if (source.workspaceTabRestoreVersion === 1) {
      const group = source.workspaceTabs?.find(
        (group) =>
          group.id === destination.sessionId ||
          group.session.id === destination.sessionId ||
          group.tabs?.some((tab) => tab.id === destination.tabId),
      );
      if (group) return !!group.tabs && !group.tabs.some((tab) => tab.id === destination.tabId);
      // A bounded catalog cannot prove that an unlisted durable group ended.
      if (
        !session ||
        session.workspaceTabRestoreVersion === 1 ||
        session.state === "closed" ||
        session.state === "failed"
      )
        return false;
    }
    return !session?.tabCatalog?.tabs.some((tab) => tab.id === destination.tabId);
  }
  const machine = source.machines.find((item) => item.id === destination.machineId);
  if (!machine) return true;
  const computerUse = machine.computerUse;
  if (!computerUse) return false;
  if (destination.source?.kind === "owner-view") {
    const { generation, viewId } = destination.source;
    const view = computerUse.ownerViews?.find((item) => item.viewId === viewId);
    return !view || view.generation !== generation || view.state === "closed";
  }
  const session = computerUse.sessions.find(
    (item) => item.sessionId === destination.computerSessionId,
  );
  if (!session) return true;
  return destination.kind === "phone"
    ? !session.display
    : !session.apps.some((app) => computerAppIdentityKey(app) === destination.appKey);
}

/** A Thread's newest place, as the Host last named it. */
export interface ThreadPlace {
  readonly placeKey: string;
  /** The Run that acted there; null when the Host did not say. */
  readonly runId: string | null;
  /** Where its picture is live now; null once the place ended or cannot be shown. */
  readonly destination: SurfaceDestination | null;
  readonly title: string;
  readonly site: string | null;
}

/**
 * A Run's place while its picture is live: the Thread's newest place when that
 * Run is the one that acted there and the place has not ended. Never an older
 * place, and never another Run's.
 */
export function runPlace(latest: ThreadPlace | null, runId: string | null): ThreadPlace | null {
  return runId !== null && latest?.runId === runId && latest.destination !== null ? latest : null;
}

export interface BrowserTabCloseImpact {
  readonly heldByLiveWork: boolean;
  readonly discardsFreshSignIns: boolean;
}
/** Confirmation copy only; the Host decides the last-tab outcome at the expected revision. */
export function browserTabCloseImpact(session: BrowserSessionSummary): BrowserTabCloseImpact {
  return {
    heldByLiveWork: session.attachedRunIds.length > 0,
    discardsFreshSignIns: session.tabCatalog?.tabs.length === 1 && session.profileId === null,
  };
}
