import type { WorkspaceTabLineage } from "@opensteer/protocol";
import type { HostClient, HostSnapshot } from "./client.js";
import { browserPlaceUnavailableReason } from "./places.js";
import { browserIdentity } from "./start-page-model.js";
import { viewerScopeOf } from "./viewer-scope.js";

type ActivationResult = NonNullable<
  Awaited<ReturnType<NonNullable<HostClient["activateWorkspaceTab"]>>>
>;
interface Activation {
  readonly promise: Promise<ActivationResult | null>;
  readonly cancel: (notify: boolean) => void;
}

interface ActivationPorts {
  readonly snapshot: () => HostSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (tabId: string) => Promise<ActivationResult>;
  readonly apply: (result: ActivationResult) => void;
  readonly changed: (ids: readonly string[]) => void;
}

/** Client-owned restoration survives selection changes and observes readiness before dispatch. */
export class WorkspaceTabActivations {
  readonly #pending = new Map<string, Activation>();
  #ids: readonly string[] = [];
  #disposed = false;

  readonly #ports: ActivationPorts;

  constructor(ports: ActivationPorts) {
    this.#ports = ports;
  }

  get ids(): readonly string[] {
    return this.#ids;
  }

  clear(notify = true): void {
    // Cancellation can publish a snapshot whose reader starts a replacement.
    const operations = [...this.#pending.values()];
    for (const operation of operations) operation.cancel(notify);
  }

  dispose(): void {
    this.#disposed = true;
    this.clear(false);
  }

  activate(tabId: string): Promise<ActivationResult | null> {
    if (this.#disposed) return Promise.resolve(null);
    const held = this.#pending.get(tabId);
    if (held) return held.promise;
    const scope = JSON.stringify(viewerScopeOf(this.#ports.snapshot()));
    let lineage: WorkspaceTabLineage | undefined;
    const read = () => {
      const snapshot = this.#ports.snapshot();
      const current = snapshot.workspaceTabs?.find(
        (group) => group.id === lineage?.id || group.tabs?.some((tab) => tab.id === tabId),
      );
      if (current) lineage = current;
      const placement = snapshot.browserPlacements.find(
        (value) => value.runnerId === lineage?.session.placement.runnerId,
      );
      // Omitted lineages and byte-bounded tab arrays cannot prove a close.
      const closed = !!current?.tabs && !current.tabs.some((tab) => tab.id === tabId);
      const reason = lineage
        ? browserPlaceUnavailableReason(
            browserIdentity(lineage.session.profileId, snapshot.browserProfiles),
            lineage.unavailableReason,
            placement?.unavailableReason,
          )
        : null;
      return {
        ended:
          this.#disposed || JSON.stringify(viewerScopeOf(snapshot)) !== scope || closed || !!reason,
        ready: !!lineage && snapshot.connection === "connected" && placement?.available === true,
        key: JSON.stringify([
          snapshot.connection,
          lineage?.session.placement.runnerId,
          placement?.available,
          placement?.runtimeId,
        ]),
      };
    };
    let state = read();
    let revision = 0;
    let settled = false;
    let unsubscribe = () => {};
    let wake: (() => void) | null = null;
    let resolve!: (value: ActivationResult | null) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ActivationResult | null>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const finish = (
      value: ActivationResult | null,
      failure?: { error: unknown },
      notify = true,
    ) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (this.#pending.get(tabId) === operation) {
        this.#pending.delete(tabId);
        this.#ids = [...this.#pending.keys()];
        if (notify) this.#ports.changed(this.#ids);
      }
      wake?.();
      if (failure) reject(failure.error);
      else resolve(value);
    };
    const operation: Activation = { promise, cancel: (notify) => finish(null, undefined, notify) };
    this.#pending.set(tabId, operation);
    this.#ids = [...this.#pending.keys()];
    const observe = () => {
      const next = read();
      const changed = next.key !== state.key;
      if (changed) revision++;
      state = next;
      if (state.ended) finish(null);
      else if (changed) wake?.();
    };
    unsubscribe = this.#ports.subscribe(observe);
    this.#ports.changed(this.#ids);
    const wait = async (since: number) => {
      while (!settled && revision === since) {
        await new Promise<void>((resume) => {
          wake = resume;
        });
        wake = null;
      }
    };
    const run = async () => {
      while (!settled) {
        observe();
        if (settled) return;
        if (!state.ready) {
          await wait(revision);
          continue;
        }
        const before = revision;
        let result: ActivationResult;
        try {
          result = await this.#ports.dispatch(tabId);
        } catch (error) {
          observe();
          if (settled) return;
          if (!(
            error &&
            typeof error === "object" &&
            "reason" in error &&
            error.reason === "browser-placement-waiting"
          ))
            throw error;
          // A readiness change during the request already earns the next attempt.
          await wait(before);
          continue;
        }
        observe();
        if (settled) return;
        this.#ports.apply(result);
        finish(result);
      }
    };
    void run().catch((error: unknown) => finish(null, { error }));
    return promise;
  }
}
