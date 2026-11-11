import { createId, type TaskFolder } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function seedPersonalFixture(database: Kysely<DatabaseSchema>, path: string) {
  const deploymentId = createId("deployment");
  const hostInstanceId = createId("hostInstance");
  const userId = createId("user");
  const runnerId = createId("runner");
  const environmentId = createId("environment");
  const agentHome: TaskFolder = { computerId: runnerId, path };
  await database.transaction().execute(async (transaction) => {
    await sql`insert into deployments(id,singleton_key,active_host_instance_id,canonical_origin,lifecycle,deployment_shape) values(${deploymentId},'primary',${hostInstanceId},'http://127.0.0.1:4310','active','{"kind":"personal"}')`.execute(
      transaction,
    );
    await sql`insert into users(id,display_name,email,email_verified) values(${userId},'Alex','alex@example.invalid',true)`.execute(
      transaction,
    );
    await sql`insert into runners(id,owner_kind,owner_user_id,name,kind,public_key_pem,public_key_fingerprint,enrollment_token_hash,capabilities,allowed_modules,module_descriptors,access_policy,access_policy_revision,connection_generation,max_concurrent_runs) values(${runnerId},'deployment',null,'Hosting computer','main','test-public-key','test-fingerprint','test-enrollment','[]','["agents"]','{}','{"reach":"nobody","commands":false,"forwarding":false,"shares":[]}',0,1,4)`.execute(
      transaction,
    );
    await sql`insert into execution_environments(id,name,kind,runner_id,capabilities) values(${environmentId},'Hosting computer','main',${runnerId},'[]')`.execute(
      transaction,
    );
    await sql`insert into personal_settings(singleton_key,owner_id,agent_home_computer_id,agent_home_path,voice_thread_id,time_zone,quiet_task_days,execution_preferences,background_model_preferences) values('personal',${userId},${runnerId},${path},null,'UTC',0,'{}','{}')`.execute(
      transaction,
    );
    await sql`insert into deployment_event_state(deployment_id,sequence) values(${deploymentId},0)`.execute(
      transaction,
    );
  });
  return { deploymentId, hostInstanceId, userId, runnerId, environmentId, agentHome };
}
