import type { EnvironmentId, RunnerId, StorageAuthorityId } from "@opensteer/core";
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
  readonly #authority: LocalWorkspaceAuthority;
  readonly #filesystem: NativeWorkspaceFilesAuthority;

  constructor(options: {
    readonly authority: LocalWorkspaceAuthority;
    readonly filesystem: NativeWorkspaceFilesAuthority;
  }) {
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
        case "host.workspace.local.provision": {
          await this.#authority.provision(
            {
              binding,
              fingerprint: request.fingerprint,
              idempotencyKey: request.operationId,
            },
            signal,
          );
          return { ...echo, type: "runner.workspace.local.provisioned" };
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
        case "host.workspace.local.destroy": {
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
        error: failureFromError(error),
        fence,
        operationId: request.operationId,
        requestId: request.requestId,
        type: "runner.workspace.local.error",
      };
    }
  }
}

function fenceMismatch(
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
