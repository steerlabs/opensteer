import {
  ControlPlaneAccountIdSchema,
  IssueTeamIdentityGrantRequestSchema,
  IssueTeamIdentityGrantResponseSchema,
  TeamIdentityAssertionClaimsSchema,
  TeamIdentityAssertionSchema,
  teamIdentityGrantLifetimeSeconds,
  type ControlPlaneAccountId,
  type IssueTeamIdentityGrantRequest,
  type IssueTeamIdentityGrantResponse,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import type { Kysely } from "kysely";
import type { ControlPlaneAuth } from "../auth/auth.js";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";

/**
 * Signs who an Account is for one exact team Host, so a native app can enter the team without a
 * browser hop. Membership is the team Host's decision: anyone signed in may prove their identity
 * to an adopted team, exactly as anyone may start its OIDC sign-in.
 */
export class TeamIdentityGrantService {
  readonly #auth: ControlPlaneAuth;
  readonly #database: Kysely<ControlPlaneDatabaseSchema>;
  readonly #issuer: string;

  constructor(input: {
    readonly auth: ControlPlaneAuth;
    readonly database: Kysely<ControlPlaneDatabaseSchema>;
    readonly issuer: URL;
  }) {
    this.#auth = input.auth;
    this.#database = input.database;
    this.#issuer = input.issuer.origin;
  }

  async issue(
    accountIdInput: ControlPlaneAccountId,
    deploymentIdInput: DeploymentId,
    requestInput: IssueTeamIdentityGrantRequest,
  ): Promise<IssueTeamIdentityGrantResponse> {
    const accountId = ControlPlaneAccountIdSchema.parse(accountIdInput);
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const request = IssueTeamIdentityGrantRequestSchema.parse(requestInput);
    const [account, team] = await Promise.all([
      this.#database
        .selectFrom("users")
        .select(["email", "displayName"])
        .where("id", "=", accountId)
        .executeTakeFirst(),
      this.#database
        .selectFrom("deployments")
        .select([
          "id",
          "activeHostInstanceId",
          "authorityEnvelope",
          "canonicalOrigin",
          "hostKeyFingerprint",
          "reachability",
        ])
        .where("id", "=", deploymentId)
        .executeTakeFirst(),
    ]);
    if (!account) throw new ControlPlaneError("unauthorized", "Account is unavailable");
    if (!team || !isAdoptedTeam(team)) {
      throw new ControlPlaneError("not_found", "Team was not found");
    }
    const expected = request.expectedAuthority;
    if (
      expected.deploymentId !== team.id ||
      expected.hostInstanceId !== team.activeHostInstanceId ||
      expected.canonicalOrigin !== team.canonicalOrigin ||
      expected.hostKeyFingerprint !== team.hostKeyFingerprint
    ) {
      throw new ControlPlaneError("conflict", "Team authority is stale");
    }
    const issuedAt = Math.floor(Date.now() / 1_000);
    const expiresAt = issuedAt + teamIdentityGrantLifetimeSeconds;
    const claims = TeamIdentityAssertionClaimsSchema.parse({
      account: { issuer: this.#issuer, subject: accountId },
      aud: expected.canonicalOrigin,
      authority: expected,
      displayName: account.displayName.trim().slice(0, 120),
      email: account.email,
      exp: expiresAt,
      iat: issuedAt,
      iss: this.#issuer,
      jti: `tig_${crypto.randomUUID()}`,
      sub: accountId,
      surface: request.surface,
      tokenUse: "opensteer-team-identity",
    });
    const { token } = await this.#auth.api.signJWT({ body: { payload: claims } });
    return IssueTeamIdentityGrantResponseSchema.parse({
      assertion: TeamIdentityAssertionSchema.parse(token),
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    });
  }
}

function isAdoptedTeam(row: {
  readonly authorityEnvelope: unknown;
  readonly reachability: string;
}): boolean {
  if (row.reachability !== "canonical") return false;
  const envelope = HostDiscoveryEnvelopeSchema.safeParse(row.authorityEnvelope);
  if (!envelope.success) return false;
  try {
    return verifyHostDiscoveryEnvelope(envelope.data).deploymentShape.kind === "team";
  } catch {
    return false;
  }
}
