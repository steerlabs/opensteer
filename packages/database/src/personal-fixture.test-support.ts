import { createId, type DeploymentId, type TaskFolder, type UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { testRunnerDescriptor } from "./runner-fixture.test-support.js";
import { initializePersonalSettings } from "./personal-settings-store.js";

export async function seedPersonalFixture(database: Kysely<DatabaseSchema>, path: string) {
  const deploymentId = createId("deployment");
  const hostInstanceId = createId("hostInstance");
  const userId = createId("user");
  await database.transaction().execute(async (transaction) => {
    await sql`insert into deployments(id,singleton_key,active_host_instance_id,canonical_origin,lifecycle,deployment_shape) values(${deploymentId},'primary',${hostInstanceId},'http://127.0.0.1:4310','active','{"kind":"personal"}')`.execute(
      transaction,
    );
    await sql`insert into users(id,display_name,email,email_verified) values(${userId},'Alex','alex@example.invalid',true)`.execute(
      transaction,
    );
    await seedPersonalOwnerResources(transaction, { deploymentId, userId, path });
  });
  const settings = await database
    .selectFrom("personalSettings")
    .selectAll()
    .executeTakeFirstOrThrow();
  const environment = await database
    .selectFrom("executionEnvironments")
    .select("id")
    .where("runnerId", "=", settings.agentHomeComputerId)
    .executeTakeFirstOrThrow();
  return {
    deploymentId,
    hostInstanceId,
    userId,
    runnerId: settings.agentHomeComputerId,
    environmentId: environment.id,
    agentHome: { computerId: settings.agentHomeComputerId, path } satisfies TaskFolder,
  };
}

export async function seedPersonalOwnerResources(
  database: Kysely<DatabaseSchema>,
  input: { readonly deploymentId: DeploymentId; readonly userId: UserId; readonly path: string },
) {
  const runnerId = createId("runner");
  const environmentId = createId("environment");
  const agentHome: TaskFolder = { computerId: runnerId, path: input.path };
  const descriptor = testRunnerDescriptor({
    runnerId,
    environmentId,
    name: "Hosting computer",
    runnerKind: "main",
  });
  await sql`insert into runners(id,owner_kind,owner_user_id,name,kind,public_key_pem,public_key_fingerprint,enrollment_token_hash,capabilities,allowed_modules,module_descriptors,access_policy,access_policy_revision,connection_generation,max_concurrent_runs) values(${runnerId},'deployment',null,'Hosting computer','main','test-public-key','test-fingerprint','test-enrollment',${JSON.stringify(descriptor.capabilities)},'["agents"]',${JSON.stringify(descriptor.modules)},'{"reach":"nobody","commands":false,"forwarding":false,"shares":[]}',0,1,4)`.execute(
    database,
  );
  await sql`insert into execution_environments(id,name,kind,runner_id,capabilities) values(${environmentId},'Hosting computer','main',${runnerId},'[]')`.execute(
    database,
  );
  await initializePersonalSettings(database, input.userId, agentHome);
  await sql`insert into deployment_event_state(deployment_id,sequence) values(${input.deploymentId},0) on conflict (deployment_id) do nothing`.execute(
    database,
  );
  return { runnerId, environmentId, agentHome };
}
