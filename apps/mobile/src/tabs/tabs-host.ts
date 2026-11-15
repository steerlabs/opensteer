import type {
  HostClient,
  LegacyHostSnapshot,
  TabsClient,
  TabsHostSnapshot,
  TabsReadModel,
} from "@opensteer/client/host";
import { WindowIdSchema, type ComputerAppIdentity, type WindowId } from "@opensteer/core";

/*
 * Integration seam, to delete when the shared client lands: its HostClient
 * implements TabsClient and its snapshot is TabsHostSnapshot. Until then these
 * narrow the frozen contracts; nothing here adds behavior.
 */
type TabsSnapshot = LegacyHostSnapshot & Partial<TabsHostSnapshot>;

/** The Host's tab catalog and layout, or null before this client carries one. */
export function selectTabs(snapshot: LegacyHostSnapshot): TabsReadModel | null {
  return (snapshot as TabsSnapshot).tabs ?? null;
}

/** Bumped on every apps change notice and reconnect; an open Apps page rereads on it. */
export function selectAppsRevision(snapshot: LegacyHostSnapshot): number {
  return (snapshot as TabsSnapshot).appsRevision ?? 0;
}

export function tabsClient(hostClient: HostClient): TabsClient {
  return hostClient as HostClient & TabsClient;
}

/** One of a Mac app's windows to open, by its opaque handle when the client has one. */
export interface AppWindowChoice {
  readonly windowId: WindowId | null;
  readonly title: string;
}

/**
 * A Mac app's windows for the picker. Until the shared client returns opaque
 * window handles, a window without one opens through its app's bundle instead;
 * a numeric OS window number never becomes a tab identity.
 */
export async function computerAppWindows(
  hostClient: HostClient,
  machineId: string,
  app: ComputerAppIdentity,
): Promise<readonly AppWindowChoice[]> {
  const windows = await hostClient.listComputerAppWindows(machineId, app);
  return windows.map((window) => {
    const parsed = WindowIdSchema.safeParse((window as { readonly windowId?: unknown }).windowId);
    return { title: window.title, windowId: parsed.success ? parsed.data : null };
  });
}
