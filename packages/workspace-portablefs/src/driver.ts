import type { PortableFsWorkspaceBacking, Workspace } from "@opensteer/core";
import type {
  ProvisionWorkspaceInput,
  ProvisionWorkspaceResult,
  WorkspaceBackingLifecycleDriver,
  WorkspaceBackingHealth,
  WorkspaceBackingReadiness,
} from "@opensteer/workspace";
import type { PortableFsControlPlane } from "./control-plane.js";
import { PortableFsControlPlaneError, PortableFsError } from "./errors.js";
import type { PortableFsManagerVolume } from "./schemas.js";

type PortableFsWorkspace = Workspace & { readonly backing: PortableFsWorkspaceBacking };

interface PortableFsWorkspaceLifecycleDriverOptions {
  readonly controlPlane: PortableFsControlPlane;
  readonly serviceId: string;
}

/**
 * Durable Workspace provisioning and health for one exact PortableFS
 * authority. Runner grants remain in the Host because they also bind a live
 * Run, Runner boot, and membership generation.
 */
export class PortableFsWorkspaceLifecycleDriver implements WorkspaceBackingLifecycleDriver<"portablefs"> {
  readonly kind = "portablefs" as const;
  readonly #controlPlane: PortableFsControlPlane;
  readonly #serviceId: string;

  constructor(options: PortableFsWorkspaceLifecycleDriverOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(options.serviceId)) {
      throw new TypeError("PortableFS service identity is invalid");
    }
    this.#controlPlane = options.controlPlane;
    this.#serviceId = options.serviceId;
  }

  initialBacking(input: ProvisionWorkspaceInput<"portablefs">): PortableFsWorkspaceBacking {
    return {
      generation: 1,
      kind: "portablefs",
      serviceId: this.#serviceId,
      volumeId: pendingVolumeId(input.workspaceId),
    };
  }

  async preflight(signal?: AbortSignal): Promise<WorkspaceBackingReadiness> {
    const health = await this.#controlPlane.health(
      signal ? { signal, timeoutMs: 5_000 } : { timeoutMs: 5_000 },
    );
    return { available: true, detail: health.releaseId };
  }

  async admitsCreates(): Promise<boolean> {
    const capacity = await this.#controlPlane.capacity({ timeoutMs: 5_000 });
    const pool = capacity.pools.find((candidate) => candidate.pool === "product");
    if (!pool) {
      throw new Error("PortableFS capacity omitted the product pool");
    }
    return pool.create_admissible;
  }

  async destroy(
    input: { readonly workspace: PortableFsWorkspace },
    signal?: AbortSignal,
  ): Promise<void> {
    const workspace = input.workspace;
    this.#assertAuthority(workspace);
    let volumeId = workspace.backing.volumeId;
    if (volumeId === pendingVolumeId(workspace.id)) {
      if (workspace.capacityPolicy.kind !== "hard-quota") {
        throw configurationError("PortableFS Workspaces require an explicit hard quota policy");
      }
      const volume = await this.#controlPlane.createVolume(
        {
          owner: workspace.createdBy,
          quotaBytes: workspace.capacityPolicy.blockHardLimitBytes,
          quotaInodes: workspace.capacityPolicy.inodeHardLimit,
        },
        {
          idempotencyKey: `workspace:${workspace.id}:provision:v1`,
          ...(signal ? { signal } : {}),
        },
      );
      volumeId = volume.id;
    }
    await this.#controlPlane.destroyVolume(volumeId, {
      idempotencyKey: `workspace:${workspace.id}:destroy:v1`,
      ...(signal ? { signal } : {}),
    });
  }

  async provision(
    input: { readonly idempotencyKey: string; readonly workspace: PortableFsWorkspace },
    signal?: AbortSignal,
  ): Promise<ProvisionWorkspaceResult<"portablefs">> {
    const workspace = input.workspace;
    this.#assertAuthority(workspace);
    if (workspace.capacityPolicy.kind !== "hard-quota") {
      throw configurationError("PortableFS Workspaces require an explicit hard quota policy");
    }
    const pending = pendingVolumeId(workspace.id);
    let volume: PortableFsManagerVolume;
    if (workspace.backing.volumeId === pending) {
      volume = await this.#controlPlane.createVolume(
        {
          owner: workspace.createdBy,
          quotaBytes: workspace.capacityPolicy.blockHardLimitBytes,
          quotaInodes: workspace.capacityPolicy.inodeHardLimit,
        },
        {
          idempotencyKey: input.idempotencyKey,
          ...(signal ? { signal } : {}),
        },
      );
    } else {
      volume = await this.#controlPlane.getVolume(
        workspace.backing.volumeId,
        signal ? { signal } : {},
      );
    }
    const health = healthFromVolume(volume);
    return {
      backing: {
        ...workspace.backing,
        serviceId: this.#serviceId,
        volumeId: volume.id,
      },
      ...(health.restoreProgressPermille === undefined
        ? {}
        : { restoreProgressPermille: health.restoreProgressPermille }),
      status: health.status,
    };
  }

  async inspect(
    workspace: PortableFsWorkspace,
    signal?: AbortSignal,
  ): Promise<WorkspaceBackingHealth> {
    try {
      this.#assertAuthority(workspace);
      if (workspace.backing.volumeId === pendingVolumeId(workspace.id)) {
        return { issue: null, status: "provisioning" };
      }
      const volume = await this.#controlPlane.getVolume(
        workspace.backing.volumeId,
        signal ? { signal } : {},
      );
      return healthFromVolume(volume);
    } catch (error) {
      const issue = this.issueFromError(error);
      return { issue, status: issue.retryable ? "unavailable" : "failed" };
    }
  }

  issueFromError(error: unknown): NonNullable<Workspace["storageIssue"]> {
    return portableFsWorkspaceIssue(error);
  }

  #assertAuthority(workspace: PortableFsWorkspace): void {
    if (workspace.backing.serviceId !== this.#serviceId) {
      throw configurationError(
        "Workspace belongs to another PortableFS authority; migrate it explicitly before changing the binding",
      );
    }
  }
}

function portableFsWorkspaceIssue(error: unknown): NonNullable<Workspace["storageIssue"]> {
  const occurredAt = new Date().toISOString();
  if (error instanceof PortableFsControlPlaneError) {
    if (error.httpStatus === 401 || error.httpStatus === 403) {
      return {
        code: "manager-identity-rejected",
        message: "The PortableFS authority rejected this Host identity.",
        occurredAt,
        retryable: false,
      };
    }
    if (error.httpStatus === 409) {
      return {
        code: "manager-allocation-rejected",
        message: "PortableFS does not currently have capacity for this Workspace.",
        occurredAt,
        retryable: true,
      };
    }
    if (error.httpStatus !== undefined && error.httpStatus < 500 && !error.retryable) {
      return {
        code: "manager-configuration-invalid",
        message: "PortableFS rejected the configured Workspace storage binding.",
        occurredAt,
        retryable: false,
      };
    }
  }
  if (error instanceof PortableFsError && error.code === "protocol_error") {
    return {
      code: "manager-protocol-error",
      message: "The Host and PortableFS authority use incompatible storage contracts.",
      occurredAt,
      retryable: false,
    };
  }
  return {
    code: "manager-unavailable",
    message: "Workspace storage is temporarily unavailable.",
    occurredAt,
    retryable: true,
  };
}

function pendingVolumeId(workspaceId: Workspace["id"]): string {
  return `pending_${workspaceId}`;
}

/**
 * Every Manager volume state, mapped to what the Workspace looks like to the
 * rest of the Host. An unmapped state is a gap in *this* Host, not a broken
 * volume: it stays retryable and never terminal, because `failed` is terminal
 * for the reconcile loop and a Manager release ahead of this one would
 * otherwise fail the whole fleet in one pass.
 */
export function healthFromVolume(volume: PortableFsManagerVolume): WorkspaceBackingHealth {
  switch (volume.state) {
    case "READY":
      return { issue: null, status: "ready" };
    case "PROVISIONING":
      return { issue: null, status: "provisioning" };
    case "RESTORING": {
      const status = ["serving-restore", "converged"].includes(volume.restore_step ?? "")
        ? "ready"
        : "provisioning";
      return {
        issue: null,
        ...(volume.restore_progress_permille === undefined
          ? {}
          : { restoreProgressPermille: volume.restore_progress_permille }),
        status,
      };
    }
    case "FENCING":
      return { issue: null, status: "unavailable" };
    case "ARCHIVING":
      // The archive cycle is in flight: the filesystem is no longer servable
      // and no sealed archive exists yet, so this is neither `ready` nor
      // `archived`. `archive_cycle_step` reports how far the cycle has got and
      // is progress detail only — a Manager that has entered ARCHIVING without
      // publishing a step is still archiving, not faulted, and calling it
      // `unavailable` would both claim a fault that is not there and strand
      // the volume outside the wake path that cancels the cycle.
      return { issue: null, status: "archiving" };
    case "ARCHIVED":
      return { issue: null, status: "archived" };
    case "DESTROYED":
    case "QUARANTINED":
    case "RETIRED":
      return { issue: null, status: "failed" };
    default:
      return {
        issue: {
          code: "manager-unknown-volume-state",
          message: `PortableFS reported volume state ${volume.state}, which this Host does not map.`,
          occurredAt: new Date().toISOString(),
          retryable: true,
        },
        status: "unavailable",
      };
  }
}

function configurationError(message: string): PortableFsControlPlaneError {
  return new PortableFsControlPlaneError({
    httpStatus: 422,
    message,
    operation: "get-volume",
    retryable: false,
  });
}
