import { createId, ModelSelectionSchema } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";

export async function seedPrivatePublisher(database: Kysely<DatabaseSchema>) {
  const personal = await seedPersonalFixture(database, "/tmp/private-publisher");
  const threadId = createId("thread");
  const runId = createId("run");
  const harnessInstanceId = createId("harnessInstance");
  const { id: principalId } = await database
    .selectFrom("principals")
    .select("id")
    .where("userId", "=", personal.userId)
    .executeTakeFirstOrThrow();
  const messageId = createId("message");
  const causalChainId = createId("causalChain");
  const modelSelection = ModelSelectionSchema.parse({
    modelId: "test-model",
    nativeModelId: "test-model",
    providerId: "test-provider",
    options: {},
  });
  await sql`insert into harness_instances(id,environment_id,driver_kind,name,config,runtime_revision,state_kind,enabled,is_default,source_id) values(${harnessInstanceId},${personal.environmentId},'codex','Codex','{}',1,'ready',true,true,'native')`.execute(
    database,
  );
  await sql`insert into threads(id,lineage_root_thread_id,purpose,parent_thread_id,listed,title,icon_source,color,environment_id,harness_instance_id,model_selection,created_by,created_by_principal_id) values(${threadId},${threadId},'task',null,true,'Publisher','default','blue',${personal.environmentId},${harnessInstanceId},${JSON.stringify(modelSelection)}::jsonb,${personal.userId},${principalId})`.execute(
    database,
  );
  await sql`insert into messages(id,thread_id,sequence,kind,actor_principal_id,author,content) values(${messageId},${threadId},1,'input',${principalId},'{}','{}')`.execute(
    database,
  );
  await sql`insert into causal_chains(id,max_delegations,max_autonomous_runs,root_message_id,used_delegations,used_autonomous_runs) values(${causalChainId},10,10,${messageId},0,0)`.execute(
    database,
  );
  await sql`insert into runs(id,thread_id,environment_id,harness_instance_id,model_selection,access_mode,activation_input_id,seed_input_id,causal_chain_id,requested_by,actor_principal_id,authority_source,run_ordinal,status) values(${runId},${threadId},${personal.environmentId},${harnessInstanceId},${JSON.stringify(modelSelection)}::jsonb,'full-access',${messageId},${messageId},${causalChainId},${personal.userId},${principalId},'{}',1,'running')`.execute(
    database,
  );
  return {
    ...personal,
    threadId,
    runId,
    harnessInstanceId,
    principalId,
    messageId,
    causalChainId,
    modelSelection,
  };
}
