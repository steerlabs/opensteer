import {
  localMachineOwnerEmail,
  normalizePersonName,
  OpensteerError,
  PersonNameSchema,
  type PersonName,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import { withPersonalTransaction } from "./personal-transaction.js";
import type { DatabaseSchema } from "./schema.js";

/** The Account a linked Host's owner name came from. */
export interface OwnerNameAccount {
  readonly issuer: string;
  readonly subject: string;
}

/** The exact link an Account answer was read through; it applies only while that link is live. */
export interface OwnerNameLink extends OwnerNameAccount {
  readonly linkGeneration: string;
}

export interface OwnerProfile {
  readonly ownerId: UserId;
  /** Null until the person, their computer or their Account gives one; shown as "You". */
  readonly name: PersonName | null;
  /** Set while the name is a linked Account's, with the revision this Host last verified. */
  readonly account: (OwnerNameAccount & { readonly revision: number }) | null;
}

/** What older readers of a person's name see while they have none. */
const unnamedOwner = "You";

/**
 * The personal owner's name. Personal settings hold it, nullable; the owner's user row and
 * principal carry a display copy that older readers (input authors, sign-in sessions) use, kept
 * in the same transaction as every change.
 */
export class OwnerProfileStore {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  /** Null on a team Host, which has no personal owner. */
  async read(): Promise<OwnerProfile | null> {
    return ownerProfile(this.#database);
  }

  /** A name the owner chose while no Account owns it. */
  async setLocal(input: { readonly userId: UserId; readonly name: PersonName | null }) {
    const name = input.name === null ? null : PersonNameSchema.parse(input.name);
    return withPersonalTransaction(this.#database, async (transaction) => {
      const current = await lockedProfile(transaction);
      if (current.ownerId !== input.userId)
        throw new OpensteerError({ code: "forbidden", message: "The personal owner is required." });
      if (current.account)
        throw new OpensteerError({
          code: "conflict",
          message: "Your name belongs to your Opensteer Account; change it there.",
        });
      await write(transaction, current.ownerId, {
        ownerName: name,
        ownerNameAccount: null,
        ownerNameRevision: null,
      });
      return { ...current, name, account: null } satisfies OwnerProfile;
    });
  }

  /**
   * The linked Account's name, verified by the caller. A different Account always wins (it is a
   * new link); the same Account only moves forward, so a late answer never restores an old name.
   */
  async applyAccount(input: {
    readonly account: OwnerNameLink;
    readonly name: PersonName;
    readonly revision: number;
  }): Promise<{
    readonly changed: boolean;
    /** The link changed after the answer was read: nothing was applied. */
    readonly stale: boolean;
    readonly profile: OwnerProfile;
  }> {
    const name = PersonNameSchema.parse(input.name);
    return withPersonalTransaction(this.#database, async (transaction) => {
      const current = await lockedProfile(transaction);
      const link = await activeLink(transaction);
      if (
        !link ||
        link.issuer !== input.account.issuer ||
        link.subject !== input.account.subject ||
        link.linkGeneration !== input.account.linkGeneration
      )
        return { changed: false, stale: true, profile: current };
      const sameAccount =
        current.account?.issuer === input.account.issuer &&
        current.account.subject === input.account.subject;
      if (sameAccount && current.account!.revision >= input.revision)
        return { changed: false, stale: false, profile: current };
      const account = {
        issuer: input.account.issuer,
        subject: input.account.subject,
        revision: input.revision,
      };
      await write(transaction, current.ownerId, {
        ownerName: name,
        ownerNameAccount: { issuer: account.issuer, subject: account.subject },
        ownerNameRevision: String(account.revision),
      });
      return {
        changed: current.name !== name || !sameAccount,
        stale: false,
        profile: { ...current, name, account },
      };
    });
  }

  /**
   * Unlinking keeps the last name as the owner's own; only the Account binding goes. Refused
   * while a link is active, so a late answer from before a relink cannot unbind the new one.
   */
  async detachAccount(): Promise<boolean> {
    return withPersonalTransaction(this.#database, async (transaction) => {
      await lockedProfile(transaction);
      if (await activeLink(transaction)) return false;
      const updated = await transaction
        .updateTable("personalSettings")
        .set({ ownerNameAccount: null, ownerNameRevision: null })
        .where("singletonKey", "=", "personal")
        .where("ownerNameAccount", "is not", null)
        .executeTakeFirst();
      return updated.numUpdatedRows > 0n;
    });
  }

  /**
   * The owner's first name, used once: only while nobody has chosen, cleared or adopted one, so
   * a person who cleared theirs is never renamed behind their back. An owner who signed up gave
   * a name; the desktop's implicit owner takes `computerName`, its computer account's full name.
   */
  async seed(computerName: string | null): Promise<boolean> {
    return withPersonalTransaction(this.#database, async (transaction) => {
      const current = await lockedProfile(transaction);
      const row = await transaction
        .selectFrom("personalSettings")
        .innerJoin("users", "users.id", "personalSettings.ownerId")
        .select(["personalSettings.ownerNameSetAt", "users.displayName", "users.email"])
        .where("personalSettings.singletonKey", "=", "personal")
        .executeTakeFirstOrThrow();
      if (row.ownerNameSetAt !== null || current.account) return false;
      const name = normalizePersonName(
        row.email === localMachineOwnerEmail ? (computerName ?? "") : row.displayName,
      );
      if (!name) return false;
      await write(transaction, current.ownerId, {
        ownerName: name,
        ownerNameAccount: null,
        ownerNameRevision: null,
      });
      return true;
    });
  }
}

async function ownerProfile(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  lock = false,
): Promise<OwnerProfile | null> {
  const row = await database
    .selectFrom("personalSettings")
    .select(["ownerId", "ownerName", "ownerNameAccount", "ownerNameRevision"])
    .where("singletonKey", "=", "personal")
    .$call((query) => (lock ? query.forUpdate() : query))
    .executeTakeFirst();
  if (!row) return null;
  // Stored before the canonical form existed: shown in it, never refused.
  const name = row.ownerName === null ? null : normalizePersonName(row.ownerName);
  return {
    ownerId: row.ownerId,
    name,
    account:
      row.ownerNameAccount && row.ownerNameRevision !== null && name !== null
        ? {
            issuer: row.ownerNameAccount.issuer,
            subject: row.ownerNameAccount.subject,
            revision: Number(row.ownerNameRevision),
          }
        : null,
  };
}

/** The Account link this Host may speak for its owner through: active, and not being unlinked. */
async function activeLink(transaction: Transaction<DatabaseSchema>) {
  const link = await transaction
    .selectFrom("personalRemoteAccountLink")
    .select(["accountOperation", "issuer", "linkGeneration", "state", "subject"])
    .where("singletonKey", "=", "opensteer-account")
    .executeTakeFirst();
  return link && link.state === "active" && link.accountOperation?.kind !== "unlink" ? link : null;
}

async function lockedProfile(transaction: Transaction<DatabaseSchema>): Promise<OwnerProfile> {
  const profile = await ownerProfile(transaction, true);
  if (!profile)
    throw new OpensteerError({ code: "conflict", message: "The hosting computer is not ready." });
  return profile;
}

async function write(
  transaction: Transaction<DatabaseSchema>,
  ownerId: UserId,
  values: {
    readonly ownerName: PersonName | null;
    readonly ownerNameAccount: OwnerNameAccount | null;
    readonly ownerNameRevision: string | null;
  },
): Promise<void> {
  const now = new Date();
  await transaction
    .updateTable("personalSettings")
    .set({ ...values, ownerNameSetAt: sql<Date>`coalesce(owner_name_set_at, ${now})` })
    .where("singletonKey", "=", "personal")
    .execute();
  const shown = values.ownerName ?? unnamedOwner;
  await transaction
    .updateTable("principals")
    .set({ displayName: shown, updatedAt: now })
    .where("kind", "=", "user")
    .where("userId", "=", ownerId)
    .execute();
  await transaction
    .updateTable("users")
    .set({ displayName: shown, updatedAt: now })
    .where("id", "=", ownerId)
    .execute();
}
