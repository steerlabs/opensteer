import { z } from "zod";
import { DeploymentIdSchema } from "@opensteer/core";
import {
  IphoneScreenAttachCommandSchema,
  IphoneScreenAttachResultSchema,
  IphoneScreenDetachCommandSchema,
  IphoneScreenDetachResultSchema,
} from "./host-api.js";
import { iphoneNativeReasonSchema } from "./iphone-bridge.js";
export const DesktopIphoneSetupReasonSchema = z.enum([
  ...iphoneNativeReasonSchema.options,
  "bridge-not-built",
  "bridge-signature-invalid",
  "bridge-protocol-mismatch",
  "unsupported-mac",
  "no-phone",
  "unsupported-device",
  "restart-required",
  "waiting-for-phone",
  "unlock-required",
  "screen-off",
  "screen-state-unknown",
  "screenshot-failed",
  "geometry-unknown",
  "accessibility-unavailable",
  "accessibility-partial",
  "host-offline",
  "host-version-unsupported",
  "runner-not-enrolled",
  "runner-module-not-allowed",
  "device-not-owned",
  "driver-conflict",
  "attach-conflict",
  "phone-already-added",
  "local-mapping-save-failed",
  "assignment-pending",
  "wifi-not-enabled",
  "local-network-permission-required",
  "wifi-phone-not-found",
  "wifi-pairing-required",
  "wifi-transport-unsupported",
  "wifi-identity-mismatch",
]);
export type DesktopIphoneSetupReason = z.infer<typeof DesktopIphoneSetupReasonSchema>;
export const DesktopIphoneSetupStepSchema = z.enum([
  "choose",
  "trust",
  "developer-mode",
  "prepare",
  "observe",
  "wifi",
  "attach",
  "confirm",
  "done",
]);
export const DesktopIphoneSetupBeginSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  target: IphoneScreenAttachCommandSchema.shape.target.optional(),
});
export const DesktopIphoneSetupIdSchema = z.strictObject({ setupId: z.uuid() });
export const DesktopIphoneSetupChooseSchema = DesktopIphoneSetupIdSchema.extend({
  candidateId: z.uuid(),
});
export const DesktopIphoneSetupAdvanceSchema = DesktopIphoneSetupIdSchema.extend({
  step: z.enum(["trust", "developer-mode", "prepare", "observe", "attach"]),
  name: z.string().trim().min(1).max(120).optional(),
});
export const DesktopIphoneWifiActionSchema = z.enum(["enable", "disable", "pair"]);
export const DesktopIphoneSetupWifiSchema = DesktopIphoneSetupIdSchema.extend({
  action: z.enum([...DesktopIphoneWifiActionSchema.options, "skip"]),
});
export const DesktopIphoneWifiInputSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  deviceId: z.string().min(1).max(128),
});
export const DesktopIphoneConfigureWifiSchema = DesktopIphoneWifiInputSchema.extend({
  action: DesktopIphoneWifiActionSchema,
});
export const DesktopIphoneWifiStatusSchema = z.strictObject({
  enabled: z.boolean(),
  transport: z.enum(["usb", "wifi"]).nullable(),
  reason: DesktopIphoneSetupReasonSchema.nullable(),
});
export const DesktopIphoneSetupCompleteSchema = DesktopIphoneSetupIdSchema.extend({
  result: IphoneScreenAttachResultSchema,
});
export const DesktopIphoneSetupFailureSchema = DesktopIphoneSetupIdSchema.extend({
  reason: DesktopIphoneSetupReasonSchema,
});
export const DesktopIphoneSetupStatusSchema = z.strictObject({
  setupId: z.uuid(),
  deploymentId: DeploymentIdSchema,
  step: DesktopIphoneSetupStepSchema,
  reason: DesktopIphoneSetupReasonSchema.nullable(),
  recoverable: z.boolean(),
  personAction: z.enum([
    "choose-phone",
    "unlock-and-trust",
    "enable-developer-mode",
    "install-developer-image",
    "choose-wifi",
    "continue",
    "retry",
    "none",
  ]),
  candidates: z
    .array(
      z.strictObject({
        candidateId: z.uuid(),
        name: z.string().max(160),
        model: z.string().max(160),
        osVersion: z.string().max(160),
        reason: DesktopIphoneSetupReasonSchema.nullable(),
      }),
    )
    .max(64),
  attachCommand: IphoneScreenAttachCommandSchema.nullable(),
  /** The Device this setup adds or sets up again; `existing` keeps that Device's name. */
  target: IphoneScreenAttachCommandSchema.shape.target.nullable().default(null),
  deviceId: z.string().max(128).nullable(),
  driverGeneration: z.number().int().positive().nullable(),
  wifiEnabled: z.boolean().default(false),
});
export type DesktopIphoneSetupStatus = z.infer<typeof DesktopIphoneSetupStatusSchema>;
export interface DesktopIphoneSetupBridge {
  wifiStatus(
    input: z.infer<typeof DesktopIphoneWifiInputSchema>,
  ): Promise<z.infer<typeof DesktopIphoneWifiStatusSchema>>;
  configureWifi(
    input: z.infer<typeof DesktopIphoneConfigureWifiSchema>,
  ): Promise<z.infer<typeof DesktopIphoneWifiStatusSchema>>;
  wifi(input: z.infer<typeof DesktopIphoneSetupWifiSchema>): Promise<DesktopIphoneSetupStatus>;
  detach(
    input: z.infer<typeof DesktopIphoneDetachInputSchema>,
  ): Promise<z.infer<typeof DesktopIphoneDetachStatusSchema>>;
  completeDetach(input: z.infer<typeof DesktopIphoneDetachCompleteSchema>): Promise<void>;
  pendingDetaches(
    input: z.infer<typeof DesktopIphoneSetupBeginSchema>,
  ): Promise<z.infer<typeof DesktopIphoneDetachStatusSchema>[]>;
  begin(input: z.infer<typeof DesktopIphoneSetupBeginSchema>): Promise<DesktopIphoneSetupStatus>;
  choose(input: z.infer<typeof DesktopIphoneSetupChooseSchema>): Promise<DesktopIphoneSetupStatus>;
  advance(
    input: z.infer<typeof DesktopIphoneSetupAdvanceSchema>,
  ): Promise<DesktopIphoneSetupStatus>;
  complete(
    input: z.infer<typeof DesktopIphoneSetupCompleteSchema>,
  ): Promise<DesktopIphoneSetupStatus>;
  failed(input: z.infer<typeof DesktopIphoneSetupFailureSchema>): Promise<DesktopIphoneSetupStatus>;
  status(input: z.infer<typeof DesktopIphoneSetupIdSchema>): Promise<DesktopIphoneSetupStatus>;
  cancel(input: z.infer<typeof DesktopIphoneSetupIdSchema>): Promise<void>;
  subscribe(
    input: z.infer<typeof DesktopIphoneSetupIdSchema>,
    listener: (status: DesktopIphoneSetupStatus) => void,
  ): () => void;
}

export const DesktopIphoneDetachInputSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  deviceId: z.string().min(1).max(128),
});
export const DesktopIphoneDetachStatusSchema = z.strictObject({
  pending: z.literal(true),
  command: IphoneScreenDetachCommandSchema,
});
export const DesktopIphoneDetachCompleteSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  idempotencyKey: z.string().min(1).max(128),
  result: IphoneScreenDetachResultSchema,
});
