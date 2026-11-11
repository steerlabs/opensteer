import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { createDatabase } from "./connection.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";

export async function createTeamFixture() {
  const clone = await cloneTestDatabase("host");
  try {
    const { database } = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({ connectionString: clone.url });
      return { database, close: () => database.destroy() };
    });
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const userId = createId("user");
    await database.transaction().execute(async (transaction) => {
      await sql`insert into team_access_state(singleton_key,revision,directory_revision) values('team',0,0)`.execute(
        transaction,
      );
      await sql`insert into deployments(id,singleton_key,active_host_instance_id,canonical_origin,lifecycle,deployment_shape) values(${deploymentId},'primary',${hostInstanceId},'https://team.example.invalid','active','{"kind":"team"}')`.execute(
        transaction,
      );
      await sql`insert into users(id,display_name,email,email_verified) values(${userId},'Maya','maya@example.invalid',true)`.execute(
        transaction,
      );
      await sql`insert into team_members(user_id,handle,role,state,joined_at,changed_at) values(${userId},'maya','owner','active',now(),now())`.execute(
        transaction,
      );
    });
    return Object.freeze({
      database,
      databaseUrl: clone.url,
      deploymentId,
      hostInstanceId,
      userId,
      close: clone.drop,
    });
  } catch (error) {
    await clone.drop();
    throw error;
  }
}
