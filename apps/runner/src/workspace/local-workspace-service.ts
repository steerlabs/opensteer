import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  OpensteerError,
  type EnvironmentId,
  type RunnerId,
  type StorageAuthorityId,
} from "@opensteer/core";
import type {
  HostWorkspaceLocalRequest,
  RunnerBootId,
  RunnerConnectionId,
  RunnerConnectionLeaseId,
  RunnerWorkspaceLocalResult,
  WorkspaceStorageFence,
} from "@opensteer/protocol";
import type { WorkspaceLocalFailure } from "@opensteer/workspace";
import {
  failureFromError,
  type LocalWorkspaceAuthority,
  type LocalWorkspaceBindingRequest,
  type NativeWorkspaceFilesAuthority,
} from "@opensteer/workspace-local";
import type { AppServerManager } from "../apps/app-server-manager.js";

/** What this Runner believes about itself while one connection is live. */
export interface LocalWorkspaceIdentity {
  readonly bootId: RunnerBootId;
  readonly connectionGeneration: number;
  readonly connectionId: RunnerConnectionId;
  readonly connectionLeaseId: RunnerConnectionLeaseId;
  readonly environmentId: EnvironmentId;
  readonly runnerId: RunnerId;
  readonly storageAuthorityId: StorageAuthorityId;
}

/**
 * The machine's side of the Workspace storage protocol. It answers the Host's
 * requests against its own disk and never trusts one that was fenced to a
 * different boot, connection, environment, or storage authority — a stale
 * request may already have been reissued to a replacement connection.
 */
export class LocalWorkspaceService {
  readonly #relocate:
    | ((
        workspaceId: HostWorkspaceLocalRequest["binding"]["workspaceId"],
        move: () => Promise<void>,
      ) => Promise<void>)
    | undefined;
  readonly #removeSpecialist:
    ((id: string, remove: () => Promise<void>) => Promise<void>) | undefined;
  readonly #appServers: Pick<AppServerManager, "stopBinding">;
  readonly #authority: LocalWorkspaceAuthority;
  readonly #filesystem: NativeWorkspaceFilesAuthority;

  constructor(options: {
    readonly relocate?: (
      workspaceId: HostWorkspaceLocalRequest["binding"]["workspaceId"],
      move: () => Promise<void>,
    ) => Promise<void>;
    readonly removeSpecialist?: (id: string, remove: () => Promise<void>) => Promise<void>;
    readonly appServers: Pick<AppServerManager, "stopBinding">;
    readonly authority: LocalWorkspaceAuthority;
    readonly filesystem: NativeWorkspaceFilesAuthority;
  }) {
    this.#appServers = options.appServers;
    this.#relocate = options.relocate;
    this.#removeSpecialist = options.removeSpecialist;
    this.#authority = options.authority;
    this.#filesystem = options.filesystem;
  }

  async handle(
    request: HostWorkspaceLocalRequest,
    identity: LocalWorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<RunnerWorkspaceLocalResult> {
    const fence = request.fence;
    const mismatch = fenceMismatch(fence, identity);
    if (mismatch) {
      return {
        error: mismatch,
        fence,
        operationId: request.operationId,
        requestId: request.requestId,
        type: "runner.workspace.local.error",
      };
    }
    const binding: LocalWorkspaceBindingRequest = request.binding;
    const echo = {
      binding: request.binding,
      fence,
      operationId: request.operationId,
      requestId: request.requestId,
    } as const;
    try {
      switch (request.type) {
        case "host.workspace.local.relocate": {
          const move = () =>
            this.#authority.relocate(
              binding,
              request.slug,
              request.adopt,
              request.createdBy,
              signal,
            );
          if (this.#relocate && (await this.#authority.relocationNeeded(binding, request.slug)))
            await this.#relocate(binding.workspaceId, move);
          else await move();
          return { ...echo, type: "runner.workspace.local.relocated" };
        }
        case "host.workspace.local.provision": {
          const path = await this.#authority.provision(
            {
              binding,
              fingerprint: request.fingerprint,
              idempotencyKey: request.operationId,
            },
            signal,
          );
          return { ...echo, path, type: "runner.workspace.local.provisioned" };
        }
        case "host.workspace.local.inspect": {
          const health = await this.#authority.inspect(binding, signal);
          return {
            ...echo,
            health:
              health.status === "ready" || health.issue === undefined
                ? { status: "ready" }
                : { issue: health.issue, status: health.status },
            type: "runner.workspace.local.inspected",
          };
        }
        case "host.workspace.local.specialist.remove": {
          const read = await this.#authority.resolveReadAuthority(binding, signal);
          const parent = join(read.root, ".specialists");
          const stat = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (stat?.isSymbolicLink()) throw new Error("Specialist directory cannot be a symlink");
          const remove = async () => {
            if (stat)
              await rm(join(parent, request.specialistId), { recursive: true, force: true });
          };
          if (this.#removeSpecialist) await this.#removeSpecialist(request.specialistId, remove);
          else await remove();
          return { ...echo, type: "runner.workspace.local.specialist.removed" };
        }
        case "host.workspace.local.destroy": {
          await this.#appServers.stopBinding(request.binding);
          const receipt = await this.#authority.destroy(binding, signal);
          return {
            ...echo,
            receipt: { destroyedAt: receipt.destroyedAt, outcome: receipt.outcome },
            type: "runner.workspace.local.destroyed",
          };
        }
        case "host.workspace.local.files.list": {
          const read = await this.#authority.resolveReadAuthority(binding, signal);
          const listing = await this.#filesystem.filesList(
            {
              ...(request.expectedDirectoryRevision === undefined
                ? {}
                : { expectedDirectoryRevision: request.expectedDirectoryRevision }),
              expectedRootIdentity: read.rootIdentity,
              limit: request.limit,
              offset: request.offset,
              pathSegmentsBase64: request.pathSegmentsBase64,
              root: read.root,
            },
            signal,
          );
          return { ...echo, listing, type: "runner.workspace.local.files.listed" };
        }
        case "host.workspace.local.files.read": {
          const read = await this.#authority.resolveReadAuthority(binding, signal);
          const range = await this.#filesystem.filesReadRange(
            {
              ...(request.expectedFileRevision === undefined
                ? {}
                : { expectedFileRevision: request.expectedFileRevision }),
              expectedRootIdentity: read.rootIdentity,
              maxBytes: request.maxBytes,
              offset: request.offset,
              pathSegmentsBase64: request.pathSegmentsBase64,
              root: read.root,
            },
            signal,
          );
          return {
            ...echo,
            bytesRead: range.bytesRead,
            contentBase64: range.bytes.toString("base64"),
            eof: range.eof,
            metadata: range.metadata,
            offset: range.offset,
            type: "runner.workspace.local.files.read",
          };
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        error:
          error instanceof OpensteerError && error.code === "workspace_unavailable"
            ? {
                code: "workspace-conflict",
                message: error.message.slice(0, 500),
                retryable: error.retryable,
              }
            : failureFromError(error),
        fence,
        operationId: request.operationId,
        requestId: request.requestId,
        type: "runner.workspace.local.error",
      };
    }
  }
}

export function fenceMismatch(
  fence: WorkspaceStorageFence,
  identity: LocalWorkspaceIdentity,
): WorkspaceLocalFailure | undefined {
  if (fence.storageAuthorityId !== identity.storageAuthorityId) {
    return {
      code: "authority-mismatch",
      message: "This machine does not hold the disk that Workspace lives on.",
      retryable: false,
    };
  }
  if (
    fence.runnerId !== identity.runnerId ||
    fence.environmentId !== identity.environmentId ||
    fence.bootId !== identity.bootId ||
    fence.connectionId !== identity.connectionId ||
    fence.connectionLeaseId !== identity.connectionLeaseId ||
    fence.connectionGeneration !== identity.connectionGeneration
  ) {
    return {
      code: "fence-stale",
      message: "This Workspace storage request belongs to an earlier connection.",
      retryable: true,
    };
  }
  return undefined;
}
