import { z } from "zod";
import { RunIdSchema, ThreadIdSchema, WorkspaceIdSchema } from "./ids.js";

export const appMaxBytes = 5 * 1_024 * 1_024;
export const AppIdSchema = z.string().regex(/^app_[0-9a-f-]{36}$/u);
export const AppTitleSchema = z.string().trim().min(1).max(160);
export const AppPublishInputSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  title: AppTitleSchema,
  appId: AppIdSchema.optional(),
});
export const AppSchema = z.object({
  id: AppIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  runId: RunIdSchema,
  title: AppTitleSchema,
  latestVersion: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type OpensteerApp = z.infer<typeof AppSchema>;
