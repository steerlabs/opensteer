import { parseNavigationInput, webSearchUrl, type NavigationInput } from "./navigation-input.js";
import {
  computerAppIdentityKey,
  type ApprovedComputerApp,
  type BrowserPlacementSelector,
} from "@opensteer/protocol";
import {
  computerNotReadyStatus,
  newOwnerViewReadiness,
  type ComputerNotReady,
} from "../integrations/computer-reasons.js";
import type { HostSnapshot } from "./client.js";
import type { BrowsingHistoryEntry } from "./recent-sites.js";
import { placeList, placeSearchFields, type PlaceItem } from "./places.js";
import { browserTabStrip } from "./browser-tab-strip.js";
import { matchSearch, rankSearch, searchQuery, searchText, type SearchField } from "./search.js";
import type { WorkspaceSurfaceDestination as SurfaceDestination } from "./surfaces.js";

export type BrowserIdentityChoice =
  { readonly kind: "profile"; readonly profileId: string } | { readonly kind: "guest" };
const tints = ["#6e77c7", "#b66b88", "#408f83", "#b57c3a", "#8868ae", "#447eab"] as const;
export function profileTint(profileId: string): string {
  let hash = 2166136261;
  for (const char of profileId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return tints[(hash >>> 0) % tints.length]!;
}
export type PlaceBrowserIdentity =
  | { readonly kind: "guest"; readonly name: "Guest" }
  | {
      readonly kind: "profile";
      readonly profileId: string;
      readonly name: string;
      readonly initial: string;
      readonly tint: string;
      readonly available: boolean;
    };
export function browserIdentity(
  profileId: string | null,
  profiles: HostSnapshot["browserProfiles"],
): PlaceBrowserIdentity {
  if (profileId === null) return { kind: "guest", name: "Guest" };
  const profile = profiles.find((profile) => profile.id === profileId);
  const name = profile?.name ?? "Profile unavailable";
  return {
    kind: "profile",
    profileId,
    name,
    initial: Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?",
    tint: profileTint(profileId),
    available: !!profile,
  };
}
export type StartPageInput = NavigationInput;
export const detectStartPageInput = parseNavigationInput;
export function profileBadgesVisible(places: readonly Pick<PlaceItem, "identity">[]): boolean {
  return (
    new Set(
      places.flatMap((place) =>
        place.identity
          ? [place.identity.kind === "profile" ? place.identity.profileId : "guest"]
          : [],
      ),
    ).size >= 2
  );
}
export type StartPageAction =
  | {
      readonly kind: "switch-to-place";
      readonly destination: SurfaceDestination;
      readonly placeKey: string;
    }
  | {
      readonly kind: "open-url";
      readonly target: { readonly identity: BrowserIdentityChoice };
      readonly url: string;
      readonly placement?: BrowserPlacementSelector;
    }
  | {
      readonly kind: "search-web";
      readonly target: { readonly identity: BrowserIdentityChoice };
      readonly query: string;
      readonly placement?: BrowserPlacementSelector;
    }
  | {
      readonly kind: "open-computer-view";
      readonly machineId: ApprovedComputerApp["machineId"];
      readonly target: ApprovedComputerApp["target"];
    };
export interface StartPageResult {
  readonly key: string;
  /** What the row is, which decides its mark: a site, an open tab, an app, a phone, a recent site, the search. */
  readonly kind: "address" | "tab" | "app" | "phone" | "recent" | "search";
  readonly title: string;
  readonly fillText?: string;
  readonly historyUrl?: string;
  readonly favicon?: string;
  /** Muted words after the title: the app's computer, or a recent site's nothing. */
  readonly detail: string | null;
  readonly label: string;
  readonly available: boolean;
  readonly action: StartPageAction;
  /** The open tab or view a "Switch to" row names. */
  readonly place?: PlaceItem;
  /** The approved app or phone an "Open" row names. */
  readonly app?: ApprovedComputerApp;
  /** Why that app or phone can't be opened now: its row says so in place of what Enter does. */
  readonly notReady?: ComputerNotReady;
}
export interface StartPageGroup {
  readonly machineId: string;
  readonly label: string;
  readonly kind: "apps" | "phone";
  readonly local: boolean;
  /**
   * Why the computer can't show these apps, or the phone itself, now — the
   * answer their views give — or null when it can. Groups that can come first.
   */
  readonly readiness: ComputerNotReady | null;
  readonly items: readonly ApprovedComputerApp[];
}
export interface StartPageProfileChoice {
  readonly identity: BrowserIdentityChoice;
  readonly presentation: PlaceBrowserIdentity;
  readonly placement: { readonly kind: "runner"; readonly runnerId: string } | null;
  readonly computerLabel: string;
  readonly available: boolean;
  /** A ready browser this person opened with this identity: opening adds a tab to it. */
  readonly yours: boolean;
}
export interface StartPageModel {
  readonly choice: BrowserIdentityChoice;
  readonly profiles: readonly StartPageProfileChoice[];
  readonly groups: readonly StartPageGroup[];
  readonly results: readonly StartPageResult[];
}
export interface StartPageModelInput {
  readonly snapshot: HostSnapshot;
  readonly query: string;
  readonly sourcePlace?: PlaceItem | null;
  readonly lastChoice?: BrowserIdentityChoice | null;
  readonly localMachineId?: string | null;
  readonly approvedApps?: readonly ApprovedComputerApp[];
  readonly history?: readonly BrowsingHistoryEntry[];
}
/** Includes the default action. */
export const startPageResultLimit = 8;

/**
 * The default identity, frozen by the caller at entry: the source tab's identity
 * (an agent's Guest has none to give), then the person's last explicit choice,
 * then Guest.
 */
export function startPageChoice(input: {
  readonly sourcePlace?: PlaceItem | null;
  readonly lastChoice?: BrowserIdentityChoice | null;
}): BrowserIdentityChoice {
  const source = input.sourcePlace?.identity;
  return source?.kind === "profile"
    ? { kind: "profile", profileId: source.profileId }
    : source?.kind === "guest" && input.sourcePlace?.browser?.opener.kind === "you"
      ? { kind: "guest" }
      : (input.lastChoice ?? { kind: "guest" });
}

interface IndexedPlace {
  readonly fillText: string;
  readonly place: PlaceItem;
  readonly fields: readonly SearchField[];
}
interface IndexedApp {
  readonly app: ApprovedComputerApp;
  readonly group: StartPageGroup;
  readonly placeKey: string;
  readonly fields: readonly SearchField[];
  readonly available: boolean;
}
/**
 * Everything typing searches, joined once per catalog, profile, placement or
 * approval change: a keystroke only filters it.
 */
export interface StartPageIndex {
  readonly profiles: readonly StartPageProfileChoice[];
  readonly groups: readonly StartPageGroup[];
  readonly places: readonly IndexedPlace[];
  readonly apps: readonly IndexedApp[];
  readonly connected: boolean;
}
export function startPageIndex(input: {
  readonly snapshot: HostSnapshot;
  readonly places?: readonly PlaceItem[];
  readonly approvedApps?: readonly ApprovedComputerApp[];
  readonly localMachineId?: string | null;
  /** The current choice, listed even when its profile has gone, so it is refused, not swapped. */
  readonly choice?: BrowserIdentityChoice;
}): StartPageIndex {
  const { snapshot } = input;
  const connected = snapshot.connection === "connected";
  const identities: BrowserIdentityChoice[] = [
    ...snapshot.browserProfiles.map((profile) => ({
      kind: "profile" as const,
      profileId: profile.id,
    })),
    { kind: "guest" },
  ];
  const choice = input.choice;
  if (
    choice?.kind === "profile" &&
    !snapshot.browserProfiles.some((profile) => profile.id === choice.profileId)
  )
    identities.unshift(choice);
  const profiles = identities.map((identity): StartPageProfileChoice => {
    const presentation = browserIdentity(
      identity.kind === "profile" ? identity.profileId : null,
      snapshot.browserProfiles,
    );
    const holder =
      identity.kind === "profile"
        ? snapshot.browserSessions.find(
            (session) =>
              session.profileId === identity.profileId &&
              ["ready", "starting", "closing"].includes(session.state),
          )
        : undefined;
    const placement = holder
      ? snapshot.browserPlacements.find(
          (placement) => placement.runnerId === holder.placement.runnerId,
        )
      : snapshot.browserPlacements.filter((placement) => placement.available).length === 1
        ? snapshot.browserPlacements.find((placement) => placement.available)
        : undefined;
    const profileId = identity.kind === "profile" ? identity.profileId : null;
    return {
      identity,
      presentation,
      placement: placement ? { kind: "runner", runnerId: placement.runnerId } : null,
      computerLabel: placement?.label ?? (holder ? "Computer unavailable" : "Choose a computer"),
      available:
        connected &&
        (presentation.kind === "guest" || presentation.available) &&
        (holder
          ? placement?.available === true
          : snapshot.browserPlacements.some((placement) => placement.available)),
      yours: snapshot.browserSessions.some(
        (session) =>
          session.opener?.kind === "you" &&
          session.state === "ready" &&
          session.profileId === profileId &&
          session.workspaceId === snapshot.homeWorkspaceId,
      ),
    };
  });
  const groups: StartPageGroup[] = [];
  for (const app of input.approvedApps ?? []) {
    const machine = snapshot.machines.find((machine) => machine.id === app.machineId);
    if (
      !machine ||
      (machine.ownership !== "mine" &&
        !(snapshot.deploymentShape?.kind === "personal" && machine.ownership === "deployment"))
    )
      continue;
    const kind = app.target.kind === "phone" ? "phone" : "apps";
    const held = groups.findIndex(
      (group) => group.machineId === app.machineId && group.kind === kind,
    );
    if (held < 0)
      groups.push({
        machineId: app.machineId,
        label: machine.name,
        local: app.machineId === input.localMachineId,
        kind,
        readiness: newOwnerViewReadiness(machine, kind === "phone"),
        items: [app],
      });
    else {
      const group = groups[held]!;
      groups[held] = {
        ...group,
        items: [...group.items, app].sort(
          (a, b) => a.name.localeCompare(b.name) || a.connectionId.localeCompare(b.connectionId),
        ),
      };
    }
  }
  groups.sort(
    (a, b) =>
      Number(a.readiness !== null) - Number(b.readiness !== null) ||
      Number(a.kind === "phone") - Number(b.kind === "phone") ||
      Number(b.local) - Number(a.local) ||
      a.label.localeCompare(b.label) ||
      a.machineId.localeCompare(b.machineId),
  );
  const listed = input.places ?? placeList(snapshot);
  const groupTitles = new Map<string, string>();
  for (const row of browserTabStrip(listed, snapshot.browserTabGroups).web)
    if (row.kind === "group")
      for (const place of row.places) groupTitles.set(place.key, row.group.title);
  // A tab is found here by what finds it in the sidebar.
  const places = listed.map((place) => {
    const destination = place.destination;
    return {
      place,
      fillText:
        destination.kind === "browser"
          ? (snapshot.browserSessions
              .find((session) => session.id === destination.sessionId)
              ?.tabs.find((tab) => tab.id === destination.tabId)?.url ??
            place.site ??
            place.title)
          : place.title,
      fields: placeSearchFields(place, groupTitles.get(place.key) ?? null),
    };
  });
  const apps = groups.flatMap((group) =>
    group.items.map((app): IndexedApp => ({
      app,
      group,
      placeKey:
        app.target.kind === "app"
          ? `app:${app.machineId}:${computerAppIdentityKey(app.target.app)}`
          : `phone:${app.machineId}:${app.target.display}`,
      fields: [
        { text: searchText(app.name), weight: 1 },
        { text: searchText(app.target.kind === "app" ? "" : "phone"), weight: 0.5 },
      ],
      available: connected && group.readiness === null,
    })),
  );
  return { profiles, groups, places, apps, connected };
}

/** A completion is drawn only from URLs the person explicitly typed, never migrated visits. */
export function inlineAutocomplete(
  query: string,
  history: readonly BrowsingHistoryEntry[],
): string | null {
  if (!query || query.trim() !== query || /\s/u.test(query)) return null;
  const lower = query.toLocaleLowerCase();
  const matches = history.filter(
    (entry) =>
      entry.typedCount > 0 &&
      displayAddress(entry.url).toLocaleLowerCase().startsWith(lower) &&
      displayAddress(entry.url).length > query.length,
  );
  matches.sort((a, b) => b.typedCount - a.typedCount || b.lastVisit - a.lastVisit);
  const match = matches[0];
  return match ? query + displayAddress(match.url).slice(query.length) : null;
}

/** The default is stable and first. A navigate and a switch to the same URL are distinct actions. */
export function startPageResults(
  index: StartPageIndex,
  input: {
    readonly query: string;
    readonly choice: BrowserIdentityChoice;
    readonly history?: readonly BrowsingHistoryEntry[];
    readonly suggestions?: readonly string[];
    readonly completion?: string | null;
    readonly includeApps?: boolean;
  },
): readonly StartPageResult[] {
  const words = searchQuery(input.query);
  if (!words.length) return [];
  const target = { identity: input.choice };
  const selected =
    index.profiles.find((profile) => sameIdentity(profile.identity, input.choice)) ??
    index.profiles.at(-1)!;
  const name = selected.presentation.name;
  const text = input.completion ?? input.query;
  const completedEntry = input.history?.find(
    (entry) =>
      entry.typedCount > 0 &&
      displayAddress(entry.url).toLocaleLowerCase() === text.toLocaleLowerCase(),
  );
  const detected = completedEntry
    ? { kind: "url" as const, url: completedEntry.url }
    : detectStartPageInput(text);
  if (detected.kind === "invalid" || detected.kind === "empty") return [];
  const defaultHistory =
    completedEntry ??
    input.history?.find((entry) => detected.kind === "url" && entry.url === detected.url);
  const results: StartPageResult[] = [];
  if (detected.kind === "url" || detected.kind === "search")
    results.push({
      key: detected.kind === "url" ? "navigate" : "search",
      kind: detected.kind === "url" ? "address" : "search",
      title: text,
      fillText: text,
      ...(defaultHistory ? { historyUrl: defaultHistory.url } : {}),
      detail: null,
      label: `${detected.kind === "url" ? "Go to site" : "Search the web"} · ${name}`,
      available: selected.available,
      action:
        detected.kind === "url"
          ? { kind: "open-url", target, url: detected.url }
          : { kind: "search-web", target, query: detected.query },
    });
  for (const suggestion of input.suggestions ?? [])
    results.push({
      key: `suggest:${suggestion}`,
      kind: "search",
      title: suggestion,
      fillText: suggestion,
      detail: null,
      label: `Search the web · ${name}`,
      available: selected.available,
      action: { kind: "search-web", target, query: suggestion },
    });
  const history = input.history ?? [];
  for (const entry of rankSearch(history, (entry) =>
    matchSearch(
      [
        { text: searchText(displayAddress(entry.url)), weight: 1 },
        { text: searchText(entry.url), weight: 1 },
        { text: searchText(new URL(entry.url).host), weight: 1 },
        { text: searchText(entry.title), weight: 0.8 },
      ],
      words,
    ),
  ).map((match) => match.item))
    results.push({
      key: `history:${entry.url}`,
      kind: "recent",
      title: displayAddress(entry.url),
      fillText: displayAddress(entry.url),
      detail: entry.title || null,
      historyUrl: entry.url,
      ...(entry.favicon ? { favicon: entry.favicon } : {}),
      label: `Go to site · ${name}`,
      available: selected.available,
      action: { kind: "open-url", target, url: entry.url },
    });
  const shownKeys = new Set<string>();
  for (const {
    item: { place, fillText },
  } of rankSearch(index.places, (entry) => {
    const address = parseNavigationInput(entry.fillText);
    return detected.kind === "url" && address.kind === "url" && detected.url === address.url
      ? { score: 100, ranges: [], hint: null }
      : matchSearch(entry.fields, words);
  })) {
    if (input.includeApps === false && place.kind !== "browser") continue;
    // A task's hold on an approved app is not the person's view of it: its app row opens one.
    if (
      place.kind !== "browser" &&
      !place.ownerView &&
      index.apps.some(
        ({ app }) =>
          app.machineId === place.device?.machineId &&
          (app.target.kind === "app" && place.icon.kind === "app"
            ? computerAppIdentityKey(app.target.app) === computerAppIdentityKey(place.icon.app)
            : app.target.kind === "phone" && place.kind === "phone"),
      )
    )
      continue;
    shownKeys.add(place.key);
    results.push({
      key: place.key,
      kind: "tab",
      title: place.title,
      fillText,
      detail: place.kind === "browser" ? fillText : (place.device?.name ?? null),
      label: place.kind === "browser" ? "Switch to tab" : "Switch to view",
      available: place.availability !== "unavailable",
      action: { kind: "switch-to-place", destination: place.destination, placeKey: place.key },
      place,
    });
  }
  const notReady: StartPageResult[] = [];
  if (input.includeApps !== false)
    for (const app of index.apps) {
      if (shownKeys.has(app.placeKey) || !matchSearch(app.fields, words)) continue;
      const phone = app.app.target.kind === "phone";
      const readiness = app.group.readiness;
      (readiness ? notReady : results).push({
        key: `open:${app.app.connectionId}`,
        kind: phone ? "phone" : "app",
        title: app.app.name,
        fillText: app.app.name,
        detail: phone ? null : app.group.label,
        label: readiness
          ? computerNotReadyStatus(readiness).label
          : phone
            ? `Open ${app.app.name}`
            : `Open ${app.app.name} · ${app.group.label}`,
        available: app.available,
        action: {
          kind: "open-computer-view",
          machineId: app.app.machineId,
          target: app.app.target,
        },
        app: app.app,
        ...(readiness ? { notReady: readiness } : {}),
      });
    }
  const seen = new Set<string>();
  return [...results, ...notReady]
    .filter((row) => {
      const action = row.action;
      const key =
        action.kind === "open-url"
          ? `url:${action.url}`
          : action.kind === "search-web"
            ? `url:${webSearchUrl(action.query)}`
            : row.key;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, startPageResultLimit);
}

export function sameIdentity(a: BrowserIdentityChoice, b: BrowserIdentityChoice): boolean {
  return a.kind === b.kind && (a.kind === "guest" || a.profileId === (b as typeof a).profileId);
}

/** An address as a person reads it: no scheme, no `www.`, no lone trailing slash. */
export function displayAddress(url: string): string {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
    return `${parsed.host.replace(/^www\./u, "")}${rest}`;
  } catch {
    return url;
  }
}

/** Computes presentation and explicit intents only. Placement and session reuse remain Host decisions. */
export function startPageModel(input: StartPageModelInput): StartPageModel {
  const { snapshot } = input;
  const choice = startPageChoice({
    sourcePlace: input.sourcePlace ?? null,
    lastChoice: input.lastChoice ?? null,
  });
  const index = startPageIndex({
    snapshot,
    approvedApps: input.approvedApps ?? [],
    localMachineId: input.localMachineId ?? null,
    choice,
  });
  return {
    choice,
    profiles: index.profiles,
    groups: index.groups,
    results: startPageResults(index, {
      query: input.query,
      choice,
      history: input.history ?? [],
    }),
  };
}
