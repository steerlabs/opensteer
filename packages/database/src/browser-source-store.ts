import { withDatabaseTransaction } from "./connection.js";
import { discoverRequestWorkspaces, withRequestWorkspaceLocks } from "./request-workspace-locks.js";
import { randomUUID } from "node:crypto";
import {
  OpensteerError,
  createId,
  type AgentEvent,
  type BrowserSourceId,
  type RequestId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { BrowserSignInRequestResponse } from "@opensteer/protocol/browser-sources";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import {
  browserSignInRequestDeliverableInTransaction,
  fulfilBrowserSignInRequestInTransaction,
} from "./request-store.js";

const maxActiveSources = 64;
const maxPendingPairings = 5;
const maxActiveSiteGrants = 1_024;

export interface BrowserSourceRecord {
  readonly id: BrowserSourceId;
  readonly ownerId: UserId;
  readonly name: string;
  readonly generation: number;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  readonly lastSeenAt: Date | null;
}

export interface BrowserSiteGrantRecord {
  readonly id: string;
  readonly ownerId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly site: string;
  readonly preferredSourceId: BrowserSourceId | null;
  readonly createdAt: Date;
  readonly lastSignedInAt: Date | null;
}

export type BrowserSignInActor = "agent" | "owner" | "request";

export interface BrowserSignInReceipt {
  readonly id: string;
  readonly ownerId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly site: string;
  readonly sourceId: BrowserSourceId;
  readonly sourceName: string;
  readonly sessionId: string;
  readonly profileName: string | null;
  readonly requestId: RequestId | null;
  readonly actor: BrowserSignInActor;
  readonly createdAt: Date;
}

/** Why a sign-in that was exported must not be imported. */
export type BrowserSignInFence =
  "source-changed" | "grant-removed" | "workspace-unavailable" | "request-closed";

const sourceColumns = [
  "browserSources.id",
  "browserSources.ownerId",
  "browserSources.name",
  "browserSources.generation",
  "browserSources.createdAt",
  "browserSources.revokedAt",
  "browserSources.lastSeenAt",
] as const;
const grantColumns = [
  "id",
  "ownerId",
  "workspaceId",
  "site",
  "preferredSourceId",
  "createdAt",
  "lastSignedInAt",
] as const;
const receiptColumns = [
  "id",
  "ownerId",
  "workspaceId",
  "site",
  "sourceId",
  "sourceName",
  "sessionId",
  "profileName",
  "requestId",
  "actor",
  "createdAt",
] as const;

/**
 * Durable authority for Chrome sign-ins: which Chrome profiles are connected
 * (sources), which sites each Workspace may sign in to without asking (site
 * grants), and what was signed in (receipts). A grant is not bound to a source,
 * so reconnecting Chrome keeps every site the person allowed.
 */
export class BrowserSourceStore {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  async createPairing(input: {
    readonly codeHash: string;
    readonly ownerId: UserId;
    readonly expiresAt: Date;
    readonly canonicalOrigin: string;
    readonly remoteOrigin: string | null;
    readonly remoteGeneration: number | null;
  }): Promise<void> {
    await withDatabaseTransaction(this.#database, async (transaction) => {
      await lockPairings(transaction, input.ownerId);
      const now = new Date();
      await transaction
        .deleteFrom("browserSourcePairings")
        .where("expiresAt", "<", new Date(now.getTime() - 24 * 60 * 60_000))
        .execute();
      const active = await transaction
        .selectFrom("browserSourcePairings")
        .select("codeHash")
        .where("ownerId", "=", input.ownerId)
        .where("consumedAt", "is", null)
        .where("expiresAt", ">", now)
        .limit(maxPendingPairings)
        .execute();
      if (active.length >= maxPendingPairings) {
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "Too many Chrome connection links are open. Wait a few minutes and try again.",
        });
      }
      await transaction
        .insertInto("browserSourcePairings")
        .values({
          codeHash: input.codeHash,
          ownerId: input.ownerId,
          expiresAt: input.expiresAt,
          consumedAt: null,
          canonicalOrigin: input.canonicalOrigin,
          remoteOrigin: input.remoteOrigin,
          remoteGeneration: input.remoteGeneration,
        })
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * Consumes a pairing code once, through any destination its invitation listed.
   * The raw code and bearer never enter durable state. A verified `replaces`
   * retires the previous connection of the same Chrome profile in the same
   * transaction and moves grant preferences to the new one; an unverified one
   * is ignored, since it could only ever have named the caller's own source.
   */
  async consumePairing(input: {
    readonly codeHash: string;
    readonly tokenHash: string;
    readonly name: string;
    readonly origin: string;
    readonly routeGeneration: number | null;
    readonly replaces: { readonly sourceId: BrowserSourceId; readonly tokenHash: string } | null;
  }): Promise<BrowserSourceRecord> {
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const now = new Date();
      const prospective = await transaction
        .selectFrom("browserSourcePairings")
        .select("ownerId")
        .where("codeHash", "=", input.codeHash)
        .where("consumedAt", "is", null)
        .where("expiresAt", ">", now)
        .executeTakeFirst();
      if (!prospective) throw invalidPairing();
      await lockPairings(transaction, prospective.ownerId);
      const pairing = await transaction
        .updateTable("browserSourcePairings")
        .set({ consumedAt: now })
        .where("codeHash", "=", input.codeHash)
        .where("consumedAt", "is", null)
        .where("expiresAt", ">", now)
        .where((eb) =>
          input.routeGeneration === null
            ? eb("canonicalOrigin", "=", input.origin)
            : eb.and([
                eb("remoteOrigin", "=", input.origin),
                eb("remoteGeneration", "=", input.routeGeneration),
              ]),
        )
        .returning(["ownerId"])
        .executeTakeFirst();
      if (!pairing) throw invalidPairing();
      if (pairing.ownerId !== prospective.ownerId) throw new Error("Pairing owner changed");
      const owner = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", pairing.ownerId)
        .where("disabledAt", "is", null)
        .executeTakeFirst();
      if (!owner) {
        throw new OpensteerError({ code: "forbidden", message: "The Chrome owner is unavailable" });
      }
      await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-sources-owner:${pairing.ownerId}`}, 0))`.execute(
        transaction,
      );
      const replaced = input.replaces
        ? await transaction
            .selectFrom("browserSources")
            .select(["id", "revokedAt"])
            .where("id", "=", input.replaces.sourceId)
            .where("ownerId", "=", pairing.ownerId)
            .where("tokenHash", "=", input.replaces.tokenHash)
            .forNoKeyUpdate()
            .executeTakeFirst()
        : undefined;
      if (replaced && replaced.revokedAt === null) {
        await transaction
          .updateTable("browserSources")
          .set({ revokedAt: now, generation: sql<number>`generation + 1`, updatedAt: now })
          .where("id", "=", replaced.id)
          .executeTakeFirstOrThrow();
      }
      const active = await transaction
        .selectFrom("browserSources")
        .select("id")
        .where("ownerId", "=", pairing.ownerId)
        .where("revokedAt", "is", null)
        .limit(maxActiveSources)
        .execute();
      if (active.length >= maxActiveSources) {
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "Disconnect a Chrome profile before connecting another.",
        });
      }
      const source = await transaction
        .insertInto("browserSources")
        .values({
          id: createId("browserSource"),
          ownerId: pairing.ownerId,
          name: input.name,
          tokenHash: input.tokenHash,
          revokedAt: null,
          lastSeenAt: null,
        })
        .returning(["id", "ownerId", "name", "generation", "createdAt", "revokedAt", "lastSeenAt"])
        .executeTakeFirstOrThrow();
      if (replaced) {
        const preferring = await transaction
          .selectFrom("browserSiteGrants")
          .select("id")
          .where("ownerId", "=", pairing.ownerId)
          .where("preferredSourceId", "=", replaced.id)
          .orderBy("id", "asc")
          .forNoKeyUpdate()
          .execute();
        if (preferring.length > 0) {
          await transaction
            .updateTable("browserSiteGrants")
            .set({ preferredSourceId: source.id })
            .where(
              "id",
              "in",
              preferring.map(({ id }) => id),
            )
            .execute();
        }
      }
      return source;
    });
  }

  async authenticate(tokenHash: string): Promise<BrowserSourceRecord | null> {
    return (
      (await this.#database
        .selectFrom("browserSources")
        .innerJoin("users", "users.id", "browserSources.ownerId")
        .select(sourceColumns)
        .where("browserSources.tokenHash", "=", tokenHash)
        .where("browserSources.revokedAt", "is", null)
        .where("users.disabledAt", "is", null)
        .executeTakeFirst()) ?? null
    );
  }

  async list(ownerId: UserId): Promise<readonly BrowserSourceRecord[]> {
    return this.#database
      .selectFrom("browserSources")
      .innerJoin("users", "users.id", "browserSources.ownerId")
      .select(sourceColumns)
      .where("browserSources.ownerId", "=", ownerId)
      .where("browserSources.revokedAt", "is", null)
      .where("users.disabledAt", "is", null)
      .orderBy("browserSources.createdAt", "asc")
      .orderBy("browserSources.id", "asc")
      .execute();
  }

  async get(sourceId: BrowserSourceId, ownerId: UserId): Promise<BrowserSourceRecord | null> {
    return (
      (await this.#database
        .selectFrom("browserSources")
        .innerJoin("users", "users.id", "browserSources.ownerId")
        .select(sourceColumns)
        .where("browserSources.id", "=", sourceId)
        .where("browserSources.ownerId", "=", ownerId)
        .where("browserSources.revokedAt", "is", null)
        .where("users.disabledAt", "is", null)
        .executeTakeFirst()) ?? null
    );
  }

  async rename(input: {
    readonly sourceId: BrowserSourceId;
    readonly ownerId: UserId;
    readonly name: string;
  }): Promise<boolean> {
    const result = await this.#database
      .updateTable("browserSources")
      .set({ name: input.name, updatedAt: new Date() })
      .where("id", "=", input.sourceId)
      .where("ownerId", "=", input.ownerId)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async markSeen(sourceId: BrowserSourceId): Promise<void> {
    await this.#database
      .updateTable("browserSources")
      .set({ lastSeenAt: new Date() })
      .where("id", "=", sourceId)
      .where("revokedAt", "is", null)
      .execute();
  }

  /**
   * Ends a connection. Grants stay: they belong to the Workspace, and a
   * preference for a revoked source is simply skipped when choosing one.
   */
  async revoke(input: {
    readonly sourceId: BrowserSourceId;
    readonly ownerId: UserId;
  }): Promise<boolean> {
    const now = new Date();
    const result = await this.#database
      .updateTable("browserSources")
      .set({ revokedAt: now, generation: sql<number>`generation + 1`, updatedAt: now })
      .where("id", "=", input.sourceId)
      .where("ownerId", "=", input.ownerId)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /** Grants in Workspaces the owner can still use, so a lost membership hides its sites. */
  async listGrants(ownerId: UserId): Promise<readonly BrowserSiteGrantRecord[]> {
    return this.#database
      .selectFrom("browserSiteGrants")
      .innerJoin("workspaces", "workspaces.id", "browserSiteGrants.workspaceId")
      .innerJoin("workspaceMemberships", (join) =>
        join
          .onRef("workspaceMemberships.workspaceId", "=", "browserSiteGrants.workspaceId")
          .onRef("workspaceMemberships.userId", "=", "browserSiteGrants.ownerId"),
      )
      .select(grantColumns.map((column) => `browserSiteGrants.${column}` as const))
      .where("browserSiteGrants.ownerId", "=", ownerId)
      .where("browserSiteGrants.revokedAt", "is", null)
      .where("workspaceMemberships.state", "=", "active")
      .where("workspaces.status", "=", "ready")
      .orderBy("browserSiteGrants.createdAt", "asc")
      .limit(maxActiveSiteGrants)
      .execute();
  }

  async getGrant(input: {
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
    readonly site: string;
  }): Promise<BrowserSiteGrantRecord | null> {
    return (
      (await this.#database
        .selectFrom("browserSiteGrants")
        .select(grantColumns)
        .where("ownerId", "=", input.ownerId)
        .where("workspaceId", "=", input.workspaceId)
        .where("site", "=", input.site)
        .where("revokedAt", "is", null)
        .executeTakeFirst()) ?? null
    );
  }

  /** Remembers a site for a Workspace, preferring one Chrome profile for it. */
  async upsertGrant(input: {
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
    readonly site: string;
    readonly preferredSourceId: BrowserSourceId;
  }): Promise<BrowserSiteGrantRecord> {
    return withRequestWorkspaceLocks(
      this.#database,
      async () => [input.workspaceId],
      async (transaction) => {
        await lockSiteGrants(transaction, input.ownerId);
        return upsertGrantInTransaction(transaction, input, null);
      },
    );
  }

  async removeGrant(input: {
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
    readonly site: string;
  }): Promise<boolean> {
    const result = await this.#database
      .updateTable("browserSiteGrants")
      .set({ revokedAt: new Date() })
      .where("ownerId", "=", input.ownerId)
      .where("workspaceId", "=", input.workspaceId)
      .where("site", "=", input.site)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /**
   * The last check between exporting a sign-in and importing it, made
   * immediately before the import so every later commit step is expected to
   * succeed: the source must be the same live connection that exported, the
   * Workspace must still be usable, a standing sign-in must still be allowed,
   * a Request must still be pending with its authority intact, and a sign-in
   * that remembers a new site must fit the owner's limit of allowed sites.
   */
  async fence(input: {
    readonly ownerId: UserId;
    readonly sourceId: BrowserSourceId;
    readonly sourceGeneration: number;
    readonly workspaceId: WorkspaceId;
    readonly site: string;
    readonly sessionId: string;
    readonly requireGrant: boolean;
    readonly rememberSite: boolean;
    readonly requestId: RequestId | null;
  }): Promise<BrowserSignInFence | null> {
    return withRequestWorkspaceLocks(
      this.#database,
      async (transaction) => [
        input.workspaceId,
        ...(input.requestId
          ? await discoverRequestWorkspaces(transaction, { requestId: input.requestId })
          : []),
      ],
      async (transaction) => {
        const source = await transaction
          .selectFrom("browserSources")
          .innerJoin("users", "users.id", "browserSources.ownerId")
          .select("browserSources.generation")
          .where("browserSources.id", "=", input.sourceId)
          .where("browserSources.ownerId", "=", input.ownerId)
          .where("browserSources.revokedAt", "is", null)
          .where("users.disabledAt", "is", null)
          .executeTakeFirst();
        if (!source || source.generation !== input.sourceGeneration) return "source-changed";
        if (!(await workspaceUsable(transaction, input.ownerId, input.workspaceId))) {
          return "workspace-unavailable";
        }
        const grant = await transaction
          .selectFrom("browserSiteGrants")
          .select("id")
          .where("ownerId", "=", input.ownerId)
          .where("workspaceId", "=", input.workspaceId)
          .where("site", "=", input.site)
          .where("revokedAt", "is", null)
          .executeTakeFirst();
        if (input.requireGrant && !grant) return "grant-removed";
        if (
          input.requestId &&
          !(await browserSignInRequestDeliverableInTransaction(transaction, {
            ownerId: input.ownerId,
            requestId: input.requestId,
            scope: { sessionId: input.sessionId, site: input.site, workspaceId: input.workspaceId },
          }))
        ) {
          return "request-closed";
        }
        if (input.rememberSite && !grant) await assertGrantCapacity(transaction, input.ownerId);
        return null;
      },
    );
  }

  async getSignIn(input: {
    readonly ownerId: UserId;
    readonly invocationId: string;
  }): Promise<BrowserSignInReceipt | null> {
    return (
      (await this.#database
        .selectFrom("browserSignIns")
        .select(receiptColumns)
        .where("ownerId", "=", input.ownerId)
        .where("id", "=", input.invocationId)
        .executeTakeFirst()) ?? null
    );
  }

  /**
   * Records a sign-in that already reached the live browser, together with the
   * Request it answers and the grant it used or created. One invocation maps to
   * one receipt: a replay with the same scope returns it, any other scope is a
   * conflict.
   */
  async commitSignIn(input: {
    readonly invocationId: string;
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
    readonly site: string;
    readonly sourceId: BrowserSourceId;
    readonly sourceName: string;
    readonly sessionId: string;
    readonly profileName: string | null;
    readonly actor: BrowserSignInActor;
    readonly requestId: RequestId | null;
    /** Create the grant if it is missing; otherwise only an active grant is touched. */
    readonly rememberSite: boolean;
  }): Promise<{
    readonly receipt: BrowserSignInReceipt;
    readonly replayed: boolean;
    readonly events: readonly AgentEvent[];
  }> {
    return withRequestWorkspaceLocks(
      this.#database,
      async (transaction) => [
        input.workspaceId,
        ...(input.requestId
          ? await discoverRequestWorkspaces(transaction, { requestId: input.requestId })
          : []),
      ],
      async (transaction) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-sign-in:${input.ownerId}:${input.invocationId}`}, 0))`.execute(
          transaction,
        );
        const replay = await transaction
          .selectFrom("browserSignIns")
          .select(receiptColumns)
          .where("ownerId", "=", input.ownerId)
          .where("id", "=", input.invocationId)
          .executeTakeFirst();
        if (replay) {
          assertSameSignIn(replay, input);
          return { receipt: replay, replayed: true, events: [] };
        }
        await lockSiteGrants(transaction, input.ownerId);
        const request = input.requestId
          ? await fulfilBrowserSignInRequestInTransaction(transaction, {
              requestId: input.requestId,
              ownerId: input.ownerId,
              response: {
                outcome: "applied",
                profileName: input.profileName,
                sourceName: input.sourceName,
              } satisfies BrowserSignInRequestResponse,
              scope: {
                sessionId: input.sessionId,
                site: input.site,
                workspaceId: input.workspaceId,
              },
            })
          : null;
        const now = new Date();
        if (input.rememberSite) {
          await upsertGrantInTransaction(
            transaction,
            { ...input, preferredSourceId: input.sourceId },
            now,
          );
        } else {
          await transaction
            .updateTable("browserSiteGrants")
            .set({ lastSignedInAt: now, preferredSourceId: input.sourceId })
            .where("ownerId", "=", input.ownerId)
            .where("workspaceId", "=", input.workspaceId)
            .where("site", "=", input.site)
            .where("revokedAt", "is", null)
            .execute();
        }
        const receipt = await transaction
          .insertInto("browserSignIns")
          .values({
            id: input.invocationId,
            ownerId: input.ownerId,
            workspaceId: input.workspaceId,
            site: input.site,
            sourceId: input.sourceId,
            sourceName: input.sourceName,
            sessionId: input.sessionId,
            profileName: input.profileName,
            requestId: request ? request.request.id : null,
            actor: input.actor,
            createdAt: now,
          })
          .returning(receiptColumns)
          .executeTakeFirstOrThrow();
        return { receipt, replayed: false, events: request?.events ?? [] };
      },
    );
  }
}

function invalidPairing(): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    message: "This connection link was already used or has expired.",
  });
}

async function lockPairings(transaction: Transaction<DatabaseSchema>, ownerId: UserId) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-source-pairing:${ownerId}`}, 0))`.execute(
    transaction,
  );
}

/**
 * Serializes grant creation per owner so the owner-wide limit holds. Taken
 * after the complete Workspace set, matching sign-in commits.
 */
async function lockSiteGrants(transaction: Transaction<DatabaseSchema>, ownerId: UserId) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-site-grants:${ownerId}`}, 0))`.execute(
    transaction,
  );
}

async function workspaceUsable(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  ownerId: UserId,
  workspaceId: WorkspaceId,
  lock = false,
): Promise<boolean> {
  let query = database
    .selectFrom("workspaces")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
    .innerJoin("users", "users.id", "workspaceMemberships.userId")
    .select(["workspaces.kind", "workspaces.status", "workspaceMemberships.role"])
    .where("workspaces.id", "=", workspaceId)
    .where("workspaceMemberships.userId", "=", ownerId)
    .where("workspaceMemberships.state", "=", "active")
    .where("users.disabledAt", "is", null);
  if (lock) query = query.forShare(["workspaces", "workspaceMemberships"]);
  const workspace = await query.executeTakeFirst();
  // Main belongs to its owner alone; a specialized Workspace to its members.
  return (
    workspace !== undefined &&
    workspace.status === "ready" &&
    (workspace.kind !== "main" || workspace.role === "owner")
  );
}

async function assertGrantCapacity(
  transaction: Transaction<DatabaseSchema>,
  ownerId: UserId,
): Promise<void> {
  const active = await transaction
    .selectFrom("browserSiteGrants")
    .select("id")
    .where("ownerId", "=", ownerId)
    .where("revokedAt", "is", null)
    .limit(maxActiveSiteGrants)
    .execute();
  if (active.length >= maxActiveSiteGrants) {
    throw new OpensteerError({
      code: "resource_exhausted",
      message: "Remove an allowed site before allowing another.",
    });
  }
}

/** Callers hold the owner's grant lock. */
async function upsertGrantInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
    readonly site: string;
    readonly preferredSourceId: BrowserSourceId;
  },
  signedInAt: Date | null,
): Promise<BrowserSiteGrantRecord> {
  if (!(await workspaceUsable(transaction, input.ownerId, input.workspaceId, true))) {
    throw new OpensteerError({ code: "forbidden", message: "Workspace is unavailable" });
  }
  const existing = await transaction
    .updateTable("browserSiteGrants")
    .set({
      preferredSourceId: input.preferredSourceId,
      ...(signedInAt ? { lastSignedInAt: signedInAt } : {}),
    })
    .where("ownerId", "=", input.ownerId)
    .where("workspaceId", "=", input.workspaceId)
    .where("site", "=", input.site)
    .where("revokedAt", "is", null)
    .returning(grantColumns)
    .executeTakeFirst();
  if (existing) return existing;
  await assertGrantCapacity(transaction, input.ownerId);
  return transaction
    .insertInto("browserSiteGrants")
    .values({
      id: randomUUID(),
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      site: input.site,
      preferredSourceId: input.preferredSourceId,
      lastSignedInAt: signedInAt,
      revokedAt: null,
    })
    .returning(grantColumns)
    .executeTakeFirstOrThrow();
}

function assertSameSignIn(
  receipt: BrowserSignInReceipt,
  input: {
    readonly workspaceId: WorkspaceId;
    readonly site: string;
    readonly sessionId: string;
  },
): void {
  if (
    receipt.workspaceId !== input.workspaceId ||
    receipt.site !== input.site ||
    receipt.sessionId !== input.sessionId
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "This sign-in invocation belongs to a different site or session",
    });
  }
}
