import {
  EnvironmentIdSchema,
  StorageAuthorityIdSchema,
  UserIdSchema,
  WorkspaceBindingIdSchema,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
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

export const PortableFsWorkspaceExecutionAccessPlanSchema = z.strictObject({
  createdBy: UserIdSchema,
  exchangeToken: z.string().min(1).max(32_768),
  exchangeUrl: z.url(),
  generation: positiveGeneration,
  kind: z.literal("portablefs"),
  volumeId: z.string().min(1).max(255),
  workspaceId: WorkspaceIdSchema,
  workspaceKind: WorkspaceKindSchema,
});
export type PortableFsWorkspaceExecutionAccessPlan = z.infer<
  typeof PortableFsWorkspaceExecutionAccessPlanSchema
>;

export const WorkspaceExecutionAccessPlanSchema = z.discriminatedUnion("kind", [
  LocalWorkspaceExecutionAccessPlanSchema,
  PortableFsWorkspaceExecutionAccessPlanSchema,
]);
export type WorkspaceExecutionAccessPlan = z.infer<typeof WorkspaceExecutionAccessPlanSchema>;
