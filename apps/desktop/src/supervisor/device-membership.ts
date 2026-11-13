import { AuthSessionIdSchema, DeploymentIdSchema, RunnerIdSchema } from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  PersonalHostAccessRouteEnvelopeSchema,
} from "@opensteer/deployment-authority";
import { DeploymentConnectionSourceSchema } from "@opensteer/client/connections";
import { DesktopAccessOriginSchema } from "@opensteer/protocol/desktop";
import { RunnerLeaveRequestSchema } from "@opensteer/protocol";
import {
  readPrivateFileText,
  replacePrivateFileAtomically,
} from "@opensteer/shared/atomicPrivateFile";
import { z } from "zod";

export const DeviceMembershipSchema = z.strictObject({
  state: z.enum(["active", "leaving", "removed"]),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  runnerId: RunnerIdSchema.nullable(),
  // Legacy preferences did not record provenance or Host authority.
  provenance: DeploymentConnectionSourceSchema.nullable(),
  hostAuthority: HostDiscoveryEnvelopeSchema.nullable(),
  lastVerifiedRoute: z
    .strictObject({
      origin: DesktopAccessOriginSchema,
      accessRoute: PersonalHostAccessRouteEnvelopeSchema.nullable(),
    })
    .nullable(),
  runnerName: z.string().trim().min(1).max(120),
  deploymentName: z.string().trim().min(1).max(120).nullable().default(null),
  runAgents: z.boolean(),
  pendingEnrollment: z
    .strictObject({
      id: z.string().min(1).max(256),
      expiresAt: z.iso.datetime({ offset: true }),
      tokenHash: z.string().optional(),
    })
    .nullable()
    .default(null),
  boundSession: z
    .strictObject({
      id: AuthSessionIdSchema,
      expiresAt: z.iso.datetime({ offset: true }),
      absoluteExpiresAt: z.iso.datetime({ offset: true }),
    })
    .nullable()
    .default(null),
  needsSignIn: z.boolean().default(false),
  confirmingSession: z.boolean().default(false),
  prepared: z.boolean().default(false),
  erasePending: z.boolean(),
  leaveProof: RunnerLeaveRequestSchema.nullable(),
});
export type DeviceMembership = z.infer<typeof DeviceMembershipSchema>;
export const DeviceMembershipsSchema = z
  .strictObject({
    runners: z.record(DeploymentIdSchema, DeviceMembershipSchema),
    version: z.literal(5),
  })
  .superRefine((value, context) => {
    if (Object.keys(value.runners).length > 100)
      context.addIssue({ code: "custom", message: "Too many device memberships." });
    for (const [id, row] of Object.entries(value.runners)) {
      if (
        (row.hostAuthority && row.hostAuthority.document.deploymentId !== id) ||
        (row.leaveProof &&
          (row.leaveProof.deploymentId !== id || row.leaveProof.runnerId !== row.runnerId)) ||
        (row.state === "leaving" && !row.leaveProof)
      )
        context.addIssue({
          code: "custom",
          message: "Inconsistent device membership identity.",
          path: ["runners", id],
        });
    }
  });
export type DeviceMemberships = z.infer<typeof DeviceMembershipsSchema>;

const legacyRunner = z.strictObject({
  enrolled: z.boolean(),
  runAgents: z.boolean(),
  runnerName: z.string().trim().min(1).max(120),
});
const v4 = z.strictObject({
  runners: z.record(DeploymentIdSchema, legacyRunner),
  version: z.literal(4),
});
const v3 = z.strictObject({
  runners: z.record(
    DeploymentIdSchema,
    z.strictObject({
      enabled: z.boolean(),
      runnerName: z.string().trim().min(1).max(120),
    }),
  ),
  version: z.literal(3),
});

export function membershipIntent(runnerName: string, runAgents: boolean): DeviceMembership {
  return {
    state: "active",
    generation: 1,
    runnerId: null,
    provenance: null,
    hostAuthority: null,
    lastVerifiedRoute: null,
    runnerName,
    deploymentName: null,
    runAgents,
    pendingEnrollment: null,
    boundSession: null,
    needsSignIn: false,
    confirmingSession: false,
    prepared: false,
    erasePending: false,
    leaveProof: null,
  };
}

export async function readMemberships(filePath: string): Promise<DeviceMemberships> {
  const invalid = () =>
    new Error(
      "This Mac's device membership file is incompatible or corrupt. Nothing was forgotten; repair the file before continuing.",
    );
  const contents = await readPrivateFileText(filePath, 4 * 1024 * 1024, {
    invalid,
    exposed: invalid,
  });
  if (contents === undefined) return { runners: {}, version: 5 };
  try {
    const decoded: unknown = JSON.parse(contents);
    const old = v4.safeParse(decoded);
    const older = v3.safeParse(decoded);
    if (old.success || older.success) {
      const runners = old.success
        ? old.data.runners
        : Object.fromEntries(
            Object.entries(older.success ? older.data.runners : {}).map(([id, row]) => [
              id,
              {
                enrolled: row.enabled,
                runAgents: true,
                runnerName: row.runnerName,
              },
            ]),
          );
      return DeviceMembershipsSchema.parse({
        version: 5,
        runners: Object.fromEntries(
          Object.entries(runners).map(([id, row]) => [
            id,
            {
              ...membershipIntent(row.runnerName, row.runAgents),
              state: row.enrolled ? "active" : "removed",
              erasePending: !row.enrolled,
            },
          ]),
        ),
      });
    }
    return DeviceMembershipsSchema.parse(decoded);
  } catch (cause) {
    throw new Error(invalid().message, { cause });
  }
}

export async function writeMemberships(filePath: string, value: DeviceMemberships): Promise<void> {
  await replacePrivateFileAtomically(
    filePath,
    `${JSON.stringify(DeviceMembershipsSchema.parse(value))}\n`,
  );
}
