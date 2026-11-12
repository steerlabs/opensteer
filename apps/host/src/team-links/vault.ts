import { AesGcmCredentialVault } from "@opensteer/access/host";
import { createId, type DeploymentId, type UserId } from "@opensteer/core";
import {
  TeamLinkCredentialSchema,
  TeamLinkOfferSchema,
  type TeamLinkOffer,
} from "@opensteer/protocol";
import type { DatabaseSchema } from "@opensteer/database";
import type { PersonalTeamCredential } from "@opensteer/database/personal-team-links-store";
import { sql, type Kysely } from "kysely";
import { randomBytes } from "node:crypto";
import { linkError } from "../team-link-endpoint/contracts.js";

const provider = "team-link";
export class PersonalTeamVault {
  readonly #vault: AesGcmCredentialVault;
  readonly #database: Kysely<DatabaseSchema>;
  readonly #ownerId: UserId;
  constructor(vault: AesGcmCredentialVault, database: Kysely<DatabaseSchema>, ownerId: UserId) {
    this.#vault = vault;
    this.#database = database;
    this.#ownerId = ownerId;
  }

  async prepare(
    offer: TeamLinkOffer,
  ): Promise<{ readonly credential: PersonalTeamCredential; readonly secret: string }> {
    const id = createId("credential");
    const secret = `ost_link_${randomBytes(32).toString("base64url")}`;
    const sealed = await this.#vault.seal(
      { secret, offer: JSON.stringify(offer) },
      { credentialId: id, ownerId: this.#ownerId, provider },
    );
    const now = new Date().toISOString();
    return {
      secret,
      credential: {
        id,
        ownerId: this.#ownerId,
        name: "Opensteer team link",
        provider,
        encryptedPayload: sealed.envelope,
        encryptionKeyVersion: sealed.keyVersion,
        metadata: { teamId: offer.teamId },
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  async open(reference: string, teamId: DeploymentId) {
    const row = await this.#database
      .selectFrom("credentials")
      .selectAll()
      .where(sql<string>`id`, "=", reference)
      .where("ownerId", "=", this.#ownerId)
      .where("provider", "=", provider)
      .executeTakeFirst();
    if (!row) throw linkError();
    const contents = await this.#vault.open(row.encryptedPayload, {
      credentialId: row.id,
      ownerId: this.#ownerId,
      provider,
    });
    const offer = TeamLinkOfferSchema.parse(JSON.parse(contents.offer ?? "null"));
    if (offer.teamId !== teamId) throw linkError();
    return { secret: TeamLinkCredentialSchema.parse(contents.secret), offer };
  }
}
