import { randomBytes } from "node:crypto";
import { digestSecret, equalSecretDigests } from "@opensteer/shared/secretDigest";
import {
  OpensteerError,
  type TeamActor,
  type TeamInviteId,
  type TeamInviteSecret,
  type UserId,
} from "@opensteer/core";
import {
  TeamCurrentInviteSchema,
  TeamInviteSchema,
  type TeamCurrentInvite,
  type TeamEntryRefusalReason,
  type TeamInviteExpiryDays,
} from "@opensteer/protocol";
import { sql, type Selectable, type Transaction } from "kysely";
import type { DatabaseSchema, TeamInviteTable } from "./schema.js";
import {
  TeamAccessStore,
  emptyTeamAccessEffects,
  requireTeam,
  teamConflict,
} from "./team-access-store.js";
import { admitTeamMember, publishTeamMember } from "./team-members-store.js";
import { appendTeamAudit } from "./team-audit-store.js";

/** Seals a reusable invite's verifier with the team Host's own secret, bound to the invite. */
export interface TeamInviteVerifierVault {
  seal(inviteId: TeamInviteId, verifier: string): Promise<Buffer>;
  open(inviteId: TeamInviteId, sealed: Buffer): Promise<string>;
}

type TeamInviteRow = Selectable<TeamInviteTable>;
const dayMs = 86_400_000;
const unmatchedDigest = digestSecret("team-invite-unmatched");

function refuseTeamEntry(reason: TeamEntryRefusalReason, message: string): never {
  throw new OpensteerError({ code: "forbidden", reason, message });
}
/** Whether an invite admits anyone right now. Callers that hold the verifier check it first. */
export function assertTeamInviteUsable(
  invite: TeamInviteRow | undefined,
  now = new Date(),
): asserts invite is TeamInviteRow {
  if (!invite || invite.revokedAt) refuseTeamEntry("invite-invalid", "This invite doesn't work");
  if (invite.expiresAt <= now) refuseTeamEntry("invite-expired", "This invite has expired");
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses)
    refuseTeamEntry("invite-used-up", "This invite has been used up");
}

export class TeamInvitesStore {
  readonly access: TeamAccessStore;
  readonly origin: string;
  readonly #verifiers: TeamInviteVerifierVault | undefined;
  constructor(access: TeamAccessStore, origin: string, verifiers?: TeamInviteVerifierVault) {
    this.access = access;
    this.origin = origin;
    this.#verifiers = verifiers;
  }
  async create(
    actor: TeamActor,
    id: TeamInviteId,
    expiresAt = new Date(Date.now() + 7 * dayMs),
    maxUses = 1,
  ) {
    return this.access.mutateAs(actor, "invite.create", async (transaction) => {
      await this.access.admin(transaction, actor);
      requireTeam(maxUses === 1, "Invites admit one member");
      requireTeam(
        expiresAt > new Date() && expiresAt.getTime() <= Date.now() + 7 * dayMs,
        "Invite expiry must be within seven days",
      );
      const selector = randomBytes(24).toString("base64url"),
        verifier = randomBytes(32).toString("base64url");
      if (
        await transaction
          .selectFrom("teamInvites")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst()
      )
        teamConflict("The invite exists; create a new invite to obtain a new link");
      const row = await transaction
        .insertInto("teamInvites")
        .values({
          id,
          selector,
          verifierHash: digestSecret(verifier),
          sealedVerifier: null,
          maxUses: 1,
          expiresAt,
          revokedAt: null,
          createdBy: actor.userId,
          createdAt: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendTeamAudit(transaction, {
        actor,
        action: "invite.create",
        resourceKind: "team",
        resourceId: id,
      });
      return {
        value: {
          invite: TeamInviteSchema.strip().parse({
            ...row,
            expiresAt: row.expiresAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
            revokedAt: null,
          }),
          url: this.#url(selector, verifier),
        },
        effects: emptyTeamAccessEffects,
      };
    });
  }
  /** Revokes the current reusable invite, if any, and replaces it in the same transaction. */
  async reset(
    actor: TeamActor,
    id: TeamInviteId,
    expiresInDays: TeamInviteExpiryDays,
    maxUses: number | null,
  ): Promise<TeamCurrentInvite> {
    const verifiers = this.#requireVerifiers();
    const selector = randomBytes(24).toString("base64url"),
      verifier = randomBytes(32).toString("base64url"),
      sealedVerifier = await verifiers.seal(id, verifier);
    return this.access.mutateAs(actor, "invite.reset", async (transaction) => {
      await this.access.admin(transaction, actor);
      const retried = await transaction
        .selectFrom("teamInvites")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (retried) {
        if (!retried.sealedVerifier || retried.revokedAt)
          teamConflict("That invite was replaced; reset again for a new link");
        return {
          value: this.#current(retried, await verifiers.open(id, retried.sealedVerifier)),
          effects: emptyTeamAccessEffects,
        };
      }
      const now = new Date();
      await transaction
        .updateTable("teamInvites")
        .set({ revokedAt: now })
        .where("sealedVerifier", "is not", null)
        .where("revokedAt", "is", null)
        .execute();
      const row = await transaction
        .insertInto("teamInvites")
        .values({
          id,
          selector,
          verifierHash: digestSecret(verifier),
          sealedVerifier,
          maxUses,
          expiresAt: new Date(now.getTime() + expiresInDays * dayMs),
          revokedAt: null,
          createdBy: actor.userId,
          createdAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendTeamAudit(transaction, {
        actor,
        action: "invite.reset",
        resourceKind: "team",
        resourceId: id,
      });
      return { value: this.#current(row, verifier), effects: emptyTeamAccessEffects };
    });
  }
  /** The reusable invite while it still admits someone; `null` once it is revoked, expired or used up. */
  async current(actor: TeamActor): Promise<{ invite: TeamCurrentInvite | null }> {
    const verifiers = this.#requireVerifiers();
    return this.access.database.transaction().execute(async (transaction) => {
      await this.access.admin(transaction, actor);
      const row = await transaction
        .selectFrom("teamInvites")
        .selectAll()
        .where("sealedVerifier", "is not", null)
        .where("revokedAt", "is", null)
        .executeTakeFirst();
      if (
        !row?.sealedVerifier ||
        row.expiresAt <= new Date() ||
        (row.maxUses !== null && row.usedCount >= row.maxUses)
      )
        return { invite: null };
      return { invite: this.#current(row, await verifiers.open(row.id, row.sealedVerifier)) };
    });
  }
  /**
   * The invite the secret names, if it admits someone now. Every wrong secret takes the same
   * path and gets the same refusal, whether or not its selector exists.
   */
  async verify(selector: string, verifier: string) {
    const row = await this.access.database
      .selectFrom("teamInvites")
      .selectAll()
      .where("selector", "=", selector)
      .executeTakeFirst();
    const matches = equalSecretDigests(
      row?.verifierHash ?? unmatchedDigest,
      digestSecret(verifier),
    );
    const invite = matches ? row : undefined;
    assertTeamInviteUsable(invite);
    return invite;
  }
  async preview(secret: TeamInviteSecret) {
    const invite = await this.verify(secret.selector, secret.verifier);
    return { expiresAt: invite.expiresAt.toISOString() };
  }
  /**
   * The one admission path for invites, shared by browser sign-in and native session exchange.
   * An active member consumes nothing. A removed person gets back in only with an invite created
   * after their removal. Pass `verifier` unless the caller already proved it (a browser admission).
   */
  async acceptInTransaction(
    transaction: Transaction<DatabaseSchema>,
    userId: UserId,
    selector: string,
    verifier?: string,
  ) {
    const member = await transaction
      .selectFrom("teamMembers")
      .selectAll()
      .where("userId", "=", userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (member?.state === "active") return member;
    const row = await transaction
      .selectFrom("teamInvites")
      .selectAll()
      .where("selector", "=", selector)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const invite =
      verifier === undefined ||
      equalSecretDigests(row?.verifierHash ?? unmatchedDigest, digestSecret(verifier))
        ? row
        : undefined;
    assertTeamInviteUsable(invite);
    // A removed member row keeps `changedAt` at its removal; every other change needs it active.
    if (member && invite.createdAt <= member.changedAt)
      refuseTeamEntry(
        "invite-invalid",
        "This invite was made before you left the team. Ask for a new invite.",
      );
    const admitted = await admitTeamMember(transaction, userId, "member");
    await transaction
      .insertInto("teamInviteUses")
      .values({
        inviteId: invite.id,
        userId,
        acceptedAt: new Date(),
        memberGeneration: admitted.generation,
      })
      .execute();
    await transaction
      .updateTable("teamInvites")
      .set({ usedCount: sql`used_count+1` })
      .where("id", "=", invite.id)
      .execute();
    await appendTeamAudit(transaction, {
      actor: { kind: "human", userId },
      action: "invite.accept",
      resourceKind: "member",
      resourceId: userId,
    });
    return admitted;
  }
  async accept(userId: UserId, selector: string, verifier: string) {
    return this.access.mutate(
      async (transaction) => ({
        value: await this.acceptInTransaction(transaction, userId, selector, verifier),
        effects: emptyTeamAccessEffects,
      }),
      (transaction) => publishTeamMember(transaction, userId),
    );
  }
  async revoke(actor: TeamActor, id: TeamInviteId) {
    return this.access.mutateAs(actor, "invite.revoke", async (transaction) => {
      await this.access.admin(transaction, actor);
      const changed = await transaction
        .updateTable("teamInvites")
        .set({ revokedAt: new Date() })
        .where("id", "=", id)
        .where("revokedAt", "is", null)
        .returning("id")
        .execute();
      if (changed.length)
        await appendTeamAudit(transaction, {
          actor,
          action: "invite.revoke",
          resourceKind: "team",
          resourceId: id,
        });
      return { value: undefined, effects: emptyTeamAccessEffects };
    });
  }
  /** Single-use invites only; the reusable invite is read through `current`. */
  async page(actor: TeamActor, after?: TeamInviteId) {
    return this.access.database.transaction().execute(async (transaction) => {
      await this.access.admin(transaction, actor);
      let query = transaction
        .selectFrom("teamInvites")
        .selectAll()
        .where("sealedVerifier", "is", null);
      if (after) query = query.where("id", ">", after);
      const rows = await query.orderBy("id").limit(51).execute();
      return {
        invites: rows.slice(0, 50).map((r) =>
          TeamInviteSchema.strip().parse({
            ...r,
            expiresAt: r.expiresAt.toISOString(),
            createdAt: r.createdAt.toISOString(),
            revokedAt: r.revokedAt?.toISOString() ?? null,
          }),
        ),
        hasMore: rows.length > 50,
      };
    });
  }
  #url(selector: string, verifier: string) {
    return `${this.origin}/invite/${selector}#${verifier}`;
  }
  #current(row: TeamInviteRow, verifier: string): TeamCurrentInvite {
    return TeamCurrentInviteSchema.parse({
      id: row.id,
      url: this.#url(row.selector, verifier),
      expiresInDays: Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / dayMs),
      expiresAt: row.expiresAt.toISOString(),
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    });
  }
  #requireVerifiers() {
    if (!this.#verifiers) throw new Error("Reusable invites need the team Host's secret storage");
    return this.#verifiers;
  }
}
