import { DeviceKindSchema } from "@opensteer/core";
import { DeviceViewSchema } from "./devices.js";
import { MachineComputerUseSchema } from "./computer-use.js";
import { z } from "zod";
import {
  ComputerAppOperationStatusSchema,
  ComputerAppStatusEntrySchema,
  computerAppMaxStatusEntries,
} from "./computer-apps.js";

import { RunnerModuleReadinessSchema } from "./runner.js";
import {
  RunnerDeviceFormSchema,
  RunnerDeviceSchema,
  RunnerDevicePlatformSchema,
  RunnerModuleNameSchema,
} from "./runner-identity.js";
import {
  MachineAccessPolicyViewSchema,
  ShellSessionSummarySchema,
  machineAccessMaxActiveSessions,
} from "./shell.js";

/**
 * What one module of a computer can do for this Deployment right now.
 *
 * Readiness is separate from the machine's `status` on purpose: a connected
 * computer whose browser died is online with an unavailable browser module,
 * and routing must be able to tell those apart.
 */
export const MachineModuleSummarySchema = z.object({
  checkedAt: z.string().max(64).nullable(),
  /** The Runner's report (at most 500 characters at ingress) or the Host's own short reason. */
  detail: z.string().max(500).nullable(),
  readiness: RunnerModuleReadinessSchema,
});
export type MachineModuleSummary = z.infer<typeof MachineModuleSummarySchema>;

export const MachineAppStatusSchema = z.object({
  ...ComputerAppStatusEntrySchema.shape,
  // Host responses are forward tolerant at every reachable object. A newer
  // Host may add operation facts without making an older app reject the
  // entire machines list.
  operations: z.array(z.object(ComputerAppOperationStatusSchema.shape)).max(64),
});
export type MachineAppStatus = z.infer<typeof MachineAppStatusSchema>;

const MachineDevicePlatformViewSchema = RunnerDevicePlatformSchema;

// Presentation fallback applies only to unfamiliar strings. Validate both
// fields before dropping a device so malformed fields still fail.
export const MachineDeviceSchema = z
  .object({
    app: RunnerDeviceSchema.shape.app,
    form: z
      .string()
      .max(64)
      .nullable()
      .transform((form) => {
        const parsed = RunnerDeviceFormSchema.safeParse(form);
        return parsed.success ? parsed.data : null;
      }),
    platform: z.string().max(64),
  })
  .transform((device) => {
    const platform = MachineDevicePlatformViewSchema.safeParse(device.platform);
    return platform.success ? { ...device, platform: platform.data } : null;
  });
export type MachineDevice = z.infer<typeof MachineDeviceSchema>;

export const MachineKindSchema = DeviceKindSchema;
export type MachineKind = z.infer<typeof MachineKindSchema>;

export const MachineSummarySchema = z.object({
  selfRunnerId: DeviceViewSchema.shape.selfRunnerId.optional(),
  drivers: DeviceViewSchema.shape.drivers.optional(),
  capabilities: DeviceViewSchema.shape.capabilities.optional(),
  phoneDisplay: DeviceViewSchema.shape.phoneDisplay.optional(),
  kind: z
    .string()
    .max(64)
    .transform((kind) => MachineKindSchema.safeParse(kind).data ?? "unknown")
    .optional(),
  apps: z.array(MachineAppStatusSchema).max(computerAppMaxStatusEntries).nullable().default(null),
  /**
   * What this computer permits callers on other computers, and who is using it
   * right now. Null for everyone but a management viewer: reach is never
   * disclosed beyond a person's own ability to connect.
   */
  access: z
    .object({
      activeSessions: z.array(ShellSessionSummarySchema).max(machineAccessMaxActiveSessions),
      /**
       * Whether `reach: "owner"` means anybody on this computer.
       *
       * A Deployment-owned machine usually has no effective owner, so "My
       * agents" would name nobody and the authoritative write refuses it. The
       * Personal main computer is the exception — the Deployment owns it, and
       * the person who established the Deployment is its effective owner — so
       * this is a fact only the server can state, not one the editor can infer
       * from ownership.
       */
      ownerReachAvailable: z.boolean(),
      policy: MachineAccessPolicyViewSchema,
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .nullable(),
  /**
   * What this Mac says about computer use, and the session running on it.
   *
   * Null for everyone but the owner, exactly as `apps` is: which apps a person
   * let agents operate, and what one is doing in them right now, is their own
   * business and not a fact about the computer anyone managing it may read.
   */
  computerUse: MachineComputerUseSchema.nullable().default(null),
  detail: z.string().nullable(),
  /**
   * What the computer says it is — its shape and platform — from its last
   * signed hello. Null until it has said, and for an older Runner.
   */
  device: MachineDeviceSchema.nullable().default(null),
  /** Correlates a pending addition with the computer that redeems it. */
  enrollmentId: z.string().min(1).max(256).nullable(),
  expiresAt: z.string().nullable(),
  /**
   * Whether macOS lets agents open everything on this computer that its
   * account can — Messages, Mail, Safari data, Desktop, Documents, Downloads.
   * The machine's own word, announced by its Runner and refreshed whenever the
   * grant changes. Null for every computer that has no such gate: Linux, a
   * pending row, a machine that does not advertise `shell`. A Host older than
   * this field omits it, and an app that outpaces its Host still lists the
   * computer rather than refusing the whole machines list.
   */
  fullDiskAccess: z.boolean().nullable().default(null),
  /** The RunnerId once enrolled; the enrollment id while the row is pending. */
  id: z.string().min(1).max(255),
  lastSeenAt: z.string().nullable(),
  /**
   * The Opensteer build this computer runs, as its current connection said
   * it. Null while it is not connected, for a pending row, and from an older
   * Host. A phone's page compares it with the Agent Phone app the client
   * bundles to offer an update over USB.
   */
  runtimeVersion: z.string().min(1).max(120).nullable().default(null),

  /**
   * The grant: every module this computer may ever advertise, fixed when it
   * was added. `modules` says what it is advertising now, which may be less.
   */
  allowedModules: z.array(RunnerModuleNameSchema).max(5),
  modules: z.object({
    agents: MachineModuleSummarySchema.optional(),
    browser: MachineModuleSummarySchema.optional(),
    integrations: MachineModuleSummarySchema.optional(),
    messaging: MachineModuleSummarySchema.optional(),
    shell: MachineModuleSummarySchema.optional(),
  }),
  name: z.string(),
  ownership: z.enum(["mine", "deployment"]),
  revocable: z.boolean(),
  status: z.enum(["online", "offline", "pending", "needs-update", "updating", "update-pending"]),
});
export type MachineSummary = z.infer<typeof MachineSummarySchema>;
/**
 * `machines.list` reads each computer with the tasks placed on it, counted in that read. The
 * `machine` resource leaves the count out: task writes do not move its revision.
 */
export const MachineListSummarySchema = MachineSummarySchema.extend({
  /** Threads placed here, which lose the computer they run on with it. */
  pinnedThreads: z.number().int().nonnegative().max(1_000_000),
});
export type MachineListSummary = z.infer<typeof MachineListSummarySchema>;

/**
 * How much each heavy section of a computer holds, for the list: null where this viewer is not
 * shown that section (the same rule that makes it null in `machine.detail.get`).
 */
export const MachineSectionCountsSchema = z.object({
  apps: z.number().int().nonnegative().max(computerAppMaxStatusEntries).nullable(),
  accessSessions: z.number().int().nonnegative().max(machineAccessMaxActiveSessions).nullable(),
  ownerViews: z.number().int().nonnegative().max(1_000).nullable(),
  computerUseSessions: z.number().int().nonnegative().max(1_000).nullable(),
});
export type MachineSectionCounts = z.infer<typeof MachineSectionCountsSchema>;

/**
 * A computer as the `machine` inventory carries it: what lists, removal, status and placement
 * read, each field bounded, so 64 of them sit far inside the inventory bound. Its heavy sections
 * (apps, access, computer use) are read per computer through `machine.detail.get`; the list
 * says only how much each holds.
 */
export const MachineInventoryEntrySchema = MachineSummarySchema.omit({
  access: true,
  apps: true,
  computerUse: true,
}).extend({
  name: z.string().max(255),
  detail: z.string().max(1_000).nullable(),
  expiresAt: z.string().max(64).nullable(),
  lastSeenAt: z.string().max(64).nullable(),
  sections: MachineSectionCountsSchema,
});
export type MachineInventoryEntry = z.infer<typeof MachineInventoryEntrySchema>;
/** Computers and devices one Personal Deployment holds, enrolled or waiting to enroll. */
export const personalMachineLimit = 64;
/**
 * No inventory entry is larger than this, whatever every section of its computer holds: every
 * field at its declared limit, every character three bytes. Real entries are a few KiB.
 */
export const machineInventoryEntryMaxBytes = 40 * 1024;

/**
 * A computer as the `machine` inventory carries it: everything but its heavy sections, which
 * become counts. `machine.detail.get` serves the sections themselves.
 */
export function machineInventoryEntry(
  machine: MachineSummary & { readonly pinnedThreads?: number },
): MachineInventoryEntry {
  const { access, apps, computerUse, pinnedThreads: _placed, ...entry } = machine;
  return {
    ...entry,
    sections: {
      apps: apps?.length ?? null,
      accessSessions: access?.activeSessions.length ?? null,
      ownerViews: computerUse ? (computerUse.ownerViews?.length ?? 0) : null,
      computerUseSessions: computerUse?.sessions.length ?? null,
    },
  };
}

export const DeviceMachineSummarySchema = MachineSummarySchema.extend({
  ...DeviceViewSchema.shape,
})
  .refine((machine) => machine.status !== "pending", "Pending enrollment is not a Device")
  .refine(
    (machine) =>
      machine.selfRunnerId !== null ||
      (machine.allowedModules.length === 0 &&
        Object.keys(machine.modules).length === 0 &&
        machine.runtimeVersion === null &&
        machine.fullDiskAccess === null),
    "A Device without a self Runner has no execution modules or runtime",
  );
export type DeviceMachineSummary = z.infer<typeof DeviceMachineSummarySchema>;
