import { z } from "zod";
import {
  ComputerAppOperationStatusSchema,
  ComputerAppStatusEntrySchema,
  computerAppMaxStatusEntries,
} from "./computer-apps.js";
import { MachineComputerUseSchema } from "./computer-use.js";
import { RunnerModuleReadinessSchema } from "./runner.js";
import {
  RunnerDeviceFormSchema,
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
  checkedAt: z.string().nullable(),
  detail: z.string().nullable(),
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
    form: z
      .string()
      .nullable()
      .transform((form) => {
        const parsed = RunnerDeviceFormSchema.safeParse(form);
        return parsed.success ? parsed.data : null;
      }),
    platform: z.string(),
  })
  .transform((device) => {
    const platform = MachineDevicePlatformViewSchema.safeParse(device.platform);
    return platform.success ? { form: device.form, platform: platform.data } : null;
  });
export type MachineDevice = z.infer<typeof MachineDeviceSchema>;

/**
 * A computer doing work for a Deployment.
 *
 * A Machine is a Runner: one enrollment, one key, one connection generation.
 * The browser relay and the messaging transport are modules of that identity
 * rather than enrollments of their own, so this row is a direct projection of
 * the Runner and needs no merging.
 */
export const MachineSummarySchema = z.object({
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
   * Workspaces whose files live on this computer's own disk. Removing the
   * computer leaves them without a storage authority, so the number is shown
   * before anyone confirms.
   */
  localWorkspaces: z.number().int().nonnegative().max(10_000),
  /**
   * The grant: every module this computer may ever advertise, fixed when it
   * was added. `modules` says what it is advertising now, which may be less.
   */
  allowedModules: z.array(RunnerModuleNameSchema).min(1).max(5),
  modules: z.object({
    agents: MachineModuleSummarySchema.optional(),
    browser: MachineModuleSummarySchema.optional(),
    integrations: MachineModuleSummarySchema.optional(),
    messaging: MachineModuleSummarySchema.optional(),
    shell: MachineModuleSummarySchema.optional(),
  }),
  name: z.string(),
  ownership: z.enum(["mine", "deployment", "other"]),
  /** Who owns a computer that is somebody else's; null for every other row. */
  ownerName: z.string().nullable().default(null),
  /** Threads placed here, which lose the computer they run on with it. */
  pinnedThreads: z.number().int().nonnegative().max(1_000_000),
  revocable: z.boolean(),
  status: z.enum(["online", "offline", "pending", "needs-update", "updating", "update-pending"]),
  /**
   * Folders this computer reported holding that no Workspace on this
   * Deployment claims. They are surfaced for a person to resolve and are never
   * removed on the machine's word.
   */
  unlinkedLocalFolders: z.number().int().nonnegative().max(10_000),
});
export type MachineSummary = z.infer<typeof MachineSummarySchema>;
