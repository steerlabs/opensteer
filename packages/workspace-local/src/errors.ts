import type { WorkspaceLocalErrorCode } from "@opensteer/workspace";

export const LocalWorkspaceErrorCode = {
  authorityMismatch: "authority-mismatch",
  configurationInvalid: "configuration-invalid",
  directoryInaccessible: "directory-inaccessible",
  directoryMissing: "directory-missing",
  directoryReplaced: "directory-replaced",
  environmentMismatch: "environment-mismatch",
  generationMismatch: "generation-mismatch",
  idempotencyConflict: "idempotency-conflict",
  provisioningIncomplete: "provisioning-incomplete",
  registryInvalid: "registry-invalid",
  registryUnavailable: "registry-unavailable",
  workspaceConflict: "workspace-conflict",
  workspaceMismatch: "workspace-mismatch",
  // A local failure that has no wire-visible meaning of its own would be
  // unreportable, so the table is pinned to the wire enum.
} as const satisfies Record<string, WorkspaceLocalErrorCode>;

export type LocalWorkspaceErrorCode =
  (typeof LocalWorkspaceErrorCode)[keyof typeof LocalWorkspaceErrorCode];

export class LocalWorkspaceError extends Error {
  readonly code: LocalWorkspaceErrorCode;
  readonly retryable: boolean;

  constructor(input: {
    readonly cause?: unknown;
    readonly code: LocalWorkspaceErrorCode;
    readonly message: string;
    readonly retryable?: boolean;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "LocalWorkspaceError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
  }
}
