import type { AdministrationCommandIdentity } from "@opensteer/database";
import type { IntegrationProviderAuthorization } from "@opensteer/integration-core";
import {
  OpensteerError,
  WorkspaceIdSchema,
  type DeploymentShape,
  type EnvironmentId,
  type MarkColor,
  type UserId,
  type Workspace,
  type WorkspaceIconName,
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
  workspaceUsesBacking,
  type WorkspaceBackingHealth,
  type WorkspaceBackingLifecycleDriver,
} from "@opensteer/workspace";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

const mainWorkspaceName = "Main";

interface WorkspaceLifecycleDrivers {
  readonly local?: WorkspaceBackingLifecycleDriver<"local-directory">;
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
  | "completeWorkspaceStorageRetry"
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
  readonly #drivers: WorkspaceLifecycleDrivers;
  readonly #resolveOwnerEnvironmentId: ((ownerId: UserId) => Promise<EnvironmentId>) | undefined;
  readonly #store: WorkspaceStore;
  readonly #providerAuthorizations:
    | ((owner: UserId) => Promise<Readonly<Record<string, IntegrationProviderAuthorization>>>)
    | undefined;

  constructor(options: {
    readonly drivers: WorkspaceLifecycleDrivers;
    readonly shape: DeploymentShape;
    readonly resolveOwnerEnvironmentId?: (ownerId: UserId) => Promise<EnvironmentId>;
    readonly store: WorkspaceStore;
    readonly providerAuthorizations?: (
      owner: UserId,
    ) => Promise<Readonly<Record<string, IntegrationProviderAuthorization>>>;
  }) {
    if (!options.drivers.local) throw new TypeError("Local Workspace storage requires a driver");
    if (
      options.shape.defaultWorkspaceBacking === "local-directory" &&
      !options.resolveOwnerEnvironmentId
    ) {
      throw new TypeError("A local-directory default requires an owning environment resolver");
    }
    this.#drivers = options.drivers;
    this.#resolveOwnerEnvironmentId = options.resolveOwnerEnvironmentId;
    this.#store = options.store;
    this.#providerAuthorizations = options.providerAuthorizations;
  }

  async create(input: {
    readonly createdBy: UserId;
    readonly icon?: WorkspaceIconName;
    readonly color?: MarkColor;
    readonly idempotencyKey: string;
    readonly kind?: WorkspaceKind;
    readonly name: string;
  }): Promise<Workspace> {
    const id = workspaceIdForCreate(input.createdBy, input.idempotencyKey);
    const provisioningKey = workspaceProvisioningKey(id);
    let main: Workspace | null = null;
    if (input.kind !== "main") {
      try {
        main = await this.ensureMainWorkspace(input.createdBy);
      } catch (error) {
        if (!(error instanceof OpensteerError) || error.code !== "workspace_unavailable")
          throw error;
        throw new OpensteerError({
          code: "workspace_unavailable",
          message:
            "Main storage is unavailable. Connect the computer holding Main and retry creating the Project.",
          retryable: true,
        });
      }
    }
    if (main && (main.status !== "ready" || main.backing.kind !== "local-directory")) {
      throw new OpensteerError({
        code: "workspace_unavailable",
        message:
          "Main storage is unavailable. Connect the computer holding Main and retry creating the Project.",
        retryable: true,
      });
    }
    const backingKind = "local-directory";
    const base = {
      backingKind,
      createdBy: input.createdBy,
      idempotencyKey: provisioningKey,
      kind: input.kind ?? "project",
      name: input.name,
      workspaceId: id,
    } as const;
    const backing = this.#requiredLocal().initialBacking({
      ...base,
      backingKind: "local-directory",
      ownerEnvironmentId:
        main?.backing.kind === "local-directory"
          ? main.backing.ownerEnvironmentId
          : await this.#ownerEnvironmentId(input.createdBy),
    });
    if (
      main?.backing.kind === "local-directory" &&
      backing.kind === "local-directory" &&
      main.backing.storageAuthorityId !== backing.storageAuthorityId
    ) {
      throw new OpensteerError({
        code: "workspace_unavailable",
        message:
          "Main storage authority is unavailable. Reconnect the computer holding Main and retry.",
        retryable: true,
      });
    }
    const workspace = await this.#store.createWorkspace({
      backing,
      createdBy: input.createdBy,
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.color ? { color: input.color } : {}),
      id,
      idempotencyKey: input.idempotencyKey,
      ...(input.kind ? { kind: input.kind } : {}),
      name: input.name,
      status: "provisioning",
      providerAuthorizations: (await this.#providerAuthorizations?.(input.createdBy)) ?? {},
    });
    if (["ready", "deleting", "deleted"].includes(workspace.status)) return workspace;
    return this.provision(workspace);
  }

  async projectPath(workspace: Workspace): Promise<string> {
    if (workspace.kind !== "project" || !workspace.slug || workspace.status !== "ready")
      throw new Error("Project storage is not ready");
    const main = await this.#store.findMainWorkspaceForOwner(workspace.createdBy);
    const root = main ? this.#drivers.local?.storageLocation?.(main) : null;
    if (
      !root ||
      workspace.backing.kind !== "local-directory" ||
      main?.backing.kind !== "local-directory" ||
      workspace.backing.ownerEnvironmentId !== main.backing.ownerEnvironmentId ||
      workspace.backing.storageAuthorityId !== main.backing.storageAuthorityId
    )
      throw new Error("The computer holding this Project is unavailable");
    return (win32.isAbsolute(root) && !posix.isAbsolute(root) ? win32 : posix).join(
      root,
      "Projects",
      workspace.slug,
    );
  }

  setIcon(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly authoritySource?: Readonly<Record<string, unknown>>;
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

  async retry(
    workspaceId: WorkspaceId,
    requestedBy: UserId,
    administration?: AdministrationCommandIdentity | undefined,
  ): Promise<Workspace> {
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
        reason: "workspace-deleting",
      });
    }
    if (workspace.storageIssue?.code === "relocation-required")
      throw new OpensteerError({
        code: "workspace_unavailable",
        message: workspace.storageIssue.message,
      });
    if (workspace.status === "ready" || workspace.storageIssue?.code === "relocation-pending") {
      const ready = await this.ensureExecutionReady(workspace);
      return administration
        ? this.#store.completeWorkspaceStorageRetry(administration, workspaceId)
        : ready;
    }
    const provisioning = await this.#store.setWorkspaceStorageState({
      issue: null,
      status: "provisioning",
      workspaceId,
    });
    const result = await this.provision(provisioning);
    return administration
      ? this.#store.completeWorkspaceStorageRetry(administration, workspaceId)
      : result;
  }

  async adoptRelocated(workspaceId: WorkspaceId, requestedBy: UserId): Promise<Workspace> {
    const workspace = await this.#store.getWorkspaceForOwner(workspaceId, requestedBy);
    if (!workspace || workspace.status === "deleting" || workspace.status === "deleted")
      throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
    if (workspace.storageIssue?.code !== "relocation-required")
      throw new OpensteerError({
        code: "conflict",
        message: "This Workspace is not awaiting relocation confirmation",
      });
    const main =
      workspace.kind === "project"
        ? await this.#store.findMainWorkspaceForOwner(workspace.createdBy)
        : null;
    if (
      workspace.kind === "project" &&
      (!main || main.backing.kind !== "local-directory" || main.status !== "ready")
    )
      throw new OpensteerError({
        code: "workspace_unavailable",
        message: "Connect the computer holding Main first",
      });
    const backing = {
      ...this.#requiredLocal().initialBacking({
        backingKind: "local-directory",

        createdBy: workspace.createdBy,
        idempotencyKey: `workspace:${workspace.id}:adopt:v1`,
        kind: workspace.kind,
        name: workspace.name,
        workspaceId: workspace.id,
        ownerEnvironmentId:
          main?.backing.kind === "local-directory"
            ? main.backing.ownerEnvironmentId
            : await this.#ownerEnvironmentId(workspace.createdBy),
      }),
      ...(workspace.backing.kind === "local-directory"
        ? { bindingId: workspace.backing.bindingId, generation: workspace.backing.generation }
        : {}),
    };
    const relocate = this.#requiredLocal().relocate;
    if (!relocate) throw new Error("Local relocation is unavailable");
    await relocate.call(this.#requiredLocal(), { ...workspace, backing }, true);
    const current = await this.#store.setWorkspaceProvisioningResult({
      backing,
      expectedBacking: workspace.backing,
      workspaceId,
      status: "ready",
      relocationConfirmed: true,
    });
    return this.#store.setWorkspaceStorageState({
      workspaceId: current.id,
      status: "ready",
      issue: null,
    });
  }

  async ensureExecutionReady(workspace: Workspace): Promise<Workspace> {
    if (workspace.storageIssue?.code === "relocation-required")
      throw new OpensteerError({
        code: "workspace_unavailable",
        message: workspace.storageIssue.message,
      });
    if (workspace.backing.kind === "local-directory") this.#assertWorkspace(workspace);
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

  workspaceView(workspace: Workspace): Promise<WorkspaceView> {
    return this.decorateWorkspaceView(workspaceViewFromWorkspace(workspace));
  }

  /**
   * Adds the name of the computer that holds the directory. The environment name is kept in step with its Runner's, so it
   * is the machine name a reader recognises.
   */
  async decorateWorkspaceView(view: WorkspaceView): Promise<WorkspaceView> {
    const name =
      view.location.kind === "machine"
        ? ((await this.#store.getEnvironment(view.location.environmentId))?.name ?? null)
        : null;
    return WorkspaceViewSchema.parse({
      ...view,
      ...(view.location.kind === "machine" ? { location: { ...view.location, name } } : {}),
    });
  }

  provision(workspace: Workspace): Promise<Workspace> {
    if (workspace.backing.kind !== "local-directory")
      return this.#store.setWorkspaceStorageState({
        workspaceId: workspace.id,
        status: "failed",
        issue: relocationIssue(),
      });
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
    for (const workspace of await this.#store.listWorkspaces()) {
      if (
        workspace.backing.kind !== "local-directory" &&
        !["deleting", "deleted"].includes(workspace.status) &&
        workspace.storageIssue?.code !== "relocation-required"
      ) {
        await this.#store.setWorkspaceStorageState({
          workspaceId: workspace.id,
          status: "failed",
          issue: relocationIssue(),
        });
      }
    }
  }

  async reconcile(): Promise<WorkspaceReconciliationResult> {
    await this.validateDeploymentCompatibility();
    for (const workspace of await this.#store.listWorkspaces()) {
      if (
        workspace.kind !== "project" ||
        !workspace.slug ||
        ["deleting", "deleted"].includes(workspace.status) ||
        workspace.storageIssue?.code === "relocation-required"
      )
        continue;
      const main = await this.#store.findMainWorkspaceForOwner(workspace.createdBy);
      if (
        workspace.backing.kind !== "local-directory" ||
        (main &&
          (workspace.backing.kind !== "local-directory" ||
            main.backing.kind !== "local-directory" ||
            workspace.backing.storageAuthorityId !== main.backing.storageAuthorityId ||
            workspace.backing.ownerEnvironmentId !== main.backing.ownerEnvironmentId))
      ) {
        const health = await this.#inspect(workspace);
        if (health.issue?.code === "relocation-required")
          await this.#store.setWorkspaceStorageState({
            workspaceId: workspace.id,
            status: "failed",
            issue: health.issue,
          });
      }
    }
    const detail = "Each machine answers for the directories it holds.";
    for (const status of ["provisioning", "unavailable"] as const) {
      await this.#forEachStatus(status, (workspace) => {
        if (workspace.storageIssue?.retryable === false) return Promise.resolve();
        if (workspace.storageIssue?.code === "relocation-pending")
          return this.ensureExecutionReady(workspace);
        return this.provision(workspace);
      });
    }
    for (const status of ["ready"] as const) {
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
    return { available: true, detail };
  }

  async #provision(workspace: Workspace): Promise<Workspace> {
    try {
      const result = await this.#provisionWithDriver(workspace);
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
    throw new Error("Workspace backing does not match the configured driver");
  }

  async #inspect(workspace: Workspace): Promise<WorkspaceBackingHealth> {
    let health: WorkspaceBackingHealth;
    if (workspace.backing.kind !== "local-directory")
      return { status: "failed", issue: relocationIssue() };
    if (workspace.storageIssue?.code === "relocation-required")
      return { status: "failed", issue: workspace.storageIssue };
    if (workspace.kind === "project" && workspace.slug) {
      const main = await this.#store.findMainWorkspaceForOwner(workspace.createdBy);
      if (
        workspace.backing.kind !== "local-directory" ||
        (main &&
          (workspace.backing.kind !== "local-directory" ||
            main.backing.kind !== "local-directory" ||
            workspace.backing.storageAuthorityId !== main.backing.storageAuthorityId ||
            workspace.backing.ownerEnvironmentId !== main.backing.ownerEnvironmentId))
      ) {
        return {
          status: "failed",
          issue: {
            code: "relocation-required",
            message: `Move this Project from ${this.#drivers.local?.storageLocation?.(workspace) ?? (workspace.backing.kind === "local-directory" ? `computer ${workspace.backing.ownerEnvironmentId}, folder ${workspace.id}` : "its previous storage")} to ${(main ? this.#drivers.local?.storageLocation?.(main) : null) ?? "<Main>"}/Projects/${workspace.slug}, then confirm “I moved it”.`,
            occurredAt: new Date().toISOString(),
            retryable: false,
          },
        };
      }
      if (workspace.backing.kind === "local-directory" && this.#drivers.local?.relocate) {
        try {
          await this.#drivers.local.relocate({ ...workspace, backing: workspace.backing });
        } catch (error) {
          if (error instanceof WorkspaceAuthorityUnreachableError) throw error;
          const issue = this.#requiredLocal().issueFromError(error);
          if (!issue.retryable)
            return {
              status: "failed",
              issue: {
                ...issue,
                code: "relocation-required",
                message:
                  `Move this Project from ${this.#drivers.local.storageLocation?.(workspace) ?? workspace.id} to ${main ? (this.#drivers.local.storageLocation?.(main) ?? "<Main>") : "<Main>"}/Projects/${workspace.slug}, then confirm “I moved it”. ${issue.message}`.slice(
                    0,
                    500,
                  ),
              },
            };
          return { status: "unavailable", issue: { ...issue, code: "relocation-pending" } };
        }
      }
    }
    if (workspaceUsesBacking(workspace, "local-directory")) {
      health = await this.#requiredLocal().inspect(workspace);
    } else {
      throw new Error("Workspace backing does not match the configured driver");
    }
    return health;
  }

  #issueFor(workspace: Workspace, error: unknown): NonNullable<Workspace["storageIssue"]> {
    return workspace.backing.kind === "local-directory"
      ? this.#requiredLocal().issueFromError(error)
      : relocationIssue();
  }

  #requiredLocal(): WorkspaceBackingLifecycleDriver<"local-directory"> {
    const local = this.#drivers.local;
    if (local) return local;
    throw new OpensteerError({
      code: "conflict",
      message: "This Deployment has no machine that can hold a local Workspace directory",
    });
  }

  #assertWorkspace(workspace: Workspace): void {
    if (workspace.backing.kind === "local-directory") this.#requiredLocal();
  }

  async #ownerEnvironmentId(ownerId: UserId): Promise<EnvironmentId> {
    const resolver = this.#resolveOwnerEnvironmentId;
    if (!resolver) throw new Error("Local Workspace owner environment resolver is unavailable");
    return resolver(ownerId);
  }

  async #forEachStatus(
    status: "provisioning" | "ready" | "unavailable",
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

function relocationIssue(): NonNullable<Workspace["storageIssue"]> {
  return {
    code: "relocation-required",
    message: "Move this Workspace to a local directory before using it.",
    occurredAt: new Date().toISOString(),
    retryable: false,
  };
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
