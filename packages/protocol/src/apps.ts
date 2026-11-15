import { TaskRuntimeFenceSchema } from "./runner-identity.js";
import { AppIdSchema } from "@opensteer/core";
import { z } from "zod";
import { ComputerFolderSchema } from "@opensteer/core";

export const AppRuntimeSpecSchema = z.strictObject({
  appId: AppIdSchema,
  version: z.number().int().positive(),
  /** The server's folder, which the Runner refuses unless it resolves inside `agentHome`. */
  folder: ComputerFolderSchema,
  agentHome: ComputerFolderSchema,

  command: z.string().min(1).max(16_384),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  port: z.number().int().min(49152).max(65535),
});
export type AppRuntimeSpec = z.infer<typeof AppRuntimeSpecSchema>;

export const RunnerAppResultSchema = z.strictObject({
  type: z.literal("runner.app.result"),
  requestId: z.uuid(),
  appId: AppIdSchema,
  fence: TaskRuntimeFenceSchema,
  ok: z.boolean(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  port: z.number().int().min(49152).max(65535).optional(),
  reason: z.literal("port_in_use").optional(),
  error: z.string().max(2_000).optional(),
  logTail: z.string().max(16_384).optional(),
});

export type RunnerAppResult = z.infer<typeof RunnerAppResultSchema>;
export const appTunnelMaxFrameBytes = 64 * 1_024;

import {
  AppServerSchema,
  AppSchema,
  AppIdSchema as PublishedAppIdSchema,
  AppNameSchema,
} from "@opensteer/core";

const request = { requestId: z.uuid(), fence: TaskRuntimeFenceSchema };
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const HostAppRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...request, type: z.literal("host.app.start"), spec: AppRuntimeSpecSchema }),
  z.strictObject({
    ...request,
    type: z.literal("host.app.connect"),
    spec: AppRuntimeSpecSchema,
    ticket: z.string().min(1).max(200),
  }),
  z.strictObject({
    ...request,
    type: z.literal("host.app.stop"),
    appId: PublishedAppIdSchema,
    generation,
  }),
  z.strictObject({ ...request, type: z.literal("host.app.cancel"), appId: PublishedAppIdSchema }),
]);
export type HostAppRequest = z.infer<typeof HostAppRequestSchema>;
export const HostAppsSyncSchema = z.strictObject({
  ...request,
  type: z.literal("host.apps.sync"),
  apps: z
    .array(
      z.strictObject({ spec: AppRuntimeSpecSchema, desiredState: z.enum(["running", "stopped"]) }),
    )
    .max(500),
});
export type HostAppsSync = z.infer<typeof HostAppsSyncSchema>;
export const RunnerAppStateSchema = z.strictObject({
  type: z.literal("runner.app.state"),
  fence: TaskRuntimeFenceSchema,
  appId: AppIdSchema,
  version: z.number().int().positive(),
  generation,
  state: z.enum(["running", "stopped", "failed"]),
  error: z.string().max(2000).optional(),
});
export type RunnerAppState = z.infer<typeof RunnerAppStateSchema>;

export const RunnerAppsSyncResultSchema = z.strictObject({
  ...request,
  type: z.literal("runner.apps.sync.result"),
  ok: z.boolean(),
  error: z.string().max(2000).optional(),
});
export type RunnerAppsSyncResult = z.infer<typeof RunnerAppsSyncResultSchema>;
const appCommand = { idempotencyKey: z.string().min(1).max(255), appId: AppIdSchema };
export const AppCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...appCommand, type: z.literal("app.rename"), name: AppNameSchema }),
  z.strictObject({ ...appCommand, type: z.literal("app.start") }),
  z.strictObject({ ...appCommand, type: z.literal("app.stop") }),
  z.strictObject({ ...appCommand, type: z.literal("app.delete") }),
]);
export type AppCommand = z.infer<typeof AppCommandSchema>;
export const AppViewSchema = z.object({
  ...AppSchema.shape,
  server: z.object(AppServerSchema.shape).nullable(),
});
export const AppCommandResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("app.rename"), app: AppViewSchema }),
  z.object({ type: z.literal("app.start"), app: AppViewSchema }),
  z.object({ type: z.literal("app.stop"), app: AppViewSchema }),
  z.object({ type: z.literal("app.delete"), appId: AppIdSchema, deleted: z.literal(true) }),
]);
export type AppCommandResult = z.infer<typeof AppCommandResultSchema>;
export const AppsListInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(200).optional(),
});
export const AppsListResultSchema = z.object({ apps: z.array(AppViewSchema).max(500) });
export const HostAppsChangedSchema = z.object({
  type: z.literal("host.apps.changed"),
  appIds: z.array(AppIdSchema).max(500),
});
