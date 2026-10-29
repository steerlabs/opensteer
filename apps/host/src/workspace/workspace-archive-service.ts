import { randomUUID } from "node:crypto";
import { OpensteerError, type Workspace, type WorkspaceId } from "@opensteer/core";
import type { PortableFsWorkspaceBacking } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import {
  healthFromVolume,
  PortableFsControlPlaneError,
  type PortableFsControlPlane,
} from "@opensteer/workspace-portablefs";
import type { WorkspaceMountService } from "./workspace-mount-service.js";

const archivePageSize = 100;
// One page is a batch of independent Manager mutations, so it is bounded rather
// than fanned out whole: the Manager enforces per-cell archive caps and the
// Host has other work on the same reconcile pass.
const archiveConcurrency = 4;
// Manager statuses that mean "not now" rather than "broken": a benign state
// conflict such as a volume that is already archiving, a rate limit, or a
// Manager shedding load. The sweep runs again.
const busyArchiveStatuses: readonly number[] = [409, 429, 503];
// The Manager answers 501 for "archiving is not supported here": a cell with no
// archive configuration, or a Manager with no archive verifier.
const archiveUnsupportedStatus = 501;

type PortableFsWorkspace = Workspace & { readonly backing: PortableFsWorkspaceBacking };

type ArchiveStore = Pick<
  OpensteerStore,
  | "claimPortableFsWorkspaceForArchive"
  | "listArchiveEligibleWorkspaces"
  | "listWorkspaceMounts"
  | "setWorkspaceStorageState"
>;

export interface WorkspaceFilesSessionEvictor {
  evictSession(workspace: PortableFsWorkspace): Promise<void>;
}

export class WorkspaceArchiveService {
  readonly #archiveAfterMs: number;
  readonly #controlPlane: Pick<PortableFsControlPlane, "archiveVolume">;
  readonly #files: WorkspaceFilesSessionEvictor | undefined;
  readonly #mounts: Pick<WorkspaceMountService, "evictIdle">;
  readonly #now: () => number;
  readonly #onError: (error: unknown, workspaceId: WorkspaceId) => void;
  readonly #onSkip: (workspaceId: WorkspaceId, reason: string) => void;
  readonly #store: ArchiveStore;

  constructor(options: {
    readonly archiveAfterDays: number;
    readonly controlPlane: Pick<PortableFsControlPlane, "archiveVolume">;
    readonly files?: WorkspaceFilesSessionEvictor;
    readonly mounts: Pick<WorkspaceMountService, "evictIdle">;
    readonly now?: () => number;
    readonly onError?: (error: unknown, workspaceId: WorkspaceId) => void;
    readonly onSkip?: (workspaceId: WorkspaceId, reason: string) => void;
    readonly store: ArchiveStore;
  }) {
    if (!Number.isSafeInteger(options.archiveAfterDays) || options.archiveAfterDays <= 0) {
      throw new TypeError("Workspace archive policy requires a positive whole-day threshold");
    }
    this.#archiveAfterMs = options.archiveAfterDays * 24 * 60 * 60 * 1_000;
    this.#controlPlane = options.controlPlane;
    this.#files = options.files;
    this.#mounts = options.mounts;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => undefined);
    this.#onSkip = options.onSkip ?? (() => undefined);
    this.#store = options.store;
  }

  async sweep(): Promise<void> {
    const idleBefore = new Date(this.#now() - this.#archiveAfterMs);
    let after: WorkspaceId | undefined;
    while (true) {
      const page = await this.#store.listArchiveEligibleWorkspaces({
        ...(after ? { after } : {}),
        idleBefore,
        limit: archivePageSize,
      });
      await this.#archivePage(page, idleBefore);
      const last = page.at(-1);
      if (!last || page.length < archivePageSize) return;
      after = last.id;
    }
  }

  async #archivePage(page: readonly Workspace[], idleBefore: Date): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const workspace = page[next++];
        if (!workspace) return;
        await this.#archive(workspace, idleBefore);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(archiveConcurrency, page.length) }, () => worker()),
    );
  }

  async #archive(workspace: Workspace, idleBefore: Date): Promise<void> {
    try {
      const liveMounts = await this.#store.listWorkspaceMounts(workspace.id);
      if (liveMounts.length > 0) {
        await this.#mounts.evictIdle(workspace.id);
        this.#onSkip(workspace.id, "mounts-evicted");
        return;
      }
      // Once a prior pass has evicted every machine mount, the claim is the
      // archive admission. A page is worked through at bounded concurrency, so
      // this can run minutes after the listing snapshot; the claim re-tests
      // eligibility against the same cutoff and advances the Files fence.
      // Everything below reads the claimed Workspace, never the listing snapshot.
      const initiated = await this.#initiate(workspace, idleBefore);
      if (!initiated) return;
      // Quiesce step: fence + evict any live Files-gateway read session,
      // so a pre-initiation grant cannot re-install one behind the archive
      // cycle. Best effort by contract: the authority stop kills surviving
      // sessions, so a gateway outage must not block archiving.
      if (this.#files) {
        try {
          await this.#files.evictSession(initiated);
        } catch (error) {
          this.#onError(error, workspace.id);
        }
      }
      // A crash between the claim and here burns one generation. Generations
      // are monotonic counters, never coordinates, so a gap costs nothing, and
      // the still-idle Workspace is re-claimed by the next sweep.
      const volume = await this.#controlPlane.archiveVolume(initiated.backing.volumeId, {
        idempotencyKey: `workspace:${workspace.id}:archive:${randomUUID()}`,
      });
      const health = healthFromVolume(volume);
      await this.#store.setWorkspaceStorageState({
        issue: health.issue,
        status: health.status,
        workspaceId: workspace.id,
      });
    } catch (error) {
      if (isManagerBusy(error)) {
        this.#onSkip(workspace.id, "manager-busy");
        return;
      }
      try {
        this.#onError(archiveNotSupported(error) ?? error, workspace.id);
      } catch {
        // One bad logger must not prevent later eligible Workspaces from being archived.
      }
    }
  }

  async #initiate(
    workspace: Workspace,
    idleBefore: Date,
  ): Promise<PortableFsWorkspace | undefined> {
    if (workspace.backing.kind !== "portablefs") return undefined;
    let claimed: Workspace;
    try {
      claimed = await this.#store.claimPortableFsWorkspaceForArchive({
        backingGeneration: workspace.backing.generation,
        idleBefore,
        workspaceId: workspace.id,
      });
    } catch (error) {
      // Eligibility came from a listing snapshot. A Workspace that was used,
      // woken, deleted, or claimed by another Host's sweep in between is simply
      // no longer eligible — a lost race is normal flow, not an operator-facing
      // failure, so it is skipped without an error report.
      if (error instanceof OpensteerError && error.code === "conflict") {
        this.#onSkip(workspace.id, "no-longer-eligible");
        return undefined;
      }
      throw error;
    }
    return claimed.backing.kind === "portablefs" ? (claimed as PortableFsWorkspace) : undefined;
  }
}

function isManagerBusy(error: unknown): boolean {
  return (
    error instanceof PortableFsControlPlaneError &&
    error.httpStatus !== undefined &&
    busyArchiveStatuses.includes(error.httpStatus)
  );
}

/**
 * A Manager that answers "archiving is not supported here" is describing this
 * Deployment, not this Workspace: nothing on the cell will ever archive, and
 * every sweep will keep advancing fences and evicting Files sessions for no
 * result. It is reported as an operator-facing failure so it is visible, rather
 * than folded into the quiet busy skip.
 */
function archiveNotSupported(error: unknown): WorkspaceArchiveUnsupportedError | undefined {
  if (
    !(error instanceof PortableFsControlPlaneError) ||
    error.httpStatus !== archiveUnsupportedStatus
  ) {
    return undefined;
  }
  return new WorkspaceArchiveUnsupportedError(error);
}

export class WorkspaceArchiveUnsupportedError extends Error {
  constructor(cause: PortableFsControlPlaneError) {
    super(
      "PortableFS reported that this cell cannot archive volumes. Workspace archiving is misconfigured for this Deployment: configure cell archive storage and a Manager archive verifier, or set the Workspace archive policy to disabled.",
      { cause },
    );
    this.name = "WorkspaceArchiveUnsupportedError";
  }
}
