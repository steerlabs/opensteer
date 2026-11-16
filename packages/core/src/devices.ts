import { z } from "zod";
import { DeploymentIdSchema, RunnerIdSchema, UserIdSchema, idSchema } from "./ids.js";

export type DeviceId = string & { readonly __brand: "DeviceId" };
export const DeviceIdSchema: z.ZodType<DeviceId, string> = z
  .union([idSchema("device"), RunnerIdSchema])
  .transform((value) => value as DeviceId);

export const DeviceKindSchema = z.enum([
  "home",
  "computer",
  "phone",
  "agent-phone",
  "server",
  "unknown",
]);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;
export const DevicePlatformSchema = z.enum(["macos", "linux", "windows", "android", "ios"]);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;
export const DeviceFormSchema = z.enum(["laptop", "desktop", "compact", "server", "phone"]);
export type DeviceForm = z.infer<typeof DeviceFormSchema>;
export const DeviceDriverRoleSchema = z.enum(["self", "screen"]);
export type DeviceDriverRole = z.infer<typeof DeviceDriverRoleSchema>;
export const DeviceDriverGenerationSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export type DeviceDriverGeneration = z.infer<typeof DeviceDriverGenerationSchema>;
export const DeviceDriverIdentitySchema = z.strictObject({
  deviceId: DeviceIdSchema,
  role: DeviceDriverRoleSchema,
  runnerId: RunnerIdSchema,
  generation: DeviceDriverGenerationSchema,
});
export type DeviceDriverIdentity = z.infer<typeof DeviceDriverIdentitySchema>;
export const DeviceRecordSchema = z
  .strictObject({
    id: DeviceIdSchema,
    deploymentId: DeploymentIdSchema,
    ownerKind: z.enum(["deployment", "user"]),
    ownerUserId: UserIdSchema.nullable(),
    name: z.string().trim().min(1).max(120),
    kind: DeviceKindSchema,
    platform: DevicePlatformSchema.nullable(),
    form: DeviceFormSchema.nullable(),
    removedAt: z.iso.datetime({ offset: true }).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .refine(
    (device) => (device.ownerKind === "user") === (device.ownerUserId !== null),
    "Device ownership must name exactly its user owner",
  );
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

export const androidPhoneDefinitionId = "android-phone";
export const iphoneScreenDefinitionId = "iphone-screen";
export const phoneDisplayDefinitionIds = [
  androidPhoneDefinitionId,
  iphoneScreenDefinitionId,
] as const;
export const PhoneDisplayDefinitionIdSchema = z.enum(phoneDisplayDefinitionIds);
export type PhoneDisplayDefinitionId = z.infer<typeof PhoneDisplayDefinitionIdSchema>;
export function isPhoneDisplayDefinitionId(value: unknown): value is PhoneDisplayDefinitionId {
  return PhoneDisplayDefinitionIdSchema.safeParse(value).success;
}
