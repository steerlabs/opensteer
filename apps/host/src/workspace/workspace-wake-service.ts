import { randomUUID } from "node:crypto";
import { workspaceWakesOnDemand, type WorkspaceId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { PortableFsControlPlane } from "@opensteer/workspace-portablefs";
import type { WorkspaceService } from "./workspace-service.js";

export class WorkspaceWakeService {
  readonly #active = new Map<WorkspaceId, Promise<void>>();
  readonly #controlPlane: Pick<PortableFsControlPlane, "wakeVolume">;
  readonly #onError: (error: unknown, workspaceId: WorkspaceId, reason: string) => void;
  readonly #store: Pick<OpensteerStore, "getWorkspace" | "setWorkspaceStorageState">;
  readonly #workspaces: Pick<WorkspaceService, "recordControlPlaneFailure">;

  constructor(options: {
    readonly controlPlane: Pick<PortableFsControlPlane, "wakeVolume">;
    readonly onError?: (error: unknown, workspaceId: WorkspaceId, reason: string) => void;
    readonly store: Pick<OpensteerStore, "getWorkspace" | "setWorkspaceStorageState">;
    readonly workspaces: Pick<WorkspaceService, "recordControlPlaneFailure">;
  }) {
    this.#controlPlane = options.controlPlane;
    this.#onError = options.onError ?? (() => undefined);
    this.#store = options.store;
    this.#workspaces = options.workspaces;
  }

  wake(workspaceId: WorkspaceId, reason: string): Promise<void> {
    const existing = this.#active.get(workspaceId);
    if (existing) return existing;
    const wake = this.#wake(workspaceId, reason)
      .catch((error: unknown) => this.#failed(workspaceId, reason, error))
      .finally(() => {
        if (this.#active.get(workspaceId) === wake) this.#active.delete(workspaceId);
      });
    this.#active.set(workspaceId, wake);
    return wake;
  }

  /**
   * A quiescing archive is woken exactly like a sealed one: the Manager's wake
   * cancels an archive cycle that has not sealed yet and returns the volume to
   * READY, which is what resolves a Run that arrives after the archive claim.
   */
  async #wake(workspaceId: WorkspaceId, _reason: string): Promise<void> {
    const workspace = await this.#store.getWorkspace(workspaceId);
    if (
      !workspace ||
      !workspaceWakesOnDemand(workspace.status) ||
      workspace.backing.kind !== "portablefs"
    ) {
      return;
    }
    await this.#controlPlane.wakeVolume(workspace.backing.volumeId, {
      // Per call, not per lifecycle: wake is state-machine-idempotent at the
      // Manager (a second wake converges on the same volume), while a stable
      // key would let a 24-hour-old Manager receipt satisfy a later cycle's
      // wake and return a stale volume.
      idempotencyKey: `workspace:${workspace.id}:wake:${randomUUID()}`,
    });
    await this.#store.setWorkspaceStorageState({
      issue: null,
      status: "provisioning",
      workspaceId,
    });
  }

  async #failed(workspaceId: WorkspaceId, reason: string, error: unknown): Promise<void> {
    await this.#workspaces.recordControlPlaneFailure(workspaceId, error).catch(() => undefined);
    try {
      this.#onError(error, workspaceId, reason);
    } catch {
      // Wake failures already have a durable storage issue; logging cannot change the outcome.
    }
  }
}
