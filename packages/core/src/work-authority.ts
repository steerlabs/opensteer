import { z } from "zod";
import { UserIdSchema, WorkspaceIdSchema } from "./ids.js";

const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const HumanRootSchema = z.strictObject({
  userId: UserIdSchema,
  initiatorGeneration: generation,
  membershipGeneration: generation,
  originConnectionId: z.string().min(1).max(255).nullable(),
});
export type HumanRoot = z.infer<typeof HumanRootSchema>;

export const ProjectAuthoritySchema = z.strictObject({
  version: z.literal(1),
  principal: z.strictObject({
    kind: z.literal("project"),
    workspaceId: WorkspaceIdSchema,
    principalId: z.string().trim().min(1).max(255),
  }),
  origin: HumanRootSchema.nullable(),
});
export type ProjectAuthority = z.infer<typeof ProjectAuthoritySchema>;
