import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ComputerAppIdentity, MachineSummary } from "@opensteer/protocol";
import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";

const retryAfterMs = 60_000;

function canReadAppIcons(machine: MachineSummary): boolean {
  return (
    machine.status === "online" &&
    machine.device?.platform !== "android" &&
    (machine.computerUse?.state === "ready" ||
      machine.computerUse?.state === "permission-required") &&
    machine.apps?.some(
      (app) =>
        app.definitionId === "macos-app" &&
        app.operations.length > 0 &&
        app.operations.every((operation) => operation.state !== "unavailable"),
    ) === true
  );
}

/** One authority owns all readers; invalidation fences both cached bytes and pending reads. */
class AppIconOwner {
  readonly #hostClient: HostClient;
  readonly #icons = new Map<
    string,
    { machineId: string; read: Promise<string | null>; retryAt: number }
  >();
  readonly #listeners = new Set<() => void>();
  readonly #machineGenerations = new Map<string, number>();
  #eligibleMachines = new Set<string>();
  #unsubscribe: (() => void) | null = null;
  #scope: string | null = null;
  #generation = 0;
  #nextGeneration = 0;
  constructor(hostClient: HostClient) {
    this.#hostClient = hostClient;
    this.#sync();
  }
  #authority(): string | null {
    const snapshot = this.#hostClient.getSnapshot();
    return snapshot.session === "authenticated" &&
      snapshot.connection === "connected" &&
      snapshot.user
      ? JSON.stringify([snapshot.deploymentId, snapshot.user.id])
      : null;
  }
  #sync = (): void => {
    const scope = this.#authority();
    const eligible = new Set(
      this.#hostClient
        .getSnapshot()
        .machines.filter(canReadAppIcons)
        .map((machine) => machine.id),
    );
    let changed = false;
    if (scope !== this.#scope) {
      this.#scope = scope;
      this.#icons.clear();
      this.#machineGenerations.clear();
      this.#generation = ++this.#nextGeneration;
      changed = true;
    } else {
      for (const machineId of new Set([...this.#eligibleMachines, ...eligible])) {
        if (this.#eligibleMachines.has(machineId) === eligible.has(machineId)) continue;
        this.#machineGenerations.set(machineId, ++this.#nextGeneration);
        for (const [key, entry] of this.#icons)
          if (entry.machineId === machineId) this.#icons.delete(key);
        changed = true;
      }
    }
    this.#eligibleMachines = eligible;
    if (changed) for (const listener of this.#listeners) listener();
  };
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#unsubscribe ??= this.#hostClient.subscribe(this.#sync);
    this.#sync();
    return () => {
      this.#listeners.delete(listener);
      if (!this.#listeners.size) {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        this.#icons.clear();
        this.#scope = null;
        this.#eligibleMachines.clear();
        this.#machineGenerations.clear();
        this.#generation = ++this.#nextGeneration;
      }
    };
  };
  generation = (machineId: string | null | undefined): number =>
    (machineId ? this.#machineGenerations.get(machineId) : undefined) ?? this.#generation;
  read(machineId: string, identity: ComputerAppIdentity): Promise<string | null> {
    this.#sync();
    if (
      this.#scope === null ||
      !this.#hostClient
        .getSnapshot()
        .machines.some((machine) => machine.id === machineId && canReadAppIcons(machine))
    )
      return Promise.resolve(null);
    const generation = this.generation(machineId);
    const key = JSON.stringify([machineId, identity.bundleId.toLowerCase()]);
    const cached = this.#icons.get(key);
    if (cached && cached.retryAt > Date.now()) return cached.read;
    const entry = { machineId, retryAt: Infinity, read: Promise.resolve<string | null>(null) };
    entry.read = this.#hostClient.rpc["integration.computer.apps.installed"]({
      icons: true,
      limit: 20,
      offset: 0,
      query: identity.displayName,
      runnerId: machineId,
    })
      .then(unwrapRpcResult)
      .then(({ apps, unavailableReason }) => {
        if (unavailableReason) entry.retryAt = Date.now() + retryAfterMs;
        this.#sync();
        return generation === this.generation(machineId)
          ? (apps.find(
              (app) => app.identity.bundleId.toLowerCase() === identity.bundleId.toLowerCase(),
            )?.iconPng ?? null)
          : null;
      })
      .catch(() => {
        entry.retryAt = Date.now() + retryAfterMs;
        return null;
      });
    this.#icons.set(key, entry);
    if (this.#icons.size > 256) this.#icons.delete(this.#icons.keys().next().value!);
    return entry.read;
  }
}
const owners = new WeakMap<HostClient, AppIconOwner>();
function sharedAppIcons(hostClient: HostClient): AppIconOwner {
  let owner = owners.get(hostClient);
  if (!owner) {
    owner = new AppIconOwner(hostClient);
    owners.set(hostClient, owner);
  }
  return owner;
}
const AppIconContext = createContext<AppIconOwner | null>(null);
const noSubscription = () => () => undefined;

export function AppIconProvider({
  children,
  hostClient,
}: {
  readonly children: ReactNode;
  readonly hostClient: HostClient;
}) {
  const owner = useMemo(() => sharedAppIcons(hostClient), [hostClient]);
  return <AppIconContext.Provider value={owner}>{children}</AppIconContext.Provider>;
}

/** The app's own icon from its Mac; an initial is drawn until an authorized read answers. */
export function useAppIcon(
  machineId: string | null | undefined,
  identity: ComputerAppIdentity,
): string | null {
  const owner = useContext(AppIconContext);
  const getGeneration = useCallback(() => owner?.generation(machineId) ?? 0, [owner, machineId]);
  const generation = useSyncExternalStore(owner?.subscribe ?? noSubscription, getGeneration);
  const key = machineId ? JSON.stringify([machineId, identity.bundleId.toLowerCase()]) : null;
  const [icon, setIcon] = useState<{
    owner: AppIconOwner;
    generation: number;
    key: string;
    png: string;
  } | null>(null);
  useEffect(() => {
    if (!owner || !machineId || key === null) return;
    let current = true;
    void owner.read(machineId, identity).then((png) => {
      if (current && png) setIcon({ owner, generation, key, png });
    });
    return () => {
      current = false;
    };
  }, [owner, generation, key]);
  return icon?.owner === owner && icon?.generation === generation && icon?.key === key
    ? icon.png
    : null;
}
