import { sql, type Kysely } from "kysely";

export const agentDirectoryMigrationName = "0047_agent_directory_verification";

export async function applyAgentDirectoryVerification(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table agent_directory_cache (
      issuer text primary key,
      document jsonb not null,
      accepted_at timestamptz not null
    );
    alter table agent_connections add column verification_withdrawn_at timestamptz;
  `.execute(database);
}
