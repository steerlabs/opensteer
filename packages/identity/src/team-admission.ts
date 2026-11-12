import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createId, type AuthAdmissionId, type UserId } from "@opensteer/core";
import {
  HostAccountAdoptionBundleSchema,
  type HostAccountAdoptionBundle,
} from "@opensteer/control-plane-protocol";
import { digestSecret, equalSecretDigests } from "@opensteer/shared/secretDigest";
import {
  TeamAccessStore,
  emptyTeamAccessEffects,
  requireTeam,
} from "@opensteer/database/team-access";
import { TeamInvitesStore, assertTeamInviteUsable } from "@opensteer/database/team-invites";
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
  constructor(options: {
    access: TeamAccessStore;
    invites: TeamInvitesStore;
    authority: AccountAdoptionAuthority;
    grantVerifier: AccountAdoptionGrantVerifier;
    installAccountBundle: (bundle: HostAccountAdoptionBundle) => Promise<void>;
  }) {
    this.access = options.access;
    this.invites = options.invites;
    this.#authority = options.authority;
    this.#verifier = options.grantVerifier;
    this.#install = options.installAccountBundle;
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
      assertTeamInviteUsable(
        await this.access.database
          .selectFrom("teamInvites")
          .selectAll()
          .where("selector", "=", record.subjectSelector)
          .executeTakeFirst(),
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
  ): Promise<OidcProviderConfiguration> {
    const verified = await this.#verifier.verify(grant);
    const bundle = HostAccountAdoptionBundleSchema.parse(bundleInput);
    requireTeam("admissionId" in verified.authorizedBy, "Setup adoption grant required");
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
    await this.access.mutate(async (t) => {
      await this.#recordCompletion(t, durableAdmission, verified, providerId);
      return { value: undefined, effects: emptyTeamAccessEffects };
    });
    await this.#install(bundle);
    return {
      providerId: "opensteer-account",
      label: "Opensteer Account",
      issuer: bundle.oidc.issuer,
      clientId: bundle.oidc.clientId,
      clientSecret: bundle.oidcClientSecret,
      allowPrivateNetwork: false,
      trustedOrigins: [],
    };
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
