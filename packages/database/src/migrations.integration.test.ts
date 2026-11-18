import { DeviceIdSchema } from "@opensteer/core";
import { seedPrivatePublisher } from "./private-publisher.test-support.js";
import {
  AgentEventViewSchema,
  createId,
  createToolOutput,
  parseReferenceHref,
  PlaceEnteredEventViewSchema,
  TabIdSchema,
  tabReferenceHref,
  TeamMessageIdSchema,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import {
  tabsAndAppsMigrationName,
  deviceDriversMigrationName,
  agentHomeSettingsMigrationName,
  dropSpecialistsMigrationName,
  MigrationLineageError,
  migrateToLatest,
  migrationProvider,
  personalTeamBaselineName,
  teamKnowledgeNotesMigrationName,
  teamAgentMigrationName,
  teamAgentAsksMigrationName,
  teamPrincipalsMigrationName,
  waitingInputEditsMigrationName,
} from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { OpensteerStore } from "./store.js";
import { TriggerStore } from "./trigger-store.js";
import { createPersonalRunFixturePort } from "./personal-run-fixture.test-support.js";
import { teamRequestView } from "./team-chat-store.js";
import {
  PersonalTeamRequestsStore,
  personalTeamRequestMirrorFromRow,
} from "./personal-team-requests-store.js";
import { personalTeamRunOutcome } from "./personal-team-run-store.js";
import { AccountDirectoryStore } from "./account-directory-store.js";
import { DeploymentSnapshotSchema } from "@opensteer/protocol";
import { requestFromRow } from "./request-persistence.js";
import { eventFromRow } from "./deployment-events.js";
import { readAgentThreadActivity, readAgentThreadRecent } from "./agent-thread-history.js";
import { latestNativePlaces } from "./browser-session-store.js";
import { resolvePersonalReferences } from "./reference-store.js";
import { readEmptyPersonalResources } from "./store.integration.test-support.js";

let clone: TestDatabase;
let database: Kysely<DatabaseSchema>;
beforeEach(async () => {
  clone = await cloneTestDatabase("host");
  database = createDatabase({ connectionString: clone.url });
  await sql`drop schema public cascade; create schema public`.execute(database);
});
afterEach(async () => {
  try {
    await database?.destroy();
  } finally {
    await clone?.drop();
  }
});

async function catalog() {
  return (
    await sql<{ name: string; kind: string; definition: string | null }>`
    select c.relname as name,c.relkind as kind,case when c.relkind='i' then pg_get_indexdef(c.oid) else null end as definition
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname
  `.execute(database)
  ).rows;
}
async function team() {
  await sql`insert into deployments(id,singleton_key,active_host_instance_id,canonical_origin,lifecycle,deployment_shape)
    values(${createId("deployment")},'primary',${createId("hostInstance")},'https://team.example.invalid','active','{"kind":"team"}')
    on conflict(singleton_key) do nothing`.execute(database);
  const owner = createId("user");
  const channel = createId("teamChannel");
  const other = createId("teamChannel");
  await sql`insert into users(id,display_name,email,email_verified,created_at,updated_at) values(${owner},'Maya','maya@example.invalid',true,now(),now());
  `.execute(database);
  await sql`insert into team_members(user_id,handle,role,state,joined_at,changed_at) values(${owner},'maya','owner','active',now(),now())`.execute(
    database,
  );
  for (const [id, name] of [
    [channel, "support"],
    [other, "private"],
  ] as const)
    await sql`
   insert into team_channels(id,kind,name,normalized_name,created_by,people_only,instructions_markdown) values(${id},'public',${name},${name},${owner},false,'')
  `.execute(database);
  return { owner, channel, other };
}
async function message(channel: string, owner: string, clientId = crypto.randomUUID()) {
  return (
    await sql<{
      id: string;
    }>`insert into team_messages(channel_id,author_user_id,author_kind,client_message_id,body_markdown,plain_text,change_seq)
    values(${channel},${owner},'human',${clientId},'Support fox','Support fox',1) returning id`.execute(
      database,
    )
  ).rows[0]!.id;
}

/** Every migration that sorts before `name`, as a database last migrated by an older build has. */
function migrationsBefore(name: string) {
  return {
    async getMigrations() {
      const all = await migrationProvider().getMigrations();
      return Object.fromEntries(Object.entries(all).filter(([key]) => key < name));
    },
  };
}

async function legacyQueuedInput(input: {
  readonly threadId: string;
  readonly requestedBy: string;
  readonly idempotencyKey: string;
  readonly content: readonly unknown[];
}) {
  const messageId = createId("message");
  const chainId = createId("causalChain");
  const thread = await database
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", input.threadId as import("@opensteer/core").ThreadId)
    .executeTakeFirstOrThrow();
  const sequence = thread.nextMessageSequence;
  const author = {
    kind: "human",
    displayName: "Alex",
    principalId: thread.createdByPrincipalId,
    userId: input.requestedBy,
  };
  await sql`insert into causal_chains(id,max_delegations,max_autonomous_runs,used_delegations,used_autonomous_runs) values(${chainId},100,100,0,0)`.execute(
    database,
  );
  await sql`insert into messages(id,thread_id,sequence,kind,actor_principal_id,author,content) values(${messageId},${thread.id},${sequence},'input',${thread.createdByPrincipalId},${JSON.stringify(author)}::jsonb,${JSON.stringify(input.content)}::jsonb)`.execute(
    database,
  );
  await sql`insert into thread_inputs(message_id,thread_id,actor_principal_id,authority_source,causal_chain_id,idempotency_key,policy,queue_rank,request_fingerprint,requested_by,state) values(${messageId},${thread.id},${thread.createdByPrincipalId},'{}',${chainId},${input.idempotencyKey},'queue',${sequence},'fixture',${input.requestedBy},'pending')`.execute(
    database,
  );
  const existing = await database
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", thread.id)
    .executeTakeFirst();
  const runId = existing ? null : createId("run");
  if (runId)
    await sql`insert into runs(id,thread_id,environment_id,harness_instance_id,model_selection,access_mode,activation_input_id,seed_input_id,causal_chain_id,requested_by,actor_principal_id,authority_source,run_ordinal,status) values(${runId},${thread.id},${thread.environmentId},${thread.harnessInstanceId},${JSON.stringify(thread.modelSelection)}::jsonb,${thread.accessMode},${messageId},${messageId},${chainId},${input.requestedBy},${thread.createdByPrincipalId},'{}',0,'queued')`.execute(
      database,
    );
  await sql`update threads set next_message_sequence=next_message_sequence+1 where id=${thread.id}`.execute(
    database,
  );
  await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,type,data)
    select deployment_id,sequence+1,${createId("event")},${thread.id},'message.created',${JSON.stringify({ message: { id: messageId, content: input.content }, input: { messageId, replyTarget: null } })}::jsonb from deployment_event_state`.execute(
    database,
  );
  await sql`update deployment_event_state set sequence=sequence+1`.execute(database);
  return { message: { id: messageId }, run: runId ? { id: runId } : null };
}

describe("fresh personal/team lineage", () => {
  it("upgrades a team server that has messages to shared channels in one migration run", async () => {
    // A team server last migrated by an older build, holding messages, as a real upgrade finds it.
    await migrateToLatest(database, migrationsBefore("0014_claude_idle_compaction"));
    const { owner, channel } = await team();
    const first = await message(channel, owner);
    // An agent's reply references its request through a deferred foreign key.
    const linkId = createId("teamLink"),
      requestId = createId("teamAgentRequest");
    await sql`insert into team_links(id,owner_user_id,state,code_hash) values(${linkId},${owner},'pending',${crypto.randomUUID()})`.execute(
      database,
    );
    await sql`insert into team_agent_requests(id,owner_user_id,channel_id,thread_root_id,trigger_message_id,link_id,state,steps,change_seq)
      values(${requestId},${owner},${channel},${first},${first},${linkId},'queued','[]',1)`.execute(
      database,
    );
    const second = (
      await sql<{
        id: string;
      }>`insert into team_messages(channel_id,thread_root_id,author_user_id,author_kind,agent_request_id,client_message_id,body_markdown,plain_text,change_seq)
        values(${channel},${first},${owner},'agent',${requestId},${crypto.randomUUID()},'Done','Done',1) returning id`.execute(
        database,
      )
    ).rows[0]!.id;
    await migrateToLatest(database);
    const rows = await database
      .selectFrom("teamMessages")
      .select(["id", "createdSeq", "publicId"])
      .where("channelId", "=", channel as never)
      .orderBy("id")
      .execute();
    expect(rows.map((row) => [row.id, String(row.createdSeq)])).toEqual([
      [first, "1"],
      [second, "2"],
    ]);
    expect(new Set(rows.map((row) => row.publicId)).size).toBe(2);
  });
  it("preserves existing uploaded bytes and assigns partner-safe identities when adding shared files", async () => {
    await migrateToLatest(database, migrationsBefore("0018_team_share_files"));
    const { owner, channel, other } = await team();
    const id = createId("teamBlob");
    await sql`insert into team_blobs(id,channel_id,uploader_user_id,uploader_kind,client_upload_id,storage_key,filename,declared_type,verified_type,size_bytes,sha256,state,received_bytes)
      values(${id},${channel},${owner},'human',${crypto.randomUUID()},${id},'notes.txt','text/plain','text/plain',3,${"a".repeat(64)},'ready',3)`.execute(
      database,
    );
    await migrateToLatest(database);
    const row = await database
      .selectFrom("teamBlobs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      storageKey: id,
      channelId: channel,
      remoteShareId: null,
      previewSha256: null,
      cacheOriginalReserved: false,
      cachePreviewReserved: false,
      sizeBytes: "3",
    });
    expect(row.publicId).toMatch(/^[a-f0-9-]{36}$/);
    await database
      .insertInto("teamBlobs")
      .values({ ...row, id: createId("teamBlob"), channelId: other })
      .execute();
    expect(
      await database
        .selectFrom("teamBlobs")
        .select("storageKey")
        .where("storageKey", "=", id)
        .execute(),
    ).toHaveLength(2);
  });
  it("backfills principals for active and removed members without changing content ids", async () => {
    await migrateToLatest(database, migrationsBefore(teamPrincipalsMigrationName));
    const { owner, channel } = await team();
    const removed = createId("user");
    await sql`insert into users(id,display_name,email,email_verified) values(${removed},'Former','former@example.invalid',true)`.execute(
      database,
    );
    await sql`insert into team_members(user_id,handle,role,state) values(${removed},'former','member','removed')`.execute(
      database,
    );
    const id = await message(channel, removed);
    await sql`insert into team_mentions(message_id,channel_id,target_user_id,target_kind) values(${id},${channel},${owner},'person')`.execute(
      database,
    );
    await sql`insert into team_message_pins(message_id,channel_id,pinned_by) values(${id},${channel},${removed})`.execute(
      database,
    );
    const before = await database.selectFrom("teamMessages").selectAll().execute();
    await migrateToLatest(database);
    const after = await database.selectFrom("teamMessages").selectAll().execute();
    expect(
      after.map(
        ({
          publicId: _publicId,
          createdSeq: _createdSeq,
          ownerChangeSeq: _ownerChangeSeq,
          ...original
        }) => original,
      ),
    ).toEqual(before);
    expect(
      after.map((row) => ({ createdSeq: row.createdSeq, ownerChangeSeq: row.ownerChangeSeq })),
    ).toEqual([{ createdSeq: "1", ownerChangeSeq: null }]);
    expect(after[0]!.publicId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(
      (
        await database
          .selectFrom("teamPrincipals")
          .select(["id", "memberUserId", "displayName", "handle"])
          .execute()
      ).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      [owner, removed]
        .sort()
        .map((userId) => ({ id: userId, memberUserId: userId, displayName: null, handle: null })),
    );
    expect(await database.selectFrom("teamMentions").select("targetUserId").execute()).toEqual([
      { targetUserId: owner },
    ]);
    expect(await database.selectFrom("teamMessagePins").select("pinnedBy").execute()).toEqual([
      { pinnedBy: removed },
    ]);
  });
  it("backfills self requests and preserves their execution and publication receipts", async () => {
    await migrateToLatest(database, migrationsBefore(teamAgentAsksMigrationName));
    const { userId } = await seedPersonalFixture(database, "/tmp/ws0-asks-agent-home");
    const store = new OpensteerStore(database);
    const base = await createPersonalRunFixturePort(store).createTask({
      ownerId: userId,
      suffix: "ask-upgrade",
    });
    const input = await legacyQueuedInput({
      threadId: base.thread.id,
      requestedBy: userId,
      content: [{ type: "text", text: "Existing work" }],
      idempotencyKey: "ask-upgrade",
    });
    const { owner, channel } = await team();
    const root = await message(channel, owner);
    const linkId = createId("teamLink"),
      teamId = createId("deployment");
    await sql`insert into team_links(id,owner_user_id,state,code_hash) values(${linkId},${owner},'pending',${crypto.randomUUID()})`.execute(
      database,
    );
    const states = [
      "queued",
      "working",
      "needs_you",
      "done",
      "failed",
      "cancelled",
      "stopped",
    ] as const;
    const requestIds = [];
    for (const state of states) {
      const trigger = await message(channel, owner),
        id = createId("teamAgentRequest");
      requestIds.push(id);
      await sql`insert into team_agent_requests(id,owner_user_id,channel_id,thread_root_id,trigger_message_id,link_id,state,steps,accepted_at,expires_at,finished_at,change_seq)
        values(${id},${owner},${channel},${root},${trigger},${linkId},${state},'[]',
          case when ${state}='queued' then null else now() end,
          case when ${state}='queued' then null else now()+interval '7 days' end,
          case when ${state} in ('done','failed','cancelled','stopped') then now() else null end,1)`.execute(
        database,
      );
    }
    await sql`insert into personal_team_links(id,team_deployment_id,team_host_instance_id,host_key_fingerprint,approved_origin,authority_envelope,state)
      values('ask-upgrade',${teamId},${createId("hostInstance")},'fixture','https://team.invalid','{}','active')`.execute(
      database,
    );
    const source = {
      teamId,
      channelId: channel,
      threadRootId: root,
      messageId: root,
      audience: {
        teamName: "Studio",
        channelName: "support",
        channelKind: "public",
        memberCount: 2,
        peopleOnly: false,
      },
    };
    await sql`insert into personal_team_requests(team_deployment_id,request_id,trigger_message_id,local_task_id,local_input_id,publication_state,terminal_state,source)
      values(${teamId},${requestIds[0]},${root},${base.thread.id},${input.message.id},'accepted','done',${JSON.stringify(source)}::jsonb)`.execute(
      database,
    );
    const before = await database
      .selectFrom("teamAgentRequests")
      .select(["id", "state", "acceptedAt", "expiresAt", "finishedAt"])
      .orderBy("id")
      .execute();
    await migrateToLatest(database);
    const rows = await database.selectFrom("teamAgentRequests").selectAll().orderBy("id").execute();
    expect(
      rows.map(({ id, state, acceptedAt, expiresAt, finishedAt }) => ({
        id,
        state,
        acceptedAt,
        expiresAt,
        finishedAt,
      })),
    ).toEqual(before);
    for (const row of rows)
      expect(teamRequestView(row)).toMatchObject({
        kind: "self",
        consentExpiresAt: null,
      });
    expect(await new PersonalTeamRequestsStore(database).get(teamId, requestIds[0]!)).toMatchObject(
      {
        kind: "self",
        remoteState: "done",
        taskId: base.thread.id,
        inputId: input.message.id,
        publicationState: "accepted",
        terminalState: "done",
        localDecision: null,
        returnPayload: null,
        returnAdmission: null,
      },
    );
  });

  it("stores taskless consent and unique returns while keeping self trigger uniqueness", async () => {
    await migrateToLatest(database);
    const { owner, channel } = await team();
    const trigger = await message(channel, owner),
      otherTrigger = await message(channel, owner);
    const linkId = createId("teamLink"),
      teamId = createId("deployment"),
      askId = createId("teamAgentRequest"),
      otherAskId = createId("teamAgentRequest");
    await sql`insert into team_links(id,owner_user_id,state,code_hash) values(${linkId},${owner},'pending',${crypto.randomUUID()})`.execute(
      database,
    );
    const presentation = {
      asker: { teamUserId: owner, displayName: "Maya", actor: "agent" },
      bodyMarkdown: "Review this",
      attachments: [],
      destination: { teamId, channelId: channel, threadRootId: trigger },
      audience: {
        teamName: "Studio",
        channelName: "support",
        channelKind: "public",
        memberCount: 2,
        peopleOnly: false,
      },
    };
    for (const [id, messageId] of [
      [askId, trigger],
      [otherAskId, otherTrigger],
    ])
      await sql`insert into team_agent_requests(id,kind,owner_user_id,channel_id,thread_root_id,trigger_message_id,link_id,state,steps,change_seq,presentation,consent_expires_at)
        values(${id},'ask',${owner},${channel},${trigger},${messageId},${linkId},'awaiting_approval','[]',1,${JSON.stringify(presentation)}::jsonb,now()+interval '7 days')`.execute(
        database,
      );
    await expect(
      sql`insert into team_agent_requests(id,owner_user_id,channel_id,thread_root_id,trigger_message_id,link_id,state,steps,change_seq)
      values(${createId("teamAgentRequest")},${owner},${channel},${trigger},${trigger},${linkId},'queued','[]',1)`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const payload = {
      originAskId: askId,
      resumeRunId: createId("run"),
      outcome: "declined",
      bodyMarkdown: null,
      attachments: [],
    };
    const insertReturn = (originAskId: string) =>
      sql`insert into team_agent_requests(id,kind,owner_user_id,channel_id,thread_root_id,trigger_message_id,link_id,state,steps,change_seq,return_payload)
      values(${createId("teamAgentRequest")},'return',${owner},${channel},${trigger},${trigger},${linkId},'queued','[]',1,${JSON.stringify({ ...payload, originAskId })}::jsonb)`.execute(
        database,
      );
    await insertReturn(askId);
    await insertReturn(otherAskId);
    await expect(insertReturn(askId)).rejects.toMatchObject({ code: "23505" });
    await sql`update team_agent_requests set state='declined',finished_at=now() where id=${askId}`.execute(
      database,
    );
    const returned = await database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("kind", "=", "return")
      .executeTakeFirstOrThrow();
    expect(teamRequestView(returned)).not.toHaveProperty("returnPayload");
    await sql`insert into personal_team_links(id,team_deployment_id,team_host_instance_id,host_key_fingerprint,approved_origin,authority_envelope,state)
      values('ask-consent',${teamId},${createId("hostInstance")},'fixture','https://team.invalid','{}','active')`.execute(
      database,
    );
    const source = {
      ...presentation.destination,
      messageId: trigger,
      audience: presentation.audience,
    };
    await sql`insert into personal_team_requests(team_deployment_id,request_id,kind,remote_state,trigger_message_id,local_task_id,local_input_id,publication_state,source,presentation,consent_expires_at)
      values(${teamId},${askId},'ask','awaiting_approval',${trigger},null,null,'pending',${JSON.stringify(source)}::jsonb,${JSON.stringify(presentation)}::jsonb,now()+interval '7 days')`.execute(
      database,
    );
    await expect(
      sql`update personal_team_requests set local_decision='approve' where request_id=${askId}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await sql`update personal_team_requests set local_decision='decline',decision_at=now() where request_id=${askId}`.execute(
      database,
    );
    const consent = await database
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("requestId", "=", askId)
      .executeTakeFirstOrThrow();
    expect(personalTeamRequestMirrorFromRow(consent)).toMatchObject({
      kind: "ask",
      taskId: null,
      inputId: null,
      localDecision: "decline",
      presentation,
    });
    const rejectedId = createId("teamAgentRequest");
    const insertReceipt = (id = createId("teamAgentRequest")) =>
      sql`insert into personal_team_requests(team_deployment_id,request_id,kind,trigger_message_id,local_task_id,local_input_id,publication_state,source,return_payload)
      values(${teamId},${id},'return',${trigger},null,null,'pending',${JSON.stringify(source)}::jsonb,${JSON.stringify(payload)}::jsonb)`.execute(
        database,
      );
    await insertReceipt(rejectedId);
    await expect(insertReceipt()).rejects.toMatchObject({ code: "23505" });
    await database
      .updateTable("personalTeamRequests")
      .set({ returnAdmission: "undeliverable" })
      .where("requestId", "=", rejectedId)
      .execute();
    await insertReceipt();
    const receipt = await database
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("requestId", "=", rejectedId)
      .executeTakeFirstOrThrow();
    expect(personalTeamRequestMirrorFromRow(receipt)).toMatchObject({
      kind: "return",
      taskId: null,
      inputId: null,
      returnPayload: payload,
      returnAdmission: "undeliverable",
    });
    await expect(
      sql`update personal_team_requests set return_admission='admitted' where request_id=${receipt.requestId}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const indexes = (await catalog()).filter(({ kind }) => kind === "i").map(({ name }) => name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "team_requests_return_origin",
        "team_requests_consent_expiring",
        "personal_team_requests_pending_consent",
      ]),
    );
  });

  it("backfills only request-associated reply targets and repairs hydrated messages and history", async () => {
    await migrateToLatest(database, migrationsBefore(teamAgentMigrationName));
    const { userId } = await seedPersonalFixture(database, "/tmp/ws0-migration-agent-home");
    const store = new OpensteerStore(database);
    const base = await createPersonalRunFixturePort(store).createTask({
      ownerId: userId,
      suffix: "team-upgrade",
    });
    const teamId = createId("deployment"),
      channelId = createId("teamChannel");
    const source = {
      teamId,
      channelId,
      threadRootId: "10",
      messageId: "11",
      audience: {
        teamName: "Studio",
        channelName: "design",
        channelKind: "private",
        memberCount: 2,
        peopleOnly: false,
      },
    };
    const { thread } = await store.createThread({
      createdBy: userId,
      environmentId: base.thread.environmentId,
      harnessInstanceId: base.harnessInstance.id,
      modelSelection: base.thread.modelSelection,
      idempotencyKey: "team-origin",
      title: "Team request",
      teamOrigin: { teamId, channelId, threadRootId: TeamMessageIdSchema.parse("10") },
    });
    const inputs = [];
    for (const key of ["run", "queued", "ledger", "private"])
      inputs.push(
        await legacyQueuedInput({
          threadId: thread.id,
          requestedBy: userId,
          content: [
            { type: "text", text: key === "private" ? "Private follow-up" : "Legacy input" },
          ],
          idempotencyKey: key,
        }),
      );
    const [running, queued, ledger, privateInput] = inputs;
    const requestId = createId("teamAgentRequest"),
      queuedRequest = createId("teamAgentRequest"),
      ledgerRequest = createId("teamAgentRequest");
    for (const [input, request] of [
      [running!, requestId],
      [queued!, queuedRequest],
    ] as const)
      await sql`update thread_inputs set team_request_id=${request},team_source=${JSON.stringify(source)}::jsonb,reply_target=null where message_id=${input.message.id}`.execute(
        database,
      );
    expect(running!.run).not.toBeNull();
    expect(queued!.run).toBeNull();
    await sql`update runs set team_request_id=${requestId},reply_target=null where id=${running!.run!.id}`.execute(
      database,
    );
    await sql`insert into personal_team_links(id,team_deployment_id,team_host_instance_id,host_key_fingerprint,approved_origin,authority_envelope,state)
      values('migration-link',${teamId},${createId("hostInstance")},'fixture','https://team.invalid','{}','active')`.execute(
      database,
    );
    await sql`insert into personal_team_requests(team_deployment_id,request_id,trigger_message_id,local_task_id,local_input_id,terminal_state,publication_state,source)
      values(${teamId},${ledgerRequest},11,${thread.id},${ledger!.message.id},'done','pending',${JSON.stringify(source)}::jsonb)`.execute(
      database,
    );
    const hydrated = [
      { type: "text", text: "Team source and audience: " + JSON.stringify(source) },
      {
        type: "text",
        text: JSON.stringify([
          { id: "10", channelId, bodyMarkdown: "Root" },
          { id: "11", channelId, bodyMarkdown: "Please review **this**." },
        ]),
      },
    ];
    await sql`update messages set content=${JSON.stringify(hydrated)}::jsonb where id=${running!.message.id}`.execute(
      database,
    );
    await sql`update messages set content=${JSON.stringify([{ type: "text", text: "Team source and audience: unrecognized" }])}::jsonb where id=${ledger!.message.id}`.execute(
      database,
    );
    await sql`update deployment_events set data=jsonb_set(data,'{message,content}',${JSON.stringify(hydrated)}::jsonb)
      where type='message.created' and data->'message'->>'id'=${running!.message.id}`.execute(
      database,
    );
    await migrateToLatest(database);
    const recovered = (await new PersonalTeamRequestsStore(database).get(teamId, ledgerRequest))!;
    expect(recovered.terminalState).toBeNull();
    expect(await personalTeamRunOutcome(database, recovered)).toMatchObject({
      state: "pending",
      runId: null,
    });
    expect(
      (await new PersonalTeamRequestsStore(database).forTeam(teamId)).map((r) => r.requestId),
    ).toContain(ledgerRequest);
    const targets = await database
      .selectFrom("threadInputs")
      .select(["messageId", "replyTarget", "teamSource"])
      .where("threadId", "=", thread.id)
      .execute();
    for (const [input, request] of [
      [running!, requestId],
      [queued!, queuedRequest],
      [ledger!, ledgerRequest],
    ] as const)
      expect(targets.find((row) => row.messageId === input.message.id)?.replyTarget).toEqual({
        kind: "team-thread",
        teamId,
        channelId,
        threadRootId: "10",
        requestId: request,
      });
    expect(targets.find((row) => row.messageId === ledger!.message.id)?.teamSource).toEqual(source);
    expect(
      targets.find((row) => row.messageId === privateInput!.message.id)?.replyTarget,
    ).toBeNull();
    expect(
      (
        await database
          .selectFrom("runs")
          .select("replyTarget")
          .where("id", "=", running!.run!.id)
          .executeTakeFirstOrThrow()
      ).replyTarget,
    ).toEqual(targets.find((row) => row.messageId === running!.message.id)?.replyTarget);
    expect(
      (
        await database
          .selectFrom("messages")
          .select("content")
          .where("id", "=", running!.message.id)
          .executeTakeFirstOrThrow()
      ).content,
    ).toEqual([{ type: "text", text: "Please review **this**." }]);
    expect(
      JSON.stringify(
        (
          await database
            .selectFrom("messages")
            .select("content")
            .where("id", "=", ledger!.message.id)
            .executeTakeFirstOrThrow()
        ).content,
      ),
    ).toContain("original trigger text is unavailable");
    const projections = await sql<{
      content: unknown;
      target: unknown;
    }>`select data->'message'->'content' as content,data->'input'->'replyTarget' as target
      from deployment_events where type='message.created' and data->'message'->>'id'=${running!.message.id}`.execute(
      database,
    );
    expect(projections.rows.length).toBeGreaterThan(0);
    for (const projection of projections.rows) {
      expect(projection.content).toEqual([{ type: "text", text: "Please review **this**." }]);
      expect(projection.target).toMatchObject({ kind: "team-thread", requestId });
    }
    expect(
      (
        await sql`select column_name from information_schema.columns where table_name='runs' and column_name='team_request_id'`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
  });
  it("upgrades waiting edits without releasing undecided or unacknowledged asks", async () => {
    await migrateToLatest(database, migrationsBefore(waitingInputEditsMigrationName));
    const { userId } = await seedPersonalFixture(database, "/tmp/opensteer-waiting-upgrade");
    const { thread } = await createPersonalRunFixturePort(new OpensteerStore(database)).createTask({
      ownerId: userId,
      suffix: "waiting-upgrade",
    });
    const input = await legacyQueuedInput({
      threadId: thread.id,
      requestedBy: userId,
      idempotencyKey: "waiting-upgrade",
      content: [{ type: "text", text: "Original" }],
    });
    const teamId = createId("deployment");
    await sql`insert into personal_team_links(id,team_deployment_id,team_host_instance_id,host_key_fingerprint,approved_origin,authority_envelope,state)
      values('waiting-upgrade',${teamId},${createId("hostInstance")},'fixture','https://team.invalid','{}','active')`.execute(
      database,
    );
    const pending = createId("teamAgentRequest"),
      approving = createId("teamAgentRequest"),
      released = createId("teamAgentRequest");
    for (const id of [pending, approving, released])
      await sql`insert into personal_team_requests(team_deployment_id,request_id,trigger_message_id,local_task_id,local_input_id,kind,remote_state,presentation,consent_expires_at,local_decision,decision_at,source,publication_state)
        values(${teamId},${id},'1',${id === released ? thread.id : null},${id === released ? input.message.id : null},'ask','awaiting_approval','{}',now()+interval '1 day',
          ${id === pending ? null : "approve"},case when ${id}=${pending} then null else now() end,'{}','pending')`.execute(
        database,
      );
    await migrateToLatest(database);
    expect(
      await database
        .selectFrom("messages")
        .select(["revision", "editedAt"])
        .where("id", "=", input.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revision: 0, editedAt: null });
    expect(await database.selectFrom("messageRevisions").selectAll().execute()).toEqual([]);
    expect(
      await database
        .selectFrom("threadWorkInputs")
        .select(["editLeaseId", "editLeaseSessionId", "editLeaseExpiresAt"])
        .execute(),
    ).toEqual([{ editLeaseId: null, editLeaseSessionId: null, editLeaseExpiresAt: null }]);
    const rows = await database.selectFrom("personalTeamRequests").selectAll().execute();
    expect(rows.find((row) => row.requestId === pending)).toMatchObject({
      localTaskId: null,
      approvedRevision: null,
      releasedAt: null,
    });
    expect(rows.find((row) => row.requestId === approving)).toMatchObject({
      localTaskId: null,
      approvedRevision: 0,
      releasedAt: null,
    });
    const admitted = rows.find((row) => row.requestId === released)!;
    expect(admitted.approvedRevision).toBe(0);
    expect(admitted.releasedAt).toEqual(admitted.decisionAt);
  });
  it("drops stored background model choices from databases made before settings.json held them", async () => {
    await migrateToLatest(database, migrationsBefore(agentHomeSettingsMigrationName));
    await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    await sql`alter table personal_settings add column background_model_preferences jsonb not null default '{"roles":{},"excludedAccounts":[]}'`.execute(
      database,
    );
    await migrateToLatest(database);
    expect(
      (
        await sql`select column_name from information_schema.columns where table_name='personal_settings' and column_name='background_model_preferences'`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    expect(await database.selectFrom("agentHomeSettings").selectAll().execute()).toEqual([]);
  });
  it("drops specialist storage and settings from databases made before specialists were removed", async () => {
    await migrateToLatest(database, migrationsBefore(dropSpecialistsMigrationName));
    const { userId } = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    await sql`create table specialists (id text primary key);
      alter table threads add column specialist_id text;
      alter table plugin_versions add column specialist_manifest jsonb`.execute(database);
    const skill = { kind: "skill", fullName: "notes" };
    const specialist = { kind: "specialist", pluginId: "p", ownerUserId: userId };
    await sql`insert into plugin_owner_settings (owner_user_id, target_key, target, enabled, revision)
      values (${userId}, 'specialist', ${JSON.stringify(specialist)}::jsonb, false, 1),
        (${userId}, 'skill', ${JSON.stringify(skill)}::jsonb, false, 1)`.execute(database);
    await migrateToLatest(database);
    expect(
      (
        await sql`select table_name, column_name from information_schema.columns where table_schema='public' and (table_name='specialists' or column_name in ('specialist_id','specialist_manifest'))`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    expect(await database.selectFrom("pluginOwnerSettings").select("target").execute()).toEqual([
      { target: skill },
    ]);
  });
  it("drops service integrations and keeps device, messaging and local-server rows", async () => {
    await migrateToLatest(database, {
      getMigrations: async () =>
        Object.fromEntries(
          Object.entries(await migrationProvider().getMigrations()).filter(
            ([name]) => name <= deviceDriversMigrationName,
          ),
        ),
    });
    const { userId, runnerId } = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    // The storage only databases made before this migration have.
    await sql`create table integration_provider_applications (id text primary key);
      create table mcp_oauth_credentials (connection_id text primary key);
      create table integration_application_source_defaults (provider text primary key);
      alter table integration_connections add column provider_application_id text,
        add column application_source jsonb, add column auth_method_id text,
        add column authorization_digest text, add column granted_scopes jsonb;
      alter table integration_installations add column adapter_snapshot jsonb;
      alter table integration_auth_attempts add column result_connection_id text;
      alter table integration_connections drop constraint integration_connections_connection_kind_check;
      alter table integration_installations drop constraint integration_installations_source_kind_check`.execute(
      database,
    );
    const installation = (id: string, sourceKind: string, pluginId: string | null) =>
      sql`insert into integration_installations
        (id, name, title, description, plugin_id, source_kind, trust, manifest, provenance, status, revision)
        values (${id}, ${id}, ${id}, '', ${pluginId}, ${sourceKind}, 'built-in', '{}', '{}', 'active', 1)`.execute(
        database,
      );
    const server = (id: string, installationId: string, transport: object, requirement: object) =>
      sql`insert into integration_servers
        (id, installation_id, name, transport, connection_requirement, status, tool_generation)
        values (${id}, ${installationId}, 'default', ${JSON.stringify(transport)}::jsonb,
          ${JSON.stringify(requirement)}::jsonb, 'active', 1)`.execute(database);
    const connection = (id: string, kind: string, serverId: string | null) =>
      sql`insert into integration_connections
        (id, owner_user_id, connection_kind, provider, connection_method, status, display_name,
          capabilities, integration_server_id, granted_scopes, runner_id, device_id, integration_definition_id)
        values (${id}, ${userId}, ${kind}, ${kind}, 'computer', 'connected', ${id}, '[]',
          ${serverId}, '[]', ${kind === "computer" ? runnerId : null}, ${kind === "computer" ? runnerId : null},
          ${kind === "computer" ? "apple-calendar" : null})`.execute(database);
    const grant = (id: string, installationId: string, connectionId: string | null) =>
      sql`insert into integration_grants
        (access, id, owner_user_id, installation_id, connection_id, alias, is_default, created_by, status)
        values ('read', ${id}, ${userId}, ${installationId}, ${connectionId}, ${id}, false, ${userId},
          'active')`.execute(database);
    await installation("device", "built-in", null);
    await server(
      "device-server",
      "device",
      { type: "computer", definitionId: "apple-calendar" },
      {
        kind: "computer",
        definitionId: "apple-calendar",
      },
    );
    await installation("local", "plugin", "local-plugin");
    await server(
      "local-server",
      "local",
      { type: "runner", runnerId: null, launch: { type: "stdio", command: "./tv" } },
      { kind: "none" },
    );
    await installation("gmail", "built-in", null);
    await server(
      "gmail-server",
      "gmail",
      { type: "adapter", adapter: "openapi", definitionId: "gmail" },
      {
        kind: "provider",
        definitionId: "gmail",
        provider: "google",
        providerApplicationRequired: true,
      },
    );
    await installation("remote", "remote-mcp", null);
    await server(
      "remote-server",
      "remote",
      { type: "streamable-http", url: "https://mcp.example.test", headers: {} },
      { kind: "mcp-oauth" },
    );
    await connection("computer-connection", "computer", "device-server");
    await connection("channel-connection", "channel", null);
    await connection("google-account", "provider-account", null);
    await connection("mcp-account", "mcp-oauth", "remote-server");
    await sql`insert into mcp_oauth_credentials values ('mcp-account');
      insert into integration_provider_applications values ('google-app')`.execute(database);
    const channelCredential = createId("credential");
    const serviceCredential = createId("credential");
    for (const [id, connectionId] of [
      [channelCredential, "channel-connection"],
      [serviceCredential, "google-account"],
    ] as const) {
      await sql`insert into credentials(id,owner_id,name,provider,encrypted_payload,encryption_key_version,metadata)
        values(${id},${userId},${connectionId},'fixture',${Buffer.from("sealed-fixture")},1,'{}')`.execute(
        database,
      );
      await sql`update integration_connections set credential_id=${id} where id=${connectionId}`.execute(
        database,
      );
      await sql`insert into credential_access_audit(id,actor_id,credential_id,connection_id,purpose)
        values(${connectionId},${userId},${id},${connectionId},'channel-transport')`.execute(
        database,
      );
    }
    await grant("device-grant", "device", "computer-connection");
    await grant("local-grant", "local", null);
    await grant("gmail-grant", "gmail", "google-account");
    await grant("remote-grant", "remote", "mcp-account");
    await sql`insert into plugin_owner_settings (owner_user_id, target_key, target, enabled, revision)
      values (${userId}, '["service","gmail"]', '{"kind":"service","definitionId":"gmail"}', false, 1),
        (${userId}, '["device-app","apple-calendar"]', '{"kind":"device-app","definitionId":"apple-calendar"}', false, 1),
        (${userId}, '["plugin","local-plugin"]', '{"kind":"plugin","pluginId":"local-plugin"}', false, 2)`.execute(
      database,
    );

    await sql`create unique index if not exists integration_connections_definition_identity_unique
      on integration_connections(integration_definition_id, external_tenant_id, external_identity_id)
      nulls not distinct where connection_kind='provider-account' and external_identity_id is not null and status<>'revoked'`.execute(
      database,
    );
    const store = new OpensteerStore(database);
    const runs = createPersonalRunFixturePort(store);
    const task = await runs.createTask({ ownerId: userId, suffix: "service-upgrade" });
    const triggers = new TriggerStore(database);
    const program = {
      language: "javascript",
      source: 'export default async ({opensteer}) => opensteer.callTool("opensteer_task_list", {})',
      toolContractVersion: 5,
    } as const;
    const savedSchedule = await triggers.create({
      actorThreadId: null,
      anchorThreadId: task.threadId,
      createdBy: userId,
      idempotencyKey: "saved-schedule",
      name: "Saved schedule",
      program,
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      },
    });
    const savedWatch = await triggers.create({
      actorThreadId: null,
      anchorThreadId: task.threadId,
      createdBy: userId,
      idempotencyKey: "saved-watch",
      name: "Saved watch",
      program: {
        ...program,
        source:
          'export default async ({opensteer}) => { await opensteer.callTool("opensteer_task_list", {}); await new Promise(() => setInterval(() => {}, 1000)); }',
      },
      source: { kind: "watch" },
    });
    for (const { revision } of [savedSchedule, savedWatch]) {
      await database
        .updateTable("triggerRevisions")
        .set({ program: { ...revision.program, toolContractVersion: 4 } })
        .where("id", "=", revision.id)
        .execute();
    }
    const { run } = await runs.startTask(task.threadId, "Existing task");
    const removedRequests: string[] = [];
    const keptRequests: string[] = [];
    for (const [kind, installationId, manifest] of [
      ["integration.install", "gmail", null],
      ["integration.input", "remote", null],
      ["integration.access", "gmail", null],
      [
        "integration.access",
        null,
        { kind: "catalog", definition: { id: "gmail", adapter: "openapi" } },
      ],
      ["integration.access", "device", null],
      ["integration.access", "local", null],
    ] as const) {
      const id = createId("request");
      const keep = installationId === "device" || installationId === "local";
      (keep ? keptRequests : removedRequests).push(id);
      const payload = {
        kind,
        access: "read",
        installationId,
        manifest,
        reason: "Existing request",
        requestedConnectionId: null,
        requestedServerId: null,
      };
      await sql`insert into requests (id,kind,mode,status,originating_thread_id,originating_run_id,call_id,requested_by,required_actor,presentation,payload)
        values (${id},${kind},'durable','pending',${task.threadId},${run.id},${id},${userId},'requester',
        '{"kind":"external","title":"Existing request","subject":{"kind":"integration.access","id":"app"}}',${JSON.stringify(payload)}::jsonb)`.execute(
        database,
      );
      await sql`insert into integration_request_details(request_id,access,installation_id,manifest) values(${id},'read',${installationId},${JSON.stringify(manifest)}::jsonb)`.execute(
        database,
      );
      await sql`insert into request_continuations(request_id,status) values(${id},'waiting')`.execute(
        database,
      );
      const row = await database
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const request = keep ? requestFromRow(row) : { id, kind, payload };
      for (const type of [
        "request.opened",
        "request.updated",
        "request.resolved",
        "request.cancelled",
      ]) {
        await sql`update deployment_event_state set sequence=sequence+1`.execute(database);
        await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data)
          select deployment_id,sequence,${createId("event")},${task.threadId},${run.id},${run.environmentId},${type},
          ${JSON.stringify(type === "request.cancelled" ? { requestId: id, reason: "resource-deleted" } : { request: type === "request.resolved" ? { ...request, status: "declined", resolvedAt: new Date().toISOString(), resolvedBy: userId, response: { kind: "external", value: { decision: "declined" } } } : request })}::jsonb from deployment_event_state`.execute(
          database,
        );
      }
    }
    for (const [kind, payload] of [
      ["integration.install", {}],
      ["integration.input", {}],
      ["integration.access", { installationId: "gmail", manifest: null }],
      [
        "integration.access",
        { installationId: null, manifest: { kind: "catalog", definition: { adapter: "openapi" } } },
      ],
    ] as const) {
      const id = createId("request");
      for (const [type, data] of [
        ["request.opened", { request: { id, kind, payload } }],
        ["request.cancelled", { requestId: id, reason: "resource-deleted" }],
      ] as const) {
        await sql`update deployment_event_state set sequence=sequence+1`.execute(database);
        await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data)
          select deployment_id,sequence,${createId("event")},${task.threadId},${run.id},${run.environmentId},${type},
          ${JSON.stringify(data)}::jsonb from deployment_event_state`.execute(database);
      }
    }
    await sql`create schema plugin_engine; create table plugin_engine.kept_data(id text primary key);
      insert into plugin_engine.kept_data values('engine-data')`.execute(database);
    const toolEventId = createId("event");
    await sql`update deployment_event_state set sequence=sequence+1`.execute(database);
    await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data)
      select deployment_id,sequence,${toolEventId},${task.threadId},${run.id},${run.environmentId},'tool.started',
      '{"callId":"old-call","tool":{"name":"integration_call","namespace":"opensteer"},"arguments":{},"integration":{"integration":"Gmail"}}' from deployment_event_state`.execute(
      database,
    );
    await migrateToLatest(database);

    expect(
      (await database.selectFrom("requests").select("id").execute()).map(({ id }) => id).sort(),
    ).toEqual(keptRequests.sort());
    expect(
      (await database.selectFrom("integrationRequestDetails").select("requestId").execute())
        .map(({ requestId }) => requestId)
        .sort(),
    ).toEqual(keptRequests.sort());
    const historical = await database
      .selectFrom("deploymentEvents")
      .selectAll()
      .where("type", "in", [
        "request.opened",
        "request.updated",
        "request.resolved",
        "request.cancelled",
      ])
      .execute();
    expect(historical).toHaveLength(8);
    for (const row of historical) expect(() => eventFromRow(row)).not.toThrow();
    const oldTool = await database
      .selectFrom("deploymentEvents")
      .select("data")
      .where("eventId", "=", toolEventId)
      .executeTakeFirstOrThrow();
    expect(oldTool.data).toMatchObject({ tool: { name: "retired_service", namespace: "history" } });
    expect(oldTool.data).not.toHaveProperty("integration");
    expect((await sql`select * from plugin_engine.kept_data`.execute(database)).rows).toEqual([
      { id: "engine-data" },
    ]);
    await sql`drop schema plugin_engine cascade`.execute(database);
    const ids = async (table: string) =>
      (
        await sql<{ id: string }>`select id from ${sql.table(table)} order by id`.execute(database)
      ).rows.map(({ id }) => id);
    expect(await ids("integration_installations")).toEqual(["device", "local"]);
    expect(await ids("integration_servers")).toEqual(["device-server", "local-server"]);
    expect(await ids("integration_connections")).toEqual([
      "channel-connection",
      "computer-connection",
    ]);
    expect(await ids("integration_grants")).toEqual(["device-grant", "local-grant"]);
    expect(await ids("credentials")).toEqual([channelCredential]);
    expect(
      (
        await sql<{
          name: string | null;
        }>`select to_regclass('public.integration_connections_definition_identity_unique')::text as name`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ name: null }]);
    expect(await ids("credential_access_audit")).toEqual(["channel-connection"]);
    expect(await database.selectFrom("pluginOwnerSettings").select("targetKey").execute()).toEqual(
      [],
    );
    expect(
      await database
        .selectFrom("pluginAgentSettings")
        .select(["pluginId", "access"])
        .orderBy("pluginId")
        .execute(),
    ).toEqual([
      { pluginId: "app_device_computer-connection", access: "off" },
      { pluginId: "app_server_local-server", access: "off" },
    ]);
    for (const saved of [savedSchedule, savedWatch]) {
      const detail = await triggers.getForOwner(saved.trigger.id, userId, 1);
      expect(detail?.revision.program).toEqual(saved.revision.program);
    }
    expect(
      (await triggers.getForOwner(savedWatch.trigger.id, userId, 1))?.activation,
    ).toMatchObject({
      desired: "active",
    });
    expect(
      (
        await sql`select table_name, column_name from information_schema.columns where table_schema='public'
          and (table_name in ('integration_provider_applications', 'mcp_oauth_credentials', 'integration_application_source_defaults')
            or column_name in ('provider_application_id', 'application_source', 'auth_method_id', 'authorization_digest', 'granted_scopes', 'adapter_snapshot', 'result_connection_id'))`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    await expect(
      sql`insert into integration_connections
        (id, owner_user_id, connection_kind, provider, connection_method, status, display_name, capabilities)
        values ('late-account', ${userId}, 'provider-account', 'google', 'computer', 'connected',
          'Late', '[]')`.execute(database),
    ).rejects.toThrow("integration_connections_connection_kind_check");
  });
  it("upgrades existing queued inputs with fresh context disabled in the table and work view", async () => {
    await migrateToLatest(database, migrationsBefore("0005_thread_input_fresh_context"));
    const { userId } = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    const store = new OpensteerStore(database);
    const { thread } = await createPersonalRunFixturePort(store).createTask({
      ownerId: userId,
      suffix: "before-fresh-context",
    });
    const input = await legacyQueuedInput({
      content: [{ type: "text", text: "Already queued" }],
      idempotencyKey: "before-upgrade",
      requestedBy: userId,
      threadId: thread.id,
    });
    await migrateToLatest(database);
    for (const table of ["threadInputs", "threadWorkInputs"] as const) {
      expect(
        await database.selectFrom(table).select(["messageId", "freshContext"]).execute(),
      ).toEqual([{ messageId: input.message.id, freshContext: false }]);
    }
  });
  it("projects Account ownership changes and fences an acknowledgement from before revocation", async () => {
    await migrateToLatest(database);
    const { userId } = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    const directory = new AccountDirectoryStore(database);
    await directory.configureProvider({
      issuer: "https://accounts.invalid",
      providerId: "oidc:account",
    });
    const accountId = "account-owner";
    const id = createId("authAccount");
    await database
      .insertInto("authAccounts")
      .values({ id, userId, providerId: "oidc:account", accountId })
      .execute();
    const [pending] = await directory.claimPending();
    expect(pending).toMatchObject({ userId, present: true, generation: 1 });
    if (!pending) throw new Error("Owner directory projection was not queued");
    await directory.refreshUser(userId);
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", userId)
      .execute();
    await expect(directory.complete(pending)).resolves.toBe(false);
    const [removed] = await directory.claimPending();
    expect(removed).toMatchObject({ userId, present: false, generation: 2 });
    await database
      .updateTable("users")
      .set({ disabledAt: null })
      .where("id", "=", userId)
      .execute();
    const [restored] = await directory.claimPending();
    expect(restored).toMatchObject({ userId, present: true, generation: 3 });
    await database.deleteFrom("authAccounts").where("id", "=", id).execute();
    expect(await directory.claimPending()).toEqual([
      expect.objectContaining({ userId, present: false, generation: 4 }),
    ]);
  });
  it("preserves personal operation journals and production upsert identities", async () => {
    await migrateToLatest(database);
    const operation = (
      await sql<{
        dataType: string;
      }>`select data_type from information_schema.columns where table_schema='public' and table_name='personal_remote_account_link' and column_name='account_operation'`.execute(
        database,
      )
    ).rows;
    expect(operation).toEqual([{ dataType: "jsonb" }]);
    const revision = (
      await sql<{
        columnDefault: string;
      }>`select column_default from information_schema.columns where table_schema='public' and table_name='delegations' and column_name='revision'`.execute(
        database,
      )
    ).rows;
    expect(revision).toEqual([{ columnDefault: "1" }]);
    expect(
      (
        await sql`select table_name,column_name,data_type,is_nullable from information_schema.columns where table_schema='public' and ((table_name='plugin_owner_settings' and column_name='revision') or (table_name='personal_desktop_update' and column_name='detail')) order by table_name`.execute(
          database,
        )
      ).rows,
    ).toEqual([
      {
        tableName: "personal_desktop_update",
        columnName: "detail",
        dataType: "text",
        isNullable: "YES",
      },
      {
        tableName: "plugin_owner_settings",
        columnName: "revision",
        dataType: "integer",
        isNullable: "NO",
      },
    ]);
    const constraints = (
      await sql<{
        name: string;
        definition: string;
      }>`select conname as name,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'browser_session_uses'::regclass and contype='u' order by conname`.execute(
        database,
      )
    ).rows;
    expect(constraints).toEqual([
      {
        name: "browser_session_uses_identity",
        definition: "UNIQUE NULLS NOT DISTINCT (session_id, thread_id, run_id, tab_id)",
      },
    ]);
    const indexes = await catalog();
    expect(indexes.find(({ name }) => name === "delegations_result_message")?.definition).toMatch(
      /^CREATE INDEX .*\(result_message_id\)/u,
    );
    expect(
      indexes.find(({ name }) => name === "automation_failure_notices_occurrence_id_key")
        ?.definition,
    ).toContain("UNIQUE INDEX");
    expect(indexes.find(({ name }) => name === "threads_creator_created")?.definition).toContain(
      "created_by, created_at DESC, id DESC",
    );
  });
  it("migrates existing device policies without widening shell access or binding sessions", async () => {
    await migrateToLatest(database, migrationsBefore("0008_devices"));
    const fixture = await seedPersonalFixture(database, "/tmp/pre-devices-home");
    const original = { reach: "nobody", commands: false, forwarding: true, shares: [] };
    await sql`update runners set access_policy = ${JSON.stringify(original)}::jsonb`.execute(
      database,
    );
    await migrateToLatest(database);
    const runner = await database
      .selectFrom("devices")
      .select("accessPolicy")
      .where("id", "=", DeviceIdSchema.parse(fixture.runnerId))
      .executeTakeFirstOrThrow();
    expect(runner.accessPolicy).toEqual({ ...original, browser: true, apps: true });
    const columns = await sql<{
      name: string;
    }>`select column_name as name from information_schema.columns where table_name='auth_sessions' and column_name='device_id'`.execute(
      database,
    );
    expect(columns.rows).toEqual([{ name: "device_id" }]);
  });
  it("applies both kinds' tables once and survives restart", async () => {
    await migrateToLatest(database);
    const before = await catalog();
    expect(before.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "personal_settings",
        "threads",
        "deployment_events",
        "team_messages",
        "team_agent_requests",
        "personal_team_requests",
        "team_topics",
        "team_topic_grants",
        "team_notes",
        "team_note_versions",
      ]),
    );
    expect(
      before.filter((row) =>
        /workspace|project_runtime|effective_membership|team_run_tickets|team_channel_changes|team_reactions|team_command_receipts|team_message_search|knowledge/.test(
          row.name,
        ),
      ),
    ).toEqual([]);
    await database.destroy();
    database = createDatabase({ connectionString: clone.url });
    await migrateToLatest(database);
    expect(await catalog()).toEqual(before);
    expect(
      (
        await sql<{ name: string }>`select name from kysely_migration order by name`.execute(
          database,
        )
      ).rows,
    ).toEqual(Object.keys(await migrationProvider().getMigrations()).map((name) => ({ name })));
  });
  it("replaces a team's restricted knowledge schema, its login and channel topics with notes in topics", async () => {
    await migrateToLatest(database, migrationsBefore(teamKnowledgeNotesMigrationName));
    const { owner, channel } = await team();
    const { oid } = (
      await sql<{
        oid: string;
      }>`select oid::text as oid from pg_database where datname=current_database()`.execute(
        database,
      )
    ).rows[0]!;
    const executor = `opensteer_knowledge_executor_${oid}`;
    const exists = async (query: string) =>
      (
        await sql<{ present: boolean }>`select exists(${sql.raw(query)}) as present`.execute(
          database,
        )
      ).rows[0]!.present;
    try {
      // What the old team Host built at start: a schema owned by a cluster-wide role, a login
      // for agent SQL, and grant and channel-topic rows that point into it. One transaction, so
      // a concurrent migration never sees the owner without the schema it owns.
      await database.transaction().execute(async (transaction) => {
        await sql
          .raw(
            `do $$ begin create role opensteer_knowledge_owner nologin;
              exception when duplicate_object then null; end $$;
            create role "${executor}" login noinherit;
            alter role "${executor}" set search_path = pg_catalog, knowledge, pg_temp;
            create schema knowledge authorization opensteer_knowledge_owner;
            create table knowledge.topics (id text primary key, name text not null,
              origin_channel_id text references public.team_channels(id));
            alter table knowledge.topics owner to opensteer_knowledge_owner;
            alter table public.team_topic_grants add foreign key (topic_id) references knowledge.topics(id);
            alter table public.team_channel_topics add foreign key (topic_id) references knowledge.topics(id);
            grant usage on schema knowledge to "${executor}";
            grant select on knowledge.topics to "${executor}";
            insert into knowledge.topics values ('ktp_old', 'pricing', null), ('ktp_channel', 'support', '${channel}');
            insert into team_topic_grants (topic_id, subject_kind, subject_id, level, added_by)
              values ('ktp_old', 'person', '${owner}', 'manage', '${owner}');
            insert into team_channel_topics (channel_id, topic_id, attached_by)
              values ('${channel}', 'ktp_old', '${owner}');`,
          )
          .execute(transaction);
      });
      await migrateToLatest(database);
      expect(await exists("select from pg_namespace where nspname='knowledge'")).toBe(false);
      expect(await exists(`select from pg_roles where rolname='${executor}'`)).toBe(false);
      expect(await exists("select from pg_class where relname='team_channel_topics'")).toBe(false);
      // The new tables take an everyone grant, which can read or write but never manage.
      const topic = createId("knowledgeTopic");
      await sql`insert into team_topics (id, name, created_by) values (${topic}, 'General', ${owner})`.execute(
        database,
      );
      await sql`insert into team_topic_grants (topic_id, subject_kind, subject_id, level) values (${topic}, 'everyone', 'team', 'write')`.execute(
        database,
      );
      await expect(
        sql`update team_topic_grants set level='manage' where topic_id=${topic}`.execute(database),
      ).rejects.toThrow(/check constraint/u);
      await expect(
        sql`insert into team_topic_grants (topic_id, subject_kind, subject_id, level) values ('ktp_old', 'person', ${owner}, 'read')`.execute(
          database,
        ),
      ).rejects.toThrow(/foreign key/u);
      await migrateToLatest(database);
    } finally {
      await sql
        .raw(
          `drop schema if exists knowledge cascade;
          do $$ begin
            if exists (select from pg_roles where rolname = '${executor}') then drop role "${executor}"; end if;
            drop role if exists opensteer_knowledge_owner;
          exception when dependent_objects_still_exist then null; end $$;`,
        )
        .execute(database);
    }
  });
  it.each([
    ["app_versions", "size_bytes", "integer", "NO"],
    ["computer_app_setup_requests", "app", "jsonb", "NO"],
    ["computer_app_setup_requests", "server", "jsonb", "NO"],
    ["integration_connections", "computer_app", "jsonb", "NO"],
    ["plugin_owner_settings", "revision", "integer", "NO"],
    ["delegations", "revision", "integer", "NO"],
    ["tab_layouts", "items", "jsonb", "NO"],
    ["machine_access_events", "id", "bigint", "YES"],
  ])("preserves the private storage contract for %s.%s", async (table, column, type, identity) => {
    await migrateToLatest(database);
    const result = await sql<{ dataType: string; isIdentity: string }>`
      select data_type, is_identity from information_schema.columns
      where table_schema='public' and table_name=${table} and column_name=${column}
    `.execute(database);
    expect(result.rows).toEqual([{ dataType: type, isIdentity: identity }]);
  });
  it("starts credentials at a positive generation and keys browser attachments by session and binding", async () => {
    await migrateToLatest(database);
    const generation = await sql<{ columnDefault: string }>`
      select column_default from information_schema.columns
      where table_schema='public' and table_name='integration_connections' and column_name='credential_generation'
    `.execute(database);
    expect(generation.rows).toEqual([{ columnDefault: "1" }]);
    const key = await sql<{ columns: string[] }>`
      select array_agg(a.attname::text order by k.ordinality) as columns
      from pg_constraint c cross join lateral unnest(c.conkey) with ordinality k(attnum, ordinality)
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
      where c.conrelid='browser_session_attachments'::regclass and c.contype='p'
    `.execute(database);
    expect(key.rows[0]?.columns).toEqual(["session_id", "agent_binding_id"]);
  });
  it("publishes one authority generation per owner at commit and rolls invalidations back", async () => {
    await migrateToLatest(database);
    const { owner } = await team();
    const generation = () =>
      database
        .selectFrom("integrationAuthorityGenerations")
        .select("generation")
        .where("ownerUserId", "=", owner)
        .executeTakeFirst();
    await database.transaction().execute(async (tx) => {
      await sql`insert into integration_connections
        (id, owner_user_id, connection_kind, provider, connection_method, status, display_name, capabilities)
        values ('connection', ${owner}, 'channel', 'fixture', 'computer', 'connected', 'Initial', '[]')`.execute(
        tx,
      );
      await sql`update integration_connections set display_name = 'Changed' where id = 'connection'`.execute(
        tx,
      );
      expect(await generation()).toBeUndefined();
      expect(
        await tx.selectFrom("integrationAuthorityPending").select("ownerUserId").execute(),
      ).toEqual([{ ownerUserId: owner }]);
    });
    expect(await generation()).toEqual({ generation: 1 });
    const rejection = new Error("rejected mutation");
    await expect(
      database.transaction().execute(async (tx) => {
        await sql`update integration_connections set display_name = 'Rolled back' where id = 'connection'`.execute(
          tx,
        );
        throw rejection;
      }),
    ).rejects.toBe(rejection);
    expect(await generation()).toEqual({ generation: 1 });
    expect(await database.selectFrom("integrationAuthorityPending").selectAll().execute()).toEqual(
      [],
    );
  });
  it("rejects a legacy ledger before changing its schema or data", async () => {
    await sql`create table kysely_migration(name varchar(255) primary key,timestamp varchar(255) not null); insert into kysely_migration values('0001_baseline','old'); create table retained(value text); insert into retained values('untouched')`.execute(
      database,
    );
    const before = await catalog();
    await expect(migrateToLatest(database)).rejects.toBeInstanceOf(MigrationLineageError);
    expect(await catalog()).toEqual(before);
    expect((await sql`select * from retained`.execute(database)).rows).toEqual([
      { value: "untouched" },
    ]);
    expect((await sql`select * from kysely_migration`.execute(database)).rows).toEqual([
      { name: "0001_baseline", timestamp: "old" },
    ]);
  });
  it.each([false, true])(
    "refuses unversioned data with an empty ledger present: %s",
    async (emptyLedger) => {
      await sql`create table retained(value text)`.execute(database);
      if (emptyLedger)
        await sql`create table kysely_migration(name varchar(255) primary key,timestamp varchar(255) not null)`.execute(
          database,
        );
      const before = await catalog();
      await expect(migrateToLatest(database)).rejects.toBeInstanceOf(MigrationLineageError);
      expect(await catalog()).toEqual(before);
    },
  );
  it("refuses an unknown forward lineage before writing", async () => {
    await migrateToLatest(database);
    await sql`insert into kysely_migration values('9999_future','future')`.execute(database);
    const before = await catalog();
    await expect(migrateToLatest(database)).rejects.toBeInstanceOf(MigrationLineageError);
    expect(await catalog()).toEqual(before);
  });
  it("keeps generated FTS current within the message transaction and on edits", async () => {
    await migrateToLatest(database);
    const { owner, channel } = await team();
    const id = await message(channel, owner);
    expect(
      (
        await sql`select id from team_messages where search_document @@ websearch_to_tsquery('simple','fox')`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ id }]);
    await sql`update team_messages set plain_text='Fresh owl',body_markdown='Fresh owl',change_seq=2 where id=${id}`.execute(
      database,
    );
    expect(
      (
        await sql`select id from team_messages where search_document @@ websearch_to_tsquery('simple','fox')`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await sql`select id from team_messages where search_document @@ websearch_to_tsquery('simple','owl')`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ id }]);
    expect(
      (await catalog()).find((row) => row.name === "team_messages_search")?.definition,
    ).toContain("USING gin");
  });
  it("enforces same-channel references and preserves tombstone send identity", async () => {
    await migrateToLatest(database);
    const { owner, channel, other } = await team();
    const clientId = crypto.randomUUID();
    const root = await message(channel, owner, clientId);
    await expect(
      sql`insert into team_messages(channel_id,thread_root_id,author_user_id,author_kind,client_message_id,body_markdown,plain_text,change_seq) values(${other},${root},${owner},'human',${crypto.randomUUID()},'bad','bad',1)`.execute(
        database,
      ),
    ).rejects.toThrow(/foreign key/);
    await sql`update team_messages set deleted_at=now(),body_markdown='',plain_text='' where id=${root}`.execute(
      database,
    );
    await expect(message(channel, owner, clientId)).rejects.toThrow(/unique/);
    expect(
      (await sql`select id from team_messages where id=${root}`.execute(database)).rows,
    ).toEqual([{ id: root }]);
  });
  it("makes requests row-resumable and fixes expiry at first accept", async () => {
    await migrateToLatest(database);
    const { owner, channel } = await team();
    const root = await message(channel, owner);
    const link = createId("teamLink");
    const request = createId("teamAgentRequest");
    await sql`insert into team_links(id,owner_user_id,state,code_hash,code_expires_at) values(${link},${owner},'pending','hash',now()+interval '10 minutes')`.execute(
      database,
    );
    await sql`insert into team_agent_requests(id,owner_user_id,channel_id,thread_root_id,trigger_message_id,link_id,state,steps,change_seq) values(${request},${owner},${channel},${root},${root},${link},'queued','[]',2)`.execute(
      database,
    );
    await expect(
      sql`update team_agent_requests set accepted_at=now(),expires_at=now()+interval '8 days' where id=${request}`.execute(
        database,
      ),
    ).rejects.toThrow(/check constraint/);
    await sql`update team_agent_requests set accepted_at=now(),expires_at=now()+interval '7 days',state='working',change_seq=3 where id=${request}`.execute(
      database,
    );
    expect(
      (
        await sql`select id from team_agent_requests where channel_id=${channel} and change_seq>2`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ id: request }]);
    expect(
      (await catalog()).find((row) => row.name === "team_requests_resume")?.definition,
    ).toContain("channel_id, change_seq");
  });
});

it("migrates baseline read positions, including the declared message-only and newer-active exceptions", async () => {
  const { migrationProvider } = await import("./migrations.js");
  const migrations = await migrationProvider().getMigrations();
  await migrateToLatest(database, {
    getMigrations: async () => ({
      [personalTeamBaselineName]: migrations[personalTeamBaselineName]!,
    }),
  });
  const person = await seedPersonalFixture(database, "/tmp/opensteer-visit-migration");
  const principal = await database
    .selectFrom("principals")
    .select("id")
    .where("userId", "=", person.userId)
    .executeTakeFirstOrThrow();
  await sql`insert into harness_instances(id,environment_id,driver_kind,name,config,runtime_revision,state_kind,enabled,is_default,source_id) values('harness',${person.environmentId},'codex','Codex','{}',1,'isolated',true,true,'codex')`.execute(
    database,
  );
  await sql`insert into causal_chains(id,max_delegations,max_autonomous_runs,used_delegations,used_autonomous_runs) values('chain',100,100,0,0)`.execute(
    database,
  );
  const completedAt = new Date("2026-01-02T00:00:00.000Z");
  const updatedAt = new Date("2026-01-03T00:00:00.000Z");
  const cases = [
    { name: "missing-marker", status: "completed", unread: true },
    { name: "read", status: "completed", marker: 1, unread: false },
    { name: "unread-failed", status: "failed", marker: 0, unread: true },
    { name: "interrupted", status: "interrupted", unread: true },
    { name: "newer-active", status: "completed", active: true, unread: false },
    { name: "blank-only", blank: true, unread: false },
    { name: "message-after-completion", status: "completed", afterCompletion: true, unread: false },
    { name: "blank-completion", status: "completed", blank: true, unread: true },
    { name: "voice", status: "completed", voice: true, unread: true },
    { name: "future-read", status: "completed", marker: 1, future: true, unread: false },
    {
      name: "microsecond-unread",
      status: "completed",
      marker: 0,
      messageAt: "2026-01-02T00:00:00.000500Z",
      completedAt: "2026-01-02T00:00:00.000900Z",
      unread: true,
    },
  ];
  for (const item of cases) {
    const id = `thr_${item.name}`;
    await sql`insert into threads(id,lineage_root_thread_id,purpose,listed,title,icon_source,color,environment_id,harness_instance_id,model_selection,created_by,created_by_principal_id)
      values(${id},${id},${item.voice ? "voice" : "task"},${!item.voice},${item.name},'provisional','blue',${person.environmentId},'harness','{}',${person.userId},${principal.id})`.execute(
      database,
    );
    await sql`insert into messages(id,thread_id,sequence,kind,actor_principal_id,author,content,created_at)
      values(${`msg_${item.name}`},${id},1,'assistant',${principal.id},'{"kind":"agent"}',${JSON.stringify([{ type: "text", text: item.blank ? "" : "Reply" }])},${item.messageAt ?? (item.future ? new Date("2099-01-01") : item.afterCompletion ? updatedAt : completedAt)})`.execute(
      database,
    );
    if (item.status) {
      await sql`insert into runs(id,thread_id,environment_id,harness_instance_id,model_selection,requested_by,actor_principal_id,authority_source,run_ordinal,seed_input_id,activation_input_id,causal_chain_id,access_mode,status,completed_at)
        values(${`run_${item.name}`},${id},${person.environmentId},'harness','{}',${person.userId},${principal.id},'{}',0,${`msg_${item.name}`},${`msg_${item.name}`},'chain','full-access',${item.status},${item.completedAt ?? (item.future ? new Date("2099-01-01") : completedAt)})`.execute(
        database,
      );
    }
    if (item.active)
      await sql`insert into runs(id,thread_id,environment_id,harness_instance_id,model_selection,requested_by,actor_principal_id,authority_source,run_ordinal,seed_input_id,activation_input_id,causal_chain_id,access_mode,status)
      select 'run_active',thread_id,environment_id,harness_instance_id,model_selection,requested_by,actor_principal_id,authority_source,1,seed_input_id,activation_input_id,causal_chain_id,access_mode,'running' from runs where id = ${`run_${item.name}`}`.execute(
        database,
      );
    if (item.marker !== undefined)
      await sql`insert into thread_read_markers(thread_id,user_id,sequence,updated_at) values(${id},${person.userId},${item.marker},${updatedAt})`.execute(
        database,
      );
  }
  await migrateToLatest(database);
  const { threadUnreadPredicate, latestRunCompletion } = await import("./thread-visits.js");
  const rows = (
    await sql<{
      id: string;
      unread: boolean;
      lastVisitedAt: Date;
      updatedAt: Date;
    }>`select thread.id, visit.last_visited_at, visit.updated_at,
    ${threadUnreadPredicate(latestRunCompletion(sql`thread.id`), sql`visit.last_visited_at`)} as unread
    from threads thread join thread_visits visit on visit.thread_id = thread.id order by thread.id`.execute(
      database,
    )
  ).rows;
  for (const item of cases) {
    const row = rows.find((row) => row.id === `thr_${item.name}`)!;
    expect(row.unread, item.name).toBe(item.unread);
    if (item.marker !== undefined) expect(row.updatedAt).toEqual(updatedAt);
    if (item.status && !item.active && !item.future)
      expect(row.lastVisitedAt).toEqual(new Date(completedAt.getTime() - (item.unread ? 1 : 0)));
  }
  expect(
    (
      await sql<{
        present: boolean;
      }>`select to_regclass('thread_read_markers') is not null as present`.execute(database)
    ).rows[0]?.present,
  ).toBe(false);
  expect(
    (
      await sql<{
        future: boolean;
      }>`select exists(select 1 from runs where completed_at > now()) as future`.execute(database)
    ).rows[0]?.future,
  ).toBe(false);
  // Message history is never rewritten; readers compare its millisecond truncation.
  expect(
    (
      await sql<{
        id: string;
        createdAt: string;
      }>`select id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as created_at
        from messages where id in ('msg_future-read', 'msg_microsecond-unread') order by id`.execute(
        database,
      )
    ).rows,
  ).toEqual([
    { id: "msg_future-read", createdAt: "2099-01-01 00:00:00.000000" },
    { id: "msg_microsecond-unread", createdAt: "2026-01-02 00:00:00.000500" },
  ]);
});

it("keeps pre-tabs/apps history and recent places readable without live tabs", async () => {
  await migrateToLatest(database, migrationsBefore(tabsAndAppsMigrationName));
  const publisher = await seedPrivatePublisher(database);
  const browser = {
    kind: "browser",
    sessionId: `bsn_${crypto.randomUUID()}`,
    surfaceId: "legacy/page:1",
  };
  const app = { kind: "app", machineId: publisher.runnerId, appKey: "com.apple.Notes" };
  const phone = { kind: "phone", machineId: publisher.runnerId, display: "main" };
  const places = [browser, app, phone, browser, app, phone];
  const nativeWindow = { id: 42, title: "Notes" };
  const unchanged = [
    {
      type: "app.published",
      data: { appId: `app_${crypto.randomUUID()}`, version: 1, title: "Existing app" },
    },
    {
      type: "tool.started",
      data: {
        callId: "computer:legacy",
        tool: { namespace: "integrations", name: "computer.bind" },
        arguments: { window: nativeWindow.id },
      },
    },
    {
      type: "tool.completed",
      data: {
        callId: "computer:legacy",
        isError: false,
        output: createToolOutput(JSON.stringify({ window: nativeWindow })),
      },
    },
    { type: "place.entered", data: { tabId: "already-current", title: "Current", site: null } },
  ];
  const fixtures = [
    ...places.map((place, index) => ({
      type: "place.entered",
      data: {
        place,
        title: `Historical ${index}`,
        site: place.kind === "browser" ? "https://example.com" : null,
      },
    })),
    ...unchanged,
  ];
  for (const fixture of fixtures)
    await sql`with next as (update deployment_event_state set sequence=sequence+1 returning *)
      insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data)
      select deployment_id,sequence,${createId("event")},${publisher.threadId},${publisher.runId},${publisher.environmentId},${fixture.type},${JSON.stringify(fixture.data)}::jsonb from next`.execute(
      database,
    );
  const before = await database
    .selectFrom("deploymentEvents")
    .selectAll()
    .orderBy("sequence")
    .execute();
  // These are valid pre-0026 rows, but the new strict event reader cannot read them yet.
  expect(() => eventFromRow(before[0]!)).toThrow();
  await migrateToLatest(database);
  const after = await database
    .selectFrom("deploymentEvents")
    .selectAll()
    .orderBy("sequence")
    .execute();
  expect(after.map(({ data: _data, ...row }) => row)).toEqual(
    before.map(({ data: _data, ...row }) => row),
  );
  expect(after.slice(places.length)).toEqual(before.slice(places.length));
  const events = after.map(eventFromRow);
  for (const event of events) expect(AgentEventViewSchema.parse(event)).toEqual(event);
  const migrated = events.slice(0, places.length).map((event, index) => {
    const place = PlaceEnteredEventViewSchema.parse(event);
    expect(place.data).toEqual({
      tabId: place.data.tabId,
      title: `Historical ${index}`,
      site: places[index]!.kind === "browser" ? "https://example.com" : null,
    });
    return place;
  });
  const ids = migrated.map((event) => TabIdSchema.parse(event.data.tabId));
  expect(ids.slice(0, 3)).toEqual(ids.slice(3));
  expect(new Set(ids).size).toBe(3);
  expect(ids[0]).toBe(browser.surfaceId);
  for (const id of [ids[1], ids[2]])
    expect(id).toMatch(/^tab_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
  const store = new OpensteerStore(database, {
    readPersonalResources: readEmptyPersonalResources,
  });
  const owner = { ownerId: publisher.userId, threadId: publisher.threadId };
  const page = await store.threadEventPageForOwner({ ...owner, placeEvents: "include" });
  expect(page?.events).toEqual(events);
  // These are the durable activity/recent-place readers used by opensteer_task_read.
  const activity = await readAgentThreadActivity(database, { ...owner, limit: 100 });
  expect(activity?.items).toEqual(
    events
      .toReversed()
      .map((event) =>
        event.type === "tool.started"
          ? { ...event, data: { ...event.data, arguments: null } }
          : event,
      ),
  );
  const started = events.find((event) => event.type === "tool.started")!;
  expect(
    (await readAgentThreadActivity(database, { ...owner, limit: 1, itemId: started.sequence }))
      ?.items,
  ).toEqual([started]);
  const recent = await readAgentThreadRecent(database, { ...owner, runLimit: 1 });
  const placeEvents = events.filter((event) => event.type === "place.entered");
  expect(recent?.places).toEqual(placeEvents.toReversed());
  expect(await store.latestRunPlace(publisher.runId)).toEqual(placeEvents.at(-1));
  const snapshot = await store.deploymentSnapshot({
    viewerId: publisher.userId,
    placeEvents: "include",
    omitMessages: true,
  });
  expect(DeploymentSnapshotSchema.parse(snapshot).runPlaces).toEqual([placeEvents.at(-1)]);
  expect(await latestNativePlaces(database, publisher.userId)).toMatchObject([
    { taskId: publisher.threadId, tabId: "already-current" },
  ]);
  for (const id of ids)
    expect(parseReferenceHref(tabReferenceHref(id))).toEqual({ kind: "tab", id });
  expect(await resolvePersonalReferences(database, { ownerId: publisher.userId, ids })).toEqual(
    [...new Set(ids)].map((id) => ({ id, status: "unavailable" })),
  );
  await migrateToLatest(database);
  expect(
    await database.selectFrom("deploymentEvents").selectAll().orderBy("sequence").execute(),
  ).toEqual(after);
});

it("reaches the same tabs/apps schema fresh and after preserving existing publications", async () => {
  await migrateToLatest(database, migrationsBefore(tabsAndAppsMigrationName));
  const publisher = await seedPrivatePublisher(database);
  const html = `app_${crypto.randomUUID()}`;
  const server = `app_${crypto.randomUUID()}`;
  const secondServer = `app_${crypto.randomUUID()}`;
  for (const appId of [html, server, secondServer]) {
    await sql`insert into apps(id,thread_id,run_id,title,latest_version) values(${appId},${publisher.threadId},${publisher.runId},'Preserved',1)`.execute(
      database,
    );
    const serverSpec =
      appId === server || appId === secondServer
        ? JSON.stringify({
            folder: { computerId: publisher.runnerId, path: "/tmp/migrated-server" },
            command: "node server.mjs",
          })
        : null;
    await sql`insert into app_versions(app_id,version,sha256,size_bytes,server,created_by_run,publish_key) values(${appId},1,${serverSpec ? null : "a".repeat(64)},${serverSpec ? null : 10},${serverSpec}::jsonb,${publisher.runId},${appId})`.execute(
      database,
    );
  }
  await migrateToLatest(database);
  const rows = (
    await sql<{
      id: string;
      ownerId: string;
      computerId: string;
      name: string;
      threadId: string | null;
      runId: string | null;
    }>`select id,owner_id,computer_id,name,thread_id,run_id from apps order by id`.execute(database)
  ).rows;
  expect(rows).toHaveLength(3);
  for (const row of rows)
    expect(row).toMatchObject({
      ownerId: publisher.userId,
      computerId: publisher.runnerId,
      name: "Preserved",
      threadId: publisher.threadId,
      runId: publisher.runId,
    });
  const ports = (
    await sql<{
      appId: string;
      port: number;
      desiredState: string;
    }>`select app_id,port,desired_state from app_servers order by app_id`.execute(database)
  ).rows;
  expect(ports).toHaveLength(2);
  expect(new Set(ports.map((row) => row.port)).size).toBe(2);
  for (const row of ports) {
    expect(row.port).toBeGreaterThanOrEqual(49152);
    expect(row.port).toBeLessThanOrEqual(65535);
    expect(row.desiredState).toBe("running");
  }
  await sql`delete from runs where id=${publisher.runId}`.execute(database);
  expect((await sql`select run_id from apps`.execute(database)).rows).toEqual(
    Array.from({ length: 3 }, () => ({ runId: null })),
  );
  await sql`update causal_chains set root_message_id=null where id=${publisher.causalChainId}`.execute(
    database,
  );
  await sql`delete from threads where id=${publisher.threadId}`.execute(database);
  expect((await sql`select thread_id from apps`.execute(database)).rows).toEqual(
    Array.from({ length: 3 }, () => ({ threadId: null })),
  );
  expect((await sql`select * from app_versions`.execute(database)).rows).toHaveLength(3);
  await migrateToLatest(database);
  expect(
    (await sql`select app_id,port,desired_state from app_servers order by app_id`.execute(database))
      .rows,
  ).toEqual(ports);
  const upgraded = await catalog();
  await sql`drop schema public cascade;create schema public`.execute(database);
  await migrateToLatest(database);
  expect(await catalog()).toEqual(upgraded);
});

it("enforces generic tab identity, descriptor shape, and fixed server ports on a fresh database", async () => {
  await migrateToLatest(database);
  const person = await seedPersonalFixture(database, "/tmp/tabs-contract-migration");
  const tab = (id: string) =>
    sql`insert into personal_tabs(id,owner_id,kind,computer_id,title,opened_by) values(${id},${person.userId},'phone',${person.runnerId},'Phone','"person"')`.execute(
      database,
    );
  await tab("first");
  await expect(tab("second")).rejects.toThrow(/unique/u);
  await sql`update personal_tabs set closed_at=now() where id='first'`.execute(database);
  await expect(tab("second")).rejects.toThrow(/unique/u);
  await expect(
    sql`insert into personal_tabs(id,owner_id,kind,computer_id,title,opened_by) values('page',${person.userId},'page',${person.runnerId},'Missing URL','"person"')`.execute(
      database,
    ),
  ).rejects.toThrow(/check constraint/u);
  const columns = (
    await sql<{
      tableName: string;
      columnName: string;
    }>`select table_name,column_name from information_schema.columns where table_schema='public' and table_name in ('apps','personal_tabs','runners','tab_layouts')`.execute(
      database,
    )
  ).rows;
  expect(columns.filter((row) => row.columnName === "tab_opened_at")).toEqual([]);
  expect(
    (
      await sql`select to_regclass('browser_tab_layouts') as old_layout,to_regclass('browser_tab_groups') as old_groups,to_regclass('browser_tab_group_members') as old_members`.execute(
        database,
      )
    ).rows,
  ).toEqual([{ oldLayout: null, oldGroups: null, oldMembers: null }]);
});

it("keeps a server's recorded home when the publishing computer can no longer be derived", async () => {
  await migrateToLatest(database, migrationsBefore(tabsAndAppsMigrationName));
  const publisher = await seedPrivatePublisher(database);
  const html = `app_${crypto.randomUUID()}`,
    server = `app_${crypto.randomUUID()}`;
  for (const appId of [html, server]) {
    await sql`insert into apps(id,thread_id,run_id,title,latest_version) values(${appId},${publisher.threadId},${publisher.runId},'Existing',1)`.execute(
      database,
    );
    const spec =
      appId === server
        ? JSON.stringify({
            folder: { computerId: publisher.runnerId, path: "/tmp/saved-app" },
            command: "node server.mjs",
          })
        : null;
    await sql`insert into app_versions(app_id,version,sha256,size_bytes,server,created_by_run,publish_key) values(${appId},1,${spec ? null : "a".repeat(64)},${spec ? null : 10},${spec}::jsonb,${publisher.runId},${appId})`.execute(
      database,
    );
  }
  await sql`update execution_environments set runner_id=null where id=${publisher.environmentId}`.execute(
    database,
  );
  await migrateToLatest(database);
  expect((await sql`select id,computer_id from apps`.execute(database)).rows).toEqual([
    { id: server, computerId: publisher.runnerId },
  ]);
  expect((await sql`select app_id from app_versions`.execute(database)).rows).toEqual([
    { appId: server },
  ]);
});
