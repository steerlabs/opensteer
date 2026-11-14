import { createId, TeamMessageIdSchema } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import {
  MigrationLineageError,
  migrateToLatest,
  migrationProvider,
  personalTeamBaselineName,
  teamKnowledgeNotesMigrationName,
  teamAgentMigrationName,
  teamAgentAsksMigrationName,
  teamPrincipalsMigrationName,
} from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { OpensteerStore } from "./store.js";
import { createPersonalRunFixturePort } from "./personal-run-fixture.test-support.js";
import { teamRequestView } from "./team-chat-store.js";
import {
  PersonalTeamRequestsStore,
  personalTeamRequestMirrorFromRow,
} from "./personal-team-requests-store.js";
import { personalTeamRunOutcome } from "./personal-team-run-store.js";
import { AccountDirectoryStore } from "./account-directory-store.js";

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

describe("fresh personal/team lineage", () => {
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
    const input = await store.enqueueThreadInput({
      threadId: base.thread.id,
      requestedBy: userId,
      source: { kind: "human" },
      policy: "queue",
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
        await store.enqueueThreadInput({
          threadId: thread.id,
          requestedBy: userId,
          source: { kind: "human" },
          policy: "queue",
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
  it("upgrades existing queued inputs with fresh context disabled in the table and work view", async () => {
    await migrateToLatest(database, migrationsBefore("0005_thread_input_fresh_context"));
    const { userId } = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    const store = new OpensteerStore(database);
    const { thread } = await createPersonalRunFixturePort(store).createTask({
      ownerId: userId,
      suffix: "before-fresh-context",
    });
    const input = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Already queued" }],
      idempotencyKey: "before-upgrade",
      policy: "queue",
      requestedBy: userId,
      source: { kind: "human" },
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
      }>`select conname as name,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid in ('specialists'::regclass,'browser_session_uses'::regclass) and contype='u' order by conname`.execute(
        database,
      )
    ).rows;
    expect(constraints).toEqual([
      {
        name: "browser_session_uses_identity",
        definition: "UNIQUE NULLS NOT DISTINCT (session_id, thread_id, run_id, tab_id)",
      },
      { name: "specialists_plugin_owner", definition: "UNIQUE (plugin_id, owner_user_id)" },
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
      .selectFrom("runners")
      .select("accessPolicy")
      .where("id", "=", fixture.runnerId)
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
    ["browser_tab_layouts", "tab_order", "jsonb", "NO"],
    ["machine_access_events", "id", "bigint", "YES"],
    ["mcp_oauth_credentials", "encrypted_state", "bytea", "NO"],
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
      await tx
        .insertInto("pluginOwnerSettings")
        .values({
          ownerUserId: owner,
          targetKey: '["service","records"]',
          target: { kind: "service", definitionId: "records" },
          enabled: true,
          revision: 1,
        })
        .execute();
      await tx
        .updateTable("pluginOwnerSettings")
        .set({ enabled: false })
        .where("ownerUserId", "=", owner)
        .execute();
      expect(await generation()).toBeUndefined();
      expect(
        await tx.selectFrom("integrationAuthorityPending").select("ownerUserId").execute(),
      ).toEqual([{ ownerUserId: owner }]);
    });
    expect(await generation()).toEqual({ generation: 1 });
    const rejection = new Error("rejected mutation");
    await expect(
      database.transaction().execute(async (tx) => {
        await tx
          .updateTable("pluginOwnerSettings")
          .set({ enabled: true })
          .where("ownerUserId", "=", owner)
          .execute();
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
