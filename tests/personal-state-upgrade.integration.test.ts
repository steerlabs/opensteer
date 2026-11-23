import { sql } from "kysely";
import { expect, test } from "vitest";
import { createId, RequestSchema, TeamMessageIdSchema } from "../packages/core/src/index.js";
import { TranscriptItemBodySchema } from "../packages/protocol/src/transcript.js";
import {
  createDatabase,
  migrateToLatest,
  migrationProvider,
} from "../packages/database/src/index.js";
import { commandRequestsMigrationName } from "../packages/database/src/migrations.js";
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
import { runProviderRetryMigrationName } from "../packages/database/src/personal-state-schema.js";
import { agentGrantsMigrationName } from "../packages/database/src/agent-grants-migration.js";
import { agentSessionsMigrationName } from "../packages/database/src/agent-sessions-migration.js";
import { agentDirectoryMigrationName } from "../packages/database/src/agent-directory-migration.js";
import { workHomeMigrationName } from "../packages/database/src/work-home-migration.js";
import { browserPoolMigrationName } from "../packages/database/src/browser-pool-migration.js";
import { bridgeConnectionsMigrationName } from "../packages/database/src/bridge-connections-migration.js";
import { chatRoutesEndMigrationName } from "../packages/database/src/chat-routes-end-migration.js";
import { OpensteerStore } from "../packages/database/src/store.js";
import { AgentConnectionStore } from "../packages/database/src/agent-connection-store.js";
import { TabStore } from "../packages/database/src/tab-store.js";
import { runFromRow } from "../packages/database/src/thread-row-mappers.js";

test("preserves message bodies and Request outcomes from a real 0029 database, and leaves its team delivery out", async () => {
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
    // A team ask's source and delivery, as a Home that served teams stored them.
    const teamSource = {
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
    };
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
      await sql`insert into requests(id,kind,mode,status,originating_thread_id,originating_run_id,
        call_id,requested_by,required_actor,presentation,payload,response,resolved_at,resolved_by,created_at)
        values(${request.id},${request.kind},${request.mode},${request.status},${threadId},${runId},
          ${request.callId},${request.requestedBy},${request.requiredActor},${JSON.stringify(request.presentation)}::jsonb,
          ${JSON.stringify(request.payload)}::jsonb,${JSON.stringify(request.response)}::jsonb,
          ${request.resolvedAt},${request.resolvedBy},${request.createdAt})`.execute(tx);
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
    });
    expect(card(uncertainId)).not.toHaveProperty("teamSource");
    const hydrated = await hydrate(uncertainId);
    expect(hydrated).toMatchObject({
      body: long,
      delivery: { status: "unconfirmed" },
      runId,
    });
    expect(hydrated).not.toHaveProperty("teamSource");
    expect(card(`request:${requestId}`)).toMatchObject({
      requestKind: "harness.input",
      outcome: "Fulfilled · Go ahead",
      waitedSince: request.createdAt,
    });
    expect(card(`run:${runId}`)).toMatchObject({
      replyMessageId: answerId,
      endedAt: request.resolvedAt,
      usage: { inputTokens: 15, outputTokens: 25 },
    });
    expect(card(`run:${runId}`)).not.toHaveProperty("delivery");
  } finally {
    await database.destroy();
    await fixture.drop();
  }
});

test("carries a person's work from a database the released Home last migrated through this lineage's migrations", async () => {
  const fixture = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: fixture.url });
  try {
    await sql`drop schema public cascade; create schema public`.execute(database);
    // The released lineage ends at main's newest migration; everything after it is this one's.
    const all = await migrationProvider().getMigrations();
    const names = Object.keys(all);
    const released = names.filter((name) => name <= runProviderRetryMigrationName);
    expect(names.filter((name) => name > runProviderRetryMigrationName)).toEqual([
      agentGrantsMigrationName,
      agentSessionsMigrationName,
      "0102_chrome_live_tabs_source",
      agentDirectoryMigrationName,
      "0104_shared_chrome_grants",
      workHomeMigrationName,
      browserPoolMigrationName,
      "0107_needs_you_counts_requests",
      bridgeConnectionsMigrationName,
      chatRoutesEndMigrationName,
      commandRequestsMigrationName,
      "0113_automations_contract",
      "0114_thread_inputs_written_by_connection",
      "0115_provider_session_person_lineage",
    ]);
    await migrateToLatest(database, {
      async getMigrations() {
        return Object.fromEntries(Object.entries(all).filter(([name]) => released.includes(name)));
      },
    });
    const applied = async () =>
      (
        await sql<{ name: string }>`select name from kysely_migration order by name`.execute(
          database,
        )
      ).rows.map(({ name }) => name);
    expect(await applied()).toEqual(released);

    // Rows as the released Home writes them, in the columns its schema has.
    const owner = await seedPersonalFixture(database, "/fixture/agent-home");
    const { id: principalId } = await database
      .selectFrom("principals")
      .select("id")
      .where("userId", "=", owner.userId)
      .executeTakeFirstOrThrow();
    const harnessId = createId("harnessInstance");
    const connectionId = `mcn_${crypto.randomUUID()}`;
    const ownThreadId = createId("thread");
    const sentThreadId = createId("thread");
    const seedId = createId("message");
    const answerId = createId("message");
    const sentId = createId("message");
    const chainId = createId("causalChain");
    const sentChainId = createId("causalChain");
    const runId = createId("run");
    const sentRunId = createId("run");
    const requestId = createId("request");
    const profileId = createId("browserProfile");
    const sessionId = `bsn_${crypto.randomUUID()}`;
    const openTabId = createId("tab");
    const closedTabId = createId("tab");
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
        threadId: ownThreadId,
        presentation: {
          kind: "choice",
          title: "Book the flight?",
          options: [{ id: "allow", label: "Book it", hint: "allow-once" }],
        },
      }),
      status: "fulfilled",
      resolvedAt: "2026-11-19T09:00:02.000Z",
      createdAt: "2026-11-19T09:00:00.000Z",
      resolvedBy: owner.userId,
      response: { kind: "choice", optionId: "allow" },
    });
    const page = (surface: string) =>
      JSON.stringify({ lineageId: sessionId, sessionId, surfaceId: `surface_${surface}` });
    await database.transaction().execute(async (tx) => {
      await sql`insert into harness_instances(id,environment_id,driver_kind,name,config,runtime_revision,state_kind,enabled,is_default,source_id)
        values(${harnessId},${owner.environmentId},'codex','Codex','{}',1,'ready',true,true,'native')`.execute(
        tx,
      );
      await sql`insert into agent_connections(id,user_id,label,client_name,access_mode,resource,token_hash,expires_at,last_used_at)
        values(${connectionId},${owner.userId},'Laptop agent','Agent','auto','https://h.example/internal/v1/mcp',
          'hash',now() + interval '30 days',now())`.execute(tx);
      await sql`insert into threads(id,lineage_root_thread_id,listed,title,icon_source,color,purpose,
        environment_id,harness_instance_id,model_selection,created_by,created_by_principal_id,next_message_sequence,next_run_ordinal)
        values(${ownThreadId},${ownThreadId},true,'Plan the trip','provisional','blue','task',${owner.environmentId},
          ${harnessId},${model}::jsonb,${owner.userId},${principalId},3,2),
        (${sentThreadId},${sentThreadId},true,'Sort the inbox','provisional','blue','task',${owner.environmentId},
          ${harnessId},${model}::jsonb,${owner.userId},${principalId},2,1)`.execute(tx);
      await sql`insert into messages(id,thread_id,sequence,kind,actor_principal_id,author,content)
        values(${seedId},${ownThreadId},1,'input',${principalId},${human}::jsonb,'[{"type":"text","text":"Find flights to Lisbon"}]'),
          (${sentId},${sentThreadId},1,'input',${principalId},${human}::jsonb,'[{"type":"text","text":"Sort my inbox"}]')`.execute(
        tx,
      );
      await sql`insert into causal_chains(id,max_delegations,max_autonomous_runs,used_delegations,used_autonomous_runs,root_message_id)
        values(${chainId},4,4,0,0,${seedId}),(${sentChainId},4,4,0,0,${sentId})`.execute(tx);
      await sql`insert into runs(id,thread_id,environment_id,activation_input_id,causal_chain_id,
        access_mode,harness_instance_id,model_selection,requested_by,actor_principal_id,
        authority_source,run_ordinal,seed_input_id,status,completed_at,input_tokens,output_tokens)
        values(${runId},${ownThreadId},${owner.environmentId},${seedId},${chainId},'full-access',
          ${harnessId},${model}::jsonb,${owner.userId},${principalId},
          ${authority}::jsonb,1,${seedId},'completed',${request.resolvedAt},15,25)`.execute(tx);
      // A Run still queued from an input the connection sent: only the input names the connection.
      await sql`insert into runs(id,thread_id,environment_id,activation_input_id,causal_chain_id,
        access_mode,harness_instance_id,model_selection,requested_by,actor_principal_id,
        authority_source,run_ordinal,seed_input_id,status)
        values(${sentRunId},${sentThreadId},${owner.environmentId},${sentId},${sentChainId},'auto',
          ${harnessId},${model}::jsonb,${owner.userId},${principalId},'{}',0,${sentId},'queued')`.execute(
        tx,
      );
      const agent = JSON.stringify({
        kind: "agent",
        displayName: "Opensteer",
        runId,
        threadId: ownThreadId,
      });
      await sql`insert into messages(id,thread_id,run_id,sequence,kind,actor_principal_id,author,content)
        values(${answerId},${ownThreadId},${runId},2,'assistant',${principalId},${agent}::jsonb,
          '[{"type":"text","text":"Booked the 9:40 flight."}]')`.execute(tx);
      await sql`insert into thread_inputs(message_id,thread_id,run_id,actor_principal_id,authority_source,
          causal_chain_id,idempotency_key,policy,queue_rank,request_fingerprint,requested_by,state)
        values(${seedId},${ownThreadId},${runId},${principalId},${authority}::jsonb,${chainId},'fixture:ask',
            'queue',1,'fingerprint',${owner.userId},'delivered'),
          (${sentId},${sentThreadId},null,${principalId},
            ${JSON.stringify({ kind: "connection", connectionId, userId: owner.userId })}::jsonb,
            ${sentChainId},'fixture:sent','queue',1,'fingerprint',${owner.userId},'pending')`.execute(
        tx,
      );
      await sql`insert into requests(id,kind,mode,status,originating_thread_id,originating_run_id,
        call_id,requested_by,required_actor,presentation,payload,response,resolved_at,resolved_by,created_at)
        values(${request.id},${request.kind},${request.mode},${request.status},${ownThreadId},${runId},
          ${request.callId},${request.requestedBy},${request.requiredActor},${JSON.stringify(request.presentation)}::jsonb,
          ${JSON.stringify(request.payload)}::jsonb,${JSON.stringify(request.response)}::jsonb,
          ${request.resolvedAt},${request.resolvedBy},${request.createdAt})`.execute(tx);
      await sql`insert into plugin_executions(id,owner_user_id,thread_id,run_id,caller,mode,state)
        values('fixture-personal',${owner.userId},${ownThreadId},${runId},'personal','automatic','completed'),
          ('fixture-sent',${owner.userId},${sentThreadId},${sentRunId},'delegated','automatic','running')`.execute(
        tx,
      );
      await sql`insert into browser_profiles(id,owner_id,name,initialized) values(${profileId},${owner.userId},'Personal',true)`.execute(
        tx,
      );
      await sql`insert into browser_sessions(id,tab_group_id,origin,profile_id,placement_key,runner_id,runtime_id,state)
        values(${sessionId},${sessionId},'person',${profileId},${`profile:${profileId}`},${owner.runnerId},'runtime','ready')`.execute(
        tx,
      );
      await sql`insert into personal_tabs(id,owner_id,kind,computer_id,title,url,profile_id,profile_name,page_binding,opened_by,closed_at)
        values(${openTabId},${owner.userId},'page',${owner.runnerId},'Flights','https://flights.example/',
            ${profileId},'Personal',${page(crypto.randomUUID())}::jsonb,'"person"',null),
          (${closedTabId},${owner.userId},'page',${owner.runnerId},'Hotels','https://hotels.example/',
            ${profileId},'Personal',${page(crypto.randomUUID())}::jsonb,'"person"',now())`.execute(
        tx,
      );
    });

    const upgrade = await migrateToLatest(database);
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.map(({ migrationName, status }) => [migrationName, status])).toEqual(
      names.filter((name) => !released.includes(name)).map((name) => [name, "Success"]),
    );
    expect(await applied()).toEqual(names);

    // A person's own task, Run and Request load through the current stores.
    const store = new OpensteerStore(database);
    expect(
      await store.getThreadForOwner(ownThreadId as never, owner.userId as never),
    ).toMatchObject({
      id: ownThreadId,
      title: "Plan the trip",
    });
    expect(
      await store.getThreadForOwner(sentThreadId as never, owner.userId as never),
    ).toMatchObject({
      id: sentThreadId,
      title: "Sort the inbox",
    });
    const reference = await store.requests.referenceForOwner({
      ownerId: owner.userId as never,
      threadId: ownThreadId as never,
      requestId: requestId as never,
    });
    expect(reference?.request).toMatchObject({
      id: requestId,
      status: "fulfilled",
      originatingRunId: runId,
      response: { kind: "choice", optionId: "allow" },
    });
    expect(reference?.revision).toEqual(expect.any(String));
    expect(
      await store.listRunAttemptsForOwner({
        ownerId: owner.userId as never,
        runId: runId as never,
      }),
    ).not.toBeNull();
    // Every store parses a Run with the same mapper; both Runs still parse.
    const runs = await database.selectFrom("runs").selectAll().orderBy("runOrdinal").execute();
    expect(runs.map(runFromRow)).toMatchObject([
      { id: sentRunId, threadId: sentThreadId, status: "queued" },
      {
        id: runId,
        threadId: ownThreadId,
        status: "completed",
        usage: { inputTokens: 15, outputTokens: 25 },
      },
    ]);

    // Existing tasks stay the person's; only the queued work the connection sent is its lineage.
    expect(
      await database
        .selectFrom("threads")
        .select(["id", "worker", "originConnectionId"])
        .orderBy("title")
        .execute(),
    ).toEqual([
      { id: ownThreadId, worker: "native", originConnectionId: null },
      { id: sentThreadId, worker: "native", originConnectionId: null },
    ]);
    expect(
      await database
        .selectFrom("runs")
        .select(["id", "connectionId"])
        .orderBy("runOrdinal")
        .execute(),
    ).toEqual([
      { id: sentRunId, connectionId },
      { id: runId, connectionId: null },
    ]);
    expect(
      await database
        .selectFrom("pluginExecutions")
        .select(["id", "connectionId", "agentSessionId", "state"])
        .orderBy("id")
        .execute(),
    ).toEqual([
      { id: "fixture-personal", connectionId: null, agentSessionId: null, state: "completed" },
      { id: "fixture-sent", connectionId, agentSessionId: null, state: "running" },
    ]);
    expect(await new AgentConnectionStore(database).list(owner.userId as never)).toMatchObject([
      {
        id: connectionId,
        label: "Laptop agent",
        accessMode: "auto",
        grant: { scope: "everything" },
        grantRevision: 1,
        consentVersion: 1,
        state: "active",
      },
    ]);

    // The browser session and its tabs read as before, through main's open-tab index.
    expect(
      await store.readBrowserSessionCut(owner.userId as never, sessionId as never, [closedTabId]),
    ).toMatchObject({
      state: "ready",
      tabs: [{ tabId: openTabId }],
      closed: [closedTabId],
    });
    expect(
      await new TabStore(database).get(owner.userId as never, openTabId as never),
    ).toMatchObject({
      kind: "page",
      url: "https://flights.example/",
      pageBinding: { sessionId },
      openedBy: "person",
    });

    // The Home starts again with nothing left to apply.
    const again = await migrateToLatest(database);
    expect(again.error).toBeUndefined();
    expect(again.results).toEqual([]);
    expect(await applied()).toEqual(names);
  } finally {
    await database.destroy();
    await fixture.drop();
  }
});
