import { randomBytes } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import type { Kysely } from "kysely";
import { hashCredential } from "../auth/credentials.js";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";

/** Sliding lifetime of a portal browser session, matched to the Account session. */
export const portalSessionLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1_000;
/** A read older than this extends the row; younger reads stay write-free. */
const portalSessionSlideMilliseconds = 24 * 60 * 60 * 1_000;

export interface PortalSession {
  readonly accountId: ControlPlaneAccountId;
  readonly accountSessionId: string;
  readonly displayName: string;
  readonly email: string;
  readonly expiresAt: Date;
}

interface IssuedPortalSession {
  readonly expiresAt: Date;
  readonly token: string;
}

/**
 * Durable portal browser sessions. The portal proves identity once through the
 * Account authorization server and then reads the control-plane database
 * directly, so the only thing that survives an authorization is this row. Every
 * read re-checks that the proving Account session is still live, which keeps a
 * portal session strictly no longer-lived than the Account session behind it.
 */
export class PortalSessionStore {
  readonly #database: Kysely<ControlPlaneDatabaseSchema>;

  constructor(database: Kysely<ControlPlaneDatabaseSchema>) {
    this.#database = database;
  }

  async create(input: {
    readonly accountId: ControlPlaneAccountId;
    readonly accountSessionId: string;
    readonly now?: Date;
  }): Promise<IssuedPortalSession> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + portalSessionLifetimeMilliseconds);
    const token = `ops_${randomBytes(32).toString("base64url")}`;
    await this.#database
      .insertInto("portalSessions")
      .values({
        accountId: ControlPlaneAccountIdSchema.parse(input.accountId),
        accountSessionId: input.accountSessionId,
        createdAt: now,
        expiresAt,
        id: `pss_${crypto.randomUUID()}`,
        tokenHash: hashCredential(token),
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    return { expiresAt, token };
  }

  /** Reads a live session and slides its expiry at most once a day. */
  async read(token: string, now = new Date()): Promise<PortalSession | undefined> {
    const tokenHash = hashCredential(token);
    const row = await this.#database
      .selectFrom("portalSessions")
      .innerJoin("users", "users.id", "portalSessions.accountId")
      .innerJoin("authSessions", "authSessions.id", "portalSessions.accountSessionId")
      .select([
        "portalSessions.accountId as accountId",
        "portalSessions.accountSessionId as accountSessionId",
        "portalSessions.expiresAt as expiresAt",
        "users.displayName as displayName",
        "users.email as email",
      ])
      .where("portalSessions.tokenHash", "=", tokenHash)
      .where("portalSessions.expiresAt", ">", now)
      .where("authSessions.expiresAt", ">", now)
      .executeTakeFirst();
    if (!row) return undefined;
    const slid = new Date(now.getTime() + portalSessionLifetimeMilliseconds);
    if (slid.getTime() - row.expiresAt.getTime() < portalSessionSlideMilliseconds) {
      return { ...row, expiresAt: row.expiresAt };
    }
    await this.#database
      .updateTable("portalSessions")
      .set({ expiresAt: slid, updatedAt: now })
      .where("tokenHash", "=", tokenHash)
      .execute();
    return { ...row, expiresAt: slid };
  }

  /** Deletes one session and reports what it proved, for sign-out. */
  async delete(token: string): Promise<
    | {
        readonly accountId: ControlPlaneAccountId;
        readonly accountSessionId: string;
      }
    | undefined
  > {
    const deleted = await this.#database
      .deleteFrom("portalSessions")
      .where("tokenHash", "=", hashCredential(token))
      .returning(["accountId", "accountSessionId"])
      .executeTakeFirst();
    return deleted;
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const result = await this.#database
      .deleteFrom("portalSessions")
      .where("expiresAt", "<=", now)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }
}
