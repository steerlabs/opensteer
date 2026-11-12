import { z } from "zod";
import {
  DeploymentIdSchema,
  RunnerIdSchema,
  SequenceSchema,
  ThreadIdSchema,
  UserIdSchema,
} from "./ids.js";

export const TaskFolderSchema = z.strictObject({
  computerId: RunnerIdSchema,
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (path) =>
        !path.includes("\0") &&
        (path.startsWith("/") ||
          /^[A-Za-z]:[\\/]/u.test(path) ||
          /^\\\\[^\\]+\\[^\\]+/u.test(path)),
      "Folder path must be absolute",
    ),
});
export type TaskFolder = z.infer<typeof TaskFolderSchema>;
export const PersonalSettingsSchema = z.strictObject({
  ownerId: UserIdSchema,
  agentHome: TaskFolderSchema,
  voiceThreadId: ThreadIdSchema.nullable(),
});
export type PersonalSettings = z.infer<typeof PersonalSettingsSchema>;
export const DeploymentResumeCursorSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  apiVersion: z.number().int().positive(),
  afterSequence: SequenceSchema,
});
export type DeploymentResumeCursor = z.infer<typeof DeploymentResumeCursorSchema>;
