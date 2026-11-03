import { AppIdSchema } from "@opensteer/core";
import { z } from "zod";
import { LocalWorkspaceBindingRefSchema, WorkspaceStorageFenceSchema } from "./workspace-local.js";

export const AppRuntimeSpecSchema = z.strictObject({
  appId: AppIdSchema,
  version: z.number().int().positive(),
  binding: LocalWorkspaceBindingRefSchema,
  folder: z.string().min(1).max(4_096),
  command: z.string().min(1).max(16_384),
});
export type AppRuntimeSpec = z.infer<typeof AppRuntimeSpecSchema>;
const base = {
  requestId: z.uuid(),
  spec: AppRuntimeSpecSchema,
  fence: WorkspaceStorageFenceSchema,
};
export const HostAppRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...base, type: z.literal("host.app.start") }),
  z.strictObject({
    ...base,
    type: z.literal("host.app.connect"),
    ticket: z.string().min(1).max(200),
  }),
  z.strictObject({ ...base, type: z.literal("host.app.stop") }),
  z.strictObject({ ...base, type: z.literal("host.app.cancel") }),
]);
export type HostAppRequest = z.infer<typeof HostAppRequestSchema>;
export const RunnerAppResultSchema = z.strictObject({
  type: z.literal("runner.app.result"),
  requestId: z.uuid(),
  appId: AppIdSchema,
  fence: WorkspaceStorageFenceSchema,
  ok: z.boolean(),
  port: z.number().int().min(1).max(65_535).optional(),
  error: z.string().max(2_000).optional(),
  logTail: z.string().max(16_384).optional(),
});
export type RunnerAppResult = z.infer<typeof RunnerAppResultSchema>;
export const appTunnelMaxFrameBytes = 64 * 1_024;
