import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createId, type AuthAdmissionId, type TeamChannelId, type UserId } from "@opensteer/core";
import {
  HostAccountAdoptionBundleSchema,
  HostedTeamBootstrapReceiptSchema,
  HostedTeamBootstrapSchema,
  type HostAccountAdoptionBundle,
  type HostedTeamBootstrap,
  type HostedTeamBootstrapReceipt,
  type HostedTeamOwnerCheckClaims,
} from "@opensteer/control-plane-protocol";
import { digestSecret, equalSecretDigests } from "@opensteer/shared/secretDigest";
import {
  TeamAccessStore,
  emptyTeamAccessEffects,
  requireTeam,
} from "@opensteer/database/team-access";
import { TeamInvitesStore } from "@opensteer/database/team-invites";
import { admitTeamMember, publishTeamMember } from "@opensteer/database/team-members";
import { appendTeamAudit } from "@opensteer/database/team-audit";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "@opensteer/database";
import type {
  AccountAdoptionAccount,
  AccountAdoptionAuthority,
  AccountAdoptionGrantVerifier,
  ConsumedAccountAdoptionProof,
  IssuedAccountAdoptionProof,
  OidcProviderConfiguration,
} from "./types.js";
import { z } from "zod";

const proofSchema = z.strictObject({
  admissionId: z.string(),
  credentialHash: z.string(),
  account: z.strictObject({ issuer: z.string(), subject: z.string() }),
  authority: z.strictObject({
    canonicalOrigin: z.string(),
    deploymentId: z.string(),
    hostInstanceId: z.string(),
    hostKeyFingerprint: z.string(),
  }),
  consumedAt: z.string().nullable(),
  completed: z.boolean(),
});
/** One hosted bootstrap per Host, ever; a replay must name the same team, authority and owner. */
const hostedBootstrapIdentifier = "team-hosted-bootstrap";
const StoredHostedBootstrapSchema = HostedTeamBootstrapReceiptSchema.extend({
  ownerSubject: z.string(),
  proofId: z.string(),
});
type StoredHostedBootstrap = z.infer<typeof StoredHostedBootstrapSchema>;

export interface TeamAdoptionCompletion {
  readonly provider: OidcProviderConfiguration;
  /** Present exactly when the completion carried a hosted bootstrap. */
  readonly receipt?: HostedTeamBootstrapReceipt;
}

export interface TeamAdmissionProof {
  readonly id: AuthAdmissionId;
  readonly purpose: "setup" | "recovery" | "invitation";
  readonly subjectSelector: string;
  readonly consumedBy: UserId | null;
}
export class TeamIdentityAdmission {
  readonly access: TeamAccessStore;
  readonly invites: TeamInvitesStore;
  readonly #authority: AccountAdoptionAuthority;
  readonly #verifier: AccountAdoptionGrantVerifier;
  readonly #install: (bundle: HostAccountAdoptionBundle) => Promise<void>;
  readonly #hosted:
    | {
        readonly createGeneralChannel: (
          transaction: Transaction<DatabaseSchema>,
          ownerUserId: UserId,
        ) => Promise<TeamChannelId>;
        readonly verifyOwnerCheck: (assertion: unknown) => Promise<HostedTeamOwnerCheckClaims>;
      }
    | undefined;
  constructor(options: {
    access: TeamAccessStore;
    invites: TeamInvitesStore;
    authority: AccountAdoptionAuthority;
    grantVerifier: AccountAdoptionGrantVerifier;
    installAccountBundle: (bundle: HostAccountAdoptionBundle) => Promise<void>;
    /** Enables Account's hosted bootstrap (`team-hosted-bootstrap-v1`). */
    hosted?: {
      createGeneralChannel: (
        transaction: Transaction<DatabaseSchema>,
        ownerUserId: UserId,
      ) => Promise<TeamChannelId>;
      verifyOwnerCheck: (assertion: unknown) => Promise<HostedTeamOwnerCheckClaims>;
    };
  }) {
    this.access = options.access;
    this.invites = options.invites;
    this.#authority = options.authority;
    this.#verifier = options.grantVerifier;
    this.#install = options.installAccountBundle;
    this.#hosted = options.hosted;
  }
  get hostedBootstrapAvailable() {
    return this.#hosted !== undefined;
  }
  /** The #general a hosted bootstrap created, while it still exists. */
  async generalChannelId(): Promise<TeamChannelId | null> {
    const receipt = await readHostedBootstrap(this.access.database);
    if (!receipt) return null;
    const channel = await this.access.database
      .selectFrom("teamChannels")
      .select("id")
      .where("id", "=", receipt.generalChannelId)
      .where("archivedAt", "is", null)
      .executeTakeFirst();
    return channel?.id ?? null;
  }
  /**
   * Whether the Account the signed assertion names is an active owner here. The assertion is
   * Account's, for this exact Host, and lives a minute; the answer is about that Account only.
   */
  async isOwner(assertion: unknown): Promise<boolean> {
    requireTeam(this.#hosted, "Hosted teams are unavailable");
    const claims = await this.#hosted.verifyOwnerCheck(assertion);
    requireTeam(sameAuthority(claims.authority, this.#authority), "Assertion is for another team");
    const owner = await this.access.database
      .selectFrom("teamMembers as m")
      .innerJoin("authAccounts as a", "a.userId", "m.userId")
      .innerJoin("accountDirectoryProvider as p", "p.providerId", "a.providerId")
      .innerJoin("users as u", "u.id", "m.userId")
      .select("m.userId")
      .where("p.issuer", "=", claims.iss)
      .where("a.accountId", "=", claims.sub)
      .where("m.role", "=", "owner")
      .where("m.state", "=", "active")
      .where("u.disabledAt", "is", null)
      .executeTakeFirst();
    return owner !== undefined;
  }
  async hasOwner() {
    return !!(await this.access.database
      .selectFrom("teamMembers")
      .select("userId")
      .where("role", "=", "owner")
      .where("state", "=", "active")
      .executeTakeFirst());
  }
  async sessionActive(userId: UserId, generation: string | null) {
    return !!(await this.access.database
      .selectFrom("teamMembers")
      .select("userId")
      .where("userId", "=", userId)
      .where("state", "=", "active")
      .where("generation", "=", generation ?? "0")
      .executeTakeFirst());
  }
  async validateAdmission(proof: TeamAdmissionProof) {
    const record = await this.access.database
      .selectFrom("authAdmissions")
      .selectAll()
      .where("id", "=", proof.id)
      .where("expiresAt", ">", new Date())
      .where("consumedAt", "is", null)
      .executeTakeFirst();
    requireTeam(record);
    if (record.purpose === "setup") requireTeam(!(await this.hasOwner()));
    else {
      requireTeam(record.purpose === "invitation");
      const invite = await this.access.database
        .selectFrom("teamInvites")
        .selectAll()
        .where("selector", "=", record.subjectSelector)
        .executeTakeFirst();
      requireTeam(
        invite &&
          !invite.revokedAt &&
          invite.expiresAt > new Date() &&
          invite.usedCount < invite.maxUses,
      );
    }
  }
  async admit(
    userId: UserId,
    proof: TeamAdmissionProof | null,
    sessionId?: import("@opensteer/core").AuthSessionId,
  ) {
    return this.access.mutate(
      async (t) => {
        const finish = (generation: string) => ({
          value: generation,
          effects: emptyTeamAccessEffects,
        });
        const provider = await t
          .selectFrom("accountDirectoryProvider")
          .selectAll()
          .executeTakeFirst();
        requireTeam(provider, "Complete Opensteer Account adoption first");
        const account = await t
          .selectFrom("authAccounts")
          .selectAll()
          .where("userId", "=", userId)
          .where("providerId", "=", provider.providerId)
          .executeTakeFirst();
        requireTeam(account, "Sign in with Opensteer Account");
        const existing = await t
          .selectFrom("teamMembers")
          .selectAll()
          .where("userId", "=", userId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (existing?.state === "active") return finish(existing.generation);
        requireTeam(proof, "A setup or invitation admission is required");
        const admission = await t
          .selectFrom("authAdmissions")
          .selectAll()
          .where("id", "=", proof.id)
          .where("expiresAt", ">", new Date())
          .where("consumedAt", "is", null)
          .executeTakeFirst();
        requireTeam(admission);
        if (admission.purpose === "invitation")
          await t
            .selectFrom("teamInvites")
            .select("id")
            .where("selector", "=", admission.subjectSelector)
            .forNoKeyUpdate()
            .execute();
        await t
          .selectFrom("authAdmissions")
          .select("id")
          .where("id", "=", admission.id)
          .forNoKeyUpdate()
          .execute();
        let member;
        if (admission.purpose === "setup") {
          requireTeam(
            !(await t
              .selectFrom("teamMembers")
              .select("userId")
              .where("role", "=", "owner")
              .where("state", "=", "active")
              .executeTakeFirst()),
            "The first owner is already set",
          );
          const enrollment = await t
            .selectFrom("ownerEnrollments")
            .selectAll()
            .where(
              "id",
              "=",
              admission.subjectSelector as import("@opensteer/core").OwnerEnrollmentId,
            )
            .where("consumedAt", "is", null)
            .where("expiresAt", ">", new Date())
            .executeTakeFirst();
          requireTeam(enrollment);
          const completed = await t
            .selectFrom("authVerifications")
            .select("value")
            .where("identifier", "like", "team-account-adoption:%")
            .execute();
          requireTeam(
            completed.some((r) => {
              const p = proofSchema.parse(JSON.parse(r.value));
              return (
                p.completed &&
                p.account.issuer === provider.issuer &&
                p.account.subject === account.accountId
              );
            }),
            "Use the Account that adopted this team",
          );
          member = await admitTeamMember(t, userId, "owner");
          await t
            .updateTable("ownerEnrollments")
            .set({ consumedAt: new Date(), consumedBy: userId })
            .where("id", "=", enrollment.id)
            .execute();
        } else {
          requireTeam(admission.purpose === "invitation");
          member = await this.invites.acceptInTransaction(t, userId, admission.subjectSelector);
        }
        await t
          .updateTable("authAdmissions")
          .set({ consumedAt: new Date(), consumedBy: userId })
          .where("id", "=", admission.id)
          .execute();
        await appendTeamAudit(t, {
          actor: { kind: "human", userId },
          action: "member.admitted",
          resourceKind: "member",
          resourceId: userId,
        });
        return finish(member.generation);
      },
      async (t, generation) => {
        await publishTeamMember(t, userId);
        if (sessionId) {
          const updated = await t
            .updateTable("authSessions")
            .set({ memberGeneration: generation })
            .where("id", "=", sessionId)
            .where("userId", "=", userId)
            .where("expiresAt", ">", new Date())
            .returning("id")
            .executeTakeFirst();
          requireTeam(updated, "Sign-in session ended before team admission");
        }
      },
    );
  }
  async issueAdoption(
    proof: TeamAdmissionProof,
    account: AccountAdoptionAccount,
  ): Promise<IssuedAccountAdoptionProof> {
    await this.validateAdmission(proof);
    requireTeam(proof.purpose === "setup");
    const proofId = `hap_${randomUUID()}`,
      proofCredential = `oap_${randomBytes(32).toString("base64url")}`,
      expiresAt = new Date(Date.now() + 5 * 60000);
    await this.access.mutate(async (t) => {
      requireTeam(
        !(await t
          .selectFrom("teamMembers")
          .select("userId")
          .where("role", "=", "owner")
          .where("state", "=", "active")
          .executeTakeFirst()),
      );
      await t
        .insertInto("authVerifications")
        .values({
          id: createId("authVerification"),
          identifier: `team-account-adoption:${proofId}`,
          value: JSON.stringify({
            admissionId: proof.id,
            credentialHash: digestSecret(proofCredential),
            account,
            authority: this.#authority,
            consumedAt: null,
            completed: false,
          }),
          expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .execute();
      return { value: undefined, effects: emptyTeamAccessEffects };
    });
    return { account, deployment: this.#authority, expiresAt, proofId, proofCredential };
  }
  async consumeAdoption(input: {
    expectedAccount: AccountAdoptionAccount;
    expectedDeployment: AccountAdoptionAuthority;
    proofCredential: string;
    proofId: string;
  }): Promise<ConsumedAccountAdoptionProof | null> {
    const observed = await this.access.database
      .selectFrom("authVerifications")
      .select("id")
      .where("identifier", "=", `team-account-adoption:${input.proofId}`)
      .executeTakeFirst();
    if (!observed) return null;
    return this.access.mutate(async (t) => {
      const row = await t
        .selectFrom("authVerifications")
        .selectAll()
        .where("id", "=", observed.id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const proof = proofSchema.parse(JSON.parse(row.value));
      requireTeam(
        equalSecretDigests(proof.credentialHash, digestSecret(input.proofCredential)) &&
          proof.account.issuer === input.expectedAccount.issuer &&
          proof.account.subject === input.expectedAccount.subject &&
          sameAuthority(proof.authority, input.expectedDeployment) &&
          sameAuthority(proof.authority, this.#authority),
      );
      const admission = await t
        .selectFrom("authAdmissions")
        .selectAll()
        .where("id", "=", proof.admissionId as AuthAdmissionId)
        .where("expiresAt", ">", new Date())
        .where("purpose", "=", "setup")
        .where("consumedAt", "is", null)
        .executeTakeFirst();
      requireTeam(admission);
      requireTeam(proof.consumedAt || row.expiresAt > new Date(), "Setup adoption expired");
      const consumedAt = proof.consumedAt ? new Date(proof.consumedAt) : new Date();
      if (!proof.consumedAt)
        await t
          .updateTable("authVerifications")
          .set({
            value: JSON.stringify({ ...proof, consumedAt: consumedAt.toISOString() }),
            updatedAt: new Date(),
          })
          .where("id", "=", row.id)
          .execute();
      return {
        value: {
          proofId: input.proofId,
          account: input.expectedAccount,
          deployment: this.#authority,
          authorizedBy: { admissionId: admission.id },
          consumedAt,
        },
        effects: emptyTeamAccessEffects,
      };
    });
  }
  async completeAdoption(
    admission: TeamAdmissionProof | null,
    grant: unknown,
    bundleInput: unknown,
    hostedInput?: unknown,
  ): Promise<TeamAdoptionCompletion> {
    const verified = await this.#verifier.verify(grant);
    const bundle = HostAccountAdoptionBundleSchema.parse(bundleInput);
    const hosted =
      hostedInput === undefined ? undefined : HostedTeamBootstrapSchema.parse(hostedInput);
    requireTeam("admissionId" in verified.authorizedBy, "Setup adoption grant required");
    requireTeam(!hosted || this.#hosted, "Hosted bootstrap is unavailable");
    // Owner email and name are unsigned display data; the signed subject decides who owns.
    requireTeam(
      !hosted || hosted.owner.subject === verified.account.subject,
      "The owner must be the Account that adopted this team",
    );
    const admissionId = verified.authorizedBy.admissionId;
    if (admission) requireTeam(admission.id === admissionId);
    const durableAdmission = await this.access.database
      .selectFrom("authAdmissions")
      .selectAll()
      .where("id", "=", admissionId)
      .executeTakeFirst();
    requireTeam(durableAdmission);
    admission = durableAdmission;

    requireTeam(
      "admissionId" in verified.authorizedBy &&
        verified.authorizedBy.admissionId === admission.id &&
        sameAuthority(verified.deployment, this.#authority) &&
        sameAuthority(bundle.deployment, this.#authority) &&
        bundle.controlApiOrigin === verified.account.issuer,
    );
    const issuerDigest = createHash("sha256")
      .update(bundle.oidc.issuer.replace(/\/$/, ""))
      .digest("base64url")
      .slice(0, 22);
    const providerId = `oidc.opensteer-account.${issuerDigest}`;
    const outcome = await this.access.mutate(
      async (t) => {
        const prior = hosted ? await readHostedBootstrap(t) : undefined;
        if (hosted && prior) {
          // A replay answers the first receipt and changes nobody's membership: the creator may
          // since have been removed, or ownership may have moved to someone else.
          requireTeam(
            prior.hostedTeamId === hosted.hostedTeamId &&
              prior.ownerSubject === verified.account.subject &&
              prior.proofId === verified.proofId &&
              sameAuthority(prior.authority, this.#authority),
            "This team was already set up",
          );
          return { value: { receipt: prior, fresh: false }, effects: emptyTeamAccessEffects };
        }
        await this.#recordCompletion(t, durableAdmission, verified, providerId);
        const receipt = hosted
          ? await this.#bootstrapOwner(t, durableAdmission, verified.proofId, hosted, providerId)
          : undefined;
        return { value: { receipt, fresh: true }, effects: emptyTeamAccessEffects };
      },
      async (t, value) => {
        if (value.fresh && value.receipt) await publishTeamMember(t, value.receipt.ownerUserId);
      },
    );
    await this.#install(bundle);
    return {
      provider: {
        providerId: "opensteer-account",
        label: "Opensteer Account",
        issuer: bundle.oidc.issuer,
        clientId: bundle.oidc.clientId,
        clientSecret: bundle.oidcClientSecret,
        allowPrivateNetwork: false,
        trustedOrigins: [],
      },
      ...(outcome.receipt ? { receipt: publicReceipt(outcome.receipt) } : {}),
    };
  }
  /**
   * Commits the hosted creator as this team's one owner, signed in through Account like anyone,
   * and creates #general, all in the completion's transaction.
   */
  async #bootstrapOwner(
    t: Transaction<DatabaseSchema>,
    admission: TeamAdmissionProof,
    proofId: string,
    hosted: HostedTeamBootstrap,
    providerId: string,
  ): Promise<StoredHostedBootstrap> {
    const hostedPort = this.#hosted;
    requireTeam(hostedPort);
    requireTeam(
      !(await t
        .selectFrom("teamMembers")
        .select("userId")
        .where("role", "=", "owner")
        .where("state", "=", "active")
        .executeTakeFirst()),
      "This team already has an owner",
    );
    const now = new Date();
    const enrollment = await t
      .selectFrom("ownerEnrollments")
      .select("id")
      .where("id", "=", admission.subjectSelector as import("@opensteer/core").OwnerEnrollmentId)
      .where("consumedAt", "is", null)
      .where("expiresAt", ">", now)
      .executeTakeFirst();
    requireTeam(enrollment, "Team setup expired");
    const linked = await t
      .selectFrom("authAccounts")
      .select("userId")
      .where("providerId", "=", providerId)
      .where("accountId", "=", hosted.owner.subject)
      .executeTakeFirst();
    let userId: UserId;
    if (linked) {
      userId = linked.userId as UserId;
      // Someone this team already knows is never promoted or brought back by setup.
      requireTeam(
        !(await t
          .selectFrom("teamMembers")
          .select("userId")
          .where("userId", "=", userId)
          .executeTakeFirst()),
        "This Account already belongs to this team",
      );
    } else {
      requireTeam(
        !(await t
          .selectFrom("users")
          .select("id")
          .where("email", "=", hosted.owner.email)
          .executeTakeFirst()),
        "Another person here already uses this email",
      );
      userId = createId("user");
      await t
        .insertInto("users")
        .values({
          id: userId,
          displayName: hosted.owner.displayName,
          email: hosted.owner.email,
          emailVerified: true,
          image: null,
          disabledAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      await t
        .insertInto("authAccounts")
        .values({
          id: createId("authAccount"),
          accountId: hosted.owner.subject,
          providerId,
          userId,
          accessToken: null,
          refreshToken: null,
          idToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          scope: null,
          password: null,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
    }
    await admitTeamMember(t, userId, "owner");
    await t
      .updateTable("ownerEnrollments")
      .set({ consumedAt: now, consumedBy: userId })
      .where("id", "=", enrollment.id)
      .execute();
    await t
      .updateTable("authAdmissions")
      .set({ consumedAt: now, consumedBy: userId })
      .where("id", "=", admission.id)
      .execute();
    await appendTeamAudit(t, {
      actor: { kind: "human", userId },
      action: "member.admitted",
      resourceKind: "member",
      resourceId: userId,
    });
    const generalChannelId = await hostedPort.createGeneralChannel(t, userId);
    const stored: StoredHostedBootstrap = {
      hostedTeamId: hosted.hostedTeamId,
      authority: { ...this.#authority },
      ownerUserId: userId,
      ownerSubject: hosted.owner.subject,
      proofId,
      generalChannelId,
      completedAt: now.toISOString(),
    };
    await t
      .insertInto("authVerifications")
      .values({
        id: createId("authVerification"),
        identifier: hostedBootstrapIdentifier,
        value: JSON.stringify(stored),
        expiresAt: new Date("9999-01-01"),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    return stored;
  }
  async #recordCompletion(
    t: Transaction<DatabaseSchema>,
    admission: TeamAdmissionProof,
    verified: Awaited<ReturnType<AccountAdoptionGrantVerifier["verify"]>>,
    providerId: string,
  ) {
    const stored = await t
      .selectFrom("authAdmissions")
      .selectAll()
      .where("id", "=", admission.id)
      .where("purpose", "=", "setup")
      .where("expiresAt", ">", new Date())
      .where("consumedAt", "is", null)
      .executeTakeFirst();
    requireTeam(stored);
    const row = await t
      .selectFrom("authVerifications")
      .selectAll()
      .where("identifier", "=", `team-account-adoption:${verified.proofId}`)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const proof = proofSchema.parse(JSON.parse(row.value));
    requireTeam(
      proof.admissionId === admission.id &&
        proof.consumedAt === verified.consumedAt.toISOString() &&
        proof.account.subject === verified.account.subject &&
        proof.account.issuer === verified.account.issuer,
    );
    const existing = await t.selectFrom("accountDirectoryProvider").selectAll().executeTakeFirst();
    requireTeam(
      !existing ||
        (existing.providerId === providerId && existing.issuer === verified.account.issuer),
    );
    if (!existing)
      await t
        .insertInto("accountDirectoryProvider")
        .values({
          singletonKey: "opensteer-account",
          providerId,
          issuer: verified.account.issuer,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .execute();
    await t
      .updateTable("authVerifications")
      .set({
        value: JSON.stringify({ ...proof, completed: true }),
        expiresAt: new Date("9999-01-01"),
        updatedAt: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
  }
}
async function readHostedBootstrap(
  executor: Pick<Transaction<DatabaseSchema>, "selectFrom">,
): Promise<StoredHostedBootstrap | undefined> {
  const row = await executor
    .selectFrom("authVerifications")
    .select("value")
    .where("identifier", "=", hostedBootstrapIdentifier)
    .executeTakeFirst();
  return row ? StoredHostedBootstrapSchema.parse(JSON.parse(row.value)) : undefined;
}

function publicReceipt(stored: StoredHostedBootstrap): HostedTeamBootstrapReceipt {
  return HostedTeamBootstrapReceiptSchema.parse({
    hostedTeamId: stored.hostedTeamId,
    authority: stored.authority,
    ownerUserId: stored.ownerUserId,
    generalChannelId: stored.generalChannelId,
    completedAt: stored.completedAt,
  });
}

function sameAuthority(
  a: {
    deploymentId: string;
    hostInstanceId: string;
    canonicalOrigin: string;
    hostKeyFingerprint: string;
  },
  b: {
    deploymentId: string;
    hostInstanceId: string;
    canonicalOrigin: string;
    hostKeyFingerprint: string;
  },
) {
  return (
    a.deploymentId === b.deploymentId &&
    a.hostInstanceId === b.hostInstanceId &&
    a.canonicalOrigin === b.canonicalOrigin &&
    a.hostKeyFingerprint === b.hostKeyFingerprint
  );
}
