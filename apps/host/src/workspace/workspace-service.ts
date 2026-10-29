import { createHash } from "node:crypto";
import {
  OpensteerError,
  WorkspaceIdSchema,
  type DeploymentShape,
  type EnvironmentId,
  type UserId,
  type Workspace,
  type WorkspaceCapacityPolicy,
  type WorkspaceIconName,
  type MarkColor,
  type WorkspaceId,
  type WorkspaceKind,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import {
  WorkspaceViewSchema,
  workspaceViewFromWorkspace,
  type WorkspaceView,
} from "@opensteer/protocol";
import {
  WorkspaceAuthorityUnreachableError,
  assertBackingAllowedByDeployment,
  type WorkspaceStorageChoice,
  type WorkspaceBackingHealth,
  type WorkspaceBackingLifecycleDriver,
  type WorkspaceBackingReadiness,
  workspaceUsesBacking,
} from "@opensteer/workspace";

const mainWorkspaceName = "Main";

/**
 * Where an agent's or Trigger's new Workspace lives: the backing it asked for,
 * else the Deployment's default, and for a local directory the machine it
 * named, else the machine it is running on. Anywhere else would surprise it.
 */
export function callerWorkspaceStorage(input: {
  readonly callerEnvironmentId: EnvironmentId;
  readonly defaultBacking: WorkspaceStorageChoice["backing"];
  readonly requested:
    | { readonly backing: "local-directory"; readonly environmentId?: EnvironmentId | undefined }
    | { readonly backing: "portablefs" }
    | undefined;
}): WorkspaceStorageChoice {
  const backing = input.requested?.backing ?? input.defaultBacking;
  if (backing === "portablefs") return { backing };
  return {
    backing,
    environmentId:
      (input.requested?.backing === "local-directory"
        ? input.requested.environmentId
        : undefined) ?? input.callerEnvironmentId,
  };
}

interface WorkspaceLifecycleDrivers {
  readonly local?: WorkspaceBackingLifecycleDriver<"local-directory">;
  readonly portableFs?: WorkspaceBackingLifecycleDriver<"portablefs">;
}

type WorkspaceStore = Pick<
  OpensteerStore,
  | "createWorkspace"
  | "findMainWorkspaceForOwner"
  | "getEnvironment"
  | "getWorkspaceForOwner"
  | "listWorkspaces"
  | "listWorkspacesByStatus"
  | "setWorkspaceIcon"
  | "setWorkspaceProvisioningResult"
  | "setWorkspaceStorageState"
>;

interface WorkspaceReconciliationResult {
  readonly available: boolean;
  readonly detail: string;
  readonly issue?: NonNullable<Workspace["storageIssue"]>;
  readonly severity?: "alert";
}

/**
 * Storage-neutral durable Workspace lifecycle. The database intent is always
 * committed before a driver creates external state; every retry derives the
 * same Workspace and backing identities.
 */
export class WorkspaceService {
  readonly #active = new Map<WorkspaceId, Promise<Workspace>>();
  readonly #capacityPolicy: WorkspaceCapacityPolicy | undefined;
  readonly #capacityPolicyCeiling: WorkspaceCapacityPolicy | undefined;
  readonly #drivers: WorkspaceLifecycleDrivers;
  readonly #shape: DeploymentShape;
  readonly #restoreProgress = new Map<WorkspaceId, number>();
  readonly #resolveOwnerEnvironmentId: ((ownerId: UserId) => Promise<EnvironmentId>) | undefined;
  readonly #store: WorkspaceStore;
  #consecutiveFailedPreflights = 0;

  constructor(options: {
    readonly capacityPolicy?: WorkspaceCapacityPolicy;
    readonly capacityPolicyCeiling?: WorkspaceCapacityPolicy;
    readonly drivers: WorkspaceLifecycleDrivers;
    readonly shape: DeploymentShape;
    readonly resolveOwnerEnvironmentId?: (ownerId: UserId) => Promise<EnvironmentId>;
    readonly store: WorkspaceStore;
  }) {
    if (!options.drivers.local && !options.drivers.portableFs) {
      throw new TypeError("Workspace storage requires at least one lifecycle driver");
    }
    if ((options.drivers.portableFs !== undefined) !== (options.capacityPolicy !== undefined)) {
      throw new TypeError("PortableFS Workspace storage requires its quota policy");
    }
    if (options.capacityPolicy?.kind !== options.capacityPolicyCeiling?.kind) {
      throw new TypeError("Workspace capacity policy and ceiling do not match");
    }
    if (
      options.capacityPolicy?.kind === "hard-quota" &&
      options.capacityPolicyCeiling?.kind === "hard-quota"
    ) {
      assertHardQuotaPolicy(options.capacityPolicy, options.capacityPolicyCeiling);
    }
    if (
      options.shape.defaultWorkspaceBacking === "local-directory" &&
      !options.resolveOwnerEnvironmentId
    ) {
      throw new TypeError("A local-directory default requires an owning environment resolver");
    }
    this.#capacityPolicy = options.capacityPolicy;
    this.#capacityPolicyCeiling = options.capacityPolicyCeiling;
    this.#drivers = options.drivers;
    this.#shape = options.shape;
    this.#resolveOwnerEnvironmentId = options.resolveOwnerEnvironmentId;
    this.#store = options.store;
  }

  async create(input: {
    readonly createdBy: UserId;
    readonly capacityPolicy?: WorkspaceCapacityPolicy;
    readonly icon?: WorkspaceIconName;
    readonly color?: MarkColor;
    readonly idempotencyKey: string;
    readonly kind?: WorkspaceKind;
    readonly name: string;
    readonly storage?: WorkspaceStorageChoice;
  }): Promise<Workspace> {
    const id = workspaceIdForCreate(input.createdBy, input.idempotencyKey);
    const provisioningKey = workspaceProvisioningKey(id);
    const backingKind = input.storage?.backing ?? this.#shape.defaultWorkspaceBacking;
    const capacityPolicy = this.#effectiveCapacityPolicy(backingKind, input.capacityPolicy);
    const base = {
      backingKind,
      capacityPolicy,
      createdBy: input.createdBy,
      idempotencyKey: provisioningKey,
      kind: input.kind ?? "specialized",
      name: input.name,
      workspaceId: id,
    } as const;
    const backing =
      backingKind === "local-directory"
        ? this.#requiredLocal().initialBacking({
            ...base,
            backingKind: "local-directory",
            ownerEnvironmentId:
              input.storage?.backing === "local-directory"
                ? input.storage.environmentId
                : await this.#ownerEnvironmentId(input.createdBy),
          })
        : this.#requiredPortableFs().initialBacking({ ...base, backingKind: "portablefs" });
    assertBackingAllowedByDeployment(this.#shape, backing);
    const workspace = await this.#store.createWorkspace({
      backing,
      capacityPolicy,
      createdBy: input.createdBy,
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.color ? { color: input.color } : {}),
      id,
      idempotencyKey: input.idempotencyKey,
      ...(input.kind ? { kind: input.kind } : {}),
      name: input.name,
      status: "provisioning",
    });
    if (["ready", "deleting", "deleted"].includes(workspace.status)) return workspace;
    return this.provision(workspace);
  }

  setIcon(input: {
    readonly icon: WorkspaceIconName | null;
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<Workspace> {
    return this.#store.setWorkspaceIcon(input);
  }

  async ensureMainWorkspace(ownerId: UserId): Promise<Workspace> {
    const existing = await this.#store.findMainWorkspaceForOwner(ownerId);
    if (existing) {
      if (existing.status === "deleting" || existing.status === "deleted") return existing;
      return existing.status === "ready"
        ? this.ensureExecutionReady(existing)
        : this.provision(existing);
    }
    return this.create({
      createdBy: ownerId,
      idempotencyKey: `main:${ownerId}`,
      kind: "main",
      name: mainWorkspaceName,
    });
  }

  async retry(workspaceId: WorkspaceId, requestedBy: UserId): Promise<Workspace> {
    const workspace = await this.#store.getWorkspaceForOwner(workspaceId, requestedBy);
    if (!workspace) {
      throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
    }
    if (workspace.status === "deleted") {
      throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
    }
    if (workspace.status === "deleting") {
      throw new OpensteerError({
        code: "workspace_unavailable",
        message: "Workspace is awaiting deletion",
      });
    }
    if (workspace.status === "ready") return this.ensureExecutionReady(workspace);
    const provisioning = await this.#store.setWorkspaceStorageState({
      issue: null,
      status: "provisioning",
      workspaceId,
    });
    return this.provision(provisioning);
  }

  async ensureExecutionReady(workspace: Workspace): Promise<Workspace> {
    this.#assertWorkspace(workspace);
    let health: WorkspaceBackingHealth;
    try {
      health = await this.#inspect(workspace);
    } catch (error) {
      if (!(error instanceof WorkspaceAuthorityUnreachableError)) throw error;
      // The machine is unreachable, which says nothing about its disk. The
      // last verified state stands and the caller retries.
      throw new OpensteerError({
        cause: error,
        code: "workspace_unavailable",
        message: error.message,
        retryable: true,
      });
    }
    if (health.status === "ready") {
      if (workspace.status === "ready" && workspace.storageIssue === null) return workspace;
      return this.#store.setWorkspaceStorageState({
        issue: null,
        status: "ready",
        workspaceId: workspace.id,
      });
    }
    const current = await this.#store.setWorkspaceStorageState({
      issue: health.issue,
      status: health.status,
      workspaceId: workspace.id,
    });
    throw new OpensteerError({
      code: "workspace_unavailable",
      message: current.storageIssue?.message ?? "Workspace storage is not ready",
      retryable: current.status === "provisioning" || current.status === "unavailable",
    });
  }

  async recordControlPlaneFailure(workspaceId: WorkspaceId, error: unknown): Promise<Workspace> {
    this.#restoreProgress.delete(workspaceId);
    const issue = this.#requiredPortableFs().issueFromError(error);
    return this.#store.setWorkspaceStorageState({
      issue,
      status: issue.retryable ? "unavailable" : "failed",
      workspaceId,
    });
  }

  workspaceView(workspace: Workspace): Promise<WorkspaceView> {
    return this.decorateWorkspaceView(workspaceViewFromWorkspace(workspace));
  }

  /**
   * The single place a Workspace view acquires what only the Host knows: how
   * far a restore has got, and the name of the computer that holds a local
   * directory. The environment name is kept in step with its Runner's, so it
   * is the machine name a reader recognises.
   */
  async decorateWorkspaceView(view: WorkspaceView): Promise<WorkspaceView> {
    const restoreProgressPermille = this.#restoreProgress.get(view.id);
    const name =
      view.location.kind === "machine"
        ? ((await this.#store.getEnvironment(view.location.environmentId))?.name ?? null)
        : null;
    return WorkspaceViewSchema.parse({
      ...view,
      ...(view.location.kind === "machine" ? { location: { ...view.location, name } } : {}),
      ...(restoreProgressPermille === undefined ? {} : { restoreProgressPermille }),
    });
  }

  provision(workspace: Workspace): Promise<Workspace> {
    this.#assertWorkspace(workspace);
    const existing = this.#active.get(workspace.id);
    if (existing) return existing;
    const provisioning = this.#provision(workspace).finally(() =>
      this.#active.delete(workspace.id),
    );
    this.#active.set(workspace.id, provisioning);
    return provisioning;
  }

  async validateDeploymentCompatibility(): Promise<void> {
    for (const workspace of await this.#store.listWorkspaces()) this.#assertWorkspace(workspace);
  }

  async reconcile(): Promise<WorkspaceReconciliationResult> {
    await this.validateDeploymentCompatibility();
    // Only a shared authority can be globally unavailable. Runner-owned local
    // storage has no such authority: one sleeping laptop is not an outage.
    const shared = this.#drivers.portableFs;
    let detail = "Each machine answers for the directories it holds.";
    if (shared) {
      let readiness: WorkspaceBackingReadiness;
      try {
        readiness = await shared.preflight();
      } catch (error) {
        const issue = shared.issueFromError(error);
        await this.#recordFailedPreflight(issue);
        return {
          available: false,
          detail: issue.message,
          issue,
          ...(!issue.retryable ? { severity: "alert" as const } : {}),
        };
      }
      if (!readiness.available) {
        const issue = shared.issueFromError(new Error(readiness.detail));
        await this.#recordFailedPreflight(issue);
        return {
          available: false,
          detail: readiness.detail,
          issue,
          ...(!issue.retryable ? { severity: "alert" as const } : {}),
        };
      }
      detail = readiness.detail;
    }
    this.#consecutiveFailedPreflights = 0;
    let admitsCreates = true;
    let createsPausedDetail =
      "PortableFS product-pool capacity has no create headroom, so pending volume creates were skipped.";
    if (shared?.admitsCreates) {
      try {
        admitsCreates = await shared.admitsCreates();
      } catch (error) {
        admitsCreates = false;
        createsPausedDetail = `Create admission check is unavailable (${errorDetail(error)}), so creates are paused.`;
      }
    }
    for (const status of ["provisioning", "unavailable"] as const) {
      await this.#forEachStatus(status, (workspace) => {
        if (workspace.storageIssue?.retryable === false) return Promise.resolve();
        return admitsCreates || !workspaceNeedsVolumeCreate(workspace)
          ? this.provision(workspace)
          : Promise.resolve();
      });
    }
    // `archiving` is inspected alongside `ready` because it is the one status
    // whose next state lives entirely at the storage authority: the archive
    // cycle seals into `archived`, or a wake cancels it back to `ready`, and
    // neither transition reports itself to the Host.
    for (const status of ["archiving", "ready"] as const) {
      await this.#forEachStatus(status, async (workspace) => {
        let health: WorkspaceBackingHealth;
        try {
          health = await this.#inspect(workspace);
        } catch (error) {
          // An unreachable machine leaves its Workspaces exactly as they were.
          if (error instanceof WorkspaceAuthorityUnreachableError) return;
          throw error;
        }
        if (health.status !== workspace.status || health.issue !== null) {
          await this.#store.setWorkspaceStorageState({
            issue: health.issue,
            status: health.status,
            workspaceId: workspace.id,
          });
        }
      });
    }
    if (!admitsCreates) {
      return {
        available: true,
        detail: `${detail}; ${createsPausedDetail}`,
        severity: "alert",
      };
    }
    return { available: true, detail };
  }

  async #provision(workspace: Workspace): Promise<Workspace> {
    try {
      const result = await this.#provisionWithDriver(workspace);
      this.#recordRestoreProgress(workspace.id, result.restoreProgressPermille);
      return this.#store.setWorkspaceProvisioningResult({
        backing: result.backing,
        expectedBacking: workspace.backing,
        status: result.status,
        workspaceId: workspace.id,
      });
    } catch (error) {
      const issue = this.#issueFor(workspace, error);
      return this.#store.setWorkspaceStorageState({
        issue,
        // An unreachable machine has not failed to provision; the intent is
        // still outstanding and the next reconcile picks it up.
        status:
          error instanceof WorkspaceAuthorityUnreachableError
            ? "provisioning"
            : issue.retryable
              ? "unavailable"
              : "failed",
        workspaceId: workspace.id,
      });
    }
  }

  #provisionWithDriver(workspace: Workspace) {
    const idempotencyKey = workspaceProvisioningKey(workspace.id);
    if (workspaceUsesBacking(workspace, "local-directory")) {
      return this.#requiredLocal().provision({ idempotencyKey, workspace });
    }
    if (workspaceUsesBacking(workspace, "portablefs")) {
      return this.#requiredPortableFs().provision({ idempotencyKey, workspace });
    }
    throw new Error("Workspace backing does not match the configured driver");
  }

  async #inspect(workspace: Workspace): Promise<WorkspaceBackingHealth> {
    let health: WorkspaceBackingHealth;
    if (workspaceUsesBacking(workspace, "local-directory")) {
      health = await this.#requiredLocal().inspect(workspace);
    } else if (workspaceUsesBacking(workspace, "portablefs")) {
      health = await this.#requiredPortableFs().inspect(workspace);
    } else {
      throw new Error("Workspace backing does not match the configured driver");
    }
    this.#recordRestoreProgress(workspace.id, health.restoreProgressPermille);
    return health;
  }

  #issueFor(workspace: Workspace, error: unknown): NonNullable<Workspace["storageIssue"]> {
    return workspace.backing.kind === "local-directory"
      ? this.#requiredLocal().issueFromError(error)
      : this.#requiredPortableFs().issueFromError(error);
  }

  #requiredLocal(): WorkspaceBackingLifecycleDriver<"local-directory"> {
    const local = this.#drivers.local;
    if (local) return local;
    throw new OpensteerError({
      code: "conflict",
      message: "This Deployment has no machine that can hold a local Workspace directory",
    });
  }

  #requiredPortableFs(): WorkspaceBackingLifecycleDriver<"portablefs"> {
    const portableFs = this.#drivers.portableFs;
    if (portableFs) return portableFs;
    throw new OpensteerError({
      code: "conflict",
      message: "This Deployment has no shared Workspace storage",
    });
  }

  #recordRestoreProgress(workspaceId: WorkspaceId, progress: number | undefined): void {
    if (progress === undefined) this.#restoreProgress.delete(workspaceId);
    else this.#restoreProgress.set(workspaceId, progress);
  }

  #assertWorkspace(workspace: Workspace): void {
    assertBackingAllowedByDeployment(this.#shape, workspace.backing);
    if (workspace.backing.kind === "local-directory") this.#requiredLocal();
    else this.#requiredPortableFs();
  }

  /**
   * A local directory is bounded by the machine's own disk, so it never carries
   * a quota. Only shared storage does, and only there can a caller ask for one.
   */
  #effectiveCapacityPolicy(
    backingKind: "local-directory" | "portablefs",
    override: WorkspaceCapacityPolicy | undefined,
  ): WorkspaceCapacityPolicy {
    if (backingKind === "local-directory") {
      if (override && override.kind !== "host-filesystem") {
        throw new OpensteerError({
          code: "bad_request",
          message: "A Workspace on a machine's own disk cannot carry a storage quota",
        });
      }
      return { kind: "host-filesystem" };
    }
    const configured = this.#capacityPolicy;
    const ceiling = this.#capacityPolicyCeiling;
    if (!configured || !ceiling) {
      throw new OpensteerError({
        code: "conflict",
        message: "This Deployment has no shared Workspace storage",
      });
    }
    if (!override) return configured;
    if (override.kind !== configured.kind) {
      throw new OpensteerError({
        code: "conflict",
        message: "Workspace capacity policy is unsupported by this Deployment",
      });
    }
    if (override.kind === "hard-quota" && ceiling.kind === "hard-quota") {
      assertHardQuotaPolicy(override, ceiling);
    }
    return override;
  }

  async #ownerEnvironmentId(ownerId: UserId): Promise<EnvironmentId> {
    const resolver = this.#resolveOwnerEnvironmentId;
    if (!resolver) throw new Error("Local Workspace owner environment resolver is unavailable");
    return resolver(ownerId);
  }

  async #markGlobalUnavailable(issue: NonNullable<Workspace["storageIssue"]>): Promise<void> {
    for (const status of ["provisioning", "ready", "unavailable"] as const) {
      await this.#forEachStatus(status, (workspace) =>
        this.#store
          .setWorkspaceStorageState({
            issue,
            status: "unavailable",
            workspaceId: workspace.id,
          })
          .then(() => undefined),
      );
    }
  }

  async #recordFailedPreflight(issue: NonNullable<Workspace["storageIssue"]>): Promise<void> {
    const reachedDemotionThreshold = this.#consecutiveFailedPreflights === 2;
    this.#consecutiveFailedPreflights = Math.min(3, this.#consecutiveFailedPreflights + 1);
    if (reachedDemotionThreshold) await this.#markGlobalUnavailable(issue);
  }

  async #forEachStatus(
    status: "archiving" | "provisioning" | "ready" | "unavailable",
    operation: (workspace: Workspace) => Promise<unknown>,
  ): Promise<void> {
    let after: { readonly createdAt: string; readonly id: WorkspaceId } | undefined;
    while (true) {
      const page = await this.#store.listWorkspacesByStatus(status, {
        ...(after ? { after } : {}),
        limit: 100,
      });
      await Promise.allSettled(page.map(operation));
      const last = page.at(-1);
      if (!last || page.length < 100) return;
      after = { createdAt: last.createdAt, id: last.id };
    }
  }
}

function assertHardQuotaPolicy(
  policy: Extract<WorkspaceCapacityPolicy, { readonly kind: "hard-quota" }>,
  ceiling: Extract<WorkspaceCapacityPolicy, { readonly kind: "hard-quota" }>,
): void {
  if (
    !Number.isSafeInteger(policy.blockHardLimitBytes) ||
    policy.blockHardLimitBytes <= 0 ||
    policy.blockHardLimitBytes % 1_024 !== 0
  ) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Workspace byte quota must be a positive multiple of 1024",
    });
  }
  if (!Number.isSafeInteger(policy.inodeHardLimit) || policy.inodeHardLimit <= 0) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Workspace inode quota must be a positive integer",
    });
  }
  if (
    policy.blockHardLimitBytes > ceiling.blockHardLimitBytes ||
    policy.inodeHardLimit > ceiling.inodeHardLimit
  ) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Workspace quota exceeds this Deployment's configured ceiling",
    });
  }
}

function workspaceNeedsVolumeCreate(workspace: Workspace): boolean {
  return (
    workspace.backing.kind === "portablefs" &&
    workspace.backing.volumeId === `pending_${workspace.id}`
  );
}

function errorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown Manager response").slice(0, 500);
}

function workspaceProvisioningKey(workspaceId: WorkspaceId): string {
  return `workspace:${workspaceId}:provision:v1`;
}

function workspaceIdForCreate(createdBy: UserId, idempotencyKey: string): WorkspaceId {
  if (idempotencyKey.length === 0 || Buffer.byteLength(idempotencyKey, "utf8") > 512) {
    throw new TypeError("Workspace idempotency key must contain 1 to 512 bytes");
  }
  const bytes = createHash("sha256")
    .update("opensteer:workspace-create:v1\0", "utf8")
    .update(createdBy, "utf8")
    .update("\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return WorkspaceIdSchema.parse(
    `wsp_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}
