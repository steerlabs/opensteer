import { createDatabase, OpensteerStore, TabStore, type DatabaseSchema } from "@opensteer/database";
import { personalFixtureOwner } from "@opensteer/database/test-support/personal-run";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";

export async function tabDatabaseFixture() {
  const clone = await cloneTestDatabase("host");
  const { database, legacy } = await ownTestDatabaseProducer(clone.url, async () => {
    const database = createDatabase<DatabaseSchema>({ connectionString: clone.url });
    const legacy = createDatabase({ connectionString: clone.url });
    return {
      database,
      legacy,
      close: async () => {
        await database.destroy();
        await legacy.destroy();
      },
    };
  });
  const personal = await personalFixtureOwner(legacy, clone.url);
  return {
    ...personal,
    ownerId: personal.userId,
    database,
    legacy,
    tabs: new TabStore(database),
    store: new OpensteerStore(legacy),
  };
}
