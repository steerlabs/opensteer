import {
  EnvironmentIdSchema,
  StorageAuthorityIdSchema,
  WorkspaceBindingIdSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";
import { z } from "zod";

const positiveGeneration = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const LocalWorkspaceExecutionAccessPlanSchema = z.strictObject({
  bindingId: WorkspaceBindingIdSchema,
  generation: positiveGeneration,
  kind: z.literal("local-directory"),
  ownerEnvironmentId: EnvironmentIdSchema,
  storageAuthorityId: StorageAuthorityIdSchema,
  workspaceId: WorkspaceIdSchema,
});
export type LocalWorkspaceExecutionAccessPlan = z.infer<
  typeof LocalWorkspaceExecutionAccessPlanSchema
>;

export const WorkspaceExecutionAccessPlanSchema = LocalWorkspaceExecutionAccessPlanSchema;
export type WorkspaceExecutionAccessPlan = z.infer<typeof WorkspaceExecutionAccessPlanSchema>;
