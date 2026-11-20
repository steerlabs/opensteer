import { z } from "zod";
import {
  DeviceIdSchema,
  DeviceKindSchema,
  DeviceDriverRoleSchema,
  DeviceDriverGenerationSchema,
  PhoneDisplayDefinitionIdSchema,
  RunnerIdSchema,
} from "@opensteer/core";

export const DeviceInitialAccessSchema = z.strictObject({
  browser: z.boolean(),
  apps: z.boolean(),
  files: z.boolean(),
});
export type DeviceInitialAccess = z.infer<typeof DeviceInitialAccessSchema>;
export const DeviceSessionBindingProofSchema = z.strictObject({
  issuedAt: z.iso.datetime({ offset: true }),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type DeviceSessionBindingProof = z.infer<typeof DeviceSessionBindingProofSchema>;
export const DevicePreparedIdentitySchema = z.strictObject({
  runnerId: RunnerIdSchema,
  publicKeyPem: z.string().min(1).max(4096),
});
export type DevicePreparedIdentity = z.infer<typeof DevicePreparedIdentitySchema>;

export const RunnerLeaveRequestSchema = z.strictObject({
  deploymentId: z.string().min(1).max(255),
  runnerId: z.string().min(1).max(255),
  ...DeviceSessionBindingProofSchema.shape,
  preparedIdentity: DevicePreparedIdentitySchema.optional(),
});
export type RunnerLeaveRequest = z.infer<typeof RunnerLeaveRequestSchema>;
export const RunnerLeaveResponseSchema = z.object({ outcome: z.literal("removed") });
export type RunnerLeaveResponse = z.infer<typeof RunnerLeaveResponseSchema>;

export const DeviceRefusalContextSchema = z.object({
  machineId: DeviceIdSchema,
  capability: z.enum(["browser", "apps", "files"]),
});
export type DeviceRefusalContext = z.infer<typeof DeviceRefusalContextSchema>;

export const DeviceDriverViewSchema = z.object({
  role: DeviceDriverRoleSchema,
  runnerId: RunnerIdSchema,
  runnerName: z.string().min(1).max(120),
  generation: DeviceDriverGenerationSchema,
  attached: z.boolean(),
});
export type DeviceDriverView = z.infer<typeof DeviceDriverViewSchema>;

export const DeviceCapabilityReasonSchema = z.strictObject({
  kind: z.enum([
    "unsupported",
    "not-connected",
    "driver-offline",
    "driver-asleep",
    "driver-stopped",
    "connecting",
    "unreported",
    "driver-update-required",
    "helper-unavailable",
    "setup-required",
    "permission-required",
    "trust-required",
    "developer-mode-required",
    "locked",
    "paused",
    "protected",
    "access-off",
    "approval-required",
    "runtime-failed",
  ]),
});
export type DeviceCapabilityReason = z.infer<typeof DeviceCapabilityReasonSchema>;
export function normalizeDeviceCapabilityReason(value: unknown): DeviceCapabilityReason {
  const result = DeviceCapabilityReasonSchema.safeParse(value);
  return result.success ? result.data : { kind: "runtime-failed" };
}
export const DeviceAvailabilitySchema = z
  .strictObject({
    state: z.enum(["ready", "disabled", "unavailable", "unsupported"]),
    reason: DeviceCapabilityReasonSchema.nullable(),
  })
  .refine(
    (value) => (value.state === "ready") === (value.reason === null),
    "Only ready availability has no reason",
  );
export type DeviceAvailability = z.infer<typeof DeviceAvailabilitySchema>;
const deviceAvailabilityViewShape = {
  state: DeviceAvailabilitySchema.shape.state.catch("unavailable"),
  reason: z
    .unknown()
    .transform((value) => (value === null ? null : normalizeDeviceCapabilityReason(value))),
};
function conservativeAvailability<T extends DeviceAvailability>(value: T): T {
  return value.state === "ready" && value.reason !== null
    ? { ...value, state: "unavailable" }
    : value;
}
export const DeviceAvailabilityViewSchema = z
  .object(deviceAvailabilityViewShape)
  .transform(conservativeAvailability);
export const DeviceCapabilitySchema = DeviceAvailabilitySchema.safeExtend({
  supported: z.boolean(),
  enabled: z.boolean(),
  configurable: z.boolean(),
});
export type DeviceCapability = z.infer<typeof DeviceCapabilitySchema>;
export const DeviceCapabilityViewSchema = z
  .object({
    ...deviceAvailabilityViewShape,
    supported: z.boolean(),
    enabled: z.boolean(),
    configurable: z.boolean(),
  })
  .transform(conservativeAvailability);
export const DeviceCapabilitiesSchema = z.object({
  browser: DeviceCapabilityViewSchema,
  apps: DeviceCapabilityViewSchema,
  files: DeviceCapabilityViewSchema,
});
export type DeviceCapabilities = z.infer<typeof DeviceCapabilitiesSchema>;

export const PhoneDisplayActionTypeSchema = z.enum([
  "tap",
  "longPress",
  "swipe",
  "drag",
  "type",
  "clear",
  "navigate",
  "launch",
  "scroll",
  "wake",
  "wait",
]);
export type PhoneDisplayActionType = z.infer<typeof PhoneDisplayActionTypeSchema>;
export const PhoneDisplayNavigationIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/u);
export const PhoneDisplayNavigationButtonSchema = z.strictObject({
  id: PhoneDisplayNavigationIdSchema,
  label: z.string().trim().min(1).max(120),
});
export type PhoneDisplayNavigationButton = z.infer<typeof PhoneDisplayNavigationButtonSchema>;
export const PhoneDisplayNavigationButtonViewSchema = z.object(
  PhoneDisplayNavigationButtonSchema.shape,
);
export const PhoneDisplayNavigationButtonsSchema = z
  .array(PhoneDisplayNavigationButtonSchema)
  .max(32)
  .refine(
    (buttons) => new Set(buttons.map(({ id }) => id)).size === buttons.length,
    "Navigation IDs must be unique",
  );
export const PhoneDisplaySetupSchema = z.discriminatedUnion("location", [
  z.object({ location: z.literal("android-usb") }),
  z.object({ location: z.literal("this-device") }),
  z.object({
    location: z.literal("driver-mac"),
    driverRunnerId: RunnerIdSchema,
    driverRunnerName: z.string().min(1).max(120),
  }),
]);
export const PhoneDisplayViewSchema = z.object({
  definitionId: PhoneDisplayDefinitionIdSchema,
  driver: DeviceDriverViewSchema.nullable(),
  control: DeviceAvailabilityViewSchema,
  view: DeviceAvailabilityViewSchema,
  input: DeviceAvailabilityViewSchema,
  navigationButtons: z
    .array(PhoneDisplayNavigationButtonViewSchema)
    .max(32)
    .refine(
      (buttons) => new Set(buttons.map(({ id }) => id)).size === buttons.length,
      "Navigation IDs must be unique",
    ),
  actions: z.array(PhoneDisplayActionTypeSchema).max(11),
  wake: z.boolean(),
  lock: z.boolean().nullable(),
  setup: PhoneDisplaySetupSchema,
});
export type PhoneDisplayView = z.infer<typeof PhoneDisplayViewSchema>;
export const DeviceViewSchema = z.object({
  id: DeviceIdSchema,
  kind: DeviceKindSchema,
  name: z.string().min(1).max(120),
  selfRunnerId: RunnerIdSchema.nullable(),
  drivers: z
    .array(DeviceDriverViewSchema)
    .max(2)
    .refine(
      (drivers) => new Set(drivers.map(({ role }) => role)).size === drivers.length,
      "A Device has one driver slot per role",
    ),
  capabilities: DeviceCapabilitiesSchema,
  phoneDisplay: PhoneDisplayViewSchema.nullable(),
});
export type DeviceView = z.infer<typeof DeviceViewSchema>;

export const DeviceTargetRefusalContextSchema = DeviceRefusalContextSchema.extend({
  machineId: DeviceIdSchema,
});
export type DeviceTargetRefusalContext = z.infer<typeof DeviceTargetRefusalContextSchema>;
