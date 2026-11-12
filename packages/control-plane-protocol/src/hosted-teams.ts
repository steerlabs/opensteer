import { z } from "zod";

/** Every hosted team is served at `https://<slug>.<hostedTeamsDomain>`. */
export const hostedTeamsDomain = "teams.opensteer.com";
/** Teams an Account may hold at once; deleted teams do not count. */
export const maximumLiveHostedTeamsPerAccount = 3;

/** Labels that would read as Opensteer's own, or that DNS and mail conventions claim. */
export const reservedHostedTeamSlugs: ReadonlySet<string> = new Set([
  "abuse",
  "account",
  "accounts",
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blog",
  "cdn",
  "connect",
  "dashboard",
  "dev",
  "docs",
  "edge",
  "help",
  "internal",
  "login",
  "mail",
  "opensteer",
  "postmaster",
  "root",
  "security",
  "setup",
  "smtp",
  "staging",
  "static",
  "status",
  "support",
  "system",
  "team",
  "teams",
  "test",
  "webmaster",
  "www",
]);

export const HostedTeamSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u, "Use 3–32 lowercase letters, digits or hyphens")
  .refine((slug) => !slug.includes("--"), "Don’t use two hyphens in a row")
  .refine((slug) => !reservedHostedTeamSlugs.has(slug), "That address is reserved");
export type HostedTeamSlug = z.infer<typeof HostedTeamSlugSchema>;

export function hostedTeamOrigin(slug: HostedTeamSlug): string {
  return `https://${slug}.${hostedTeamsDomain}`;
}

export const HostedTeamIdSchema = z.uuid();
export type HostedTeamId = z.infer<typeof HostedTeamIdSchema>;

export const HostedTeamStateSchema = z.enum(["active", "suspended", "deleted"]);
export type HostedTeamState = z.infer<typeof HostedTeamStateSchema>;

export const HostedTeamPhaseSchema = z.enum([
  "provisioning",
  "ready",
  "failed",
  "suspended",
  "deleted",
]);
export type HostedTeamPhase = z.infer<typeof HostedTeamPhaseSchema>;

/** Lowercase hex SHA-256 of the first-owner setup token; the plaintext never leaves Account. */
export const SetupTokenDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const DesiredHostedTeamSchema = z.strictObject({
  id: HostedTeamIdSchema,
  slug: HostedTeamSlugSchema,
  state: HostedTeamStateSchema,
  setupTokenDigest: SetupTokenDigestSchema.nullable(),
  setupGeneration: z.number().int().min(1),
});
export type DesiredHostedTeam = z.infer<typeof DesiredHostedTeamSchema>;

export const DesiredHostedTeamsResponseSchema = z.strictObject({
  teams: z.array(DesiredHostedTeamSchema).max(10_000),
});
export type DesiredHostedTeamsResponse = z.infer<typeof DesiredHostedTeamsResponseSchema>;

const PinnedImageSchema = z
  .string()
  .max(512)
  .regex(/^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$/u);

export const HostedTeamStatusReportSchema = z.strictObject({
  phase: HostedTeamPhaseSchema,
  /** The Host image the team runs, or null when no Host runs. */
  hostImage: PinnedImageSchema.nullable(),
  observedSetupGeneration: z.number().int().min(0),
  message: z.string().min(1).max(1_000).optional(),
});
export type HostedTeamStatusReport = z.infer<typeof HostedTeamStatusReportSchema>;

export const hostedTeamsDesiredPath = "/v1/hosted-teams/desired";
export const hostedTeamStatusPath = (id: HostedTeamId) =>
  `/v1/hosted-teams/${encodeURIComponent(id)}/status`;
