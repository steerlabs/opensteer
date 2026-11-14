import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sql, type Selectable, type Transaction } from "kysely";
import { type TeamActor, type UserId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import {
  TeamAccessStore,
  emptyTeamAccessEffects,
  requireTeam,
} from "@opensteer/database/team-access";
import { appendTeamAudit } from "@opensteer/database/team-audit";
import { hostKeyFingerprint, type HostDiscoveryEnvelope } from "@opensteer/deployment-authority";
import {
  TeamPartnerInviteSchema,
  TeamPartnerLinkSchema,
  serializeTeamPartnerOffer,
  type TeamSharingPolicy,
} from "@opensteer/protocol";

export type PartnerRow = Selectable<DatabaseSchema["teamPartnerLinks"]>;
type Tx = Transaction<DatabaseSchema>;

export class TeamPartnerStore {
  readonly access: TeamAccessStore;
  readonly authority: HostDiscoveryEnvelope;
  constructor(access: TeamAccessStore, authority: HostDiscoveryEnvelope) {
    this.access = access;
    this.authority = authority;
  }

  async policy(t: Tx) {
    return (
      await t
        .selectFrom("teamSharingSettings")
        .select("policy")
        .where("singletonKey", "=", "team")
        .executeTakeFirstOrThrow()
    ).policy;
  }

  async authorize(
    t: Tx,
    actor: TeamActor,
    action: "propose" | "approve" | "revoke",
    row?: PartnerRow,
  ) {
    requireTeam(actor.kind === "human");
    const member = await this.access.member(t, actor.userId);
    const policy = await this.policy(t);
    const admin = member.role !== "member";
    if (action === "revoke") {
      requireTeam(
        admin || policy === "members" || (row?.createdBy === actor.userId && !row.localApproved),
      );
      return true;
    }
    requireTeam(policy !== "off", "Team sharing is off");
    requireTeam(
      admin || policy === "members" || (policy === "members-propose" && action === "propose"),
    );
    return admin || policy === "members";
  }

  write<T>(run: (t: Tx) => Promise<T>): Promise<T> {
    return this.access.mutate(async (t) => ({
      value: await run(t),
      effects: emptyTeamAccessEffects,
    }));
  }

  async createInvite(actor: TeamActor) {
    return this.write(async (t) => {
      await this.authorize(t, actor, "propose");
      const id = randomUUID(),
        verifier = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const invite = await t
        .insertInto("teamPartnerInvites")
        .values({
          id,
          verifierHash: digest(verifier),
          createdBy: actor.userId,
          expiresAt,
          consumedAt: null,
          revokedAt: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(t, actor, "invite.created", id);
      const document = this.authority.document;
      return {
        invite: TeamPartnerInviteSchema.parse({
          ...invite,
          createdAt: invite.createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          canRevoke: true,
        }),
        offer: serializeTeamPartnerOffer({
          teamId: document.deploymentId,
          origin: document.canonicalOrigin,
          hostInstanceId: document.hostInstanceId,
          hostKeyFingerprint: hostKeyFingerprint(this.authority.publicKey.spki),
          selector: id,
          verifier,
          expiresAt: expiresAt.toISOString(),
        }),
      };
    });
  }

  async revokeInvite(actor: TeamActor, id: string) {
    await this.write(async (t) => {
      const invite = await t
        .selectFrom("teamPartnerInvites")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      requireTeam(invite);
      const member = await this.access.member(t, actor.userId);
      requireTeam(
        actor.kind === "human" && (member.role !== "member" || invite.createdBy === actor.userId),
      );
      await t
        .updateTable("teamPartnerInvites")
        .set({ revokedAt: new Date() })
        .where("id", "=", id)
        .execute();
      await this.audit(t, actor, "invite.revoked", id);
    });
  }

  async setPolicy(actor: TeamActor, policy: TeamSharingPolicy) {
    await this.write(async (t) => {
      await this.access.admin(t, actor);
      await t
        .updateTable("teamSharingSettings")
        .set({ policy })
        .where("singletonKey", "=", "team")
        .execute();
      await this.audit(t, actor, "policy.changed", undefined, { policy });
    });
  }

  async getPolicy(actor: TeamActor) {
    return this.access.database.transaction().execute(async (t) => {
      const member = await this.access.member(t, actor.userId);
      const policy = await this.policy(t);
      return {
        policy,
        canSet: actor.kind === "human" && member.role !== "member",
        canPropose:
          actor.kind === "human" &&
          policy !== "off" &&
          (member.role !== "member" || policy !== "admins"),
      };
    });
  }

  async list(
    actor: TeamActor,
    connected: (id: string) => boolean,
    cursor?: { after?: string | undefined; id?: string | undefined },
  ) {
    return this.access.database.transaction().execute(async (t) => {
      requireTeam(actor.kind === "human");
      const member = await this.access.member(t, actor.userId),
        policy = await this.policy(t);
      let query = t.selectFrom("teamPartnerLinks").selectAll();
      if (cursor?.after) query = query.where("id", ">", cursor.after);
      if (cursor?.id) query = query.where("id", "=", cursor.id);
      const rows = await query.orderBy("id").limit(51).execute();
      const admin = member.role !== "member";
      return {
        links: rows.slice(0, 50).map((r) =>
          TeamPartnerLinkSchema.parse({
            ...r,
            createdAt: r.createdAt.toISOString(),
            approvedAt: r.approvedAt?.toISOString() ?? null,
            lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
            revokedAt: r.revokedAt?.toISOString() ?? null,
            connected: connected(r.id),
            canApprove:
              r.lastError !== "identity-mismatch" &&
              !r.localApproved &&
              r.state !== "revoked" &&
              policy !== "off" &&
              (admin || policy === "members"),
            canRevoke:
              r.state !== "revoked" &&
              (admin || policy === "members" || (r.createdBy === actor.userId && !r.localApproved)),
          }),
        ),
        nextCursor: rows.length > 50 ? rows[49]!.id : null,
      };
    });
  }

  async invites(actor: TeamActor, after?: string) {
    return this.access.database.transaction().execute(async (t) => {
      requireTeam(actor.kind === "human");
      const member = await this.access.member(t, actor.userId);
      let query = t.selectFrom("teamPartnerInvites").selectAll();
      if (member.role === "member") query = query.where("createdBy", "=", actor.userId);
      if (after) query = query.where("id", ">", after);
      const rows = await query.orderBy("id").limit(51).execute();
      return {
        invites: rows.slice(0, 50).map((r) =>
          TeamPartnerInviteSchema.parse({
            ...r,
            createdAt: r.createdAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
            consumedAt: r.consumedAt?.toISOString() ?? null,
            revokedAt: r.revokedAt?.toISOString() ?? null,
            canRevoke: !r.consumedAt && !r.revokedAt && r.expiresAt > new Date(),
          }),
        ),
        nextCursor: rows.length > 50 ? rows[49]!.id : null,
      };
    });
  }

  async propose(actor: TeamActor, authority: HostDiscoveryEnvelope, name: string) {
    return this.write(async (t) => {
      const approved = await this.authorize(t, actor, "propose");
      return this.insert(t, authority, name, "dialer", actor.userId, approved, false);
    });
  }

  async accept(
    selector: string,
    verifier: string,
    authority: HostDiscoveryEnvelope,
    name: string,
    partnerApproved: boolean,
    id?: string,
  ) {
    return this.write(async (t) => {
      const invite = await t
        .selectFrom("teamPartnerInvites")
        .selectAll()
        .where("id", "=", selector)
        .forNoKeyUpdate()
        .executeTakeFirst();
      requireTeam(
        invite && !invite.consumedAt && !invite.revokedAt && invite.expiresAt > new Date(),
      );
      requireTeam(
        timingSafeEqual(
          Buffer.from(invite.verifierHash, "hex"),
          Buffer.from(digest(verifier), "hex"),
        ),
      );
      await this.authorize(t, { kind: "human", userId: invite.createdBy }, "propose");
      await t
        .updateTable("teamPartnerInvites")
        .set({ consumedAt: new Date() })
        .where("id", "=", selector)
        .execute();
      // An unaddressed invite does not approve the identity of whoever redeems it.
      const approved = (await this.policy(t)) === "members";
      return this.insert(
        t,
        authority,
        name,
        "listener",
        invite.createdBy,
        approved,
        partnerApproved,
        id,
      );
    });
  }

  async insert(
    t: Tx,
    authority: HostDiscoveryEnvelope,
    name: string,
    role: "dialer" | "listener",
    createdBy: UserId,
    approved: boolean,
    partnerApproved: boolean,
    id?: string,
  ) {
    requireTeam(authority.document.deploymentId !== this.authority.document.deploymentId);
    const row = await t
      .insertInto("teamPartnerLinks")
      .values({
        id: id ?? randomUUID(),
        partnerTeamId: authority.document.deploymentId,
        partnerOrigin: authority.document.canonicalOrigin,
        partnerHostInstanceId: authority.document.hostInstanceId,
        partnerHostKeyFingerprint: hostKeyFingerprint(authority.publicKey.spki),
        partnerAuthority: sql`${JSON.stringify(authority)}::jsonb`,
        partnerName: name,
        role,
        state: approved && partnerApproved ? "active" : "pending",
        localApproved: approved,
        partnerApproved,
        createdBy,
        approvedBy: approved ? createdBy : null,
        approvedAt: approved ? new Date() : null,
        lastSeenAt: null,
        lastError: null,
        revokedAt: null,
        revokedBy: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit(t, { kind: "human", userId: createdBy }, "proposed", row.id);
    return row;
  }

  async approve(actor: TeamActor, id: string) {
    await this.write(async (t) => {
      await this.authorize(t, actor, "approve");
      const row = await this.get(id, t);
      requireTeam(row && row.state !== "revoked");
      requireTeam(
        row.lastError !== "identity-mismatch",
        "Revoke this link and pair again to approve the changed identity",
      );
      await t
        .updateTable("teamPartnerLinks")
        .set({
          localApproved: true,
          approvedBy: actor.userId,
          approvedAt: new Date(),
          state: row.partnerApproved ? "active" : "pending",
        })
        .where("id", "=", id)
        .execute();
      await this.audit(t, actor, "approved", id);
    });
  }

  async abandonProposal(id: string) {
    await this.write(async (t) => {
      await t
        .updateTable("teamPartnerLinks")
        .set({ state: "revoked", revokedAt: new Date(), revokedBy: "local" })
        .where("id", "=", id)
        .where("role", "=", "dialer")
        .where("partnerApproved", "=", false)
        .where("state", "=", "pending")
        .execute();
    });
  }

  async revoke(id: string, actor?: TeamActor) {
    await this.write(async (t) => {
      const row = await this.get(id, t);
      requireTeam(row);
      if (actor) await this.authorize(t, actor, "revoke", row);
      if (row.state === "revoked") return;
      await t
        .updateTable("teamPartnerLinks")
        .set({ state: "revoked", revokedAt: new Date(), revokedBy: actor ? "local" : "partner" })
        .where("id", "=", id)
        .execute();
      await this.audit(t, actor ?? null, "revoked", id, { by: actor ? "local" : "partner" });
    });
  }

  async seen(id: string, partnerApproved: boolean, partnerName?: string) {
    return this.write(async (t) => {
      requireTeam((await this.policy(t)) !== "off");
      const row = await this.get(id, t);
      requireTeam(row);
      if (row.state === "revoked") return row;
      const result = await t
        .updateTable("teamPartnerLinks")
        .set({
          partnerApproved,
          state: row.localApproved && partnerApproved ? "active" : "pending",
          lastSeenAt: new Date(),
          lastError: null,
          ...(partnerName ? { partnerName } : {}),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(t, null, "connected", id);
      return result;
    });
  }

  async failed(id: string, reason: NonNullable<PartnerRow["lastError"]>) {
    await this.write(async (t) => {
      const row = await this.get(id, t);
      if (!row || row.state === "revoked" || row.lastError === reason) return;
      await t
        .updateTable("teamPartnerLinks")
        .set({
          lastError: reason,
          ...(reason === "identity-mismatch"
            ? {
                state: "pending" as const,
                localApproved: false,
                approvedBy: null,
                approvedAt: null,
              }
            : {}),
        })
        .where("id", "=", id)
        .execute();
      await this.audit(t, null, "connection.refused", id, { reason });
    });
  }

  get(id: string, db = this.access.database) {
    return db.selectFrom("teamPartnerLinks").selectAll().where("id", "=", id).executeTakeFirst();
  }
  async find(teamId: PartnerRow["partnerTeamId"]) {
    return this.access.database
      .selectFrom("teamPartnerLinks")
      .selectAll()
      .where("partnerTeamId", "=", teamId)
      .orderBy("createdAt", "desc")
      .executeTakeFirst();
  }
  audit(
    t: Tx,
    actor: TeamActor | null,
    action: string,
    id?: string,
    metadata?: Readonly<Record<string, unknown>>,
  ) {
    return appendTeamAudit(t, {
      actor,
      action: `partner.${action}`,
      resourceKind: "team",
      resourceId: id,
      ...(metadata ? { metadata } : {}),
    });
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
