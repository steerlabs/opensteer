import type {
  EnvironmentId,
  LocalWorkspaceBacking,
  StorageAuthorityId,
  UserId,
  Workspace,
  WorkspaceBacking,
  WorkspaceCapacityPolicy,
  WorkspaceId,
  WorkspaceKind,
} from "@opensteer/core";
import { OpensteerError } from "@opensteer/core";
import type { WorkspaceExecutionAccessPlan } from "./schemas.js";

export type WorkspaceBackingKind = WorkspaceBacking["kind"];
export type WorkspaceBackingFor<K extends WorkspaceBackingKind> = Extract<
  WorkspaceBacking,
  { readonly kind: K }
>;
export type WorkspaceExecutionPlanFor<K extends WorkspaceBackingKind> = Extract<
  WorkspaceExecutionAccessPlan,
  { readonly kind: K }
>;

interface ProvisionWorkspaceInputBase<K extends WorkspaceBackingKind> {
  readonly backingKind: K;
  readonly capacityPolicy: WorkspaceCapacityPolicy;
  readonly createdBy: UserId;
  readonly idempotencyKey: string;
  readonly kind: WorkspaceKind;
  readonly name: string;
  readonly workspaceId: WorkspaceId;
}

export type ProvisionWorkspaceInput<K extends WorkspaceBackingKind> = Extract<
  | (ProvisionWorkspaceInputBase<"local-directory"> & {
      readonly ownerEnvironmentId: EnvironmentId;
    })
  | ProvisionWorkspaceInputBase<"portablefs">,
  { readonly backingKind: K }
>;

export interface ProvisionWorkspaceResult<K extends WorkspaceBackingKind> {
  readonly backing: WorkspaceBackingFor<K>;
  readonly restoreProgressPermille?: number;
  readonly status: Workspace["status"];
}

export interface WorkspaceBackingHealth {
  readonly issue: Workspace["storageIssue"];
  readonly restoreProgressPermille?: number;
  readonly status: Workspace["status"];
}

export interface WorkspaceBackingReadiness {
  readonly available: boolean;
  readonly detail: string;
}

export interface WorkspaceBackingLifecycleDriver<K extends WorkspaceBackingKind> {
  readonly kind: K;
  /** Optional deployment-level admission signal. An absent signal preserves
   * create availability for drivers without a shared capacity authority. */
  admitsCreates?(): Promise<boolean>;
  /**
   * Derive the first durable binding without touching external storage. The
   * Host persists this value before `provision` runs, so a crash always has one
   * intent to replay instead of an untracked directory or volume allocation.
   */
  initialBacking(input: ProvisionWorkspaceInput<K>): WorkspaceBackingFor<K>;
  /**
   * Permanently destroy this backing. The operation is idempotent: success
   * means its durable data is destroyed or was already absent. Implementations
   * must reject rather than resolve when that outcome is ambiguous.
   */
  destroy(
    input: {
      readonly workspace: Workspace & { readonly backing: WorkspaceBackingFor<K> };
    },
    signal?: AbortSignal,
  ): Promise<void>;
  preflight(signal?: AbortSignal): Promise<WorkspaceBackingReadiness>;
  provision(
    input: {
      readonly idempotencyKey: string;
      readonly workspace: Workspace & { readonly backing: WorkspaceBackingFor<K> };
    },
    signal?: AbortSignal,
  ): Promise<ProvisionWorkspaceResult<K>>;
  inspect(
    workspace: Workspace & { readonly backing: WorkspaceBackingFor<K> },
    signal?: AbortSignal,
  ): Promise<WorkspaceBackingHealth>;
  issueFromError(error: unknown): NonNullable<Workspace["storageIssue"]>;
}

/**
 * The storage authority for this Workspace cannot be reached right now.
 *
 * It is distinct from every storage fault because connectivity is not evidence
 * about a disk. A caller must leave the last verified status in place and retry
 * rather than recording that the files are gone: the computer holding them is
 * simply asleep, closed, or off the network.
 */
export class WorkspaceAuthorityUnreachableError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceAuthorityUnreachableError";
  }
}

export const legacyLocalWorkspaceAuthorityMessage =
  "This Workspace predates machine-owned storage and must be recreated on the computer that holds its files.";

export class WorkspaceStorageAuthorityMissingError extends OpensteerError {
  constructor() {
    super({
      code: "workspace_unavailable",
      message: legacyLocalWorkspaceAuthorityMessage,
      retryable: false,
    });
    this.name = "WorkspaceStorageAuthorityMissingError";
  }
}

export function requireLocalWorkspaceStorageAuthority(
  backing: LocalWorkspaceBacking,
): StorageAuthorityId {
  if (backing.storageAuthorityId === null) throw new WorkspaceStorageAuthorityMissingError();
  return backing.storageAuthorityId;
}

export function workspaceUsesBacking<K extends WorkspaceBackingKind>(
  workspace: Workspace,
  kind: K,
): workspace is Workspace & { readonly backing: WorkspaceBackingFor<K> } {
  return workspace.backing.kind === kind;
}
