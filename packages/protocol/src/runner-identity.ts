import { RunnerIdSchema } from "@opensteer/core";
import { z } from "zod";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const RunnerBootIdSchema = z
  .string()
  .regex(new RegExp(`^rbt_${uuid}$`, "i"))
  .brand<"RunnerBootId">();
export type RunnerBootId = z.infer<typeof RunnerBootIdSchema>;

export const RunnerChallengeIdSchema = z
  .string()
  .regex(new RegExp(`^rch_${uuid}$`, "i"))
  .brand<"RunnerChallengeId">();
export type RunnerChallengeId = z.infer<typeof RunnerChallengeIdSchema>;

export const RunnerConnectionIdSchema = z
  .string()
  .regex(new RegExp(`^rcn_${uuid}$`, "i"))
  .brand<"RunnerConnectionId">();
export type RunnerConnectionId = z.infer<typeof RunnerConnectionIdSchema>;

export const RunnerConnectionLeaseIdSchema = z
  .string()
  .regex(new RegExp(`^rls_${uuid}$`, "i"))
  .brand<"RunnerConnectionLeaseId">();
export type RunnerConnectionLeaseId = z.infer<typeof RunnerConnectionLeaseIdSchema>;

export const RunnerAuxiliaryStreamIdSchema = z
  .string()
  .regex(new RegExp(`^rax_${uuid}$`, "i"))
  .brand<"RunnerAuxiliaryStreamId">();
export type RunnerAuxiliaryStreamId = z.infer<typeof RunnerAuxiliaryStreamIdSchema>;

/**
 * What one computer offers this Deployment. A Runner is the machine, so the
 * browser relay and the messaging runtime are modules of that one identity
 * rather than enrollments of their own.
 */
export const RunnerModuleNameSchema = z.enum([
  "agents",
  "browser",
  "integrations",
  "messaging",
  "shell",
]);
export type RunnerModuleName = z.infer<typeof RunnerModuleNameSchema>;

/**
 * The shape of the computer a Runner runs on. People recognise a computer by
 * its shape before its name, so clients draw it; nothing routes on it. Null
 * means the Runner could not tell, and a client draws a plain computer.
 */
export const RunnerDeviceFormSchema = z.enum(["laptop", "desktop", "compact", "server", "phone"]);
export type RunnerDeviceForm = z.infer<typeof RunnerDeviceFormSchema>;

export const RunnerDevicePlatformSchema = z.enum(["macos", "linux", "windows", "android", "ios"]);
export type RunnerDevicePlatform = z.infer<typeof RunnerDevicePlatformSchema>;

export const RunnerDeviceSchema = z.object({
  form: RunnerDeviceFormSchema.nullable(),
  platform: RunnerDevicePlatformSchema,
});
export type RunnerDevice = z.infer<typeof RunnerDeviceSchema>;

/**
 * The modules that reach the Host over a stream separate from the primary
 * control connection. `agents` is absent because agent work rides the primary
 * connection itself.
 */
export const RunnerAuxiliaryModuleSchema = RunnerModuleNameSchema.exclude(["agents"]);
export type RunnerAuxiliaryModule = z.infer<typeof RunnerAuxiliaryModuleSchema>;

/**
 * The exact socket a message belongs to. Every post-authentication frame in
 * both directions carries it, so a message written for a superseded connection
 * — or for a boot that has since been fenced — is refused rather than applied
 * to whatever connection happens to be current.
 */
export const RunnerConnectionFenceSchema = z.strictObject({
  bootId: RunnerBootIdSchema,
  connectionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  connectionId: RunnerConnectionIdSchema,
  connectionLeaseId: RunnerConnectionLeaseIdSchema,
  runnerId: RunnerIdSchema,
});
export type RunnerConnectionFence = z.infer<typeof RunnerConnectionFenceSchema>;

export function sameRunnerConnectionFence(
  left: RunnerConnectionFence,
  right: RunnerConnectionFence,
): boolean {
  return (
    left.runnerId === right.runnerId &&
    left.bootId === right.bootId &&
    left.connectionId === right.connectionId &&
    left.connectionLeaseId === right.connectionLeaseId &&
    left.connectionGeneration === right.connectionGeneration
  );
}
