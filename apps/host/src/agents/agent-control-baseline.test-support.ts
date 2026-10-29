import { z } from "zod";
import {
  EnvironmentIdSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
} from "@opensteer/core";

/** c33be3c1 Runner response: deliberately independent of the current Workspace view. */
export const baselineWorkspaceCreateResponse = z.strictObject({
  type: z.literal("workspace.create.result"),
  requestId: z.uuid(),
  workspace: z.strictObject({
    homeThreadId: ThreadIdSchema.nullable(),
    capacity: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("host-filesystem") }),
      z.strictObject({ kind: z.literal("managed-quota") }),
    ]),
    createdAt: z.iso.datetime({ offset: true }),
    id: WorkspaceIdSchema,
    kind: WorkspaceKindSchema,
    location: z.discriminatedUnion("kind", [
      z.strictObject({
        environmentId: EnvironmentIdSchema,
        kind: z.literal("machine"),
        name: z.string().trim().min(1).max(120).nullable(),
      }),
      z.strictObject({ kind: z.literal("shared-storage") }),
    ]),
    name: z.string().trim().min(1).max(160),
    restoreProgressPermille: z.number().int().min(0).max(1000).optional(),
    status: z.enum([
      "provisioning",
      "ready",
      "archiving",
      "archived",
      "unavailable",
      "failed",
      "deleting",
      "deleted",
    ]),
    storageIssue: z
      .strictObject({
        code: z.string().trim().min(1).max(120),
        message: z.string().trim().min(1).max(500),
        occurredAt: z.iso.datetime({ offset: true }),
        retryable: z.boolean(),
      })
      .nullable(),
    updatedAt: z.iso.datetime({ offset: true }),
  }),
});
