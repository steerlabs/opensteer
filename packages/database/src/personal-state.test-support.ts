import type { DatabaseSchema } from "./schema.js";
import { sql } from "kysely";
import { createDatabase } from "./connection.js";
import { applyPersonalStateSchema } from "./personal-state-schema.js";
import { createStoreFixture } from "./store.integration.test-support.js";
import { ownTestDatabaseProducer } from "./test-database.test-support.js";

export async function createPersonalStateFixture(suffix: string) {
  const fixture = await createStoreFixture();
  try {
    const run = await fixture.startRunFixture(suffix);
    await fixture.database.transaction().execute(applyPersonalStateSchema);
    await sql`update client_sync_state set ready=true,pruned_through_sequence=sequence`.execute(
      fixture.database,
    );
    const { database } = await ownTestDatabaseProducer(fixture.databaseUrl, async () => {
      const database = createDatabase<DatabaseSchema>({
        connectionString: fixture.databaseUrl,
      });
      return { database, close: () => database.destroy() };
    });
    const attempt = await database
      .selectFrom("runAttempts")
      .select("id")
      .where("runId", "=", run.runId)
      .where("status", "=", "current")
      .limit(1)
      .executeTakeFirstOrThrow();
    return { ...fixture, database, run, attemptId: attempt.id };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
