import { sql, type Kysely } from "kysely";

export const agentDirectoryMigrationName = "0047_agent_directory_verification";

export async function applyAgentDirectoryVerification(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table agent_directory_cache (
      issuer text primary key,
      document jsonb not null,
      accepted_at timestamptz not null
    );
    create table agent_embedder_assertion_claims (
      issuer text not null,
      statement_id text not null,
      expires_at timestamptz not null,
      primary key (issuer, statement_id)
    );
    create index agent_embedder_assertion_claims_expiry
      on agent_embedder_assertion_claims (expires_at);
    alter table agent_connections add column verification_withdrawn_at timestamptz;
  `.execute(database);
}
