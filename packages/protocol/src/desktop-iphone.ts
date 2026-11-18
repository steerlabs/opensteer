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
  /** Xcode isn't installed on this Mac. */
  "xcode-missing",
  "xcode-installing",
  /** Xcode is installed but hasn't installed its iPhone support yet (open it once). */
  "xcode-setup-required",
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
  "attach-failed",
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
/**
 * The person-facing checklist, in order. Setup on the Mac drives itself through it: each stage
 * is worked on by Opensteer, waits for the person (and keeps checking, so it moves on by itself
 * once they've done it), or asks them to decide something in the dialog.
 */
export const DesktopIphoneSetupStageSchema = z.enum([
  /** This Mac has the bridge and Xcode's iPhone support; checked before asking for a phone. */
  "mac",
  /** An iPhone is plugged in with a data cable; the person picks one only when there are several. */
  "connect",
  /** The person taps Trust on the iPhone and enters its passcode. */
  "trust",
  /** Developer Mode is on (Opensteer reveals the switch, the person turns it on and restarts). */
  "developer-mode",
  /** Opensteer mounts Apple's developer files and takes a first look at the screen. */
  "prepare",
  /** The person chooses whether to also control it over the same Wi‑Fi. */
  "wifi",
  /** The person names it and adds it; Opensteer adds it to the Host and waits for this Mac to take it on. */
  "add",
  "done",
]);
export type DesktopIphoneSetupStage = z.infer<typeof DesktopIphoneSetupStageSchema>;
/**
 * - working: Opensteer is doing the stage; nothing to press.
 * - waiting: the person must do something on the iPhone or this Mac (see `reason`). Setup keeps
 *   checking and continues by itself; `retry` only checks again now.
 * - decide: the dialog asks the person to choose (`action` says what).
 * - blocked: the stage failed in a way checking again won't fix by itself; `action` says how out.
 * - done: the iPhone was added and this Mac took it on.
 */
export const DesktopIphoneSetupStateSchema = z.enum([
  "working",
  "waiting",
  "decide",
  "blocked",
  "done",
]);
export const DesktopIphoneSetupActionSchema = z.enum([
  /** Open Xcode's page in the Mac App Store. */
  "get-xcode",
  /** Open Xcode so it finishes installing its iPhone support. */
  "open-xcode",
  "open-local-network",
  "choose-phone",
  "choose-wifi",
  "name-phone",
  /** Run the blocked stage again. */
  "retry",
  /** Cancel and begin again from the start. */
  "start-over",
  "none",
]);
export type DesktopIphoneSetupAction = z.infer<typeof DesktopIphoneSetupActionSchema>;
export const DesktopIphoneSetupBeginSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  target: IphoneScreenAttachCommandSchema.shape.target.optional(),
});
export const DesktopIphoneSetupIdSchema = z.strictObject({ setupId: z.uuid() });
export const DesktopIphoneSetupChooseSchema = DesktopIphoneSetupIdSchema.extend({
  candidateId: z.uuid(),
});
/** Runs one of the Mac-side helper actions the status offers (`get-xcode`, `open-xcode`, `open-local-network`). */
export const DesktopIphoneSetupHelpSchema = DesktopIphoneSetupIdSchema.extend({
  action: z.enum(["get-xcode", "open-xcode", "open-local-network"]),
});
/** Prepares the Host command that adds the iPhone under `name` (ignored when setting up an existing one). */
export const DesktopIphoneSetupAddSchema = DesktopIphoneSetupIdSchema.extend({
  name: z.string().trim().min(1).max(120).optional(),
});
export const DesktopIphoneWifiActionSchema = z.enum(["enable", "disable", "pair"]);
export const DesktopIphoneSetupWifiSchema = DesktopIphoneSetupIdSchema.extend({
  choice: z.enum(["wifi", "usb-only"]),
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
export const DesktopIphoneSetupPhoneSchema = z.strictObject({
  name: z.string().max(160),
  model: z.string().max(160),
  osVersion: z.string().max(160),
});
export const DesktopIphoneSetupStatusSchema = z.strictObject({
  setupId: z.uuid(),
  revision: z.number().int().positive(),
  deploymentId: DeploymentIdSchema,
  stage: DesktopIphoneSetupStageSchema,
  state: DesktopIphoneSetupStateSchema,
  /** Why setup waits or is blocked; null while working, deciding or done. */
  reason: DesktopIphoneSetupReasonSchema.nullable(),
  /** The one thing the dialog offers for this state. */
  action: DesktopIphoneSetupActionSchema,
  /** USB iPhones on this Mac; `reason` is set only when that phone can't be chosen. */
  candidates: z
    .array(
      DesktopIphoneSetupPhoneSchema.extend({
        candidateId: z.uuid(),
        trust: z.enum(["trusted", "untrusted", "checking"]),
        reason: DesktopIphoneSetupReasonSchema.nullable(),
      }),
    )
    .max(64),
  /** The iPhone this setup works on, once chosen. */
  phone: DesktopIphoneSetupPhoneSchema.nullable(),
  /** The name to prefill when adding. */
  suggestedName: z.string().max(120).nullable(),
  attachCommand: IphoneScreenAttachCommandSchema.nullable(),
  /** The Device this setup adds or sets up again; `existing` keeps that Device's name. */
  target: IphoneScreenAttachCommandSchema.shape.target.nullable(),
  deviceId: z.string().max(128).nullable(),
  driverGeneration: z.number().int().positive().nullable(),
  wifiEnabled: z.boolean(),
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
  /** Prepares `attachCommand` for the renderer to dispatch to the Host; then `complete` or `failed`. */
  add(input: z.infer<typeof DesktopIphoneSetupAddSchema>): Promise<DesktopIphoneSetupStatus>;
  help(input: z.infer<typeof DesktopIphoneSetupHelpSchema>): Promise<DesktopIphoneSetupStatus>;
  retry(input: z.infer<typeof DesktopIphoneSetupIdSchema>): Promise<DesktopIphoneSetupStatus>;
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
