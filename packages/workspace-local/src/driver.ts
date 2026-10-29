import type {
  EnvironmentId,
  StorageAuthorityId,
  UserId,
  Workspace,
  WorkspaceBindingId,
  WorkspaceId,
  WorkspaceKind,
} from "@opensteer/core";
import type {
  LocalWorkspaceExecutionAccessPlan,
  WorkspaceLocalErrorCode,
  WorkspaceLocalFailure,
} from "@opensteer/workspace";
import { localWorkspaceBindingId } from "@opensteer/workspace/local-binding";
import { LocalWorkspaceError, LocalWorkspaceErrorCode } from "./errors.js";
import {
  LocalWorkspaceRegistry,
  type DestructionReceipt,
  type LocalWorkspaceRegistryOptions,
  type ProvisionFingerprint,
} from "./registry.js";
import type { NativeDirectoryIdentity } from "./native-fs-helper.js";

export interface LocalWorkspaceAuthorityOptions extends LocalWorkspaceRegistryOptions {}

/** The binding a Host request names, as the Runner re-derives and checks it. */
export interface LocalWorkspaceBindingRequest {
  readonly bindingId: WorkspaceBindingId;
  readonly generation: number;
  readonly ownerEnvironmentId: EnvironmentId;
  readonly storageAuthorityId: StorageAuthorityId;
  readonly workspaceId: WorkspaceId;
}

export interface LocalWorkspaceHealth {
  readonly issue?: WorkspaceLocalFailure;
  readonly status: "ready" | "unavailable" | "failed";
}

export interface LocalWorkspaceReadAuthority {
  readonly bindingId: WorkspaceBindingId;
  readonly generation: number;
  readonly root: string;
  readonly rootIdentity: NativeDirectoryIdentity;
  readonly workspaceId: WorkspaceId;
}

/**
 * The machine's own answer for every local-directory Workspace it holds. It
 * runs inside the owning Runner: the Host coordinates metadata and membership,
 * but only this side ever opens a path.
 */
export class LocalWorkspaceAuthority {
  readonly #registry: LocalWorkspaceRegistry;

  constructor(options: LocalWorkspaceAuthorityOptions) {
    this.#registry = new LocalWorkspaceRegistry(options);
  }

  async preflight(signal?: AbortSignal) {
    try {
      await this.#registry.preflight(signal);
      return {
        available: true,
        detail: "Managed local Workspace storage is ready.",
      } as const;
    } catch (error) {
      if (signal?.aborted === true) throw error;
      const issue = failureFromError(error);
      return { available: false, detail: issue.message } as const;
    }
  }

  storageAuthorityId(signal?: AbortSignal): Promise<StorageAuthorityId> {
    return this.#registry.storageAuthority(signal);
  }

  inventory(signal?: AbortSignal) {
    return this.#registry.inventory(signal);
  }

  /**
   * `idempotencyKey` is the Host's stable operation identity, so a replay after
   * a lost response returns the directory this machine already created rather
   * than creating a second one.
   */
  async provision(
    input: {
      readonly binding: LocalWorkspaceBindingRequest;
      readonly fingerprint: { readonly createdBy: UserId; readonly workspaceKind: WorkspaceKind };
      readonly idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertAuthority(input.binding, signal);
    const fingerprint: ProvisionFingerprint = {
      createdBy: input.fingerprint.createdBy,
      kind: input.fingerprint.workspaceKind,
      ownerEnvironmentId: input.binding.ownerEnvironmentId,
      workspaceId: input.binding.workspaceId,
    };
    const expected = localWorkspaceBindingId({
      createdBy: fingerprint.createdBy,
      idempotencyKey: input.idempotencyKey,
      kind: fingerprint.kind,
      ownerEnvironmentId: fingerprint.ownerEnvironmentId,
      workspaceId: fingerprint.workspaceId,
    });
    if (expected !== input.binding.bindingId) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.workspaceMismatch,
        message: "The local Workspace binding does not match its creation intent.",
      });
    }
    await this.#registry.provision({
      bindingId: input.binding.bindingId,
      fingerprint,
      generation: input.binding.generation,
      idempotencyKey: input.idempotencyKey,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async inspect(
    binding: LocalWorkspaceBindingRequest,
    signal?: AbortSignal,
  ): Promise<LocalWorkspaceHealth> {
    try {
      signal?.throwIfAborted();
      await this.#assertAuthority(binding, signal);
      await this.#registry.getReadyBinding({
        bindingId: binding.bindingId,
        generation: binding.generation,
        ownerEnvironmentId: binding.ownerEnvironmentId,
        workspaceId: binding.workspaceId,
      });
      signal?.throwIfAborted();
      return { status: "ready" };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      const issue = failureFromError(error);
      return { issue, status: issue.retryable ? "unavailable" : "failed" };
    }
  }

  async destroy(
    binding: LocalWorkspaceBindingRequest,
    signal?: AbortSignal,
  ): Promise<DestructionReceipt> {
    await this.#assertAuthority(binding, signal);
    return this.#registry.destroy({
      bindingId: binding.bindingId,
      generation: binding.generation,
      ...(signal === undefined ? {} : { signal }),
      workspaceId: binding.workspaceId,
    });
  }

  async resolveExecutionPath(input: {
    readonly environmentId: EnvironmentId;
    readonly plan: LocalWorkspaceExecutionAccessPlan;
  }): Promise<string> {
    if (input.environmentId !== input.plan.ownerEnvironmentId) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.environmentMismatch,
        message: "A local Workspace access plan belongs to another execution environment.",
      });
    }
    await this.#assertAuthority({
      bindingId: input.plan.bindingId,
      generation: input.plan.generation,
      ownerEnvironmentId: input.plan.ownerEnvironmentId,
      storageAuthorityId: input.plan.storageAuthorityId,
      workspaceId: input.plan.workspaceId,
    });
    const binding = await this.#registry.getReadyBinding({
      bindingId: input.plan.bindingId,
      generation: input.plan.generation,
      ownerEnvironmentId: input.environmentId,
      workspaceId: input.plan.workspaceId,
    });
    return this.#registry.resolvePath(binding);
  }

  /**
   * The identity-bound root a Files read is performed against. The helper
   * compares `rootIdentity` after opening it; a pathname on its own would let a
   * replaced directory answer for the original.
   */
  async resolveReadAuthority(
    binding: LocalWorkspaceBindingRequest,
    signal?: AbortSignal,
  ): Promise<LocalWorkspaceReadAuthority> {
    await this.#assertAuthority(binding, signal);
    const ready = await this.#registry.getReadyBinding({
      bindingId: binding.bindingId,
      generation: binding.generation,
      ownerEnvironmentId: binding.ownerEnvironmentId,
      workspaceId: binding.workspaceId,
    });
    return {
      bindingId: ready.bindingId,
      generation: ready.generation,
      root: this.#registry.resolvePath(ready),
      rootIdentity: ready.filesystemIdentity,
      workspaceId: ready.workspaceId,
    };
  }

  async #assertAuthority(
    binding: LocalWorkspaceBindingRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const authorityId = await this.#registry.storageAuthority(signal);
    if (authorityId !== binding.storageAuthorityId) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.authorityMismatch,
        message: "This machine does not hold the disk that Workspace lives on.",
      });
    }
    if (
      this.#registry.namespace.kind === "single-owner" &&
      this.#registry.namespace.ownerEnvironmentId !== binding.ownerEnvironmentId
    ) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.environmentMismatch,
        message: "This local Workspace registry belongs to another execution environment.",
      });
    }
  }
}

export function failureFromError(error: unknown): WorkspaceLocalFailure {
  const localError = asLocalWorkspaceError(error);
  return {
    code: localError.code,
    message: localError.message.slice(0, 500),
    retryable: localError.retryable,
  };
}

/** The Workspace-level meaning of a machine's failure, as the Host records it. */
export function storageIssueCodeForFailure(
  code: WorkspaceLocalErrorCode,
): NonNullable<Workspace["storageIssue"]>["code"] {
  switch (code) {
    case "directory-missing":
    case "not-found":
      return "local-directory-missing";
    case "directory-replaced":
    case "root-replaced":
    case "cross-device":
    case "symlink-denied":
    case "unsafe-parent":
      return "local-directory-replaced";
    case "registry-invalid":
    case "generation-mismatch":
    case "workspace-mismatch":
    case "provisioning-incomplete":
      return "local-registry-invalid";
    case "authority-mismatch":
      return "local-authority-mismatch";
    case "fence-stale":
    case "helper-unavailable":
      return "local-authority-unavailable";
    case "configuration-invalid":
    case "directory-inaccessible":
    case "environment-mismatch":
    case "idempotency-conflict":
    case "registry-unavailable":
    case "workspace-conflict":
    case "concurrent-modification":
    case "invalid-path":
    case "invalid-request":
    case "not-directory":
    case "not-regular":
    case "outside-workspace":
    case "permission-denied":
      return "local-directory-inaccessible";
  }
}

function asLocalWorkspaceError(error: unknown): LocalWorkspaceError {
  return error instanceof LocalWorkspaceError
    ? error
    : new LocalWorkspaceError({
        cause: error,
        code: LocalWorkspaceErrorCode.directoryInaccessible,
        message: "The managed Workspace directory cannot be inspected.",
        retryable: true,
      });
}

export type {
  DestructionReceipt,
  LocalStorageInventory,
  LocalWorkspaceNamespace,
} from "./registry.js";
