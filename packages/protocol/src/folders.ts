import { RunnerConnectionFenceSchema } from "./runner-identity.js";
import { EnvironmentIdSchema } from "@opensteer/core";
import { z } from "zod";
import { TaskFolderSchema } from "@opensteer/core";
export const PersonalExecutionLocationSchema = z.strictObject({
  folder: TaskFolderSchema,
  agentHome: TaskFolderSchema,
});
export type PersonalExecutionLocation = z.infer<typeof PersonalExecutionLocationSchema>;

export const TaskRuntimeFenceSchema = RunnerConnectionFenceSchema.extend({
  environmentId: EnvironmentIdSchema,
  bindingGeneration: z.number().int().positive(),
}).strict();
