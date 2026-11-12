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
});
export type AppRuntimeSpec = z.infer<typeof AppRuntimeSpecSchema>;
const base = {
  requestId: z.uuid(),
  spec: AppRuntimeSpecSchema,
  fence: TaskRuntimeFenceSchema,
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
  fence: TaskRuntimeFenceSchema,
  ok: z.boolean(),
  port: z.number().int().min(1).max(65_535).optional(),
  error: z.string().max(2_000).optional(),
  logTail: z.string().max(16_384).optional(),
});
export type RunnerAppResult = z.infer<typeof RunnerAppResultSchema>;
export const appTunnelMaxFrameBytes = 64 * 1_024;
