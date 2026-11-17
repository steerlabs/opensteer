import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "@opensteer/database";
import type { AesGcmSecretVault } from "@opensteer/access";
import type { UserId } from "@opensteer/core";
import type { z } from "zod";

export class PluginOAuthStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly vault: AesGcmSecretVault;
  constructor(database: Kysely<DatabaseSchema>, vault: AesGcmSecretVault) {
    this.database = database;
    this.vault = vault;
  }
  async read<S extends z.ZodType>(
    id: string,
    owner: UserId,
    schema: S,
  ): Promise<z.infer<S> | null> {
    const result = await sql<{
      encryptedPayload: Buffer;
    }>`select encrypted_payload from plugin_oauth_records where id = ${id} and owner_user_id = ${owner}`.execute(
      this.database,
    );
    const row = result.rows[0];
    if (!row) return null;
    const value = await this.vault.open(row.encryptedPayload, this.context(id, owner));
    return schema.parse(JSON.parse(value.value ?? "null"));
  }
  async save(
    id: string,
    owner: UserId,
    value: unknown,
    expiresAt: string | null = null,
    insert = false,
  ) {
    const sealed = await this.vault.seal({ value: JSON.stringify(value) }, this.context(id, owner));
    if (insert) {
      await sql`insert into plugin_oauth_records (id, owner_user_id, expires_at, encrypted_payload) values (${id}, ${owner}, ${expiresAt}, ${sealed.envelope}) on conflict (id) do nothing`.execute(
        this.database,
      );
    } else {
      await sql`insert into plugin_oauth_records (id, owner_user_id, expires_at, encrypted_payload) values (${id}, ${owner}, ${expiresAt}, ${sealed.envelope}) on conflict (id) do update set encrypted_payload = excluded.encrypted_payload, expires_at = excluded.expires_at where plugin_oauth_records.owner_user_id = excluded.owner_user_id`.execute(
        this.database,
      );
    }
  }
  async savePending(id: string, owner: UserId, value: unknown) {
    const sealed = await this.vault.seal({ value: JSON.stringify(value) }, this.context(id, owner));
    const result =
      await sql`update plugin_oauth_records set encrypted_payload = ${sealed.envelope} where id = ${id} and owner_user_id = ${owner} and begun_at is null returning id`.execute(
        this.database,
      );
    return result.rows.length === 1;
  }
  async claimBegin(id: string, owner: UserId) {
    const result =
      await sql`update plugin_oauth_records set begun_at = clock_timestamp() where id = ${id} and owner_user_id = ${owner} and begun_at is null returning id`.execute(
        this.database,
      );
    return result.rows.length === 1;
  }
  async remove(id: string, owner: UserId) {
    await sql`delete from plugin_oauth_records where id = ${id} and owner_user_id = ${owner}`.execute(
      this.database,
    );
  }
  private context(id: string, owner: UserId) {
    return { purpose: "plugin-oauth", recordId: id, scope: `user:${owner}` };
  }
}
