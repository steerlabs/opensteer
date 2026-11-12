import { resolveBrowserTabOrder, type BrowserTabOrderTab } from "@opensteer/core";
import { browserIdentity, displayAddress, type PlaceBrowserIdentity } from "./start-page-model.js";
import { searchText, type SearchField } from "./search.js";
import {
  type BrowserSessionOpener,
  type ComputerUseSessionSummary,
  type ComputerView,
  type ComputerViewRef,
  computerAppIdentityKey,
  type ComputerAppIdentity,
  type PlaceOccupant,
} from "@opensteer/protocol";
import { BrowserTabStore, type BrowserTabKey } from "./browser-tab-store.js";
import type { BrowserSessionSummary, HostSnapshot } from "./client.js";
import { phoneOwnerView, phonePlaceKey, phoneTabOpen, phoneTaskSession } from "./phone-tab.js";
import type { PersonalSurfaceDestination as SurfaceDestination } from "./surfaces.js";
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

export type PlaceKind = "browser" | "app" | "phone" | "opensteer-app";
export type PlaceIcon =
  | { readonly kind: "opensteer-app" }
  | { readonly kind: "site"; readonly ref: string | null; readonly sessionId: string }
  | { readonly kind: "app"; readonly app: ComputerAppIdentity; readonly machineId: string }
  | { readonly kind: "phone" };
export interface PlaceItem {
  readonly opensteerApp?: {
    readonly appId: string;
    readonly threadId: string;
  };
  readonly personalTab?: BrowserTabOrderTab & {
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
  /** The task session holding this app or phone now. */
  readonly task: Pick<ComputerUseSessionSummary, "runId" | "sessionId"> | null;
  /** The Host keeps this phone's tab, so closing it is `phone.tab.close`, not a view's close. */
  readonly phoneTab?: boolean;
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
  "appTabs",
  "openingAppTabs",
  "browserTabGroups",
  "browserTabs",
  "browserSessions",
  "activatingPersonalTabs",
  "browserProfiles",
  "browserPlacements",
  "machines",
] as const;
export type PlaceListSource = Pick<HostSnapshot, (typeof sourceKeys)[number]> &
  Partial<Pick<HostSnapshot, "tabRestoreVersion">>;
export function samePlaceListSource(a: PlaceListSource, b: PlaceListSource): boolean {
  return sourceKeys.every((key) => a[key] === b[key]);
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
export interface PlaceDescriptor {
  readonly key: string;
  readonly kind: PlaceKind;
  readonly destination: SurfaceDestination;
  readonly device: PlaceItem["device"];
  readonly browser: { readonly sessionId: string } | null;
  readonly personalTab?: BrowserTabOrderTab & { readonly lineageId: string };
}
const noTabs = new BrowserTabStore();
const projections = new WeakMap<BrowserTabStore, PlaceProjection>();
function projection(source: PlaceListSource) {
  const store = source.browserTabs ?? noTabs;
  let held = projections.get(store);
  if (!held) projections.set(store, (held = new PlaceProjection(store)));
  return held;
}
export function placeList(source: PlaceListSource): readonly PlaceItem[] {
  return projection(source).list(source);
}
export type PlaceFilterItem = Pick<PlaceItem, "key" | "identity" | "device" | "occupants">;
export function placeFilterList(source: PlaceListSource): readonly PlaceFilterItem[] {
  return projection(source).filterList(source);
}
export function placeStructure(source: PlaceListSource): readonly PlaceDescriptor[] {
  return projection(source).structure(source);
}
export function placeByKey(source: PlaceListSource, key: string): PlaceItem | undefined {
  return projection(source).place(source, key);
}
function sameDependencies(a: readonly unknown[] | undefined, b: readonly unknown[]) {
  return a?.length === b.length && b.every((value, i) => value === a[i]);
}

/** Structural selectors never depend on a tab's title, loading or occupants. */
export class PlaceProjection {
  readonly #store: BrowserTabStore;
  readonly #rows = new Map<string, { dependencies: readonly unknown[]; item: PlaceItem }>();
  #bindings = new Map<string, BrowserTabKey>();
  #versions: readonly (1 | undefined)[] = [];
  #descriptors = new Map<string, PlaceDescriptor>();
  #structure: readonly PlaceDescriptor[] = [];
  #sessionSource: PlaceListSource["browserSessions"] | undefined;
  #sessions: readonly string[] | undefined;
  #structureDependencies: readonly unknown[] | undefined;
  #nativeDependencies: readonly unknown[] | undefined;
  #native: readonly PlaceItem[] = [];
  #list: readonly PlaceItem[] = [];
  #listDependencies: readonly unknown[] | undefined;
  #filterDependencies: readonly unknown[] | undefined;
  #filterList: readonly PlaceFilterItem[] = [];
  #indices = new Map<string, number>();
  readonly #dirty = new Set<string>();
  constructor(store: BrowserTabStore) {
    this.#store = store;
    store.subscribeTabChanges((groupId, ids) => {
      const sessionId = store.group(groupId)?.sessionId;
      for (const id of ids) {
        const key = `browser:${sessionId}:${id}`;
        if (this.#indices.has(key)) this.#dirty.add(key);
      }
    });
  }
  #nativePlaces(source: PlaceListSource) {
    const dependencies = [source.appTabs, source.machines];
    if (!sameDependencies(this.#nativeDependencies, dependencies)) {
      this.#nativeDependencies = dependencies;
      // A computer reporting in anew rebuilds these; a place that reads the same keeps its identity.
      const held = new Map(this.#native.map((place) => [place.key, place]));
      const next = nativePlaces(source).map((place) => {
        const before = held.get(place.key);
        return before && JSON.stringify(before) === JSON.stringify(place) ? before : place;
      });
      if (!sameDependencies(this.#native, next)) this.#native = next;
    }
    return this.#native;
  }
  structure(source: PlaceListSource): readonly PlaceDescriptor[] {
    if (this.#sessionSource !== source.browserSessions) {
      this.#sessionSource = source.browserSessions;
      const sessions = source.browserSessions?.map((session) => session.id);
      if (!sessions || !sameDependencies(this.#sessions, sessions)) this.#sessions = sessions;
      const versions = source.browserSessions.map((session) => session.tabRestoreVersion);
      if (!sameDependencies(this.#versions, versions)) this.#versions = versions;
    }
    const dependencies = [
      this.#sessions,
      this.#versions,
      this.#store.structure(),
      this.#nativePlaces(source),
      source.browserTabGroups,
      source.browserPlacements,
      source.machines,
    ];
    if (sameDependencies(this.#structureDependencies, dependencies)) return this.#structure;
    this.#structureDependencies = dependencies;
    const descriptors = new Map<string, PlaceDescriptor>();
    const bindings = new Map<string, BrowserTabKey>();
    const durable = new Set(
      source.browserSessions
        .filter((session) => session.tabRestoreVersion === 1)
        .map((session) => session.id),
    );
    const next: PlaceDescriptor[] = [];
    const authorized = this.#sessions ? new Set(this.#sessions) : undefined;
    for (const tab of this.#store.structure()) {
      const group = this.#store.group(tab.groupId)!;
      if (authorized && !authorized.has(group.sessionId)) continue;
      const machineId = group.placement.runnerId;
      const name =
        source.browserPlacements.find((placement) => placement.runnerId === machineId)?.label ??
        source.machines.find((machine) => machine.id === machineId)?.name ??
        "Computer unavailable";
      const key = `browser:${tab.sessionId}:${tab.tabId}`;
      const held = this.#descriptors.get(key);
      const persistent = durable.has(group.sessionId);
      const item: PlaceDescriptor =
        held &&
        this.#bindings.get(key) === tab &&
        !!held.personalTab === persistent &&
        held.device?.machineId === machineId &&
        held.device.name === name
          ? held
          : {
              key,
              kind: "browser",
              destination: { kind: "browser", sessionId: tab.sessionId, tabId: tab.tabId },
              device: { machineId, name },
              browser: { sessionId: tab.sessionId },
              ...(persistent
                ? {
                    personalTab: {
                      id: tab.tabId,
                      order: tab.order,
                      openerId: tab.openerId,
                      createdAt: tab.createdAt,
                      lineageCreatedAt: tab.lineageCreatedAt,
                      lineageId: tab.groupId,
                    },
                  }
                : {}),
            };
      bindings.set(key, tab);
      descriptors.set(key, item);
      next.push(item);
    }
    for (const place of this.#nativePlaces(source)) {
      const held = this.#descriptors.get(place.key);
      const item =
        held?.kind === place.kind &&
        held.destination === place.destination &&
        held.device === place.device
          ? held
          : {
              key: place.key,
              kind: place.kind,
              destination: place.destination,
              device: place.device,
              browser: null,
            };
      descriptors.set(place.key, item);
      next.push(item);
    }
    this.#descriptors = descriptors;
    this.#bindings = bindings;
    const layout = source.browserTabGroups;
    const saved = new Map(
      next.flatMap((place) => (place.personalTab ? [[place.personalTab.id, place] as const] : [])),
    );
    const groupOf = new Map(
      layout?.groups.flatMap((group) => group.tabIds.map((id) => [id, group.id] as const)),
    );
    const ordered = layout?.order
      ? [
          ...resolveBrowserTabOrder(
            layout.order,
            [...saved.values()].map((place) => place.personalTab!),
            groupOf,
          ).map((id) => saved.get(id)!),
          ...next.filter((place) => !place.personalTab),
        ]
      : next;
    if (!sameDependencies(this.#structure, ordered)) this.#structure = ordered;
    for (const key of this.#rows.keys()) if (!descriptors.has(key)) this.#rows.delete(key);
    return this.#structure;
  }
  place(source: PlaceListSource, key: string): PlaceItem | undefined {
    this.structure(source);
    const descriptor = this.#descriptors.get(key);
    if (!descriptor) return undefined;
    const binding = this.#bindings.get(key);
    if (!binding) return this.#nativePlaces(source).find((place) => place.key === key);
    const group = this.#store.group(binding.groupId)!;
    const tab = this.#store.tab(group.id, binding.tabId)!;
    const profile = source.browserProfiles.find((profile) => profile.id === group.profileId);
    const placement = source.browserPlacements.find(
      (placement) => placement.runnerId === group.placement.runnerId,
    );
    const activating = source.activatingPersonalTabs?.includes(tab.id) === true;
    const dependencies = [
      descriptor,
      tab,
      profile,
      group.profileId,
      placement,
      group.opener,
      group.unavailableReason,
      activating,
    ];
    const held = this.#rows.get(key);
    if (sameDependencies(held?.dependencies, dependencies)) return held!.item;
    const identity = browserIdentity(group.profileId, source.browserProfiles);
    const reason = browserPlaceUnavailableReason(
      identity,
      group.unavailableReason ?? undefined,
      placement?.unavailableReason,
    );
    const live = tab.state === "live";
    const { personalTab, ...base } = descriptor;
    const item: PlaceItem = {
      ...base,
      ...(personalTab
        ? {
            personalTab: {
              ...personalTab,
              state: tab.state,
              unavailableReason: group.unavailableReason ?? undefined,
            },
          }
        : {}),
      identity,
      browser: { sessionId: tab.sessionId, opener: group.opener, documentId: tab.documentId },
      task: null,
      ownerView: null,
      ownerClose: null,
      title: tab.title.trim() || tab.site || "New tab",
      site: tab.site,
      icon: { kind: "site", sessionId: tab.sessionId, ref: tab.iconRef },
      occupants: occupants(tab.occupants),
      availability: reason
        ? "unavailable"
        : live
          ? tab.availability
          : placement?.available
            ? "ready"
            : "starting",
      loading: !reason && (activating || tab.state === "restoring" || tab.loading),
      closable: true,
    };
    this.#rows.set(key, { dependencies, item });
    return item;
  }
  list(source: PlaceListSource): readonly PlaceItem[] {
    const structure = this.structure(source);
    const dependencies = [
      structure,
      this.#store.groupRevision,
      source.browserProfiles,
      source.browserPlacements,
      source.activatingPersonalTabs,
    ];
    if (!sameDependencies(this.#listDependencies, dependencies)) {
      this.#listDependencies = dependencies;
      const next = structure.map(({ key }) => this.place(source, key)!);
      this.#indices = new Map(structure.map(({ key }, index) => [key, index]));
      if (!sameDependencies(this.#list, next)) this.#list = next;
    } else if (this.#dirty.size) {
      let next: PlaceItem[] | undefined;
      for (const key of this.#dirty) {
        const index = this.#indices.get(key);
        if (index === undefined) continue;
        const item = this.place(source, key)!;
        if (item === this.#list[index]) continue;
        next ??= [...this.#list];
        next[index] = item;
      }
      if (next) this.#list = next;
    }
    this.#dirty.clear();
    return this.#list;
  }
  filterList(source: PlaceListSource): readonly PlaceFilterItem[] {
    const dependencies = [
      this.structure(source),
      this.#store.filterRevision,
      source.browserProfiles,
      source.browserPlacements,
    ];
    if (!sameDependencies(this.#filterDependencies, dependencies)) {
      this.#filterDependencies = dependencies;
      this.#filterList = this.list(source);
    }
    return this.#filterList;
  }
}
function nativePlaces(source: PlaceListSource): readonly PlaceItem[] {
  const result: { item: PlaceItem; openedAt: string; order: number }[] = [];
  for (const tab of source.appTabs ?? [])
    result.push({
      openedAt: tab.openedAt,
      order: 0,
      item: {
        kind: "opensteer-app",
        key: `opensteer-app:${tab.appId}`,
        title: tab.title,
        destination: { kind: "opensteer-app", appId: tab.appId },
        opensteerApp: { appId: tab.appId, threadId: tab.threadId },
        device: null,
        occupants: [],
        availability: "ready",
        closable: true,
        icon: { kind: "opensteer-app" },
        identity: null,
        browser: null,
        ownerView: null,
        ownerClose: null,
        task: null,
        site: null,
        loading: false,
      },
    });
  const native = new Map<string, { item: PlaceItem; openedAt: string; lastActiveAt: string }>();
  for (const machine of source.machines) {
    for (const session of machine.computerUse?.sessions ?? []) {
      const values: PlaceOccupant[] = session.actor
        ? [{ ...session.actor, holding: true, acting: false, lastActiveAt: session.openedAt }]
        : [];
      for (const app of session.display ? [] : session.apps) {
        const key = computerAppIdentityKey(app);
        const placeKey = `app:${machine.id}:${key}:task:${session.sessionId}`;
        const acting = session.actingAppKeys.includes(key);
        const own = values.map((occupant) => ({
          ...occupant,
          acting,
        }));
        const at = own.reduce(
          (at, value) => (value.lastActiveAt > at ? value.lastActiveAt : at),
          session.openedAt,
        );
        const held = native.get(placeKey);
        const destination: SurfaceDestination = {
          kind: "app",
          appKey: key,
          machineId: machine.id,
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
          kind: "app",
          destination,
          task: { sessionId: session.sessionId, runId: session.runId },
          title: [app.displayName, session.windows?.find((window) => window.appKey === key)?.title]
            .filter(Boolean)
            .join(" — "),
          site: null,
          icon: { kind: "app", app, machineId: machine.id },
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
      if (view.state === "closed" || view.target.kind !== "app") continue;
      const { app } = view.target;
      const key = computerAppIdentityKey(app);
      const windowId = view.window?.id ?? view.target.window;
      const placeKey = `app:${machine.id}:${key}:${windowId ?? view.viewId}`;
      const held = native.get(placeKey);
      const ownerView = { viewId: view.viewId, generation: view.generation };
      const item: PlaceItem = {
        identity: null,
        browser: null,
        ownerView: view,
        ownerClose: { viewId: view.viewId, generation: view.generation },
        key: placeKey,
        kind: "app",
        destination: {
          kind: "app",
          machineId: machine.id,
          appKey: key,
          ...(windowId === undefined ? {} : { windowId }),
          source: { kind: "owner-view", ...ownerView },
        },
        task: null,
        title: [app.displayName, view.window?.title].filter(Boolean).join(" — "),
        site: null,
        icon: { kind: "app", machineId: machine.id, app },
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
  for (const machine of source.machines) {
    if (!phoneTabOpen(machine)) continue;
    const item = phoneTabPlace(machine);
    const session = phoneTaskSession(machine);
    const openedAt =
      machine.tabOpenedAt ?? session?.openedAt ?? phoneOwnerView(machine)?.openedAt ?? "";
    native.set(item.key, { item, openedAt, lastActiveAt: openedAt });
  }
  for (const value of native.values()) result.push({ ...value, order: 0 });
  return result
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.item.key.localeCompare(b.item.key))
    .map(({ item }) => item);
}
/**
 * A phone's one row. It shows the person's own view while that can show
 * anything, else the holding task's, else nothing until the person opens it;
 * each picture keeps its own authority, and neither is inferred from the other.
 */
function phoneTabPlace(machine: PlaceListSource["machines"][number]): PlaceItem {
  const session = phoneTaskSession(machine);
  const view = phoneOwnerView(machine);
  const shownView =
    view && (view.state === "ready" || view.state === "opening" || !session) ? view : null;
  const acting = session?.actingDisplay === true;
  return {
    identity: null,
    browser: null,
    ownerView: shownView,
    // Under a task the tab would only open a live view again; Stop is the way out.
    ownerClose:
      view && !(session && shownView) ? { viewId: view.viewId, generation: view.generation } : null,
    key: phonePlaceKey(machine.id),
    kind: "phone",
    destination: { kind: "phone", machineId: machine.id },
    task: session ? { sessionId: session.sessionId, runId: session.runId } : null,
    phoneTab: Boolean(machine.tabOpenedAt),
    title: machine.name,
    site: null,
    icon: { kind: "phone" },
    device: { machineId: machine.id, name: machine.name },
    occupants: occupants(
      session?.actor
        ? [{ ...session.actor, holding: true, acting, lastActiveAt: session.openedAt }]
        : [],
    ),
    availability:
      machine.status !== "online" || machine.computerUse?.state !== "ready"
        ? "unavailable"
        : shownView?.state === "opening"
          ? "starting"
          : shownView && shownView.state !== "ready"
            ? "unavailable"
            : "ready",
    loading: false,
    closable: !session,
  };
}
/**
 * Whether the exact place a destination names has ended, by its identity and
 * lifecycle alone: a tab its browser no longer lists (a closed or failed
 * browser lists none), a phone whose tab closed, a task's computer session no
 * longer holding that app, the person's view closed or replaced by a newer one. Readiness
 * never decides it — a Mac asking for permission, offline or unreachable, a
 * profile or placement unavailable — and a computer whose computer use is not
 * reported at all proves nothing either way.
 */
export function placeDestinationEnded(
  source: PlaceListSource,
  destination: SurfaceDestination,
): boolean {
  if (destination.kind === "browser") {
    const store = source.browserTabs;
    const groupId = store?.groupForSession(destination.sessionId);
    if (groupId === undefined) return source.tabRestoreVersion !== 1;
    return (
      groupId !== undefined && store!.tabs(groupId).whole && !store!.tab(groupId, destination.tabId)
    );
  }
  if (destination.kind === "opensteer-app") return !isAppTabOpen(source, destination.appId);
  const machine = source.machines.find((item) => item.id === destination.machineId);
  if (!machine) return true;
  if (destination.kind === "phone") return !phoneTabOpen(machine);
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
  return !session.apps.some((app) => computerAppIdentityKey(app) === destination.appKey);
}

export interface BrowserTabCloseImpact {
  readonly heldByLiveWork: boolean;
  readonly discardsFreshSignIns: boolean;
}
/** Confirmation copy only; the Host decides the last-tab outcome at the expected revision. */
export function browserTabCloseImpact(session: BrowserSessionSummary): BrowserTabCloseImpact {
  return {
    heldByLiveWork: session.attachedRunIds.length > 0,
    discardsFreshSignIns:
      session.browserTabs?.sessionList(session.id).whole === true &&
      session.browserTabs.sessionTabs(session.id).length === 1 &&
      session.profileId === null,
  };
}

export function isAppTabOpen(
  source: Pick<HostSnapshot, "appTabs" | "openingAppTabs">,
  appId: string,
): boolean {
  return (
    source.openingAppTabs?.includes(appId) === true ||
    source.appTabs?.some((tab) => tab.appId === appId) === true
  );
}
