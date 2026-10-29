import { randomUUID } from "node:crypto";
import {
  OpensteerError,
  type EnvironmentId,
  type LocalWorkspaceBacking,
  type StorageAuthorityId,
  type Workspace,
} from "@opensteer/core";
import type { RunnerRegistry, WorkspaceLocalRequest } from "@opensteer/orchestration";
import type { RunnerWorkspaceLocalResult } from "@opensteer/protocol";
import { workspaceLocalOperationId } from "@opensteer/protocol";
import {
  WorkspaceAuthorityUnreachableError,
  WorkspaceStorageAuthorityMissingError,
  requireLocalWorkspaceStorageAuthority,
  type LocalWorkspaceExecutionAccessPlan,
  type ProvisionWorkspaceInput,
  type ProvisionWorkspaceResult,
  type WorkspaceBackingHealth,
  type WorkspaceBackingLifecycleDriver,
  type WorkspaceBackingReadiness,
  type WorkspaceLocalFailure,
} from "@opensteer/workspace";
import { localWorkspaceBindingId } from "@opensteer/workspace/local-binding";
import { storageIssueCodeForFailure } from "@opensteer/workspace-local";

type LocalWorkspace = Workspace & { readonly backing: LocalWorkspaceBacking };

export type RunnerStorageRegistry = Pick<
  RunnerRegistry,
  "identityForEnvironment" | "requestWorkspaceLocal"
>;

const requestTimeoutMs = 30_000;

/**
 * The Host's side of Runner-owned local storage. It holds no paths and opens no
 * files: it derives the durable binding, addresses the machine that owns it, and
 * turns that machine's answer into Workspace state.
 */
export class RunnerLocalWorkspaceDriver implements WorkspaceBackingLifecycleDriver<"local-directory"> {
  readonly kind = "local-directory" as const;
  readonly #runners: RunnerStorageRegistry;

  constructor(options: { readonly runners: RunnerStorageRegistry }) {
    this.#runners = options.runners;
  }

  /**
   * The owning machine has to be connected to create a Workspace on it: its
   * storage authority is part of the durable binding, and inventing one would
   * commit a row no disk can ever answer for.
   */
  initialBacking(input: ProvisionWorkspaceInput<"local-directory">): LocalWorkspaceBacking {
    return {
      bindingId: localWorkspaceBindingId({
        createdBy: input.createdBy,
        idempotencyKey: workspaceLocalOperationId({
          generation: 1,
          operation: "provision",
          workspaceId: input.workspaceId,
        }),
        kind: input.kind,
        ownerEnvironmentId: input.ownerEnvironmentId,
        workspaceId: input.workspaceId,
      }),
      generation: 1,
      kind: "local-directory",
      ownerEnvironmentId: input.ownerEnvironmentId,
      storageAuthorityId: this.#requireStorageAuthority(input.ownerEnvironmentId),
    };
  }

  #requireStorageAuthority(environmentId: EnvironmentId): StorageAuthorityId {
    const identity = this.#runners.identityForEnvironment(environmentId);
    if (!identity) {
      throw new OpensteerError({
        code: "workspace_unavailable",
        message: "That computer is not connected right now.",
        retryable: true,
      });
    }
    const authority = identity.modules.agents?.localStorage?.storageAuthorityId;
    if (!authority) {
      throw new OpensteerError({
        code: "conflict",
        message: "That computer does not hold Workspace directories of its own.",
      });
    }
    return authority;
  }

  /**
   * There is no single authority to preflight: each Workspace lives on its own
   * machine, and one of them being asleep says nothing about the others.
   */
  async preflight(): Promise<WorkspaceBackingReadiness> {
    return { available: true, detail: "Each machine answers for the directories it holds." };
  }

  async provision(
    input: { readonly idempotencyKey: string; readonly workspace: LocalWorkspace },
    signal?: AbortSignal,
  ): Promise<ProvisionWorkspaceResult<"local-directory">> {
    await this.#request(
      input.workspace.backing,
      {
        binding: bindingRef(input.workspace.backing, input.workspace.id),
        fingerprint: {
          createdBy: input.workspace.createdBy,
          workspaceKind: input.workspace.kind,
        },
        operationId: workspaceLocalOperationId({
          generation: input.workspace.backing.generation,
          operation: "provision",
          workspaceId: input.workspace.id,
        }),
        requestId: randomUUID(),
        type: "host.workspace.local.provision",
      },
      "runner.workspace.local.provisioned",
      signal,
    );
    return { backing: input.workspace.backing, status: "ready" };
  }

  async inspect(workspace: LocalWorkspace, signal?: AbortSignal): Promise<WorkspaceBackingHealth> {
    const result = await this.#request(
      workspace.backing,
      {
        binding: bindingRef(workspace.backing, workspace.id),
        operationId: `workspace:${workspace.id}:inspect:v1`,
        requestId: randomUUID(),
        type: "host.workspace.local.inspect",
      },
      "runner.workspace.local.inspected",
      signal,
    );
    if (result.health.status === "ready") return { issue: null, status: "ready" };
    return { issue: this.#issue(result.health.issue), status: result.health.status };
  }

  async destroy(
    input: { readonly workspace: LocalWorkspace },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#request(
      input.workspace.backing,
      {
        binding: bindingRef(input.workspace.backing, input.workspace.id),
        operationId: workspaceLocalOperationId({
          generation: input.workspace.backing.generation,
          operation: "destroy",
          workspaceId: input.workspace.id,
        }),
        requestId: randomUUID(),
        type: "host.workspace.local.destroy",
      },
      "runner.workspace.local.destroyed",
      signal,
    );
  }

  planExecutionAccess(input: {
    readonly environmentId: EnvironmentId;
    readonly workspace: LocalWorkspace;
  }): LocalWorkspaceExecutionAccessPlan {
    if (input.environmentId !== input.workspace.backing.ownerEnvironmentId) {
      throw new OpensteerError({
        code: "conflict",
        message: "A local Workspace can run only on the computer that holds it",
      });
    }
    return { ...bindingRef(input.workspace.backing, input.workspace.id), kind: "local-directory" };
  }

  issueFromError(error: unknown): NonNullable<Workspace["storageIssue"]> {
    if (error instanceof WorkspaceStorageAuthorityMissingError) {
      return this.#issue({ code: "authority-mismatch", message: error.message, retryable: false });
    }
    if (error instanceof LocalWorkspaceFailureError) return this.#issue(error.failure);
    if (error instanceof WorkspaceAuthorityUnreachableError) {
      return this.#issue({
        code: "fence-stale",
        message: error.message,
        retryable: true,
      });
    }
    return this.#issue({
      code: "directory-inaccessible",
      message:
        error instanceof Error
          ? error.message.slice(0, 500)
          : "The machine holding this Workspace reported an unreadable failure.",
      retryable: true,
    });
  }

  #issue(failure: WorkspaceLocalFailure): NonNullable<Workspace["storageIssue"]> {
    return {
      code: storageIssueCodeForFailure(failure.code),
      message: failure.message,
      occurredAt: new Date().toISOString(),
      retryable: failure.retryable,
    };
  }

  async #request<Type extends RunnerWorkspaceLocalResult["type"]>(
    backing: LocalWorkspaceBacking,
    request: WorkspaceLocalRequest,
    expected: Type,
    signal?: AbortSignal,
  ): Promise<Extract<RunnerWorkspaceLocalResult, { readonly type: Type }>> {
    let result: RunnerWorkspaceLocalResult;
    try {
      result = await this.#runners.requestWorkspaceLocal(
        backing.ownerEnvironmentId,
        request,
        signal ?? AbortSignal.timeout(requestTimeoutMs),
      );
    } catch (error) {
      if (error instanceof OpensteerError && error.code === "workspace_unavailable") {
        throw new WorkspaceAuthorityUnreachableError(error.message, { cause: error });
      }
      throw error;
    }
    if (result.type === "runner.workspace.local.error") {
      // A stale fence means this answer belongs to a connection the Host has
      // already replaced, so nothing was learned about the disk either way.
      if (result.error.code === "fence-stale") {
        throw new WorkspaceAuthorityUnreachableError(result.error.message);
      }
      throw new LocalWorkspaceFailureError(result.error);
    }
    if (result.type !== expected) {
      throw new Error("The machine answered a different Workspace storage question");
    }
    return result as Extract<RunnerWorkspaceLocalResult, { readonly type: Type }>;
  }
}

/** A failure the owning machine reported about its own disk. */
export class LocalWorkspaceFailureError extends Error {
  readonly failure: WorkspaceLocalFailure;

  constructor(failure: WorkspaceLocalFailure) {
    super(failure.message);
    this.name = "LocalWorkspaceFailureError";
    this.failure = failure;
  }
}

function bindingRef(backing: LocalWorkspaceBacking, workspaceId: Workspace["id"]) {
  return {
    bindingId: backing.bindingId,
    generation: backing.generation,
    ownerEnvironmentId: backing.ownerEnvironmentId,
    storageAuthorityId: requireLocalWorkspaceStorageAuthority(backing),
    workspaceId,
  } as const;
}
