import { z } from "zod";
import { EnvironmentIdSchema, RunIdSchema, ThreadIdSchema, WorkspaceIdSchema } from "./ids.js";

export const appMaxBytes = 5 * 1_024 * 1_024;
export const AppIdSchema = z.string().regex(/^app_[0-9a-f-]{36}$/u);
export const AppTitleSchema = z.string().trim().min(1).max(160);
export const AppPublishInputSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  title: AppTitleSchema,
  appId: AppIdSchema.optional(),
  start: z.string().trim().min(1).max(16_384).optional(),
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

export const AppServerSpecSchema = z.strictObject({
  environmentId: EnvironmentIdSchema,
  folder: z.string().min(1).max(4_096),
  command: z.string().min(1).max(16_384),
});
export type AppServerSpec = z.infer<typeof AppServerSpecSchema>;
export const AppFetchInputSchema = z.strictObject({
  appId: AppIdSchema,
  method: z
    .string()
    .regex(/^[A-Z]{1,32}$/u)
    .default("GET"),
  path: z.string().max(4_096).default("/"),
  headers: z.record(z.string().max(200), z.string().max(8_192)).optional(),
  body: z.string().max(262_144).optional(),
});
export function appFolderSegments(folder: string): string[] {
  const normalized = folder.replace(/^\.\//u, "");
  if (normalized === ".") return [];
  const segments = normalized.split("/");
  if (
    segments.some(
      (part) =>
        !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"),
    )
  )
    throw new Error("Use a Workspace-relative path without traversal");
  return segments;
}
