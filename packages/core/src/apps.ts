import { ComputerFolderSchema } from "./personal.js";
import { z } from "zod";
import { RunnerIdSchema, RunIdSchema, ThreadIdSchema } from "./ids.js";

export const appMaxBytes = 5 * 1_024 * 1_024;
export const AppIdSchema = z.string().regex(/^app_[0-9a-f-]{36}$/u);
export const AppTitleSchema = z.string().trim().min(1).max(160);
export const LegacyAppPublishInputSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  title: AppTitleSchema,
  appId: AppIdSchema.optional(),
  start: z.string().trim().min(1).max(16_384).optional(),
});
export const LegacyAppSchema = z.object({
  id: AppIdSchema,
  threadId: ThreadIdSchema,
  runId: RunIdSchema,
  title: AppTitleSchema,
  latestVersion: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type OpensteerApp = z.infer<typeof LegacyAppSchema>;

export const AppServerSpecSchema = z.strictObject({
  folder: ComputerFolderSchema,
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
    throw new Error("Use a folder-relative path without traversal");
  return segments;
}

export const AppNameSchema = z.string().trim().min(1).max(160);
export type AppId = z.infer<typeof AppIdSchema>;
export const AppPublishInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(4096)
    .describe("HTML file or server folder relative to Agent home, without traversal."),
  name: AppNameSchema,
  appId: AppIdSchema.optional().describe("App ID from app_list or app_publish."),
  start: z
    .string()
    .trim()
    .min(1)
    .max(16384)
    .optional()
    .describe("Hosting-computer shell command; the server reads PORT from its environment."),
});
export type AppPublishInput = z.infer<typeof AppPublishInputSchema>;
export const AppStateSchema = z.enum(["running", "stopped", "failed", "offline"]);
export const AppServerSchema = z.strictObject({
  desiredState: z.enum(["running", "stopped"]),
  state: AppStateSchema,
  port: z.number().int().min(49152).max(65535),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lastError: z.string().max(2000).nullable(),
});
export type AppServer = z.infer<typeof AppServerSchema>;
export const AppSchema = z.strictObject({
  appId: AppIdSchema,
  name: AppNameSchema,
  kind: z.enum(["html", "server"]),
  state: AppStateSchema,
  localUrl: z.string().optional(),
  folder: z.string().max(4096).optional(),
  start: z.string().max(16384).optional(),
  computerId: RunnerIdSchema,
  taskId: ThreadIdSchema.nullable(),
  version: z.number().int().positive(),
  server: AppServerSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type App = z.infer<typeof AppSchema>;
export const AppListItemSchema = AppSchema.omit({ server: true, createdAt: true });
export type AppListItem = z.infer<typeof AppListItemSchema>;
