import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useNavigationType, type To } from "react-router";
import { z } from "zod";
import {
  parseNavigationInput,
  type TabDestination as SurfaceDestination,
} from "@opensteer/client/host";
import { TabIdSchema, type TabId } from "@opensteer/core";
import { teamEntryRefusalOutcome } from "@opensteer/protocol";
import { useTeams } from "../../team/team-attachments.js";
import type { SidebarSides } from "@opensteer/client/team";

/**
 * The address has two axes and this module is the only thing that writes
 * either: the path names the conversation (or another conversation-area page),
 * the query names the place in the middle. Every explicit choice pushes exactly
 * one history entry; canonicalising an old address replaces once. A Host event
 * navigates only when it takes the place in the middle away, and then once, by
 * replace, or when the person's own input opened a popup, which is their
 * choice and pushes ([place succession](./place-succession.ts)).
 */

/**
 * The query parameters that name the place in the middle. `panel` alone is the
 * start page.
 */
const placeParams = ["panel", "tab"] as const;

/** Addresses of the stage before places: read once, then replaced away. */
const legacyParams = [
  "browserWorkspace",
  "surfaceThread",
  "surfaces",
  "computerWindow",
  "computerView",
  "computerViewGeneration",
  "browser",
  "browserTab",
  "pendingBrowserTab",
  "computerSession",
  "app",
  "mac",
  "phone",
  "display",
  "opensteerApp",
] as const;

/** What the middle shows, as the address says it. */
export type PlaceSelection =
  | { readonly kind: "talk" }
  | { readonly kind: "launcher" }
  | { readonly kind: "place"; readonly destination: SurfaceDestination };

export function placeSelection(params: URLSearchParams): PlaceSelection {
  if (!params.has("panel")) return { kind: "talk" };
  const destination = placeDestination(params);
  return destination ? { kind: "place", destination } : { kind: "launcher" };
}

/**
 * Where the start page was opened from, carried in its history entry: the
 * place query it replaced, so Esc and its × go back there, and the default
 * profile is read from that tab. History state is untrusted; anything else
 * is no place at all.
 */
export function startPageOrigin(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("startFrom" in state)) return null;
  const from = state.startFrom;
  return typeof from === "string" && from.length <= 2048 ? from : null;
}

/** Which opening of the start page this entry is: a new one starts fresh, a reload does not. */
export function startPageOpening(state: unknown): string {
  if (typeof state !== "object" || state === null || !("startId" in state)) return "";
  const id = state.startId;
  return typeof id === "string" && id.length <= 64 ? id : "";
}
export interface StartPageLink {
  readonly address: string;
  readonly open: boolean;
}
/**
 * The web address a link asked this start page to open, and whether that is
 * still to happen. Opening clears `open` in the same history entry, so Back,
 * Forward and reload show the address without opening it again. History
 * state is untrusted; anything but a web address is no link at all.
 */
export function startPageLink(state: unknown): StartPageLink | null {
  if (typeof state !== "object" || state === null || !("startAddress" in state)) return null;
  const address = state.startAddress;
  if (
    typeof address !== "string" ||
    address.length > 8192 ||
    parseNavigationInput(address).kind !== "url"
  )
    return null;
  return { address, open: "startOpen" in state && state.startOpen === true };
}
let openings = 0;

function placeDestination(params: URLSearchParams): SurfaceDestination | null {
  const tabId = TabIdSchema.safeParse(params.get("tab"));
  return tabId.success ? { kind: "tab", tabId: tabId.data } : null;
}

/** The tab catalog's key for a destination. */
export function destinationPlaceKey(destination: SurfaceDestination): TabId {
  return destination.tabId;
}

/** A destination as the address names it: two destinations are one place exactly when these match. */
export function placeAddress(destination: SurfaceDestination): string {
  const params = new URLSearchParams();
  writePlace(params, { kind: "place", destination });
  return params.toString();
}

function clearPlace(params: URLSearchParams): void {
  for (const name of placeParams) params.delete(name);
  for (const name of legacyParams) params.delete(name);
}

function writePlace(params: URLSearchParams, selection: PlaceSelection): void {
  clearPlace(params);
  if (selection.kind === "talk") return;
  params.set("panel", "browser");
  if (selection.kind === "launcher") return;
  params.set("tab", selection.destination.tabId);
}

/** Only the place survives a change of conversation; a message anchor or request focus does not. */
function placeOnly(search: string): URLSearchParams {
  const current = new URLSearchParams(search);
  const next = new URLSearchParams();
  for (const name of placeParams) {
    const value = current.get(name);
    if (value !== null) next.set(name, value);
  }
  return next;
}

function searchString(params: URLSearchParams): string {
  const value = params.toString();
  return value ? `?${value}` : "";
}

/**
 * A conversation-area page, as an address that keeps the place in the middle:
 * the target's own parameters (a message anchor) join the place's, never
 * replace them.
 */
function areaAddress(to: string, currentSearch: string): Address & { readonly hash: string } {
  const target = new URL(to, "http://workspace.invalid");
  const params = placeOnly(currentSearch);
  for (const [name, value] of target.searchParams)
    if (!(placeParams as readonly string[]).includes(name)) params.set(name, value);
  return { hash: target.hash, pathname: target.pathname, search: searchString(params) };
}

/**
 * The canonical form of an address, or null when it already is one. Legacy
 * stage parameters go, `panel=computer` becomes `panel=browser`, and a browser
 * address naming only its session names the tab the session shows, once the
 * catalog can say which.
 */
export function canonicalPlaceSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  let changed = false;
  for (const name of legacyParams) {
    if (params.has(name)) {
      params.delete(name);
      changed = true;
    }
  }
  if (params.get("panel") === "computer") {
    params.set("panel", "browser");
    changed = true;
  }
  return changed ? searchString(params) : null;
}

/* ---- The last place the person chose, per deployment and user ---- */

const RememberedPlaceSchema = z.object({ kind: z.literal("tab"), tabId: TabIdSchema });

const RememberedTalkSchema = z.object({
  kind: z.literal("talk"),
  lastPlace: RememberedPlaceSchema.nullable(),
});

export interface PlaceMemoryScope {
  readonly deploymentId: string | null;
  readonly userId: string | null;
}

function memoryKey(scope: PlaceMemoryScope): string | null {
  if (!scope.deploymentId || !scope.userId) return null;
  return `opensteer.workspace.last-place.v1:${encodeURIComponent(scope.deploymentId)}:${encodeURIComponent(scope.userId)}`;
}

export function rememberedPlace(scope: PlaceMemoryScope): SurfaceDestination | null {
  const key = memoryKey(scope);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    const talk = RememberedTalkSchema.safeParse(value);
    const parsed = RememberedPlaceSchema.safeParse(talk.success ? talk.data.lastPlace : value);
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    // A convenience, not authority: unreadable or refused storage remembers nothing.
    return null;
  }
}

export function rememberedNewTab(scope: PlaceMemoryScope): boolean {
  const key = memoryKey(scope);
  if (!key) return false;
  try {
    return localStorage.getItem(key) === '{"kind":"launcher"}';
  } catch {
    return false;
  }
}
export function rememberedTalk(scope: PlaceMemoryScope): boolean {
  const key = memoryKey(scope);
  if (!key) return false;
  try {
    return RememberedTalkSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? "null")).success;
  } catch {
    return false;
  }
}
function rememberTalk(scope: PlaceMemoryScope): void {
  const key = memoryKey(scope);
  if (!key) return;
  try {
    const lastPlace = rememberedPlace(scope);
    localStorage.setItem(key, JSON.stringify({ kind: "talk", lastPlace }));
  } catch {
    /* Navigation works without storage. */
  }
}
export function rememberNewTab(scope: PlaceMemoryScope): void {
  const key = memoryKey(scope);
  if (!key) return;
  try {
    localStorage.setItem(key, '{"kind":"launcher"}');
  } catch {
    /* Navigation works without storage. */
  }
}

/** The place the address shows, kept as the one Show computer returns to. */
export function rememberPlace(scope: PlaceMemoryScope, destination: SurfaceDestination): void {
  const key = memoryKey(scope);
  if (!key) return;
  const parsed = RememberedPlaceSchema.safeParse(destination);
  if (!parsed.success) return;
  try {
    localStorage.setItem(key, JSON.stringify(parsed.data));
  } catch {
    // Storage denial must not prevent navigation.
  }
}

/* ---- The hook every control uses ---- */

export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/**
 * The setup screen: this computer, its AI and a phone, over the whole window.
 * Not `/setup`, which is where a server's one-time owner link lands.
 */
export const setupPath = "/get-started";

/** A task's address. */
export function taskPath(threadId: string): string {
  return `/tasks/${encodeURIComponent(threadId)}`;
}

/** The task a path shows, if it shows one. */
export function taskAt(pathname: string): string | null {
  const match = /^\/tasks\/([^/]+)/u.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function isSetupPath(pathname: string): boolean {
  return pathname === setupPath;
}

/** The address owns the side; full-window and directory pages belong to neither. */
export function workspaceSide(pathname: string): string | null {
  const team = /^\/teams\/([^/]+)(?:\/|$)/u.exec(pathname);
  if (team) {
    try {
      return decodeURIComponent(team[1]!);
    } catch {
      return null;
    }
  }
  return pathname === "/" || /^\/(?:tasks|automations|voice)(?:\/|$)/u.test(pathname)
    ? "tasks"
    : null;
}

const SideBookmarkSchema = z.object({
  pathname: z.string().startsWith("/").max(8192),
  search: z.string().max(16384),
  hash: z.string().max(8192),
  startFrom: z.string().max(2048).nullable(),
  viewer: z.string().nullable(),
});
const SideMemorySchema = z.object({
  side: z.string(),
  /** The team last shown, which keeps its name in the switch while on Tasks. */
  recent: z.string().nullable().catch(null),
  bookmarks: z.record(z.string(), SideBookmarkSchema),
});
type SideMemory = z.infer<typeof SideMemorySchema>;

function sideMemoryKey(scope: PlaceMemoryScope): string | null {
  return scope.deploymentId && scope.userId
    ? `opensteer.workspace.sides.v1:${encodeURIComponent(scope.deploymentId)}:${encodeURIComponent(scope.userId)}`
    : null;
}

function readSideMemory(key: string | null): SideMemory {
  try {
    const parsed = SideMemorySchema.safeParse(
      JSON.parse(key ? (sessionStorage.getItem(key) ?? "null") : "null"),
    );
    if (parsed.success) {
      const bookmarks = Object.fromEntries(
        Object.entries(parsed.data.bookmarks).filter(
          ([side, bookmark]) =>
            !bookmark.pathname.startsWith("//") &&
            workspaceSide(bookmark.pathname) === side &&
            (!bookmark.search || bookmark.search.startsWith("?")) &&
            (!bookmark.hash || bookmark.hash.startsWith("#")),
        ),
      );
      return { side: parsed.data.side, recent: parsed.data.recent, bookmarks };
    }
  } catch {
    /* The window still remembers when storage is unavailable. */
  }
  return { side: "tasks", recent: null, bookmarks: {} };
}

function useTeamViewers() {
  const { teams, forgotten } = useTeams();
  const cache = useRef<readonly { id: string; viewer: string | null; removed: boolean }[]>([]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = teams.map((team) => team.client?.subscribe(listener));
      return () => {
        for (const stop of stops) stop?.();
      };
    },
    [teams],
  );
  const read = useCallback(() => {
    const next = teams.map((team) => {
      const snapshot = team.client?.getSnapshot();
      return {
        id: team.teamId,
        viewer: team.client?.scope.userId ?? null,
        removed:
          team.failure === "join" ||
          team.link?.state === "revoked" ||
          snapshot?.ended === "removed" ||
          snapshot?.ended === "viewer-changed" ||
          teamEntryRefusalOutcome(snapshot?.refusalReason) === "membership",
      };
    });
    for (const id of forgotten) next.push({ id, viewer: null, removed: true });
    if (JSON.stringify(next) !== JSON.stringify(cache.current)) cache.current = next;
    return cache.current;
  }, [teams, forgotten]);
  return useSyncExternalStore(subscribe, read, read);
}

export interface WorkspaceNavigation {
  readonly sides: SidebarSides;
  readonly openSide: (side: string) => void;
  /** Changes on a place choice, including reselecting the current tab. */
  readonly placeOpening: number;
  readonly pendingPlace: string | null;
  /** Where a conversation-area page is, keeping the place in the middle. */
  readonly conversationHref: (to: string) => To;
  /**
   * Goes to a conversation-area page — an automation, back from
   * an editor — keeping the place in the middle. Settings keep their own
   * full-page navigation and do not use this.
   */
  readonly openPage: (
    to: string,
    options?: { readonly replace?: boolean; readonly state?: unknown },
  ) => void;
  /** Back from Settings to the conversation and place left for it, or Home if opened there. */
  readonly leaveSettings: () => void;
  /** Writes into the current entry's history state, keeping the rest of it and the address. */
  readonly mergeEntryState: (patch: Readonly<Record<string, unknown>>) => void;
  /** The path of a task: under /tasks. */
  readonly threadPath: (threadId: string) => string;
  /** Task row, task line, the menu under a name: the conversation only. */
  readonly openConversation: (
    path: string,
    options?: {
      /** The unsent task to open there. */
      readonly draftId?: string;
      readonly focusRequest?: string;
      readonly messageId?: string;
      /** A subagent of this conversation to open in its place, read-only. */
      readonly subagent?: string;
      /** Takes the current entry's place in history: a hop between siblings. */
      readonly replace?: boolean;
    },
  ) => void;
  /** Includes synchronous choices made since the last render. */
  readonly address: () => Address;
  /** Tab row, viewfinder, chip: the place only (opens Work from Talk). */
  readonly showPlace: (
    destination: SurfaceDestination,
    options?: { readonly replace?: boolean },
  ) => void;
  /** A mark on a tab: that place and that conversation, as one entry. */
  readonly showPlaceWithConversation: (destination: SurfaceDestination, path: string) => void;
  /** The start page, remembering the place it covers and optionally opening an address on arrival. */
  readonly showLauncher: (options?: {
    /** In place of a place that has gone (a closed view): nothing to return to. */
    readonly replace?: boolean;
    /** A web address to open through the start page with its default profile. */
    readonly address?: string;
    readonly open?: boolean;
  }) => void;
  /** Esc or × on the start page: the place it was opened from, else the conversation alone. */
  readonly leaveLauncher: (from: string | null) => void;
  /**
   * The place in the middle is no longer listed: its successor takes its
   * history entry, or, with none, the start page does, opened fresh.
   */
  readonly succeedPlace: (successor: SurfaceDestination | null) => void;
  /** The monitor button: the last place chosen, or the launcher. */
  readonly showComputer: (available: (destination: SurfaceDestination) => boolean) => void;
  readonly hideComputer: () => void;
  /** The search a place selection would have, from the address being rendered. */
  readonly placeSearch: (destination: SurfaceDestination) => string;
  /**
   * Starts a choice whose place arrives later — a new tab, a started browser.
   * The returned function shows that place only if, by then, the person has
   * chosen no other place and started no newer such operation; it reads the
   * address as it is when the answer lands, so the conversation open then stays.
   */
  readonly beginPlaceOperation: (options?: {
    readonly address?: string;
    /** The answer takes the start page's own history entry, as a new tab's page does. */
    readonly replace?: boolean;
  }) => ((destination: SurfaceDestination) => void) & {
    readonly launcher: (options: { address: string; open: boolean }) => void;
  };
}

interface Address {
  readonly pathname: string;
  readonly search: string;
  readonly hash?: string;
  /** The entry's history state, as the newest navigation left it. */
  readonly state?: unknown;
}

export function useWorkspaceNavigation(scope: PlaceMemoryScope): WorkspaceNavigation {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { search } = location;
  const { deploymentId, userId } = scope;
  const [placeOpening, setPlaceOpening] = useState(0);
  const [pending, setPending] = useState<{
    address: string;
    operation: number;
    epoch: number;
  } | null>(null);
  const { surface } = useTeams();
  const viewers = useTeamViewers();
  const scopeKey = sideMemoryKey(scope);
  const memory = useRef<{ key: string | null; value: SideMemory } | null>(null);
  memory.current ??= { key: scopeKey, value: readSideMemory(scopeKey) };
  const identity = useRef(scope);
  const placeEpoch = useRef(0);
  const operation = useRef(0);
  if (memory.current.key !== scopeKey) {
    memory.current = { key: scopeKey, value: readSideMemory(scopeKey) };
    placeEpoch.current += 1;
  }
  if (identity.current.deploymentId !== deploymentId || identity.current.userId !== userId) {
    placeEpoch.current += 1;
    identity.current = scope;
  }
  const bookmarks = memory.current.value;
  const previousViewers = useRef(viewers);
  for (const team of viewers) {
    const bookmark = bookmarks.bookmarks[team.id];
    if (team.removed || (team.viewer && bookmark?.viewer && bookmark.viewer !== team.viewer))
      delete bookmarks.bookmarks[team.id];
    if (team.removed && bookmarks.side === team.id) bookmarks.side = "tasks";
    if (team.removed && bookmarks.recent === team.id) bookmarks.recent = null;
    const previous = previousViewers.current.find((held) => held.id === team.id);
    if (previous && (team.viewer !== previous.viewer || team.removed !== previous.removed))
      placeEpoch.current += 1;
  }
  if (previousViewers.current.some((previous) => !viewers.some((team) => team.id === previous.id)))
    placeEpoch.current += 1;
  previousViewers.current = viewers;
  // Includes choices made synchronously since the last router render.
  const latest = useRef<Address>(location);
  const seen = useRef(location);
  const settingsReturn = useRef<Address>({ pathname: "/", search: "" });
  const remember = useCallback(
    (address: Address) => {
      const side = workspaceSide(address.pathname);
      if (side === null) return;
      const team = viewers.find((viewer) => viewer.id === side);
      if (team?.removed) return;
      bookmarks.side = side;
      if (side !== "tasks") bookmarks.recent = side;
      if (side !== "tasks" && !team?.viewer) return;
      // An opening still under way finishes only on the address it started from.
      const params = new URLSearchParams(address.search);
      const search = params.toString();
      bookmarks.bookmarks[side] = {
        pathname: address.pathname,
        search: search ? `?${search}` : "",
        hash: address.hash ?? "",
        startFrom: startPageOrigin(address.state),
        viewer: team?.viewer ?? null,
      };
    },
    [bookmarks, viewers],
  );
  if (seen.current !== location) {
    if (
      (latest.current.search !== location.search ||
        latest.current.pathname !== location.pathname ||
        navigationType === "POP") &&
      (placeOnly(seen.current.search).toString() !== placeOnly(search).toString() ||
        workspaceSide(seen.current.pathname) !== workspaceSide(location.pathname) ||
        navigationType === "POP")
    )
      placeEpoch.current += 1;
    if (!isSettingsPath(seen.current.pathname) && navigationType !== "REPLACE")
      settingsReturn.current = seen.current;
    seen.current = location;
    latest.current = location;
  }
  remember(location);
  const side = workspaceSide(location.pathname) ?? bookmarks.side;
  const recent = bookmarks.recent;
  const sides = useMemo<SidebarSides>(() => ({ side, recent }), [side, recent]);
  useEffect(() => {
    try {
      if (scopeKey) sessionStorage.setItem(scopeKey, JSON.stringify(bookmarks));
    } catch {
      /* Navigation works without storage. */
    }
  }, [bookmarks, location, scopeKey, viewers]);
  useEffect(
    () => () => {
      placeEpoch.current += 1;
    },
    [],
  );
  // An explicit choice of what is already shown adds no entry.
  const go = useCallback(
    (to: Address, state?: unknown, replace = false) => {
      const current = latest.current;
      const same =
        to.pathname === current.pathname &&
        to.search === current.search &&
        (to.hash ?? "") === (current.hash ?? "");
      if (same && state === undefined) return;
      if (workspaceSide(to.pathname) !== workspaceSide(current.pathname)) placeEpoch.current += 1;
      void navigate(to, { replace: same || replace, ...(state === undefined ? {} : { state }) });
      // Two choices in one event build on each other, not on the render before both.
      latest.current = { ...to, state };
    },
    [navigate],
  );
  const openSide = useCallback(
    (targetSide: string) => {
      if (surface === "team-web" && targetSide === "tasks") return;
      remember(latest.current);
      if (workspaceSide(latest.current.pathname) === targetSide) return;
      const target = bookmarks.bookmarks[targetSide];
      const viewer = viewers.find((candidate) => candidate.id === targetSide);
      const restored =
        target && (targetSide === "tasks" || (viewer?.viewer === target.viewer && !viewer.removed));
      go(
        restored
          ? target
          : {
              pathname: targetSide === "tasks" ? "/" : `/teams/${encodeURIComponent(targetSide)}/`,
              search: "",
            },
        restored && target.startFrom !== null ? { startFrom: target.startFrom } : undefined,
      );
    },
    [surface, remember, bookmarks, viewers, go],
  );
  const choosePlace = useCallback(
    (
      selection: PlaceSelection,
      pathname?: string,
      options: { readonly replace?: boolean; readonly state?: unknown } = {},
    ) => {
      placeEpoch.current += 1;
      if (!options.replace) setPlaceOpening((value) => value + 1);
      if (selection.kind === "talk") rememberTalk({ deploymentId, userId });
      else if (selection.kind === "launcher") rememberNewTab({ deploymentId, userId });
      const current = latest.current;
      const path = pathname ?? current.pathname;
      // Changing conversation leaves its message anchor behind; the place keeps everything.
      const params =
        path === current.pathname ? new URLSearchParams(current.search) : placeOnly(current.search);
      writePlace(params, selection);
      go({ pathname: path, search: searchString(params) }, options.state, options.replace);
    },
    [deploymentId, go, userId],
  );

  const threadPath = useCallback((threadId: string) => taskPath(threadId), []);
  const conversationHref = useCallback((to: string): To => areaAddress(to, search), [search]);
  const openPage = useCallback<WorkspaceNavigation["openPage"]>(
    (to, options) => {
      const target = areaAddress(to, latest.current.search);
      go(target, options?.state, options?.replace);
    },
    [go],
  );
  const mergeEntryState = useCallback<WorkspaceNavigation["mergeEntryState"]>(
    (patch) => {
      const { pathname, search: current, hash, state } = latest.current;
      go(
        { pathname, search: current, hash: hash ?? "" },
        { ...(typeof state === "object" && state !== null ? state : {}), ...patch },
      );
    },
    [go],
  );
  const leaveSettings = useCallback<WorkspaceNavigation["leaveSettings"]>(
    () => void navigate(settingsReturn.current),
    [navigate],
  );
  const openConversation = useCallback<WorkspaceNavigation["openConversation"]>(
    (path, options) => {
      // A path may carry its own query (All tasks' filter); the place shown stays beside it.
      const [pathname = path, query = ""] = path.split("?", 2);
      const params = placeOnly(latest.current.search);
      for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
      if (options?.messageId) params.set("messageId", options.messageId);
      if (options?.draftId) params.set("draft", options.draftId);
      if (options?.subagent) params.set("subagent", options.subagent);
      // The place stays, so a replaced entry keeps what its place saved there.
      go(
        { pathname, search: searchString(params) },
        options?.focusRequest
          ? { focusRequest: options.focusRequest }
          : options?.replace
            ? latest.current.state
            : undefined,
        options?.replace,
      );
    },
    [go],
  );
  const placeSearch = useCallback(
    (destination: SurfaceDestination) => {
      const params = new URLSearchParams(search);
      writePlace(params, { kind: "place", destination });
      return searchString(params);
    },
    [search],
  );
  const showPlace = useCallback<WorkspaceNavigation["showPlace"]>(
    (destination, options) =>
      choosePlace({ kind: "place", destination }, undefined, {
        replace: options?.replace === true,
      }),
    [choosePlace],
  );
  const showPlaceWithConversation = useCallback(
    (destination: SurfaceDestination, path: string) =>
      choosePlace({ kind: "place", destination }, path),
    [choosePlace],
  );
  const showLauncher = useCallback<WorkspaceNavigation["showLauncher"]>(
    (options = {}) => {
      const covered = placeSelection(new URLSearchParams(latest.current.search));
      // A start page opened over another keeps covering what that one covered.
      const from = options.replace
        ? null
        : covered.kind === "place"
          ? placeOnly(latest.current.search).toString()
          : covered.kind === "launcher"
            ? startPageOrigin(seen.current.state)
            : null;
      openings += 1;
      choosePlace({ kind: "launcher" }, undefined, {
        replace: options.replace === true,
        state: {
          startFrom: from,
          startId: `${Date.now().toString(36)}-${openings}`,
          ...(options.address === undefined
            ? {}
            : { startAddress: options.address, startOpen: options.open ?? true }),
        },
      });
    },
    [choosePlace],
  );
  const leaveLauncher = useCallback(
    (from: string | null) => {
      const selection = from === null ? null : placeSelection(new URLSearchParams(from));
      choosePlace(selection?.kind === "place" ? selection : { kind: "talk" }, undefined, {
        replace: true,
      });
    },
    [choosePlace],
  );
  const succeedPlace = useCallback(
    (successor: SurfaceDestination | null) => {
      if (successor)
        choosePlace({ kind: "place", destination: successor }, undefined, { replace: true });
      else showLauncher({ replace: true });
    },
    [choosePlace, showLauncher],
  );
  const hideComputer = useCallback(() => choosePlace({ kind: "talk" }), [choosePlace]);
  const showComputer = useCallback(
    (available: (destination: SurfaceDestination) => boolean) => {
      const remembered = rememberedPlace({ deploymentId, userId });
      choosePlace(
        remembered && available(remembered)
          ? { kind: "place", destination: remembered }
          : { kind: "launcher" },
      );
    },
    [choosePlace, deploymentId, userId],
  );
  const beginPlaceOperation = useCallback(
    (options: { readonly replace?: boolean; readonly address?: string } = {}) => {
      operation.current += 1;
      const mine = operation.current;
      if (options.address !== undefined) showLauncher({ address: options.address, open: false });
      const epoch = placeEpoch.current;
      setPending(
        options.address === undefined ? null : { address: options.address, operation: mine, epoch },
      );
      const current = () => operation.current === mine && placeEpoch.current === epoch;
      return Object.assign(
        (destination: SurfaceDestination) => {
          if (!current()) return;
          setPending(null);
          choosePlace({ kind: "place", destination }, undefined, {
            replace: options.address !== undefined || options.replace === true,
          });
        },
        {
          launcher: (failure: { address: string; open: boolean }) => {
            if (!current()) return;
            setPending(null);
            showLauncher({ ...failure, replace: true });
          },
        },
      );
    },
    [choosePlace, showLauncher],
  );
  const pendingPlace =
    pending?.operation === operation.current && pending.epoch === placeEpoch.current
      ? pending.address
      : null;

  const address = useCallback(() => latest.current, []);
  return useMemo(
    () => ({
      address,
      sides,
      openSide,
      placeOpening,
      pendingPlace,
      beginPlaceOperation,
      conversationHref,
      hideComputer,
      leaveLauncher,
      leaveSettings,
      mergeEntryState,
      openConversation,
      openPage,
      placeSearch,
      showComputer,
      showLauncher,
      showPlace,
      showPlaceWithConversation,
      succeedPlace,
      threadPath,
    }),
    [
      address,
      sides,
      openSide,
      placeOpening,
      pendingPlace,
      beginPlaceOperation,
      conversationHref,
      hideComputer,
      leaveLauncher,
      leaveSettings,
      mergeEntryState,
      openConversation,
      openPage,
      placeSearch,
      showComputer,
      showLauncher,
      showPlace,
      showPlaceWithConversation,
      succeedPlace,
      threadPath,
    ],
  );
}
