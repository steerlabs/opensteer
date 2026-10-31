import { useCallback, useMemo, useRef } from "react";
import { useLocation, useNavigate, useNavigationType, type To } from "react-router";
import { z } from "zod";
import {
  parseNavigationInput,
  type WorkspaceSurfaceDestination as SurfaceDestination,
} from "@opensteer/client/host";
import { interact } from "./interaction.js";

/**
 * The address has two axes and this module is the only thing that writes
 * either: the path names the conversation (or another conversation-area page),
 * the query names the place in the middle. Every explicit choice pushes exactly
 * one history entry; canonicalising an old address replaces once. A Host event
 * navigates only when it takes the place in the middle away, and then once, by
 * replace ([place succession](./place-succession.ts)). Every explicit choice
 * also counts as the person's [interaction](./interaction.ts); an agent's
 * presentation and the Host's rewrites do not.
 */

/**
 * The query parameters that name the place in the middle. `panel` alone is the
 * start page.
 */
const placeParams = [
  "computerWindow",
  "computerView",
  "computerViewGeneration",
  "panel",
  "browser",
  "browserTab",
  "pendingBrowserTab",
  "computerSession",
  "app",
  "mac",
  "phone",
  "display",
] as const;

/** Addresses of the stage before places: read once, then replaced away. */
const legacyParams = ["browserWorkspace", "surfaceThread", "surfaces"] as const;

/** What the middle shows, as the address says it. */
export type PlaceSelection =
  | { readonly kind: "talk" }
  | { readonly kind: "launcher" }
  | { readonly kind: "pending"; readonly idempotencyKey: string }
  | { readonly kind: "place"; readonly destination: SurfaceDestination };

export function placeSelection(params: URLSearchParams): PlaceSelection {
  if (!params.has("panel")) return { kind: "talk" };
  const pending = params.get("pendingBrowserTab");
  if (pending) return { kind: "pending", idempotencyKey: pending };
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
  const sessionId = params.get("browser");
  const tabId = params.get("browserTab");
  if (sessionId && tabId) return { kind: "browser", sessionId, tabId };
  const computerSessionId = params.get("computerSession");
  const viewId = params.get("computerView");
  const generation = Number(params.get("computerViewGeneration"));
  if (viewId && Number.isSafeInteger(generation) && generation > 0) {
    const phone = params.get("phone");
    const appKey = params.get("app");
    const source = { kind: "owner-view" as const, viewId, generation };
    if (phone)
      return { kind: "phone", machineId: phone, display: params.get("display") ?? "main", source };
    if (appKey) {
      const window = Number(params.get("computerWindow"));
      return {
        kind: "app",
        machineId: params.get("mac") ?? "",
        appKey,
        source,
        ...(params.has("computerWindow") && Number.isSafeInteger(window) && window >= 0
          ? { windowId: window }
          : {}),
      };
    }
  }
  const phone = params.get("phone");
  if (computerSessionId && phone) {
    const display = params.get("display");
    return {
      kind: "phone",
      computerSessionId,
      machineId: phone,
      ...(display ? { display } : {}),
    };
  }
  const appKey = params.get("app");
  if (computerSessionId && appKey) {
    return { appKey, computerSessionId, kind: "app", machineId: params.get("mac") ?? "" };
  }
  return null;
}

/** The place catalog's key for a destination; a browser address without its tab has none yet. */
export function destinationPlaceKey(destination: SurfaceDestination): string | null {
  switch (destination.kind) {
    case "browser":
      return destination.tabId ? `browser:${destination.sessionId}:${destination.tabId}` : null;
    case "app":
      return destination.source?.kind === "owner-view"
        ? `app:${destination.machineId}:${destination.appKey}:${destination.windowId ?? destination.source.viewId}`
        : `app:${destination.machineId}:${destination.appKey}:task:${destination.computerSessionId}`;
    case "phone":
      return `phone:${destination.machineId}:${destination.display ?? "main"}:${destination.source?.kind === "owner-view" ? `owner:${destination.source.viewId}` : `task:${destination.computerSessionId}`}`;
  }
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
  if (selection.kind === "pending") {
    params.set("pendingBrowserTab", selection.idempotencyKey);
    return;
  }
  const { destination } = selection;
  if (destination.kind === "browser") {
    params.set("browser", destination.sessionId);
    if (destination.tabId) params.set("browserTab", destination.tabId);
    return;
  }
  if (destination.source?.kind === "owner-view") {
    params.set("computerView", destination.source.viewId);
    params.set("computerViewGeneration", String(destination.source.generation));
  } else if (destination.computerSessionId)
    params.set("computerSession", destination.computerSessionId);
  if (destination.kind === "phone") {
    params.set("phone", destination.machineId);
    if (destination.display) params.set("display", destination.display);
  } else {
    if (destination.windowId !== undefined)
      params.set("computerWindow", String(destination.windowId));
    params.set("app", destination.appKey);
    params.set("mac", destination.machineId);
  }
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
export function canonicalPlaceSearch(
  search: string,
  activeTabOf: (sessionId: string) => string | null | undefined,
): string | null {
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
  const sessionId = params.get("browser");
  if (sessionId && !params.get("browserTab")) {
    const tabId = activeTabOf(sessionId);
    // Unknown yet: wait for the catalog rather than inventing a tab.
    if (tabId === undefined) return changed ? searchString(params) : null;
    if (tabId) {
      params.set("browserTab", tabId);
      changed = true;
    }
  }
  if (sessionId && !params.has("panel")) {
    params.set("panel", "browser");
    changed = true;
  }
  return changed ? searchString(params) : null;
}

/* ---- The last place the person chose, per deployment and user ---- */

const RememberedPlaceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("browser"),
    sessionId: z.string().min(1).max(200),
    tabId: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal("app"),
    appKey: z.string().min(1).max(512),
    computerSessionId: z.string().min(1).max(200),
    machineId: z.string().max(200),
  }),
  z.object({
    kind: z.literal("phone"),
    computerSessionId: z.string().min(1).max(200),
    display: z.string().min(1).max(255).optional(),
    machineId: z.string().min(1).max(200),
  }),
]);

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
    const place = parsed.data;
    if (place.kind !== "phone") return place;
    return {
      computerSessionId: place.computerSessionId,
      kind: "phone",
      machineId: place.machineId,
      ...(place.display === undefined ? {} : { display: place.display }),
    };
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

export interface WorkspaceNavigation {
  /** Where a conversation-area page is, keeping the place in the middle. */
  readonly conversationHref: (to: string) => To;
  /**
   * Goes to a conversation-area page — Specialists, an automation, back from
   * an editor — keeping the place in the middle. Settings keep their own
   * full-page navigation and do not use this.
   */
  readonly openPage: (
    to: string,
    options?: { readonly replace?: boolean; readonly state?: unknown },
  ) => void;
  /** Back from Settings to the conversation and place left for it, or Home if opened there. */
  readonly leaveSettings: () => void;
  /** The browser's Back, counted as the person's choice before the history answers. */
  readonly back: () => void;
  /** The path of a conversation: Chat at the root, a task under /threads. */
  readonly threadPath: (threadId: string) => string;
  /** Task row, task line, the menu under a name: the conversation only. */
  readonly openConversation: (
    path: string,
    options?: { readonly focusRequest?: string; readonly messageId?: string },
  ) => void;
  readonly showPendingBrowserTab: (
    idempotencyKey: string,
    options?: { readonly replace?: boolean },
  ) => void;
  readonly replacePendingBrowserTab: (
    idempotencyKey: string,
    destination: SurfaceDestination,
  ) => void;
  /** Tab row, viewfinder, chip: the place only (opens Work from Talk). */
  readonly showPlace: (destination: SurfaceDestination) => void;
  /** A mark on a tab: that place and that conversation, as one entry. */
  readonly showPlaceWithConversation: (destination: SurfaceDestination, path: string) => void;
  /** The start page, remembering the place it covers and optionally opening an address on arrival. */
  readonly showLauncher: (options?: {
    /** In place of a place that has gone (a closed view): nothing to return to. */
    readonly replace?: boolean;
    /** A web address to open through the start page with its default profile. */
    readonly address?: string;
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
    /** The answer takes the start page's own history entry, as a new tab's page does. */
    readonly replace?: boolean;
  }) => (destination: SurfaceDestination) => void;
  /** The address as it is now, including choices made since the last render. */
  readonly address: () => Address;
  /**
   * An agent's presentation: the conversation, the place, or both as one
   * entry, each axis left alone when not named. It is not the person's choice,
   * so it outdates no presentation; showing what is already shown adds nothing.
   */
  readonly present: (target: {
    readonly path?: string;
    readonly place?: SurfaceDestination;
  }) => void;
}

export interface Address {
  readonly pathname: string;
  readonly search: string;
}

export function useWorkspaceNavigation(
  scope: PlaceMemoryScope,
  homeThreadId: string | null,
): WorkspaceNavigation {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { search } = location;
  const { deploymentId, userId } = scope;
  // Every imperative choice reads the address as it is when it runs, never as
  // it was when a callback was made: an answer that lands later must not write
  // an older conversation or place back.
  const latest = useRef<Address>({ pathname: location.pathname, search });
  const seen = useRef(location);
  const settingsReturn = useRef<Address>({ pathname: "/", search: "" });
  // Any change of place in the address — a row, Back, a typed address — and
  // every explicit place choice outdates a place operation still under way.
  const placeEpoch = useRef(0);
  const operation = useRef(0);
  // The address a presentation wrote, so its arrival is not counted as the person's.
  const presented = useRef<Address | null>(null);
  if (seen.current !== location) {
    if (placeOnly(seen.current.search).toString() !== placeOnly(search).toString())
      placeEpoch.current += 1;
    const arrival = presented.current;
    presented.current = null;
    // A replace is a redirect, a canonical rewrite or a Host succession; the
    // person's own replaces counted where they were chosen.
    if (
      navigationType !== "REPLACE" &&
      (arrival?.pathname !== location.pathname || arrival.search !== search)
    )
      interact();
    // A replaced address was a redirect or rewrite, never a place to return to.
    if (!isSettingsPath(seen.current.pathname) && navigationType !== "REPLACE")
      settingsReturn.current = { pathname: seen.current.pathname, search: seen.current.search };
    seen.current = location;
    latest.current = { pathname: location.pathname, search };
  }
  // An explicit choice of what is already shown adds no entry.
  const go = useCallback(
    (to: Address, state?: unknown, replace = false) => {
      const current = latest.current;
      const same = to.pathname === current.pathname && to.search === current.search;
      if (same && state === undefined) return;
      void navigate(to, { replace: same || replace, ...(state === undefined ? {} : { state }) });
      // Two choices in one event build on each other, not on the render before both.
      latest.current = to;
    },
    [navigate],
  );
  const choosePlace = useCallback(
    (
      selection: PlaceSelection,
      pathname?: string,
      options: {
        readonly replace?: boolean;
        readonly state?: unknown;
        /** Neither the person's choice nor counted as one: a presentation or a succession. */
        readonly chosen?: false;
      } = {},
    ) => {
      if (options.chosen !== false) interact();
      placeEpoch.current += 1;
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

  const threadPath = useCallback(
    (threadId: string) =>
      threadId === homeThreadId ? "/" : `/threads/${encodeURIComponent(threadId)}`,
    [homeThreadId],
  );
  const conversationHref = useCallback((to: string): To => areaAddress(to, search), [search]);
  const openPage = useCallback<WorkspaceNavigation["openPage"]>(
    (to, options) => {
      interact();
      const target = areaAddress(to, latest.current.search);
      void navigate(target, {
        ...(options?.replace ? { replace: true } : {}),
        ...(options?.state === undefined ? {} : { state: options.state }),
      });
      latest.current = target;
    },
    [navigate],
  );
  const leaveSettings = useCallback<WorkspaceNavigation["leaveSettings"]>(() => {
    interact();
    void navigate(settingsReturn.current);
  }, [navigate]);
  const back = useCallback(() => {
    interact();
    void navigate(-1);
  }, [navigate]);
  const openConversation = useCallback<WorkspaceNavigation["openConversation"]>(
    (path, options) => {
      interact();
      const params = placeOnly(latest.current.search);
      if (options?.messageId) params.set("messageId", options.messageId);
      go(
        { pathname: path, search: searchString(params) },
        options?.focusRequest ? { focusRequest: options.focusRequest } : undefined,
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
  const currentScope = useRef({ deploymentId, userId });
  currentScope.current = { deploymentId, userId };
  const showPendingBrowserTab = useCallback<WorkspaceNavigation["showPendingBrowserTab"]>(
    (idempotencyKey, options) =>
      choosePlace({ kind: "pending", idempotencyKey }, undefined, options),
    [choosePlace],
  );
  const replacePendingBrowserTab = useCallback<WorkspaceNavigation["replacePendingBrowserTab"]>(
    (idempotencyKey, destination) => {
      if (
        currentScope.current.deploymentId !== deploymentId ||
        currentScope.current.userId !== userId
      )
        return;
      const selected = placeSelection(new URLSearchParams(latest.current.search));
      if (selected.kind === "pending" && selected.idempotencyKey === idempotencyKey)
        choosePlace({ kind: "place", destination }, undefined, { chosen: false, replace: true });
    },
    [choosePlace, deploymentId, userId],
  );
  const showPlace = useCallback(
    (destination: SurfaceDestination) => choosePlace({ kind: "place", destination }),
    [choosePlace],
  );
  const showPlaceWithConversation = useCallback(
    (destination: SurfaceDestination, path: string) =>
      choosePlace({ kind: "place", destination }, path),
    [choosePlace],
  );
  const openLauncher = useCallback(
    (options: Parameters<WorkspaceNavigation["showLauncher"]>[0] & { chosen?: false } = {}) => {
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
        ...(options.chosen === false ? { chosen: false } : {}),
        replace: options.replace === true,
        state: {
          startFrom: from,
          startId: `${Date.now().toString(36)}-${openings}`,
          ...(options.address === undefined
            ? {}
            : { startAddress: options.address, startOpen: true }),
        },
      });
    },
    [choosePlace],
  );
  const showLauncher = useCallback<WorkspaceNavigation["showLauncher"]>(
    (options) => openLauncher(options),
    [openLauncher],
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
        choosePlace({ kind: "place", destination: successor }, undefined, {
          chosen: false,
          replace: true,
        });
      else openLauncher({ chosen: false, replace: true });
    },
    [choosePlace, openLauncher],
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
    (options: { readonly replace?: boolean } = {}) => {
      interact();
      operation.current += 1;
      const mine = operation.current;
      const epoch = placeEpoch.current;
      return (destination: SurfaceDestination) => {
        if (operation.current !== mine || placeEpoch.current !== epoch) return;
        choosePlace({ kind: "place", destination }, undefined, {
          replace: options.replace === true,
        });
      };
    },
    [choosePlace],
  );

  const address = useCallback(() => latest.current, []);
  const present = useCallback<WorkspaceNavigation["present"]>(
    ({ path, place }) => {
      const before = latest.current;
      if (place) choosePlace({ kind: "place", destination: place }, path, { chosen: false });
      // The conversation already shown keeps its address, anchor and all.
      else if (path !== undefined && path !== before.pathname)
        go({ pathname: path, search: searchString(placeOnly(before.search)) });
      if (latest.current !== before) presented.current = latest.current;
    },
    [choosePlace, go],
  );

  return useMemo(
    () => ({
      address,
      back,
      beginPlaceOperation,
      conversationHref,
      hideComputer,
      leaveLauncher,
      leaveSettings,
      openConversation,
      openPage,
      placeSearch,
      present,
      showComputer,
      showLauncher,
      showPendingBrowserTab,
      replacePendingBrowserTab,
      showPlace,
      showPlaceWithConversation,
      succeedPlace,
      threadPath,
    }),
    [
      address,
      back,
      beginPlaceOperation,
      conversationHref,
      hideComputer,
      leaveLauncher,
      leaveSettings,
      openConversation,
      openPage,
      placeSearch,
      present,
      showComputer,
      showLauncher,
      showPendingBrowserTab,
      replacePendingBrowserTab,
      showPlace,
      showPlaceWithConversation,
      succeedPlace,
      threadPath,
    ],
  );
}
