import { MigrationLineageError } from "@opensteer/database";

/** Recreates the local database `pnpm setup:local` made, which every checkout here shares. */
const developmentDatabaseReset =
  "docker compose -f deploy/compose/compose.yaml down -v && pnpm setup:local";

/**
 * Adds the reset to a development database another checkout's lineage migrated.
 * Only development offers it: elsewhere the database holds data to keep.
 */
export function withDevelopmentDatabaseReset(error: unknown): unknown {
  if (!(error instanceof MigrationLineageError)) return error;
  return new Error(`${error.message} Reset the development database: ${developmentDatabaseReset}`, {
    cause: error,
  });
}
