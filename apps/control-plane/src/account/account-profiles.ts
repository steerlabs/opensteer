import {
  AccountDeploymentAccountLinkSchema,
  AccountProfileSchema,
  ControlPlaneAccountIdSchema,
  PersonProfileReceiptClaimsSchema,
  PersonProfileReceiptSchema,
  UpdateAccountProfileRequestSchema,
  UpdateAccountProfileResponseSchema,
  personProfileReceiptAudience,
  personProfileReceiptLifetimeSeconds,
  type AccountProfile,
  type ControlPlaneAccountId,
  type UpdateAccountProfileRequest,
  type UpdateAccountProfileResponse,
} from "@opensteer/control-plane-protocol";
import { normalizePersonName, personNameFromEmail } from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { requireCurrentAuthority, type HostAuthority } from "../database/store.js";
import { ControlPlaneError } from "../server/errors.js";
import { personalReachability } from "./personal-host-proof.js";

type Database = Kysely<ControlPlaneDatabaseSchema> | Transaction<ControlPlaneDatabaseSchema>;

type ProfileRow = {
  readonly displayName: string;
  readonly email: string;
  readonly nameRevision: string;
};
type Written = { readonly applied: boolean; readonly row: ProfileRow };

/** Signs a JWT with Account's Better Auth key; bound after the auth instance exists. */
export type AccountJwtSigner = (payload: Record<string, unknown>) => Promise<string>;

/**
 * The one writer of a person's shared name. Every change bumps `name_revision` in the same
 * statement that checks the caller saw the current one, and every answer carries a signed receipt
 * a client relays to the copies Account cannot reach (team servers).
 */
export class AccountProfiles {
  readonly #database: Kysely<ControlPlaneDatabaseSchema>;
  readonly #issuer: string;
  readonly #sign: AccountJwtSigner;

  constructor(input: {
    readonly database: Kysely<ControlPlaneDatabaseSchema>;
    readonly issuer: URL;
    readonly sign: AccountJwtSigner;
  }) {
    this.#database = input.database;
    this.#issuer = input.issuer.origin;
    this.#sign = input.sign;
  }

  async read(accountIdInput: ControlPlaneAccountId): Promise<AccountProfile> {
    const accountId = ControlPlaneAccountIdSchema.parse(accountIdInput);
    return this.#profile(accountId, await this.#row(this.#database, accountId));
  }

  async update(
    accountIdInput: ControlPlaneAccountId,
    request: UpdateAccountProfileRequest,
  ): Promise<UpdateAccountProfileResponse> {
    const accountId = ControlPlaneAccountIdSchema.parse(accountIdInput);
    return this.#answer(accountId, await this.#write(this.#database, accountId, request));
  }

  /** The owner of the personal Host holding `authority`, while its Account link is active. */
  async readHostOwner(authority: HostAuthority): Promise<AccountProfile> {
    const { accountId, row } = await this.#database.transaction().execute(async (transaction) => {
      const accountId = await this.#hostOwner(transaction, authority);
      return { accountId, row: await this.#row(transaction, accountId) };
    });
    return this.#profile(accountId, row);
  }

  /** The authority fence holds through the write, so a Host unlinked meanwhile renames no one. */
  async updateHostOwner(
    authority: HostAuthority,
    request: UpdateAccountProfileRequest,
  ): Promise<UpdateAccountProfileResponse> {
    const { accountId, written } = await this.#database
      .transaction()
      .execute(async (transaction) => {
        const accountId = await this.#hostOwner(transaction, authority);
        return { accountId, written: await this.#write(transaction, accountId, request) };
      });
    return this.#answer(accountId, written);
  }

  async #write(
    database: Database,
    accountId: ControlPlaneAccountId,
    requestInput: UpdateAccountProfileRequest,
  ): Promise<Written> {
    const request = UpdateAccountProfileRequestSchema.parse(requestInput);
    const written = await database
      .updateTable("users")
      .set({
        displayName: request.name,
        nameRevision: sql<string>`name_revision + 1`,
        updatedAt: new Date(),
      })
      .where("id", "=", accountId)
      .where("nameRevision", "=", String(request.expectedRevision))
      .where("displayName", "!=", request.name)
      .returning(["displayName", "email", "nameRevision"])
      .executeTakeFirst();
    const row = written ?? (await this.#row(database, accountId));
    // Asking for the name that is already current is done, whoever saved it.
    return { applied: written !== undefined || row.displayName === request.name, row };
  }

  async #answer(
    accountId: ControlPlaneAccountId,
    written: Written,
  ): Promise<UpdateAccountProfileResponse> {
    return UpdateAccountProfileResponseSchema.parse({
      applied: written.applied,
      profile: await this.#profile(accountId, written.row),
    });
  }

  async #hostOwner(
    transaction: Transaction<ControlPlaneDatabaseSchema>,
    authority: HostAuthority,
  ): Promise<ControlPlaneAccountId> {
    const candidate = await transaction
      .selectFrom("deployments")
      .select("ownerAccountId")
      .where("id", "=", authority.deploymentId)
      .executeTakeFirst();
    if (!candidate)
      throw new ControlPlaneError("forbidden", "Only a linked personal Host has an owner");
    // Lock order: an Account's user row before its deployments, as Account deletion takes them.
    await transaction
      .selectFrom("users")
      .select("id")
      .where("id", "=", candidate.ownerAccountId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    await requireCurrentAuthority(transaction, authority);
    const deployment = await transaction
      .selectFrom("deployments")
      .select(["accountLink", "authorityEnvelope", "lifecycle", "ownerAccountId", "reachability"])
      .where("id", "=", authority.deploymentId)
      .executeTakeFirstOrThrow();
    const link = AccountDeploymentAccountLinkSchema.safeParse(deployment.accountLink);
    // Only a personal Host linked to its owner speaks for that person; a team never does.
    if (
      deployment.reachability !== personalReachability(deployment.authorityEnvelope) ||
      deployment.lifecycle !== "active" ||
      !link.success ||
      link.data.issuer !== this.#issuer ||
      link.data.subject !== deployment.ownerAccountId ||
      deployment.ownerAccountId !== candidate.ownerAccountId
    )
      throw new ControlPlaneError("forbidden", "Only a linked personal Host has an owner");
    return deployment.ownerAccountId;
  }

  async #row(database: Database, accountId: ControlPlaneAccountId) {
    const row = await database
      .selectFrom("users")
      .select(["displayName", "email", "nameRevision"])
      .where("id", "=", accountId)
      .executeTakeFirst();
    if (!row) throw new ControlPlaneError("unauthorized", "Account is unavailable");
    return row;
  }

  async #profile(
    accountId: ControlPlaneAccountId,
    row: { readonly displayName: string; readonly email: string; readonly nameRevision: string },
  ) {
    // Names stored before the canonical form existed are shown in it, never refused.
    const name = normalizePersonName(row.displayName) ?? personNameFromEmail(row.email);
    const revision = Number(row.nameRevision);
    return AccountProfileSchema.parse({
      name,
      revision,
      receipt: await this.#receipt({ accountId, name, revision }),
    });
  }

  async #receipt(input: {
    readonly accountId: ControlPlaneAccountId;
    readonly name: string;
    readonly revision: number;
  }) {
    const issuedAt = Math.floor(Date.now() / 1_000);
    return PersonProfileReceiptSchema.parse(
      await this.#sign(
        PersonProfileReceiptClaimsSchema.parse({
          tokenUse: personProfileReceiptAudience,
          iss: this.#issuer,
          aud: personProfileReceiptAudience,
          sub: input.accountId,
          iat: issuedAt,
          exp: issuedAt + personProfileReceiptLifetimeSeconds,
          name: input.name,
          revision: input.revision,
        }),
      ),
    );
  }
}
