import {
  browserPagePart,
  browserSiteLabel,
  browserTabTitle,
  nativeViewerSource,
  type BrowserSessionSummary,
  type BrowserTabSummary,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import type { BrowserPageContentPart } from "@opensteer/core";
import { isRecord } from "@opensteer/shared/isRecord";

/**
 * Which conversation a tabs route belongs to. A conversation's own tabs — its
 * grid, or one of them over its sheet — are the task scope. A tab opened from
 * Tabs or the sidebar is the workspace scope and belongs to none: it is shown
 * alone, whatever was in front when it was chosen. (A previous release's
 * workspace route carried a conversation; it is ignored.)
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
      readonly machineId?: never;
      readonly computerSessionId?: never;
      readonly appKey?: never;
      readonly phone?: never;
      readonly viewId?: never;
      readonly generation?: never;
    }
  | {
      readonly sessionId?: never;
      readonly tabId?: never;
      readonly editAddress?: never;
      readonly machineId?: string;
      /** A task's own session on the app or phone. */
      readonly computerSessionId?: string;
      readonly appKey?: string;
      readonly phone?: boolean;
      /** The person's own view, by its exact generation; never a task's session. */
      readonly viewId?: string;
      readonly generation?: number;
    };

/**
 * The tabs screen's route: a conversation's grid of tabs and apps, or exactly
 * one of them. The route is the only place the selection lives, so Back from a
 * tab returns to the grid it was opened from and a link names exactly what it
 * opens.
 */
export type SurfacesRoute = { readonly deploymentId: string } & SurfacesScope & SurfacesTarget;

/**
 * A tab, app or phone over a conversation's sheet: one of its own, or one an
 * agent showed together with that conversation.
 */
export function surfaceRoute(
  deploymentId: string,
  threadId: string,
  destination: WorkspaceSurfaceDestination,
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
  if (destination.kind === "browser")
    return { sessionId: destination.sessionId, tabId: destination.tabId };
  const kind = destination.kind === "phone" ? { phone: true } : { appKey: destination.appKey };
  const source = nativeViewerSource(destination);
  return source.kind === "owner-view"
    ? {
        ...kind,
        generation: source.generation,
        machineId: destination.machineId,
        viewId: source.viewId,
      }
    : { ...kind, computerSessionId: source.sessionId, machineId: destination.machineId };
}

/** The parts of a route that name what it opens. */
interface TargetFields {
  readonly appKey?: string | undefined;
  readonly computerSessionId?: string | undefined;
  readonly generation?: number | undefined;
  readonly machineId?: string | undefined;
  readonly phone?: boolean | undefined;
  readonly sessionId?: string | undefined;
  readonly tabId?: string | undefined;
  readonly viewId?: string | undefined;
}

/** What a route names, or null for the grid. */
export function routeDestination(route: TargetFields): WorkspaceSurfaceDestination | null {
  if (route.sessionId !== undefined && route.tabId !== undefined) {
    return { kind: "browser", sessionId: route.sessionId, tabId: route.tabId };
  }
  if (route.machineId === undefined || (route.phone !== true && route.appKey === undefined))
    return null;
  const kind =
    route.phone === true
      ? { kind: "phone" as const }
      : { appKey: route.appKey!, kind: "app" as const };
  if (route.viewId !== undefined && route.generation !== undefined)
    return {
      ...kind,
      machineId: route.machineId,
      source: { generation: route.generation, kind: "owner-view", viewId: route.viewId },
    };
  if (route.computerSessionId !== undefined)
    return { ...kind, computerSessionId: route.computerSessionId, machineId: route.machineId };
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
  return routeDestination({
    appKey: text("appKey"),
    computerSessionId: text("computerSessionId"),
    generation: typeof generation === "number" ? generation : undefined,
    machineId: text("machineId"),
    phone: params["phone"] === true,
    sessionId: text("sessionId"),
    tabId: text("tabId"),
    viewId: text("viewId"),
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
  return [
    destination.kind,
    destination.machineId,
    destination.kind === "app" ? destination.appKey : null,
    destination.source?.kind === "owner-view"
      ? [destination.source.viewId, destination.source.generation]
      : (destination.computerSessionId ?? null),
  ];
}

/** The page's host, or null for a page with no address worth naming. */
export function pageSite(url: string): string | null {
  if (!/^https?:\/\//iu.test(url)) return null;
  return browserSiteLabel(url) || null;
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
  if (pageSite(tab.url) === null) return null;
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
