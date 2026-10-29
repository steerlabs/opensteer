import { DeploymentIdSchema } from "@opensteer/core";
import { z } from "zod";

export const CloudDeploymentOperationIdSchema = z.uuid().transform((value) => value.toLowerCase());
export const CreateCloudDeploymentRequestSchema = z.strictObject({
  operationId: CloudDeploymentOperationIdSchema,
  name: z.string().trim().min(1).max(120),
});
export const DeleteCloudDeploymentRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
});
/** What the Account reports back about one Cloud Deployment operation. */
export const CloudDeploymentOperationSchema = z.object({
  operationId: CloudDeploymentOperationIdSchema,
  deploymentId: DeploymentIdSchema,
  name: z.string().min(1).max(120),
  status: z.enum(["creating", "ready", "failed", "deleting", "deleted"]),
  desiredState: z.enum(["present", "deleted"]),
  error: z.string().max(512).nullable(),
  /** What the operation is waiting on while it runs; a failure is `error`, never this. */
  progress: z.string().max(512).nullable(),
  canonicalOrigin: z.url(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const ListCloudDeploymentsResponseSchema = z.object({
  available: z.boolean(),
  deployments: z.array(CloudDeploymentOperationSchema),
});
export type CloudDeploymentOperation = z.infer<typeof CloudDeploymentOperationSchema>;
export type CreateCloudDeploymentRequest = z.infer<typeof CreateCloudDeploymentRequestSchema>;
export type ListCloudDeploymentsResponse = z.infer<typeof ListCloudDeploymentsResponseSchema>;
