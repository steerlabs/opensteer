import { DeploymentIdSchema, TeamOriginSchema } from "@opensteer/core";
import { z } from "zod";
import { ControlPlaneAccountIdSchema } from "./account-id.js";

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
  /**
   * The desired setup generation this report was judged against. Account moves a team's setup
   * only on reports for its current generation; provisioners before it omit this.
   */
  setupGeneration: z.number().int().min(1).optional(),
  message: z.string().min(1).max(1_000).optional(),
});
export type HostedTeamStatusReport = z.infer<typeof HostedTeamStatusReportSchema>;

export const hostedTeamsDesiredPath = "/v1/hosted-teams/desired";
export const hostedTeamStatusPath = (id: HostedTeamId) =>
  `/v1/hosted-teams/${encodeURIComponent(id)}/status`;

/*
 * The Account JSON API native apps and the portal use to create, follow and remove hosted
 * teams, with the same Account session bearer as other native Account calls. Requests are
 * strict; responses tolerate fields a newer Account adds.
 */
export const accountHostedTeamsPath = "/v1/account/hosted-teams";
export const accountHostedTeamAvailabilityPath = `${accountHostedTeamsPath}/availability`;
export const accountHostedTeamPath = (id: HostedTeamId) =>
  `${accountHostedTeamsPath}/${encodeURIComponent(id)}`;
export const accountHostedTeamRetryPath = (id: HostedTeamId) =>
  `${accountHostedTeamPath(id)}/retry`;
export const accountHostedTeamOwnersPath = (id: HostedTeamId) =>
  `${accountHostedTeamPath(id)}/owners`;
export const accountHostedTeamTransferPath = (id: HostedTeamId) =>
  `${accountHostedTeamPath(id)}/transfer`;

/** Bounded by the Account Deployment name the team becomes. */
export const HostedTeamNameSchema = z.string().trim().min(1).max(120);

/**
 * What a person waits on. `ready` means the team Host is configured, its creator is committed
 * as owner and its directory entry is published, not merely that the pod is up.
 */
export const HostedTeamStageSchema = z.enum([
  "reserving",
  "starting",
  "configuring",
  "ready",
  "failed",
  "deleting",
]);
export type HostedTeamStage = z.infer<typeof HostedTeamStageSchema>;

export const HostedTeamAvailabilityQuerySchema = z.strictObject({ slug: z.string().max(256) });
export const HostedTeamAvailabilityResponseSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true) }),
  z.object({ available: z.literal(false), reason: z.enum(["invalid", "reserved", "taken"]) }),
]);
export type HostedTeamAvailability = z.infer<typeof HostedTeamAvailabilityResponseSchema>;

/** Replaying a `requestId` returns the team it created instead of creating another. */
export const CreateHostedTeamRequestSchema = z.strictObject({
  requestId: z.uuid(),
  name: HostedTeamNameSchema,
  slug: HostedTeamSlugSchema,
});
export type CreateHostedTeamRequest = z.infer<typeof CreateHostedTeamRequestSchema>;

export const HostedTeamViewSchema = z.object({
  id: HostedTeamIdSchema,
  name: HostedTeamNameSchema,
  // Not the input rule: a newly reserved label must not make an existing team unreadable.
  slug: z.string().min(3).max(32),
  origin: TeamOriginSchema,
  /** Present once Account adopted the team's Host. */
  deploymentId: DeploymentIdSchema.optional(),
  stage: HostedTeamStageSchema,
  /** Why the last attempt failed; present only at `failed`. */
  error: z.object({ message: z.string().min(1).max(1_000) }).optional(),
  /** Whether the signed-in Account holds the team: it created it, or was handed it. */
  creator: z.boolean().optional(),
});
export type HostedTeamView = z.infer<typeof HostedTeamViewSchema>;

export const ListHostedTeamsResponseSchema = z.object({
  teams: z.array(HostedTeamViewSchema).max(100),
});

/**
 * `POST …/:id/retry` answers the team view. `DELETE …/:id` cancels a team still being set up
 * (its creator may) or deletes a ready one (team owners only) and answers it at `deleting`;
 * a team already gone answers `not_found`.
 */
export const HostedTeamResponseSchema = HostedTeamViewSchema;

/** Someone the team's own Host confirms as an owner, whom its holder may hand it to. */
export const HostedTeamOwnerSchema = z.object({
  accountId: ControlPlaneAccountIdSchema,
  displayName: z.string().max(256),
  email: z.string().max(320),
});
export type HostedTeamOwner = z.infer<typeof HostedTeamOwnerSchema>;

/** `GET …/:id/owners`, for the team's holder only: its other owners, as its Host says now. */
export const ListHostedTeamOwnersResponseSchema = z.object({
  owners: z.array(HostedTeamOwnerSchema).max(100),
});

/**
 * `POST …/:id/transfer`: the team's holder hands it, with its Account sign-in, to one of its
 * other owners, whom its Host must confirm at that moment. Answers the team as the caller sees it.
 */
export const TransferHostedTeamRequestSchema = z.strictObject({ to: ControlPlaneAccountIdSchema });
export type TransferHostedTeamRequest = z.infer<typeof TransferHostedTeamRequestSchema>;
