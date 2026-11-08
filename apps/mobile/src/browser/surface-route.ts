import {
  browserPagePart,
  browserSiteLabel,
  browserTabTitle,
  nativeViewerSource,
  type BrowserSessionSummary,
  type BrowserTabSummary,
  type TaskSurfaceDestination,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import { AppIdSchema, type BrowserPageContentPart } from "@opensteer/core";
import { isRecord } from "@opensteer/shared/isRecord";

/**
 * Where a tab route was opened from: a conversation's own tab or app carries
 * that conversation (the task scope), one from Tabs or the sidebar is the
 * workspace scope. The screen is the same either way — who is in the page
 * comes from its occupants — so the origin decides only where Back goes, which
 * the stack already knows. A task-scope app names that task's own session of
 * it; a phone is its own address.
 */
type SurfacesScope =
  | { readonly scope?: undefined; readonly threadId: string }
  | { readonly scope: "workspace"; readonly threadId?: undefined };

/** Exactly one tab, app or phone. Nothing but the route chooses it. */
type SurfacesTarget =
  | {
      readonly sessionId: string;
      readonly tabId: string;
      readonly editAddress?: boolean;
      /** A popup the person's input opened: when it ends they return to the page under it. */
      readonly popup?: boolean;
      readonly appId?: never;
      readonly machineId?: never;
      readonly computerSessionId?: never;
      readonly appKey?: never;
      readonly phone?: never;
      readonly viewId?: never;
      readonly generation?: never;
      readonly windowId?: never;
    }
  | {
      readonly sessionId?: never;
      readonly tabId?: never;
      readonly editAddress?: never;
      readonly popup?: never;
      readonly appId?: never;
      readonly machineId?: string;
      /** A task's own session on the app or phone. */
      readonly computerSessionId?: string;
      readonly appKey?: string;
      readonly phone?: boolean;
      /** The person's own view, by its exact generation; never a task's session. */
      readonly viewId?: string;
      readonly generation?: number;
      /** The Mac window an owner view binds, so the route names what is shown. */
      readonly windowId?: number;
    }
  | {
      /** An Opensteer App's tab. Its view address is a capability and never rides in a route. */
      readonly appId: string;
      readonly sessionId?: never;
      readonly tabId?: never;
      readonly editAddress?: never;
      readonly popup?: never;
      readonly machineId?: never;
      readonly computerSessionId?: never;
      readonly appKey?: never;
      readonly phone?: never;
      readonly viewId?: never;
      readonly generation?: never;
      readonly windowId?: never;
    };

/**
 * The page screen's route: exactly one tab, app or phone. The route is the
 * only place the selection lives, so a link names exactly what it opens. A
 * previous release's route for a conversation's grid names no place, and
 * still parses.
 */
export type SurfacesRoute = {
  readonly deploymentId: string;
  readonly pendingBrowserTab?: string;
} & SurfacesScope &
  SurfacesTarget;

export type OpensteerAppDestination = Extract<
  WorkspaceSurfaceDestination,
  { kind: "opensteer-app" }
>;

/** One of a conversation's own tabs or apps, opened from that conversation. */
export function surfaceRoute(
  deploymentId: string,
  threadId: string,
  destination: TaskSurfaceDestination | OpensteerAppDestination,
): SurfacesRoute {
  return { deploymentId, threadId, ...targetParams(destination) };
}

/** A tab, app or phone opened from Tabs or the sidebar, alone. */
export function workspaceRoute(
  deploymentId: string,
  destination: WorkspaceSurfaceDestination,
): SurfacesRoute {
  return { deploymentId, scope: "workspace", ...targetParams(destination) };
}

function targetParams(destination: WorkspaceSurfaceDestination): SurfacesTarget {
  if (destination.kind === "opensteer-app") return { appId: destination.appId };
  if (destination.kind === "browser")
    return { sessionId: destination.sessionId, tabId: destination.tabId };
  if (destination.kind === "phone") return { machineId: destination.machineId, phone: true };
  const { appKey, machineId } = destination;
  const source = nativeViewerSource(destination);
  return source.kind === "owner-view"
    ? {
        appKey,
        generation: source.generation,
        machineId,
        viewId: source.viewId,
        ...(destination.windowId !== undefined ? { windowId: destination.windowId } : {}),
      }
    : { appKey, computerSessionId: source.sessionId, machineId };
}

/** The parts of a route that name what it opens. */
interface TargetFields {
  readonly appId?: string | undefined;
  readonly appKey?: string | undefined;
  readonly computerSessionId?: string | undefined;
  readonly generation?: number | undefined;
  readonly machineId?: string | undefined;
  readonly phone?: boolean | undefined;
  readonly sessionId?: string | undefined;
  readonly tabId?: string | undefined;
  readonly viewId?: string | undefined;
  readonly windowId?: number | undefined;
}

/** What a route names, or null for one that names nothing (a previous release's grid). */
export function routeDestination(route: TargetFields): WorkspaceSurfaceDestination | null {
  if (route.appId !== undefined)
    return AppIdSchema.safeParse(route.appId).success
      ? { appId: route.appId, kind: "opensteer-app" }
      : null;
  if (route.sessionId !== undefined && route.tabId !== undefined) {
    return { kind: "browser", sessionId: route.sessionId, tabId: route.tabId };
  }
  if (route.machineId === undefined) return null;
  if (route.phone === true) return { kind: "phone", machineId: route.machineId };
  if (route.appKey === undefined) return null;
  const app = { appKey: route.appKey, kind: "app" as const, machineId: route.machineId };
  if (route.viewId !== undefined && route.generation !== undefined)
    return {
      ...app,
      ...(route.windowId !== undefined ? { windowId: route.windowId } : {}),
      source: { generation: route.generation, kind: "owner-view", viewId: route.viewId },
    };
  if (route.computerSessionId !== undefined)
    return { ...app, computerSessionId: route.computerSessionId };
  return null;
}

/** What a tabs route held in the stack names, read from its untyped params. */
export function paramsDestination(params: unknown): WorkspaceSurfaceDestination | null {
  if (!isRecord(params)) return null;
  const text = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : undefined;
  };
  const generation = params["generation"];
  const windowId = params["windowId"];
  return routeDestination({
    appId: text("appId"),
    appKey: text("appKey"),
    computerSessionId: text("computerSessionId"),
    generation: typeof generation === "number" ? generation : undefined,
    machineId: text("machineId"),
    phone: params["phone"] === true,
    sessionId: text("sessionId"),
    tabId: text("tabId"),
    viewId: text("viewId"),
    windowId: typeof windowId === "number" ? windowId : undefined,
  });
}

/** Whether two destinations name the same tab, the same task session or the same view. */
export function sameDestination(
  left: WorkspaceSurfaceDestination | null,
  right: WorkspaceSurfaceDestination | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "browser" || right.kind === "browser")
    return (
      left.kind === "browser" &&
      right.kind === "browser" &&
      left.sessionId === right.sessionId &&
      left.tabId === right.tabId
    );
  return JSON.stringify(routeDestinationKey(left)) === JSON.stringify(routeDestinationKey(right));
}

function routeDestinationKey(
  destination: Exclude<WorkspaceSurfaceDestination, { kind: "browser" }>,
) {
  if (destination.kind === "opensteer-app") return [destination.kind, destination.appId];
  if (destination.kind === "phone") return [destination.kind, destination.machineId];
  return [
    destination.kind,
    destination.machineId,
    destination.appKey,
    destination.source?.kind === "owner-view"
      ? [destination.source.viewId, destination.source.generation]
      : (destination.computerSessionId ?? null),
  ];
}

/** The page's host as a person says it, or null for a page with no address worth naming. */
export function pageSite(url: string): string | null {
  if (!/^https?:\/\//iu.test(url)) return null;
  return browserSiteLabel(url).replace(/^www\./iu, "") || null;
}

/**
 * The page a person is looking at, as a message includes it: the exact tab,
 * and the title and address they saw. Null for a page with no web address,
 * which there is nothing to ask about.
 */
export function viewedPage(
  session: Pick<BrowserSessionSummary, "id">,
  tab: BrowserTabSummary,
): BrowserPageContentPart | null {
  if (tab.navigationFailed || pageSite(tab.url) === null) return null;
  try {
    return browserPagePart({
      sessionId: session.id,
      tabId: tab.id,
      title: browserTabTitle(tab),
      url: tab.url,
    });
  } catch {
    // A browser the Host never named as one cannot be included.
    return null;
  }
}

/** One page, whatever its title becomes: its browser, its tab and its address. */
export function pageIdentity(page: BrowserPageContentPart): string {
  return `${page.sessionId}\u0000${page.tabId}\u0000${page.url}`;
}
