import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { MobileClient, MobileClientState } from "../client/mobile-client.js";

const MobileClientContext = createContext<MobileClient | null>(null);

/**
 * The one client, reached from anywhere. Screens read it; none of them builds
 * one. `useSyncExternalStore` is the whole subscription: the client publishes an
 * immutable snapshot, so React re-renders exactly when the snapshot changes.
 */
export function MobileClientProvider(props: {
  readonly children: ReactNode;
  readonly client: MobileClient;
}): ReactNode {
  return (
    <MobileClientContext.Provider value={props.client}>
      {props.children}
    </MobileClientContext.Provider>
  );
}

export function useMobileClient(): MobileClient {
  const client = useContext(MobileClientContext);
  if (client === null) throw new Error("This screen was rendered outside the Opensteer app root.");
  return client;
}

export function useMobileState(): MobileClientState {
  const client = useMobileClient();
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}

/** The one attached Host client, re-rendering only when it is replaced or released. */
export function useSelectedHostClient(): HostClient | null {
  const client = useMobileClient();
  const read = useCallback(() => client.getSnapshot().selection.hostClient, [client]);
  return useSyncExternalStore(client.subscribe, read, read);
}

/**
 * One value read from a Host that may not be attached, re-rendering only when
 * that value changes — never for the stream of updates beneath it. `select`
 * returns a primitive or a reference the snapshot keeps, and `detached` is
 * what it reads while there is no Host.
 */
export function useHostValue<Value>(
  hostClient: HostClient | null,
  select: (snapshot: HostSnapshot) => Value,
  detached: Value,
): Value {
  const subscribe = useCallback(
    (listener: () => void) => hostClient?.subscribe(listener) ?? (() => undefined),
    [hostClient],
  );
  const read = useCallback(
    () => (hostClient === null ? detached : select(hostClient.getSnapshot())),
    [detached, hostClient, select],
  );
  return useSyncExternalStore(subscribe, read, read);
}

const selectUserId = (snapshot: HostSnapshot): string | null => snapshot.user?.id ?? null;

/** Who a Host client is serving, re-rendering only when that person changes. */
export function useHostUserId(hostClient: HostClient | null): string | null {
  return useHostValue(hostClient, selectUserId, null);
}

const unavailableSavedSurface = { source: "pending" } as const;

/** Saved values are presentation only. All Host hooks above remain live-only. */
export function useSavedSurface<Surface extends "home" | "tasks">(
  deploymentId: string | null,
  surface: Surface,
): import("../client/saved-view-presentation.js").SavedPresentationState[Surface] {
  const client = useMobileClient();
  const subscribe = useCallback(
    (listener: () => void) =>
      deploymentId === null ? () => undefined : client.savedViews.subscribe(listener),
    [client, deploymentId],
  );
  const read = useCallback(
    () =>
      deploymentId !== null &&
      client.getSnapshot().selection.deploymentId === deploymentId &&
      client.savedViews.getDeploymentId() === deploymentId
        ? client.savedViews.getSnapshot()[surface]
        : unavailableSavedSurface,
    [client, deploymentId, surface],
  );
  return useSyncExternalStore(subscribe, read, read);
}
