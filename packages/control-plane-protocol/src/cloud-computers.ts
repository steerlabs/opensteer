import { DeploymentIdSchema, HostKeyFingerprintSchema } from "@opensteer/core";
import { z } from "zod";
import { prefixedIdSchema } from "./account-id.js";

export const CloudComputerIdSchema = prefixedIdSchema("cc")
  .refine((id) => id === id.toLowerCase())
  .brand<"CloudComputerId">();
export type CloudComputerId = z.infer<typeof CloudComputerIdSchema>;

export const CloudComputerHostnameSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
export const CloudComputerLocationSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);
export const CloudComputerGenerationSchema = z.number().int().positive();
export const CloudComputerBootstrapTokenSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,2048}$/u);
export const CloudComputerInstallerUrlSchema = z
  .url({ protocol: /^https$/u })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !/[?#]/u.test(value);
  });
export const CloudComputerInstallerSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const CloudComputerReleaseSchema = z.object({
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u),
  installerUrl: CloudComputerInstallerUrlSchema,
  installerSha256: CloudComputerInstallerSha256Schema,
});
export type CloudComputerRelease = z.infer<typeof CloudComputerReleaseSchema>;

export const CloudComputerIdentitySchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  hostKeyFingerprint: HostKeyFingerprintSchema,
});
export type CloudComputerIdentity = z.infer<typeof CloudComputerIdentitySchema>;

export const CloudComputerDesiredSchema = z
  .object({
    id: CloudComputerIdSchema,
    generation: CloudComputerGenerationSchema,
    state: z.enum(["active", "suspended", "deleted"]),
    hostname: CloudComputerHostnameSchema,
    // Null selects the provisioner's configured default.
    region: CloudComputerLocationSchema.nullable(),
    serverType: CloudComputerLocationSchema.nullable(),
    release: CloudComputerReleaseSchema,
    bootstrapToken: CloudComputerBootstrapTokenSchema.optional(),
    // Account sets this on activation and generation bumps to preserve the initial deadline.
    readinessStartedAt: z.iso.datetime({ offset: true }).optional(),
    // Account echoes the first accepted identity for this generation across provisioner restarts.
    observedIdentity: CloudComputerIdentitySchema.optional(),
  })
  .refine((value) => value.state === "active" || value.bootstrapToken === undefined, {
    path: ["bootstrapToken"],
    message: "Only an active Cloud Computer can have a bootstrap token",
  });
export type CloudComputerDesired = z.infer<typeof CloudComputerDesiredSchema>;

export const CloudComputerDesiredResponseSchema = z.object({
  computers: z
    .array(CloudComputerDesiredSchema)
    .max(10_000)
    .refine(
      (computers) =>
        new Set(computers.map(({ id }) => id)).size === computers.length &&
        new Set(computers.map(({ hostname }) => hostname)).size === computers.length,
      { message: "Cloud Computer IDs and hostnames must be unique" },
    ),
});
export type CloudComputerDesiredResponse = z.infer<typeof CloudComputerDesiredResponseSchema>;

export const CloudComputerPhaseSchema = z.enum([
  "provisioning",
  "booting",
  "ready",
  "suspended",
  "deleting",
  "deleted",
  "failed",
]);

export const CloudComputerReportSchema = z
  .strictObject({
    id: CloudComputerIdSchema,
    generation: CloudComputerGenerationSchema,
    phase: CloudComputerPhaseSchema,
    providerServerId: z.number().int().positive().nullable(),
    ipv4: z.ipv4().nullable(),
    ipv6: z.ipv6().nullable(),
    observedIdentity: CloudComputerIdentitySchema.nullable(),
    lastError: z
      .enum([
        "A bootstrap token is required to create this Cloud Computer.",
        "The provider has a newer Cloud Computer generation.",
        "The Cloud Computer has more than one server for this generation.",
        "The Cloud Computer did not become ready before its deadline.",
        "The Cloud Computer reported a different Home identity for this generation.",
        "The Cloud Computer provider operation failed.",
        "The Cloud Computer DNS operation failed.",
      ])
      .nullable(),
  })
  .superRefine((report, context) => {
    if (
      report.phase === "ready" &&
      (!report.providerServerId || (!report.ipv4 && !report.ipv6) || !report.observedIdentity)
    ) {
      context.addIssue({
        code: "custom",
        message: "A ready Cloud Computer requires a server, an IP address and a Home identity",
      });
    }
    if (
      report.phase === "deleted" &&
      (report.providerServerId || report.ipv4 || report.ipv6 || report.observedIdentity)
    ) {
      context.addIssue({
        code: "custom",
        message: "A deleted Cloud Computer cannot have server details",
      });
    }
    if ((report.phase === "failed") !== (report.lastError !== null)) {
      context.addIssue({
        code: "custom",
        path: ["lastError"],
        message: "Only failed reports carry an error",
      });
    }
  });
export type CloudComputerReport = z.infer<typeof CloudComputerReportSchema>;

export const CloudComputerReportResponseSchema = z.object({ recorded: z.literal(true) });
export type CloudComputerReportResponse = z.infer<typeof CloudComputerReportResponseSchema>;

export const cloudComputersDesiredPath = "/v1/cloud-computers/desired";
// Account checks that the URL ID matches the body and fences writes on the current generation.
export const cloudComputerStatusPath = (id: CloudComputerId) =>
  `/v1/cloud-computers/${encodeURIComponent(id)}/status`;
