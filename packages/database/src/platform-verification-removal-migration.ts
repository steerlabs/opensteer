import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const removePlatformVerificationMigrationName = "0056_remove_platform_verification_contract";

/**
 * A connected agent is verified only by the origin of its redirect address, listed in the signed
 * agent directory; nothing is verified "through a platform" any more. A connection consented to
 * that way keeps what it was verified by, the redirect address's origin and its directory entry,
 * and reads as verified by origin: that part of what was proven still holds. The one-use claims of
 * embedder assertions go, and the cached directory forgets its entries' signing keys and pairings,
 * which nothing reads.
 */
async function removePlatformVerification(database: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists agent_embedder_assertion_claims;
    update agent_connections set identity_at_consent = jsonb_build_object(
        'kind', 'platform',
        'platformOrigin', identity_at_consent->'platformOrigin',
        'platformDirectoryId', identity_at_consent->'platformDirectoryId',
        'platformName', identity_at_consent->'platformName',
        'directoryRevision', identity_at_consent->'directoryRevision',
        'recordedAt', identity_at_consent->'recordedAt')
      where identity_at_consent->>'kind' = 'platform-and-embedder';
    update agent_directory_cache set document = jsonb_set(document, '{entries}', coalesce((
        select jsonb_agg(entry - 'keys' - 'embedsVia' order by position)
        from jsonb_array_elements(document->'entries') with ordinality as listed(entry, position)
      ), '[]'::jsonb))
      where jsonb_typeof(document->'entries') = 'array';
  `.execute(database);
}

export const platformVerificationRemovalMigration: Readonly<Record<string, Migration>> = {
  [removePlatformVerificationMigrationName]: { up: removePlatformVerification },
};
