import { sql } from "kysely";
import { expect, test } from "vitest";
import {
  createId,
  RequestSchema,
  TeamMessageIdSchema,
  TeamSourceSchema,
} from "../packages/core/src/index.js";
import { TranscriptItemBodySchema } from "../packages/protocol/src/transcript.js";
import {
  createDatabase,
  migrateToLatest,
  migrationProvider,
} from "../packages/database/src/index.js";
import { requestInsert } from "../packages/database/src/request-persistence.js";
import { seedPersonalFixture } from "../packages/database/src/personal-fixture.test-support.js";
import {
  liveRequest,
  testModelSelection,
} from "../packages/database/src/store.integration.test-support.js";
import { cloneTestDatabase } from "../packages/database/src/test-database.test-support.js";
import {
  readTranscriptItem,
  readTranscriptPage,
} from "../packages/database/src/personal-sync-store.js";
import { transcriptCard } from "../packages/client/src/host/transcript-item-view.js";

test("preserves message bodies, Request outcomes and Team delivery from a real 0029 database", async () => {
  const fixture = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: fixture.url });
  try {
    await sql`drop schema public cascade; create schema public`.execute(database);
    await migrateToLatest(database, {
      async getMigrations() {
        const migrations = await migrationProvider().getMigrations();
        return Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0030"));
      },
    });
    const migrations = await sql<{
      name: string;
    }>`select name from kysely_migration order by name desc limit 1`.execute(database);
    expect(migrations.rows).toEqual([{ name: "0029_changed_since_indexes" }]);

    const owner = await seedPersonalFixture(database, "/fixture/agent-home");
    const { id: principalId } = await database
      .selectFrom("principals")
      .select("id")
      .where("userId", "=", owner.userId)
      .executeTakeFirstOrThrow();
    const threadId = createId("thread");
    const runId = createId("run");
    const harnessId = createId("harnessInstance");
    const chainId = createId("causalChain");
    const seedId = createId("message");
    const answerId = createId("message");
    const mixedId = createId("message");
    const linesId = createId("message");
    const uncertainId = createId("message");
    const requestId = createId("request");
    const teamRequestId = createId("teamAgentRequest");
    const teamSource = TeamSourceSchema.parse({
      teamId: createId("deployment"),
      channelId: createId("teamChannel"),
      threadRootId: TeamMessageIdSchema.parse("42"),
      messageId: TeamMessageIdSchema.parse("43"),
      audience: {
        teamName: "Fixture Team",
        channelName: "General",
        channelKind: "public",
        memberCount: 3,
        peopleOnly: false,
      },
    });
    const replyTarget = {
      kind: "team-thread",
      teamId: teamSource.teamId,
      channelId: teamSource.channelId,
      threadRootId: teamSource.threadRootId,
      requestId: teamRequestId,
    };
    const model = JSON.stringify(testModelSelection);
    const authority = JSON.stringify({ kind: "user-session", userId: owner.userId });
    const human = JSON.stringify({
      kind: "human",
      displayName: "Alex",
      principalId,
      userId: owner.userId,
    });
    const request = RequestSchema.parse({
      ...liveRequest({
        harnessInstanceId: harnessId,
        id: requestId,
        requestedBy: owner.userId,
        runId,
        threadId,
        presentation: {
          kind: "choice",
          title: "Continue work?",
          options: [{ id: "allow", label: "Go ahead", hint: "allow-once" }],
        },
      }),
      status: "fulfilled",
      resolvedAt: "2026-11-17T19:00:02.000Z",
      createdAt: "2026-11-17T19:00:00.000Z",
      resolvedBy: owner.userId,
      response: { kind: "choice", optionId: "allow" },
    });
    const attachment = {
      type: "artifact",
      artifactId: "fixture-file",
      name: "Notes.txt",
      mediaType: "text/plain",
    };
    const long = "Follow-up from the team. ".repeat(85).trim();
    await database.transaction().execute(async (tx) => {
      await sql`insert into harness_instances(id,environment_id,driver_kind,name,config,runtime_revision,state_kind,enabled,is_default,source_id)
        values(${harnessId},${owner.environmentId},'native','Fixture','{}',1,'isolated',true,true,'fixture');
        `.execute(tx);
      await sql`insert into threads(id,lineage_root_thread_id,listed,title,icon_source,color,purpose,
        environment_id,harness_instance_id,model_selection,created_by,created_by_principal_id,next_message_sequence,next_run_ordinal)
        values(${threadId},${threadId},true,'Team task','provisional','slate','task',${owner.environmentId},
          ${harnessId},${model}::jsonb,${owner.userId},${principalId},6,2)`.execute(tx);
      await sql`insert into messages(id,thread_id,sequence,kind,actor_principal_id,author,content)
        values(${seedId},${threadId},1,'input',${principalId},${human}::jsonb,'[{"type":"text","text":"The ask"}]')`.execute(
        tx,
      );
      await sql`insert into causal_chains(id,max_delegations,max_autonomous_runs,used_delegations,used_autonomous_runs,root_message_id)
        values(${chainId},4,4,0,0,${seedId})`.execute(tx);
      await sql`insert into runs(id,thread_id,environment_id,activation_input_id,causal_chain_id,
        access_mode,harness_instance_id,model_selection,reply_target,requested_by,actor_principal_id,
        authority_source,run_ordinal,seed_input_id,status,completed_at,input_tokens,output_tokens)
        values(${runId},${threadId},${owner.environmentId},${seedId},${chainId},'full-access',
          ${harnessId},${model}::jsonb,${JSON.stringify(replyTarget)}::jsonb,${owner.userId},${principalId},
          ${authority}::jsonb,1,${seedId},'completed',${request.resolvedAt},15,25)`.execute(tx);
      const agent = JSON.stringify({ kind: "agent", displayName: "Opensteer", runId, threadId });
      await sql`insert into messages(id,thread_id,run_id,sequence,kind,actor_principal_id,author,content) values
        (${answerId},${threadId},${runId},2,'assistant',${principalId},${agent}::jsonb,${JSON.stringify([attachment])}::jsonb),
        (${mixedId},${threadId},${runId},3,'input',${principalId},${human}::jsonb,${JSON.stringify([{ type: "text", text: "See this" }, attachment])}::jsonb),
        (${linesId},${threadId},${runId},4,'input',${principalId},${human}::jsonb,'[{"type":"text","text":"First"},{"type":"text","text":"Second"}]'),
        (${uncertainId},${threadId},${runId},5,'input',${principalId},${human}::jsonb,${JSON.stringify([{ type: "text", text: long }])}::jsonb)`.execute(
        tx,
      );
      await sql`insert into thread_inputs(message_id,thread_id,run_id,actor_principal_id,authority_source,
          causal_chain_id,idempotency_key,policy,queue_rank,request_fingerprint,requested_by,state,team_source)
        values(${seedId},${threadId},${runId},${principalId},${authority}::jsonb,${chainId},'fixture:ask',
            'queue',1,'fingerprint',${owner.userId},'delivered',null),
          (${uncertainId},${threadId},${runId},${principalId},${authority}::jsonb,${chainId},'fixture:steer',
            'steer',2,'fingerprint',${owner.userId},'unknown',${JSON.stringify(teamSource)}::jsonb)`.execute(
        tx,
      );
      const { originatingWatchActivationId: _watch, ...legacyRequest } = requestInsert(request);
      await tx.insertInto("requests").values(legacyRequest).execute();
      await sql`insert into personal_team_links(id,team_deployment_id,team_host_instance_id,host_key_fingerprint,
        approved_origin,authority_envelope,state)
        values(${createId("teamLink")},${teamSource.teamId},${createId("hostInstance")},'fixture',
          'https://team.example.invalid','{}','active')`.execute(tx);
      await sql`insert into personal_team_requests(team_deployment_id,request_id,trigger_message_id,local_task_id,
        local_input_id,run_id,publication_state,source,answer_message_id,delivery_via,blocked_reason)
        values(${teamSource.teamId},${teamRequestId},43,${threadId},${seedId},${runId},'blocked',
          ${JSON.stringify(teamSource)}::jsonb,${answerId},'final','Link revoked')`.execute(tx);
      await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data)
        values(${owner.deploymentId},1,${createId("event")},${threadId},${runId},${owner.environmentId},
          'run.completed',jsonb_build_object('replyMessageId',${answerId}::text))`.execute(tx);
      await sql`update deployment_event_state set sequence=1 where deployment_id=${owner.deploymentId}`.execute(
        tx,
      );
    });

    await migrateToLatest(database);
    const relation = await sql`select to_regclass('deployment_events') as ledger`.execute(database);
    expect(relation.rows).toEqual([{ ledger: null }]);
    const scope = { kind: "thread" as const, threadId };
    const page = await readTranscriptPage(database, { scope, viewerId: owner.userId });
    if (page.kind !== "page") throw new Error("The migrated task has no transcript");
    const item = (id: string) => page.items.find((row) => row.id === id)!;
    const card = (id: string) => transcriptCard(item(id));
    const hydrate = async (id: string) => {
      const result = await readTranscriptItem(database, {
        scope,
        viewerId: owner.userId,
        itemId: id,
      });
      if (result.kind !== "item") throw new Error("Missing message body");
      return transcriptCard(item(id), TranscriptItemBodySchema.parse(result.body));
    };
    // The converter and the live path draw the same card: references ride on it, so an
    // attachment that fits does not mark the preview cut.
    expect(card(answerId)).toMatchObject({
      body: "",
      previewTruncated: false,
      attachments: [attachment],
    });
    expect(await hydrate(answerId)).toMatchObject({ attachments: [attachment], body: "" });
    expect(card(mixedId)).toMatchObject({
      body: "See this",
      previewTruncated: false,
      attachments: [attachment],
    });
    expect(await hydrate(mixedId)).toMatchObject({ attachments: [attachment], body: "See this" });
    expect(card(linesId)).toMatchObject({ body: "First\nSecond", previewTruncated: false });
    expect(card(uncertainId)).toMatchObject({
      messageKind: "input",
      body: long,
      previewTruncated: false,
      delivery: { status: "unconfirmed" },
      teamSource,
    });
    expect(await hydrate(uncertainId)).toMatchObject({
      body: long,
      delivery: { status: "unconfirmed" },
      teamSource,
      runId,
    });
    expect(card(`request:${requestId}`)).toMatchObject({
      requestKind: "harness.input",
      outcome: "Fulfilled · Go ahead",
      waitedSince: request.createdAt,
    });
    expect(card(`run:${runId}`)).toMatchObject({
      replyMessageId: answerId,
      endedAt: request.resolvedAt,
      usage: { inputTokens: 15, outputTokens: 25 },
      delivery: {
        state: "blocked",
        via: "final",
        reason: "Link revoked",
        answerMessageId: answerId,
      },
    });
  } finally {
    await database.destroy();
    await fixture.drop();
  }
});
