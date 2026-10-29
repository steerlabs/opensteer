import {
  EnvironmentIdSchema,
  StorageAuthorityIdSchema,
  UserIdSchema,
  WorkspaceBindingIdSchema,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
} from "@opensteer/core";
import {
  LocalDirectoryListingSchema,
  LocalFileMetadataSchema,
  LocalFileRevisionSchema,
  LocalPathSegmentBase64Schema,
  WorkspaceLocalFailureSchema,
  localFilesMaximumDirectoryOffset,
  localFilesMaximumPageEntries,
} from "@opensteer/workspace";
import { z } from "zod";
import { RunnerConnectionFenceSchema } from "./runner-identity.js";

const positiveGeneration = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Bytes per Files pull. Downloads drain the HTTP response one range at a time
 * rather than buffering a whole file, so this is also the Runner socket's
 * largest workspace payload. */
export const workspaceLocalFilesReadMaxBytes = 64 * 1_024;

/**
 * Who the Host believes it is talking to, checked by the Runner before it
 * touches a disk. `environmentId` says whose work this is; `storageAuthorityId`
 * says which disk, and the boot/connection pair says that this exact socket is
 * still the current one. A stale fence is refused rather than served, because
 * the Host may already have handed the same Workspace to a replacement
 * connection.
 */
export const WorkspaceStorageFenceSchema = z.strictObject({
  ...RunnerConnectionFenceSchema.shape,
  environmentId: EnvironmentIdSchema,
  storageAuthorityId: StorageAuthorityIdSchema,
});
export type WorkspaceStorageFence = z.infer<typeof WorkspaceStorageFenceSchema>;

export const LocalWorkspaceBindingRefSchema = z.strictObject({
  bindingId: WorkspaceBindingIdSchema,
  generation: positiveGeneration,
  ownerEnvironmentId: EnvironmentIdSchema,
  storageAuthorityId: StorageAuthorityIdSchema,
  workspaceId: WorkspaceIdSchema,
});
export type LocalWorkspaceBindingRef = z.infer<typeof LocalWorkspaceBindingRefSchema>;

/**
 * Stable across reconnects and Host restarts, unlike `requestId`. It is what
 * lets a Runner recognise a replay of work it already finished and answer from
 * its persisted receipt instead of provisioning or destroying twice.
 */
export const WorkspaceLocalOperationIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^workspace:[A-Za-z0-9_-]+:[a-z.]+:v1(?::[0-9]+)?$/u);

const workspaceLocalRequestBase = {
  binding: LocalWorkspaceBindingRefSchema,
  fence: WorkspaceStorageFenceSchema,
  operationId: WorkspaceLocalOperationIdSchema,
  requestId: z.uuid(),
} as const;

const ProvisionLocalWorkspaceSchema = z.strictObject({
  ...workspaceLocalRequestBase,
  // Exactly what the Runner needs to derive the managed directory path and to
  // refuse a replay whose creation intent differs.
  fingerprint: z.strictObject({
    createdBy: UserIdSchema,
    workspaceKind: WorkspaceKindSchema,
  }),
  type: z.literal("host.workspace.local.provision"),
});

const InspectLocalWorkspaceSchema = z.strictObject({
  ...workspaceLocalRequestBase,
  type: z.literal("host.workspace.local.inspect"),
});

const DestroyLocalWorkspaceSchema = z.strictObject({
  ...workspaceLocalRequestBase,
  type: z.literal("host.workspace.local.destroy"),
});

const ListLocalWorkspaceFilesSchema = z.strictObject({
  ...workspaceLocalRequestBase,
  expectedDirectoryRevision: LocalFileRevisionSchema.optional(),
  limit: z.number().int().min(1).max(localFilesMaximumPageEntries),
  offset: z.number().int().nonnegative().max(localFilesMaximumDirectoryOffset),
  pathSegmentsBase64: z.array(LocalPathSegmentBase64Schema).max(64),
  type: z.literal("host.workspace.local.files.list"),
});

const ReadLocalWorkspaceFileSchema = z.strictObject({
  ...workspaceLocalRequestBase,
  expectedFileRevision: LocalFileRevisionSchema.optional(),
  maxBytes: z.number().int().min(1).max(workspaceLocalFilesReadMaxBytes),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pathSegmentsBase64: z.array(LocalPathSegmentBase64Schema).min(1).max(64),
  type: z.literal("host.workspace.local.files.read"),
});

export const HostWorkspaceLocalRequestSchema = z.discriminatedUnion("type", [
  ProvisionLocalWorkspaceSchema,
  InspectLocalWorkspaceSchema,
  DestroyLocalWorkspaceSchema,
  ListLocalWorkspaceFilesSchema,
  ReadLocalWorkspaceFileSchema,
]);
export type HostWorkspaceLocalRequest = z.infer<typeof HostWorkspaceLocalRequestSchema>;

const workspaceLocalResultBase = {
  binding: LocalWorkspaceBindingRefSchema,
  fence: WorkspaceStorageFenceSchema,
  operationId: WorkspaceLocalOperationIdSchema,
  requestId: z.uuid(),
} as const;

export const RunnerWorkspaceLocalResultSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...workspaceLocalResultBase,
    type: z.literal("runner.workspace.local.provisioned"),
  }),
  z.strictObject({
    ...workspaceLocalResultBase,
    health: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("ready") }),
      z.strictObject({
        issue: WorkspaceLocalFailureSchema,
        status: z.enum(["unavailable", "failed"]),
      }),
    ]),
    type: z.literal("runner.workspace.local.inspected"),
  }),
  z.strictObject({
    ...workspaceLocalResultBase,
    // A destroy is only ever reported from a durable receipt, so an absent
    // binding never passes for a completed destruction.
    receipt: z.strictObject({
      destroyedAt: z.iso.datetime({ offset: true }),
      outcome: z.enum(["destroyed", "already-destroyed"]),
    }),
    type: z.literal("runner.workspace.local.destroyed"),
  }),
  z.strictObject({
    ...workspaceLocalResultBase,
    listing: LocalDirectoryListingSchema,
    type: z.literal("runner.workspace.local.files.listed"),
  }),
  z.strictObject({
    ...workspaceLocalResultBase,
    bytesRead: z.number().int().nonnegative().max(workspaceLocalFilesReadMaxBytes),
    contentBase64: z.string().max(90_000),
    eof: z.boolean(),
    metadata: LocalFileMetadataSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    type: z.literal("runner.workspace.local.files.read"),
  }),
  z.strictObject({
    error: WorkspaceLocalFailureSchema,
    fence: WorkspaceStorageFenceSchema,
    operationId: WorkspaceLocalOperationIdSchema,
    requestId: z.uuid(),
    type: z.literal("runner.workspace.local.error"),
  }),
]);
export type RunnerWorkspaceLocalResult = z.infer<typeof RunnerWorkspaceLocalResultSchema>;

/**
 * What the Runner says it is holding when it connects. The Host reconciles this
 * against its own rows: a binding the Host does not know about is reported as
 * an orphan for a person to resolve, never deleted on the Runner's word.
 */
export const RunnerLocalStorageInventorySchema = z.object({
  bindings: z
    .array(
      z.object({
        bindingId: WorkspaceBindingIdSchema,
        generation: positiveGeneration,
        state: z.enum(["provisioning", "ready"]),
        workspaceId: WorkspaceIdSchema,
      }),
    )
    .max(10_000),
  storageAuthorityId: StorageAuthorityIdSchema,
  /** True when `bindings` was cut to the bound above, so the Host does not read
   * a truncated list as a complete one and call the remainder orphaned. */
  truncated: z.boolean(),
});
export type RunnerLocalStorageInventory = z.infer<typeof RunnerLocalStorageInventorySchema>;

export function workspaceLocalOperationId(input: {
  readonly generation: number;
  readonly operation: "provision" | "destroy";
  readonly workspaceId: string;
}): string {
  return `workspace:${input.workspaceId}:${input.operation}:v1:${input.generation}`;
}
