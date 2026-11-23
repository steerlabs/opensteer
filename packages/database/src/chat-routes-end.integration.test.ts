import {
  ChannelDashboardSchema,
  channelProviderCatalog,
  createChannelId,
  type ChannelConversationId,
} from "@opensteer/channel-core";
import { MessageAuthorSchema, ThreadSchema, type RequestPresentation } from "@opensteer/core";
import { AgentConnectionSchema, BrowserProfileSchema } from "@opensteer/protocol";
import { outsideName } from "@opensteer/shared/outsideName";
import { TriggerViewSchema } from "@opensteer/triggers/models";
import { sql, type Kysely } from "kysely";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { AppStore } from "./app-store.js";
import { createBrowserProfile } from "./browser-session-store.js";
import { PERSONAL_TEAM_BASELINE_SQL } from "./baseline-schema.js";
import { chatRoutesEndMigrationName } from "./chat-routes-end-migration.js";
import type { LineageAttempt } from "./connection-disconnect.js";
import { migrateToLatest, migrationProvider } from "./migrations.js";
import { chatEndedMessage, lineagePersonalContext } from "./resource-access.js";
import type { DatabaseSchema } from "./schema.js";
import {
  describeStore,
  testChannelAccessPolicy,
  testMessagingRunnerId,
  testModelSelection,
} from "./store.integration.test-support.js";
import { personTaskReader } from "./task-reader.js";
import { TriggerStore } from "./trigger-store.js";

/** The route tables the release before chats had, exactly as its schema (the baseline) made them. */
const routeTables = [
  "channel_bindings",
  "channel_conversations",
  "channel_access_grants",
  "channel_deliveries",
  "channel_link_codes",
];
async function restoreRoutes(database: Kysely<DatabaseSchema>): Promise<void> {
  const statements = PERSONAL_TEAM_BASELINE_SQL.split(/;\s*\n/u).map((part) => part.trim());
  const table = (name: string) =>
    statements.find((part) => part.startsWith(`create table ${name} (`))!;
  for (const name of routeTables) await sql.raw(table(name)).execute(database);
  const ingress = table("channel_ingress_events");
  const column = ingress.split("\n").find((line) => line.trim().startsWith('"conversation_id"'))!;
  await sql
    .raw(`alter table channel_ingress_events add column ${column.trim().replace(/,$/u, "")}`)
    .execute(database);
  // Their keys, then what refers to them and what they refer to, then their indexes.
  const ofRoutes = (part: string) =>
    routeTables.some((name) => part.startsWith(`alter table ${name} add constraint`)) ||
    part.startsWith(
      "alter table channel_ingress_events add constraint channel_ingress_events_conversation_id_fkey",
    );
  for (const part of statements.filter(ofRoutes).filter((part) => !part.includes("FOREIGN KEY")))
    await sql.raw(part).execute(database);
  for (const part of statements.filter(ofRoutes).filter((part) => part.includes("FOREIGN KEY")))
    await sql.raw(part).execute(database);
  for (const part of statements)
    if (
      /^create (UNIQUE )?index \S+ on (\S+) /u.exec(part) &&
      routeTables.includes(/ on (\S+) /u.exec(part)![1]!)
    )
      await sql.raw(part).execute(database);
}

/**
 * Runs migration `0109_chat_routes_end_contract` once more, and only it, through the migrator:
 * the ledger rows from 0109 on are set aside, the migrator sees the list cut after 0109, and the
 * rows of the later migrations are put back. No later migration is ever run a second time, so
 * nothing a later migration adds has to be undone here.
 */
async function replayFromChatRoutesEnd(database: Kysely<DatabaseSchema>): Promise<void> {
  const ledger = await sql<{ name: string; timestamp: string }>`
    select name, timestamp from kysely_migration where name > ${chatRoutesEndMigrationName}`.execute(
    database,
  );
  await sql`delete from kysely_migration where name >= ${chatRoutesEndMigrationName}`.execute(
    database,
  );
  const all = await migrationProvider().getMigrations();
  const throughChatRoutesEnd = Object.fromEntries(
    Object.entries(all).filter(([name]) => name <= chatRoutesEndMigrationName),
  );
  await migrateToLatest(database, { getMigrations: async () => throughChatRoutesEnd });
  for (const row of ledger.rows)
    await sql`insert into kysely_migration (name, timestamp) values (${row.name}, ${row.timestamp})`.execute(
      database,
    );
}

describeStore("the update ends chat routes, and the work they ran keeps what it had", (it) => {
  it("ties work that ran without personal context to an ended row, keeps the person's own, and cancels what routes queued", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("routes-end", {
      bridge: false,
    });
    const create = (key: string, extra: Record<string, unknown> = {}) =>
      store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: key,
        modelSelection: testModelSelection,
        title: key,
        ...extra,
      });
    // What the release before chats left: a route, a conversation anyone could speak in (its task
    // ran without the person's personal context, and so did one made under it), and the
    // person's own direct messages (their task ran with it). Each has a message still queued.
    const anyone = fixture.thread.id;
    const { thread: under } = await create("under-anyone", { parentThreadId: anyone });
    const { thread: own } = await create("own-dm");
    await restoreRoutes(database);
    const route = `chb_${crypto.randomUUID()}`;
    await sql`insert into channel_bindings (id, account_id, created_by, selector, execution_policy,
        access_policy, revision, status)
      values (${route}, ${configured.account.id}, ${fixture.userId}, '{}'::jsonb, '{}'::jsonb,
        ${JSON.stringify(testChannelAccessPolicy("anyone"))}::jsonb, 1, 'active')`.execute(
      database,
    );
    const conversation = (id: string, personal: boolean, thread: string, type: string) =>
      sql`insert into channel_conversations (id, account_id, provider, external_account_id,
          binding_id, binding_revision, external_conversation_id, conversation_type,
          active_thread_id, provider_state, personal_context)
        values (${id}, ${configured.account.id}, 'slack', 'T-routes-end', ${route}, 1, ${id},
          ${type}, ${thread}, '{}'::jsonb, ${personal})`.execute(database);
    const channel = createChannelId("conversation");
    const direct = createChannelId("conversation");
    await conversation(channel, false, anyone, "channel");
    await conversation(direct, true, own.id, "dm");
    // The person's own identity on the account: what they send in their direct messages is theirs.
    const { upsertChannelIdentity } = await import("./channel-store.js");
    const { commitPersonalMutation } = await import("./personal-mutation.js");
    const me = await commitPersonalMutation(database, (tx) =>
      upsertChannelIdentity(tx, {
        accountId: configured.account.id,
        displayName: "Owner",
        externalUserId: "U-OWNER",
      } as never),
    );
    await database
      .updateTable("channelIdentities")
      .set({ status: "linked", linkedUserId: fixture.userId })
      .where("id", "=", me.id as never)
      .execute();
    const queued = async (
      threadId: string,
      conversationId: string,
      key: string,
      sender: string | null = null,
    ) => {
      const input = await store.enqueueThreadInput({
        requestedBy: fixture.userId,
        threadId: threadId as never,
        content: [{ type: "text", text: key }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: key,
      });
      await sql`update thread_inputs set authority_source = ${JSON.stringify({
        kind: "channel-ingress",
        conversationId,
      })}::jsonb, actor_principal_id = coalesce(${sender}, actor_principal_id)
        where message_id = ${input.message.id}`.execute(database);
      return input.message.id;
    };
    const fromChannel = await queued(anyone, channel, "queued-in-channel");
    const fromDirect = await queued(own.id, direct, "queued-in-dm", me.principalId as string);
    // One waiting behind the first, one long delivered (history), and one whose outcome is
    // unknown: it may have been acted on, and stays unknown.
    const behind = await queued(anyone, channel, "behind-in-channel");
    const delivered = await queued(anyone, channel, "delivered-in-channel");
    await database
      .updateTable("threadInputs")
      .set({ state: "delivered" })
      .where("messageId", "=", delivered as never)
      .execute();
    const unknown = await queued(anyone, channel, "unknown-in-channel");
    await database
      .updateTable("threadInputs")
      .set({ state: "unknown" })
      .where("messageId", "=", unknown as never)
      .execute();
    // An earlier task of a direct-message conversation that ran without personal context: the
    // person spoke in it, but the conversation was not theirs to read.
    const { thread: earlierDm } = await create("earlier-unpersonal-dm");
    const { thread: laterDm } = await create("later-unpersonal-dm");
    const unpersonalDm = createChannelId("conversation");
    await conversation(unpersonalDm, false, laterDm.id, "dm");
    await queued(earlierDm.id, unpersonalDm, "earlier-dm-message", me.principalId as string);
    // Automations the anyone task reached: one it made (anchored to the person's own task), one
    // whose script it last wrote, and a task that second one sent work to.
    const { TriggerStore } = await import("./trigger-store.js");
    const triggers = new TriggerStore(database);
    const automation = async (key: string) => {
      const { thread: anchor } = await create(`${key}-anchor`);
      return triggers.create({
        actorThreadId: null,
        anchorThreadId: anchor.id,
        createdBy: fixture.userId,
        idempotencyKey: key,
        name: key,
        script: {
          interpreter: null,
          text: "console.log('ok')",
        },
        source: {
          kind: "schedule",
          schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
        },
      });
    };
    const made = await automation("made-by-anyone");
    await database
      .updateTable("triggers")
      .set({ createdByThreadId: anyone })
      .where("id", "=", made.trigger.id)
      .execute();
    const rewritten = await automation("rewritten-by-anyone");
    await database
      .updateTable("triggerRevisions")
      .set({ createdByThreadId: anyone })
      .where("id", "=", rewritten.revision.id)
      .execute();
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: rewritten.trigger.id,
    });
    const { thread: sentTo } = await create("sent-to-by-automation");
    const sent = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: sentTo.id,
      content: [{ type: "text", text: "From the automation" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "sent-by-automation",
    });
    await sql`update thread_inputs set authority_source = ${JSON.stringify({
      kind: "trigger-occurrence",
      occurrenceId: occurrence.id,
    })}::jsonb where message_id = ${sent.message.id}`.execute(database);

    // A title stored dirty before the Home cleaned names where they enter.
    await database
      .updateTable("threads")
      .set({ title: "Old\u202E\ntitle\u200D" })
      .where("id", "=", under.id)
      .execute();

    await replayFromChatRoutesEnd(database);

    expect(
      (
        await database
          .selectFrom("threads")
          .select("title")
          .where("id", "=", under.id)
          .executeTakeFirstOrThrow()
      ).title,
    ).toBe("Old title");
    const origin = async (id: string) =>
      (
        await database
          .selectFrom("threads")
          .select("originConnectionId")
          .where("id", "=", id as never)
          .executeTakeFirstOrThrow()
      ).originConnectionId;
    // Work that ran without personal context, and what was made under it, stays without it.
    const ended = await origin(anyone);
    expect(ended).not.toBeNull();
    expect(await origin(under.id)).toBe(ended);
    expect(await lineagePersonalContext(database, ended)).toBe(false);
    expect(
      await database
        .selectFrom("agentConnections")
        .select(["label", "bridgeSenders", "bridgeAccountId"])
        .select((eb) => eb("revokedAt", "is not", null).as("ended"))
        .where("id", "=", ended!)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      label: "Chats from before the update",
      bridgeSenders: "anyone",
      bridgeAccountId: null,
      ended: true,
    });
    // So does every task and automation it reached.
    expect(await origin(earlierDm.id)).toBe(ended);
    expect(await origin(sentTo.id)).toBe(ended);
    for (const trigger of [made.trigger.id, rewritten.trigger.id])
      expect(
        (
          await database
            .selectFrom("triggers")
            .select("originConnectionId")
            .where("id", "=", trigger)
            .executeTakeFirstOrThrow()
        ).originConnectionId,
        trigger,
      ).toBe(ended);
    // The ended row is removed: no list draws it, and its tasks still read it.
    expect(
      (
        await database
          .selectFrom("agentConnections")
          .select("removedAt")
          .where("id", "=", ended!)
          .executeTakeFirstOrThrow()
      ).removedAt,
    ).not.toBeNull();
    // The person's own stays theirs, as it was.
    expect(await origin(own.id)).toBeNull();
    // Nothing of the routes is kept, and no chat was made from them.
    const { rows } = await sql<{ gone: boolean }>`select ${sql.join(
      routeTables.map((name) => sql`to_regclass(${name}) is null`),
      sql` and `,
    )} as gone`.execute(database);
    expect(rows).toEqual([{ gone: true }]);
    expect(
      await database
        .selectFrom("agentConnections")
        .select("id")
        .where("bridgeAccountId", "is not", null)
        .execute(),
    ).toEqual([]);

    // Each message says what is true of where it came from, its state untouched.
    const input = (id: string) =>
      database
        .selectFrom("threadInputs")
        .select(["state", "authoritySource", "connectionId"])
        .where("messageId", "=", id as never)
        .executeTakeFirstOrThrow();
    const fromTheEndedChat = { kind: "connection", connectionId: ended, userId: fixture.userId };
    expect(await input(fromChannel)).toMatchObject({
      state: "pending",
      authoritySource: fromTheEndedChat,
      connectionId: ended,
    });
    expect(await input(delivered)).toMatchObject({
      state: "delivered",
      authoritySource: fromTheEndedChat,
    });
    expect(await input(unknown)).toMatchObject({
      state: "unknown",
      authoritySource: fromTheEndedChat,
    });
    expect(await input(fromDirect)).toMatchObject({
      state: "pending",
      authoritySource: { kind: "user-session", userId: fixture.userId },
      connectionId: null,
    });
    // The queued Run the route's message seeded names the ended row, and the ordinary claim
    // refuses it in a chat's words.
    const run = await database
      .selectFrom("runs")
      .select(["id", "connectionId"])
      .where("seedInputId", "=", fromChannel as never)
      .executeTakeFirstOrThrow();
    expect(run.connectionId).toBe(ended);
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", run.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    const claimed = await store.claimCommand(command.id, "after-the-update");
    expect(claimed?.terminalFailure).toBe(chatEndedMessage);
    await store.failCommand(
      command.id,
      claimed!.terminalFailure!,
      claimed!.terminalFailureInput ?? "authority-cohort",
    );
    // Start recovery, as at any start: what waits for the ended chat is cancelled with its
    // queue by the code that cancels any waiting message of an ended connection; the person's
    // own waiting message goes on as theirs; the unknown stays unknown, history stays history.
    await store.recoverThreadWorkQueues();
    expect((await input(fromChannel)).state).toBe("cancelled");
    expect((await input(behind)).state).toBe("cancelled");
    expect((await input(unknown)).state).toBe("unknown");
    expect((await input(delivered)).state).toBe("delivered");
    expect((await input(fromDirect)).state).not.toBe("cancelled");

    // The task that ran without personal context takes no new work, and says why.
    await expect(
      store.enqueueThreadInput({
        requestedBy: fixture.userId,
        threadId: anyone,
        content: [{ type: "text", text: "More" }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: "after-the-update",
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: chatEndedMessage });
    // The person's own task goes on.
    await expect(
      store.enqueueThreadInput({
        requestedBy: fixture.userId,
        threadId: own.id,
        content: [{ type: "text", text: "More" }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: "own-after-the-update",
      }),
    ).resolves.toBeDefined();
    // And the person still reads all of them.
    for (const id of [anyone, under.id, own.id])
      expect(await store.getThreadForOwner(id as never, fixture.userId), id).not.toBeNull();

    // A chat is added again as on a Home that never had routes.
    const { AgentConnectionStore } = await import("./agent-connection-store.js");
    const chat = await new AgentConnectionStore(database).createBridge({
      userId: fixture.userId,
      accountId: configured.account.id,
      senders: "owner",
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    expect(chat).toMatchObject({ bridge: { accountId: configured.account.id, senders: "owner" } });
  });

  it("keeps the identity last used, after reading the person's own work against both", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("routes-me", {
      bridge: false,
    });
    const { upsertChannelIdentity } = await import("./channel-store.js");
    const { commitPersonalMutation } = await import("./personal-mutation.js");
    const identity = (externalUserId: string) =>
      commitPersonalMutation(database, (tx) =>
        upsertChannelIdentity(tx, {
          accountId: configured.account.id,
          displayName: externalUserId,
          externalUserId,
        } as never),
      );
    // What the release before chats allowed: the phone and the email address both "me". The
    // phone was linked first and used last; the email was linked last.
    await sql`drop index channel_identities_one_me`.execute(database);
    const phone = await identity("+14155550100");
    const email = await identity("owner@example.com");
    for (const [row, at] of [
      [phone, new Date(Date.now() - 600_000)],
      [email, new Date(Date.now() - 300_000)],
    ] as const)
      await database
        .updateTable("channelIdentities")
        .set({ status: "linked", linkedUserId: fixture.userId, updatedAt: at })
        .where("id", "=", row.id as never)
        .execute();
    await restoreRoutes(database);
    const route = `chb_${crypto.randomUUID()}`;
    await sql`insert into channel_bindings (id, account_id, created_by, selector, execution_policy,
        access_policy, revision, status)
      values (${route}, ${configured.account.id}, ${fixture.userId}, '{}'::jsonb, '{}'::jsonb,
        ${JSON.stringify(testChannelAccessPolicy("owner"))}::jsonb, 1, 'active')`.execute(database);
    const direct = createChannelId("conversation");
    // A task the person started from each identity, in their own direct messages.
    const task = async (key: string, sender: string, at: Date) => {
      const { thread } = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: key,
        modelSelection: testModelSelection,
        title: key,
      });
      const input = await store.enqueueThreadInput({
        requestedBy: fixture.userId,
        threadId: thread.id,
        content: [{ type: "text", text: key }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: key,
      });
      await sql`update thread_inputs set authority_source = ${JSON.stringify({
        kind: "channel-ingress",
        conversationId: direct,
      })}::jsonb, actor_principal_id = ${sender}, created_at = ${at}
        where message_id = ${input.message.id}`.execute(database);
      return thread.id;
    };
    const fromEmail = await task(
      "from-email",
      email.principalId as string,
      new Date(Date.now() - 200_000),
    );
    const fromPhone = await task(
      "from-phone",
      phone.principalId as string,
      new Date(Date.now() - 100_000),
    );
    await sql`insert into channel_conversations (id, account_id, provider, external_account_id,
        binding_id, binding_revision, external_conversation_id, conversation_type,
        active_thread_id, provider_state, personal_context)
      values (${direct}, ${configured.account.id}, 'slack', 'T-routes-me', ${route}, 1, ${direct},
        'dm', ${fromPhone}, '{}'::jsonb, true)`.execute(database);
    await replayFromChatRoutesEnd(database);
    // The phone, used last, stays "me".
    expect(
      await database
        .selectFrom("channelIdentities")
        .select("externalUserId")
        .where("accountId", "=", configured.account.id)
        .where("status", "=", "linked")
        .execute(),
    ).toEqual([{ externalUserId: "+14155550100" }]);
    // What the person said from either stays their own.
    for (const id of [fromEmail, fromPhone])
      expect(
        (
          await database
            .selectFrom("threads")
            .select("originConnectionId")
            .where("id", "=", id)
            .executeTakeFirstOrThrow()
        ).originConnectionId,
        id,
      ).toBeNull();
  });

  it("disconnects the ended row through ordinary cleanup: interrupts running work, cancels Requests, refuses human-seeded queued Runs, and stays hidden", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const running = await storeFixture.startRunFixture("routes-end-running");
    const { configured } = await storeFixture.createChannelDeliveryFixture(
      "routes-end-disconnect",
      {
        bridge: false,
      },
    );
    // Re-home the running task and a second tied task under the same owner, tied to a non-personal route.
    const { thread: humanQueuedTask } = await store.createThread({
      createdBy: running.userId,
      environmentId: running.environmentId,
      harnessInstanceId: running.harnessInstance.id,
      idempotencyKey: "routes-end-human-queued",
      modelSelection: testModelSelection,
      title: "human-queued-on-tied",
      parentThreadId: running.thread.id,
    });
    const humanQueued = await store.enqueueThreadInput({
      requestedBy: running.userId,
      threadId: humanQueuedTask.id,
      content: [{ type: "text", text: "Follow up from the person" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "routes-end-human-input",
    });
    expect(humanQueued.run?.status).toBe("queued");

    // A pending durable Request opened by the running task before the update.
    const questionPresentation: RequestPresentation = {
      kind: "form",
      title: "Proceed?",
      detail: "Confirm action.",
      fields: [
        {
          choices: [{ label: "Yes", value: "Yes" }],
          custom: false,
          id: "q1",
          multiSelect: false,
          prompt: "Proceed?",
          secret: false,
        },
      ],
    };
    const { request: pendingQuestion } = await store.requests.create({
      callId: "routes-end-question",
      kind: "person.question",
      mode: "durable",
      originatingRunId: running.run.id,
      originatingThreadId: running.thread.id,
      payload: { kind: "person.question" },
      presentation: questionPresentation,
      requestedBy: running.userId,
      requiredActor: "requester",
    });

    await restoreRoutes(database);
    const route = `chb_${crypto.randomUUID()}`;
    await sql`insert into channel_bindings (id, account_id, created_by, selector, execution_policy,
        access_policy, revision, status)
      values (${route}, ${configured.account.id}, ${running.userId}, '{}'::jsonb, '{}'::jsonb,
        ${JSON.stringify(testChannelAccessPolicy("anyone"))}::jsonb, 1, 'active')`.execute(
      database,
    );
    const channel = createChannelId("conversation");
    await sql`insert into channel_conversations (id, account_id, provider, external_account_id,
        binding_id, binding_revision, external_conversation_id, conversation_type,
        active_thread_id, provider_state, personal_context)
      values (${channel}, ${configured.account.id}, 'slack', 'T-routes-disconnect', ${route}, 1,
        ${channel}, 'channel', ${running.thread.id}, '{}'::jsonb, false)`.execute(database);

    await replayFromChatRoutesEnd(database);

    const ended = (
      await database
        .selectFrom("threads")
        .select("originConnectionId")
        .where("id", "=", running.thread.id)
        .executeTakeFirstOrThrow()
    ).originConnectionId;
    expect(ended).not.toBeNull();
    // Hidden (removed), with cleanup requested and NOT complete.
    expect(
      await database
        .selectFrom("agentConnections")
        .select(["removedAt", "cleanupRequestedAt", "cleanupCompletedAt", "cleanupReason"])
        .where("id", "=", ended!)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      removedAt: expect.any(Date),
      cleanupRequestedAt: expect.any(Date),
      cleanupCompletedAt: null,
      cleanupReason: "revoked",
    });
    // The ended row appears in no list.
    const connections = new AgentConnectionStore(database);
    expect(
      (await connections.list(running.userId, { includeRevoked: true })).find(
        ({ id }) => id === ended,
      ),
    ).toBeUndefined();

    // Every unfinished Run on a tied task (including one seeded by a human message) names the ended row.
    expect(
      await database
        .selectFrom("runs")
        .select(["id", "connectionId"])
        .where("id", "in", [running.run.id, humanQueued.run!.id])
        .orderBy("id")
        .execute(),
    ).toEqual(
      [running.run.id, humanQueued.run!.id].sort().map((id) => ({ id, connectionId: ended })),
    );
    // Claiming the human-seeded queued Run refuses it with the chat's sentence (never authority mismatch).
    const humanCommand = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", humanQueued.run!.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    const claimed = await store.claimCommand(humanCommand.id, "after-update-human-seeded");
    expect(claimed?.terminalFailure).toBe(chatEndedMessage);
    await store.failCommand(
      humanCommand.id,
      claimed!.terminalFailure!,
      claimed!.terminalFailureInput ?? "authority-cohort",
    );

    // Even before cleanup finishes, answering the tied task's pending Request is refused.
    await expect(
      store.requests.answerPersonQuestion({
        requestId: pendingQuestion.id,
        expectedRevision: (await store.requests.revision(pendingQuestion.id))!,
        resolvedBy: running.userId,
        response: { kind: "form", answers: { q1: ["Yes"] } },
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: chatEndedMessage });

    // Ordinary Disconnect cleanup sweeps the hidden row: interrupts the running Run with evidence
    // and cancels the pending Request.
    const stoppedAttempts: LineageAttempt[] = [];
    const driven = await store.driveConnectionCleanups({
      stopper: {
        stop: async (attempt) => {
          stoppedAttempts.push(attempt);
          return "ended";
        },
      },
    });
    expect(driven.failures).toEqual([]);
    expect(
      stoppedAttempts.some((a) => a.kind === "run-attempt" && a.runId === running.run.id),
    ).toBe(true);
    expect(
      await database
        .selectFrom("commands")
        .select("type")
        .where("runId", "=", running.run.id)
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toEqual([{ type: "run.interrupt" }]);
    expect(
      await database
        .selectFrom("runAttempts")
        .select(["connectionId", "terminalEvidenceAt"])
        .where("runId", "=", running.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ connectionId: ended, terminalEvidenceAt: expect.any(Date) });
    expect(
      await database
        .selectFrom("requests")
        .select(["status", "cancellationReason"])
        .where("id", "=", pendingQuestion.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "cancelled", cancellationReason: "authority-revoked" });
    expect(
      (
        await database
          .selectFrom("agentConnections")
          .select("cleanupCompletedAt")
          .where("id", "=", ended!)
          .executeTakeFirstOrThrow()
      ).cleanupCompletedAt,
    ).toBeInstanceOf(Date);
    // Still appears in no list after settling.
    expect(
      (await connections.list(running.userId, { includeRevoked: true })).find(
        ({ id }) => id === ended,
      ),
    ).toBeUndefined();
  });

  it("cleans every stored name column and JSON place in 0109 with outsideName", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const running = await storeFixture.startRunFixture("routes-end-names-run");
    const { channels, configured, fixture } = await storeFixture.createChannelDeliveryFixture(
      "routes-end-names",
      { bridge: false },
    );
    const connections = new AgentConnectionStore(database);
    const { upsertChannelIdentity } = await import("./channel-store.js");
    const { commitPersonalMutation } = await import("./personal-mutation.js");

    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    const zwjEmoji = "👩\u200D💻";
    const persian = "می\u200Cخواهم";
    const hundredEmoji = "😀".repeat(100); // 200 UTF-16 code units, over 100/120/160 caps
    const dirtyExternalId = `U\u202E\nFake${"x".repeat(200)}`;
    const rloWithWriting = `Helper\u202E\n${zwjEmoji} ${persian} ${england}`;

    // 1. agent_connections (label, client_name, bridge_conversation_name, identity_at_consent)
    const fallbackAgent = await connections.create({
      userId: fixture.userId,
      label: "Clean",
      clientName: "Clean",
      accessMode: "approval-required",
      resource: "https://home.example/mcp",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const emojiAgent = await connections.create({
      userId: fixture.userId,
      label: "Emoji",
      clientName: "Emoji",
      accessMode: "approval-required",
      resource: "https://home.example/mcp",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const bridgeAgent = await connections.createBridge({
      userId: fixture.userId,
      accountId: configured.account.id,
      conversation: { id: "C-names", name: "#ops" },
      senders: "anyone",
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const bridgeConvId = createChannelId("conversation") as ChannelConversationId;
    await database
      .insertInto("bridgeConversations")
      .values({
        id: bridgeConvId,
        bridgeId: bridgeAgent.id,
        accountId: configured.account.id,
        externalScopeId: null,
        externalConversationId: "C-names",
        externalThreadId: null,
        conversationType: "channel",
        displayName: "Clean chat",
        threadId: null,
      })
      .execute();

    // 2. channel_identities & principals
    const sender = await commitPersonalMutation(database, (tx) =>
      upsertChannelIdentity(tx, {
        accountId: configured.account.id,
        displayName: "Sender",
        externalUserId: dirtyExternalId,
      } as never),
    );

    // 3. channel_ingress_events
    const { ingressId: dirtyIngressId } = await channels.commitIngress(configured.connection.id, {
      accountExternalId: configured.account.externalAccountId,
      actor: { displayName: "Sender", externalUserId: dirtyExternalId },
      content: [{ type: "text", text: "hi" }],
      conversation: {
        displayName: "Conv",
        externalConversationId: "C-names",
        externalScopeId: null,
        externalThreadId: null,
        type: "channel",
      },
      eventId: "E-names-1",
      occurredAt: new Date().toISOString(),
      provider: "slack",
      providerMessageId: "M-names-1",
      trigger: "mention",
    });
    const { ingressId: fallbackIngressId } = await channels.commitIngress(
      configured.connection.id,
      {
        accountExternalId: configured.account.externalAccountId,
        actor: { displayName: "Sender", externalUserId: dirtyExternalId },
        content: [{ type: "text", text: "hi2" }],
        conversation: {
          displayName: "Conv2",
          externalConversationId: "C-names-2",
          externalScopeId: null,
          externalThreadId: null,
          type: "channel",
        },
        eventId: "E-names-2",
        occurredAt: new Date().toISOString(),
        provider: "slack",
        providerMessageId: "M-names-2",
        trigger: "mention",
      },
    );

    // 4. apps + transcript_items (app card), triggers, browser_profiles, messages.author
    const apps = new AppStore(database);
    const app = await apps.commit({
      html: { sha256: "0".repeat(64), sizeBytes: 12 },
      name: "Clean app",
      publishKey: "routes-end-names-app",
      scope: {
        environmentId: running.environmentId,
        userId: running.userId,
        runId: running.run.id,
        threadId: running.threadId,
      },
    });
    const triggers = new TriggerStore(database);
    const { trigger } = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "routes-end-names-trigger",
      name: "Clean trigger",
      script: {
        interpreter: null,
        text: "console.log('ok')",
      },
      source: {
        kind: "schedule",
        schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
      },
    });
    const profile = await createBrowserProfile(database, {
      homeRunnerId: null,
      idempotencyKey: "routes-end-names-profile",
      name: "Clean profile",
      ownerId: fixture.userId,
    });
    const msg = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
      content: [{ type: "text", text: "msg" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "routes-end-names-msg",
    });

    // Plant dirty pre-update values directly in every column and JSON place.
    const rawIdentity = {
      kind: "platform-and-embedder",
      platformOrigin: "https://platform.example",
      platformDirectoryId: "plat",
      platformName: rloWithWriting,
      embedderOrigin: "https://embed.example",
      embedderDirectoryId: "emb",
      embedderName: "\u00A0\u3000",
      keyThumbprint: "a".repeat(43),
      directoryRevision: 3,
      recordedAt: "2026-11-03T10:00:00.000Z",
    };
    await sql`update agent_connections set
      label = ${"\u00A0\u202E\u3000"},
      client_name = ${rloWithWriting},
      identity_at_consent = ${JSON.stringify(rawIdentity)}::jsonb
      where id = ${fallbackAgent.id}`.execute(database);
    await sql`update agent_connections set
      label = ${hundredEmoji},
      client_name = ${hundredEmoji}
      where id = ${emojiAgent.id}`.execute(database);
    await sql`update agent_connections set bridge_conversation_name = ${rloWithWriting}
      where id = ${bridgeAgent.id}`.execute(database);
    await sql`update bridge_conversations set display_name = ${rloWithWriting}
      where id = ${bridgeConvId}`.execute(database);
    await sql`update channel_accounts set
      display_name = ${"\u202E"},
      external_account_id = ${dirtyExternalId},
      handle = ${`  ${persian}\u202E\t${zwjEmoji}  `}
      where id = ${configured.account.id}`.execute(database);
    await sql`update integration_connections set display_name = ${hundredEmoji}
      where id = ${configured.connection.id}`.execute(database);
    await sql`update channel_identities set display_name = ${"\u00A0\u3000"}
      where id = ${sender.id}`.execute(database);
    await sql`update principals set display_name = ${rloWithWriting}
      where id = ${sender.principalId}`.execute(database);
    await sql`update threads set title = ${`${hundredEmoji} ${zwjEmoji} ${persian}`}
      where id = ${fixture.thread.id}`.execute(database);
    await sql`update threads set title = ${"\u00A0\u2003\u3000"}
      where id = ${running.threadId}`.execute(database);
    await sql`update apps set name = ${rloWithWriting} where id = ${app.appId}`.execute(database);
    await sql`update transcript_items set view = jsonb_set(view, '{title}', to_jsonb(${rloWithWriting}::text))
      where app_id = ${app.appId} and kind = 'app'`.execute(database);
    await sql`update triggers set name = ${hundredEmoji} where id = ${trigger.id}`.execute(
      database,
    );
    await sql`update browser_profiles set name = ${hundredEmoji} where id = ${profile.id}`.execute(
      database,
    );
    await sql`update messages set author = jsonb_set(author, '{displayName}', to_jsonb(${rloWithWriting}::text))
      where id = ${msg.message.id}`.execute(database);
    await sql`update channel_ingress_events set event = jsonb_set(
      jsonb_set(event, '{actor,displayName}', to_jsonb(${rloWithWriting}::text)),
      '{conversation,displayName}', to_jsonb(${`${zwjEmoji}\u202E\n${persian}`}::text))
      where id = ${dirtyIngressId}`.execute(database);
    await sql`update channel_ingress_events set event = jsonb_set(
      jsonb_set(event, '{actor,displayName}', to_jsonb(${"\u202E"}::text)),
      '{conversation,displayName}', to_jsonb(${"\u202E"}::text))
      where id = ${fallbackIngressId}`.execute(database);

    await restoreRoutes(database);
    await replayFromChatRoutesEnd(database);

    // Every stored value equals outsideName(old, cap) || fallback, preserving real writing joiners & flags.
    const listedAgents = AgentConnectionSchema.array().parse(
      await connections.list(fixture.userId, { includeRevoked: true }),
    );
    const cleanedFallback = listedAgents.find(({ id }) => id === fallbackAgent.id)!;
    expect(cleanedFallback.clientName).toBe(outsideName(rloWithWriting, 100));
    expect(cleanedFallback.label).toBe(outsideName(rloWithWriting, 100));
    expect(cleanedFallback.label).toContain(zwjEmoji);
    expect(cleanedFallback.label).toContain(persian);
    expect(cleanedFallback.label).toContain(england);
    expect(cleanedFallback.identityAtConsent).toMatchObject({
      platformName: outsideName(rloWithWriting, 100),
      embedderName: "Agent",
    });

    const cleanedEmoji = listedAgents.find(({ id }) => id === emojiAgent.id)!;
    expect(cleanedEmoji.label).toBe(outsideName(hundredEmoji, 120));
    expect(cleanedEmoji.label.length).toBe(120);
    expect(cleanedEmoji.clientName).toBe(outsideName(hundredEmoji, 100));
    expect(cleanedEmoji.clientName.length).toBe(100);

    const cleanedBridge = listedAgents.find(({ id }) => id === bridgeAgent.id)!;
    expect(cleanedBridge.bridge?.conversationName).toBe(outsideName(rloWithWriting, 160));
    expect(
      (
        await database
          .selectFrom("bridgeConversations")
          .select("displayName")
          .where("id", "=", bridgeConvId)
          .executeTakeFirstOrThrow()
      ).displayName,
    ).toBe(outsideName(rloWithWriting, 240));

    const dashboard = ChannelDashboardSchema.parse(
      await channels.dashboard(fixture.userId, channelProviderCatalog, [testMessagingRunnerId]),
    );
    const account = dashboard.accounts.find(({ id }) => id === configured.account.id)!;
    expect(account.displayName).toBe(outsideName(dirtyExternalId, 160));
    expect(account.handle).toBe(`${persian} ${zwjEmoji}`);
    const channelConn = dashboard.connections.find(({ id }) => id === configured.connection.id)!;
    expect(channelConn.displayName).toBe(outsideName(hundredEmoji, 160));
    expect(channelConn.displayName.length).toBe(160);

    expect(
      (
        await database
          .selectFrom("channelIdentities")
          .select("displayName")
          .where("id", "=", sender.id)
          .executeTakeFirstOrThrow()
      ).displayName,
    ).toBe(outsideName(dirtyExternalId, 160));
    expect(
      (
        await database
          .selectFrom("principals")
          .select("displayName")
          .where("id", "=", sender.principalId)
          .executeTakeFirstOrThrow()
      ).displayName,
    ).toBe(outsideName(rloWithWriting, 160));

    const emojiThread = ThreadSchema.parse(
      await store.getThreadForOwner(fixture.thread.id, fixture.userId),
    );
    expect(emojiThread.title).toBe(outsideName(`${hundredEmoji} ${zwjEmoji} ${persian}`, 240));
    const blankThread = ThreadSchema.parse(
      await store.getThreadForOwner(running.threadId, running.userId),
    );
    expect(blankThread.title).toBe("Task");

    expect((await apps.get(running.userId, app.appId)).name).toBe(outsideName(rloWithWriting, 160));
    const appCard = await database
      .selectFrom("transcriptItems")
      .select("view")
      .where("appId", "=", app.appId)
      .where("kind", "=", "app")
      .executeTakeFirstOrThrow();
    expect((appCard.view as { title?: string }).title).toBe(outsideName(rloWithWriting, 160));

    const triggerDetail = await triggers.getForOwner(
      trigger.id,
      fixture.userId,
      5,
      personTaskReader,
    );
    const cleanedTrigger = TriggerViewSchema.parse(triggerDetail!.trigger);
    expect(cleanedTrigger.name).toBe(outsideName(hundredEmoji, 160));
    expect(cleanedTrigger.name.length).toBe(160);

    const cleanedProfile = BrowserProfileSchema.parse(
      await database
        .selectFrom("browserProfiles")
        .select(["id", "name", "homeRunnerId"])
        .where("id", "=", profile.id)
        .executeTakeFirstOrThrow(),
    );
    expect(cleanedProfile.name).toBe(outsideName(hundredEmoji, 120));
    expect(cleanedProfile.name.length).toBe(120);

    const cleanedMsg = await database
      .selectFrom("messages")
      .select("author")
      .where("id", "=", msg.message.id)
      .executeTakeFirstOrThrow();
    expect(MessageAuthorSchema.parse(cleanedMsg.author)).toMatchObject({
      displayName: outsideName(rloWithWriting, 160),
    });

    const cleanedIngress = await database
      .selectFrom("channelIngressEvents")
      .select("event")
      .where("id", "=", dirtyIngressId)
      .executeTakeFirstOrThrow();
    expect(cleanedIngress.event).toMatchObject({
      actor: { displayName: outsideName(rloWithWriting, 160) },
      conversation: { displayName: `${zwjEmoji} ${persian}` },
    });
    const cleanedFallbackIngress = await database
      .selectFrom("channelIngressEvents")
      .select("event")
      .where("id", "=", fallbackIngressId)
      .executeTakeFirstOrThrow();
    expect(cleanedFallbackIngress.event).toMatchObject({
      actor: { displayName: outsideName(dirtyExternalId, 160) },
      conversation: { displayName: null },
    });
  });

  it("fails closed on orphaned channel-ingress inputs and clears reply_target on rewritten personal DM inputs and their unfinished Runs", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture(
      "routes-end-orphan-dm",
      { bridge: false },
    );
    const { upsertChannelIdentity } = await import("./channel-store.js");
    const { commitPersonalMutation } = await import("./personal-mutation.js");
    const me = await commitPersonalMutation(database, (tx) =>
      upsertChannelIdentity(tx, {
        accountId: configured.account.id,
        displayName: "Owner",
        externalUserId: "U-OWNER-ORPHAN",
      } as never),
    );
    await database
      .updateTable("channelIdentities")
      .set({ status: "linked", linkedUserId: fixture.userId })
      .where("id", "=", me.id as never)
      .execute();

    const { thread: orphanThread } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "routes-end-orphan-thread",
      modelSelection: testModelSelection,
      title: "orphan-thread",
    });
    const orphanInput = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: orphanThread.id,
      content: [{ type: "text", text: "Stranger message whose conversation row is missing" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "routes-end-orphan-input",
    });
    await sql`update thread_inputs set
      authority_source = ${JSON.stringify({
        kind: "channel-ingress",
        conversationId: createChannelId("conversation"),
      })}::jsonb
      where message_id = ${orphanInput.message.id}`.execute(database);

    // Personal DM with a live reply_target pointing at the route conversation being dropped.
    const dmRunning = await storeFixture.startRunFixture("routes-end-dm-reply-target");
    await restoreRoutes(database);
    const route = `chb_${crypto.randomUUID()}`;
    await sql`insert into channel_bindings (id, account_id, created_by, selector, execution_policy,
        access_policy, revision, status)
      values (${route}, ${configured.account.id}, ${dmRunning.userId}, '{}'::jsonb, '{}'::jsonb,
        ${JSON.stringify(testChannelAccessPolicy("owner"))}::jsonb, 1, 'active')`.execute(database);
    const dmConv = createChannelId("conversation");
    await sql`insert into channel_conversations (id, account_id, provider, external_account_id,
        binding_id, binding_revision, external_conversation_id, conversation_type,
        active_thread_id, provider_state, personal_context)
      values (${dmConv}, ${configured.account.id}, 'slack', 'T-dm-reply', ${route}, 1, ${dmConv},
        'dm', ${dmRunning.thread.id}, '{}'::jsonb, true)`.execute(database);
    const staleReplyTarget = { kind: "channel", conversationId: dmConv };
    await sql`update thread_inputs set
      authority_source = ${JSON.stringify({ kind: "channel-ingress", conversationId: dmConv })}::jsonb,
      actor_principal_id = ${me.principalId},
      reply_target = ${JSON.stringify(staleReplyTarget)}::jsonb
      where message_id = ${dmRunning.run.seedInputId}`.execute(database);
    await sql`update runs set reply_target = ${JSON.stringify(staleReplyTarget)}::jsonb
      where id = ${dmRunning.run.id}`.execute(database);

    await replayFromChatRoutesEnd(database);

    // Orphaned channel-ingress MUST fail closed: tied to the ended row, never user-session.
    const orphanAfter = await database
      .selectFrom("threads")
      .select("originConnectionId")
      .where("id", "=", orphanThread.id)
      .executeTakeFirstOrThrow();
    expect(orphanAfter.originConnectionId).not.toBeNull();
    const orphanInputAfter = await database
      .selectFrom("threadInputs")
      .select(["authoritySource", "connectionId"])
      .where("messageId", "=", orphanInput.message.id)
      .executeTakeFirstOrThrow();
    expect(orphanInputAfter).toMatchObject({
      authoritySource: { kind: "connection", connectionId: orphanAfter.originConnectionId },
      connectionId: orphanAfter.originConnectionId,
    });

    // Personal DM stays the person's own, and stale reply_target is cleared on input and Run.
    expect(
      (
        await database
          .selectFrom("threads")
          .select("originConnectionId")
          .where("id", "=", dmRunning.thread.id)
          .executeTakeFirstOrThrow()
      ).originConnectionId,
    ).toBeNull();
    expect(
      await database
        .selectFrom("threadInputs")
        .select(["authoritySource", "replyTarget"])
        .where("messageId", "=", dmRunning.run.seedInputId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      authoritySource: { kind: "user-session", userId: dmRunning.userId },
      replyTarget: null,
    });
    expect(
      (
        await database
          .selectFrom("runs")
          .select("replyTarget")
          .where("id", "=", dmRunning.run.id)
          .executeTakeFirstOrThrow()
      ).replyTarget,
    ).toBeNull();
    // A typed follow-up (replyTarget null) can now steer into the personal DM's running Run.
    const followUp = await store.enqueueThreadInput({
      requestedBy: dmRunning.userId,
      threadId: dmRunning.thread.id,
      content: [{ type: "text", text: "Typed follow-up" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "routes-end-dm-typed-followup",
    });
    await expect(
      store.steerThreadInput({
        expectedRunId: dmRunning.run.id,
        idempotencyKey: "routes-end-dm-steer",
        messageId: followUp.message.id,
        requestedBy: dmRunning.userId,
        threadId: dmRunning.thread.id,
      }),
    ).resolves.toMatchObject({ input: { state: "claimed", runId: dmRunning.run.id } });
  });

  it("sweeps paused, done, archived, awaiting-approval, and leased inputs through Disconnect, and defers invalid provider sessions during recovery", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture(
      "routes-end-sweep",
      { bridge: false },
    );
    const makeTask = (key: string, parentThreadId?: string) =>
      store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: key,
        modelSelection: testModelSelection,
        title: key,
        ...(parentThreadId ? { parentThreadId: parentThreadId as never } : {}),
      });
    const root = fixture.thread.id;
    const { thread: pausedTask } = await makeTask("sweep-paused", root);
    const { thread: doneTask } = await makeTask("sweep-done", root);
    const { thread: archivedTask } = await makeTask("sweep-archived", root);
    const { thread: approvalTask } = await makeTask("sweep-approval", root);

    const pausedInput = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: pausedTask.id,
      content: [{ type: "text", text: "paused-waiting" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "sweep-paused-input",
    });
    const doneInput = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: doneTask.id,
      content: [{ type: "text", text: "done-waiting" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "sweep-done-input",
    });
    const archivedInput = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: archivedTask.id,
      content: [{ type: "text", text: "archived-waiting" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "sweep-archived-input",
    });
    const approvalInput = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: approvalTask.id,
      content: [{ type: "text", text: "approval-waiting" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "sweep-approval-input",
    });

    // Clear queued runs so these inputs sit purely as queued/awaiting-approval inputs on non-normal tasks.
    await database
      .deleteFrom("runs")
      .where("threadId", "in", [pausedTask.id, doneTask.id, archivedTask.id, approvalTask.id])
      .execute();
    await database
      .updateTable("threads")
      .set({ inputQueuePaused: true })
      .where("id", "=", pausedTask.id)
      .execute();
    await database
      .updateTable("threadInputs")
      .set({
        editLeaseId: "lease-1",
        editLeaseSessionId: "aus_00000000-0000-4000-8000-000000000001" as never,
        editLeaseDeviceLabel: "Mac",
        editLeaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where("messageId", "=", pausedInput.message.id)
      .execute();
    await database
      .updateTable("threads")
      .set({ doneAt: new Date(), doneReason: "quiet" })
      .where("id", "=", doneTask.id)
      .execute();
    await database
      .updateTable("threads")
      .set({ status: "archived" })
      .where("id", "=", archivedTask.id)
      .execute();
    await sql`update thread_inputs set state = 'awaiting-approval' where message_id = ${approvalInput.message.id}`.execute(
      database,
    );

    // Deactivate the active provider_sessions row on a separate pending task so
    // recoverThreadWorkQueues encounters an invalid selection before later pending tasks.
    const { thread: brokenSessionTask } = await makeTask("sweep-broken-session");
    await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: brokenSessionTask.id,
      content: [{ type: "text", text: "broken-session-input" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "sweep-broken-session-input",
    });
    await database.deleteFrom("runs").where("threadId", "=", brokenSessionTask.id).execute();
    await database
      .updateTable("providerSessions")
      .set({ active: false })
      .where("threadId", "=", brokenSessionTask.id)
      .where("active", "=", true)
      .execute();

    await restoreRoutes(database);
    const route = `chb_${crypto.randomUUID()}`;
    await sql`insert into channel_bindings (id, account_id, created_by, selector, execution_policy,
        access_policy, revision, status)
      values (${route}, ${configured.account.id}, ${fixture.userId}, '{}'::jsonb, '{}'::jsonb,
        ${JSON.stringify(testChannelAccessPolicy("anyone"))}::jsonb, 1, 'active')`.execute(
      database,
    );
    const channel = createChannelId("conversation");
    await sql`insert into channel_conversations (id, account_id, provider, external_account_id,
        binding_id, binding_revision, external_conversation_id, conversation_type,
        active_thread_id, provider_state, personal_context)
      values (${channel}, ${configured.account.id}, 'slack', 'T-sweep', ${route}, 1, ${channel},
        'channel', ${root}, '{}'::jsonb, false)`.execute(database);

    await replayFromChatRoutesEnd(database);

    const ended = (
      await database
        .selectFrom("threads")
        .select("originConnectionId")
        .where("id", "=", root)
        .executeTakeFirstOrThrow()
    ).originConnectionId!;
    expect(ended).not.toBeNull();

    // Ordinary Disconnect cleanup sweeps all four waiting/awaiting-approval inputs with zero failures.
    const driven = await store.driveConnectionCleanups({
      stopper: { stop: async () => "ended" },
    });
    expect(driven.failures).toEqual([]);
    for (const messageId of [
      pausedInput.message.id,
      doneInput.message.id,
      archivedInput.message.id,
      approvalInput.message.id,
    ]) {
      expect(
        await database
          .selectFrom("threadInputs")
          .select(["state", "cancelReason", "editLeaseId"])
          .where("messageId", "=", messageId)
          .executeTakeFirstOrThrow(),
        messageId,
      ).toEqual({
        state: "cancelled",
        cancelReason: "authority-revoked",
        editLeaseId: null,
      });
    }
    expect(
      (
        await database
          .selectFrom("agentConnections")
          .select("cleanupCompletedAt")
          .where("id", "=", ended)
          .executeTakeFirstOrThrow()
      ).cleanupCompletedAt,
    ).toBeInstanceOf(Date);

    // recoverThreadWorkQueues defers the invalid provider session rather than aborting.
    await expect(store.recoverThreadWorkQueues()).resolves.toBeUndefined();
  });

  it("cleans every stored column Sol's entrances cover while leaving already-clean rows byte-for-byte unchanged", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const fixture = await storeFixture.createRunFixture("sol-stored-names");
    const deployment = await database
      .selectFrom("deployments")
      .select("id")
      .executeTakeFirstOrThrow();
    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    const cleanKeep = `Clean 👩\u200D💻 می\u200Cخواهم ${england}`;
    const dirty = `Dirty\u202E\n👩\u200D💻 می\u200Cخواهم ${england}`;
    const expectedClean = `Dirty 👩\u200D💻 می\u200Cخواهم ${england}`;
    const controlOnly = "\u202E\n\t";

    // 1. runner_enrollments.name
    const reDirty = `ren_${crypto.randomUUID()}`;
    const reClean = `ren_${crypto.randomUUID()}`;
    const reEmpty = `ren_${crypto.randomUUID()}`;
    for (const [id, name] of [
      [reDirty, dirty],
      [reClean, cleanKeep],
      [reEmpty, controlOnly],
    ] as const) {
      await sql`
        insert into runner_enrollments (id, name, token_hash, allowed_modules, created_by,
          owner_kind, owner_user_id, idempotency_key, request_fingerprint, runner_kind)
        values (${id}, ${name}, ${`hash-${id}`}, '[]'::jsonb, ${fixture.userId},
          'user', ${fixture.userId}, ${`idem-${id}`}, ${`fp-${id}`}, 'local')
      `.execute(database);
    }

    // 2. runners.name + 3. devices.name + 4. execution_environments.name
    const rDirty = `run_${crypto.randomUUID()}`;
    const rClean = `run_${crypto.randomUUID()}`;
    for (const [id, name] of [
      [rDirty, dirty],
      [rClean, cleanKeep],
    ] as const) {
      await sql`
        insert into runners (id, owner_kind, owner_user_id, name, kind, public_key_pem,
          public_key_fingerprint, enrollment_token_hash, capabilities, allowed_modules,
          module_descriptors, connection_generation)
        values (${id}, 'user', ${fixture.userId}, ${name}, 'local', ${`pem-${id}`},
          ${`fp-${id}`}, ${`eth-${id}`}, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 1)
      `.execute(database);
    }
    const devDirty = `dev_${crypto.randomUUID()}`;
    const devClean = `dev_${crypto.randomUUID()}`;
    for (const [id, name] of [
      [devDirty, dirty],
      [devClean, cleanKeep],
    ] as const) {
      await sql`
        insert into devices (id, deployment_id, owner_kind, owner_user_id, name, kind, access_policy)
        values (${id}, ${deployment.id}, 'user', ${fixture.userId}, ${name}, 'computer', '{}'::jsonb)
      `.execute(database);
    }
    const envDirty = `env_${crypto.randomUUID()}`;
    const envClean = `env_${crypto.randomUUID()}`;
    for (const [id, name, runnerId] of [
      [envDirty, dirty, rDirty],
      [envClean, cleanKeep, rClean],
    ] as const) {
      await sql`
        insert into execution_environments (id, name, kind, runner_id, capabilities)
        values (${id}, ${name}, 'local', ${runnerId}, '[]'::jsonb)
      `.execute(database);
    }

    // 5. integration_connections.display_name (computer connections, with & without computer_app)
    const connCompDirty = `con_${crypto.randomUUID()}`;
    const connCompClean = `con_${crypto.randomUUID()}`;
    const connAppDirty = `con_${crypto.randomUUID()}`;
    const connAppClean = `con_${crypto.randomUUID()}`;
    const appIdentity = { bundleId: "com.example.App", displayName: dirty, teamId: null };
    for (const [id, displayName, computerApp, appKey, runnerId, defId] of [
      [connCompDirty, dirty, null, null, rDirty, "def-comp-dirty"],
      [connCompClean, cleanKeep, null, null, rClean, "def-comp-clean"],
      [connAppDirty, dirty, appIdentity, "com.example.app.dirty", rDirty, "macos-app"],
      [connAppClean, cleanKeep, appIdentity, "com.example.app.clean", rClean, "macos-app"],
    ] as const) {
      await sql`
        insert into integration_connections (id, owner_user_id, provider, connection_kind,
          connection_method, display_name, status, capabilities, integration_definition_id,
          computer_app, computer_app_key, runner_id)
        values (${id}, ${fixture.userId}, 'computer-app', 'computer', 'computer',
          ${displayName}, 'connected', '[]'::jsonb, ${defId},
          ${computerApp === null ? null : JSON.stringify(computerApp)}::jsonb,
          ${appKey}, ${runnerId})
      `.execute(database);
    }

    // 6. integration_installations (title + manifest device name), plugin_versions, integration_tools, integration_grants
    const pluginDirty = `plg_${crypto.randomUUID()}`;
    const pluginClean = `plg_${crypto.randomUUID()}`;
    for (const [id, pkg] of [
      [pluginDirty, "pkg-dirty"],
      [pluginClean, "pkg-clean"],
    ] as const) {
      await sql`
        insert into plugins (id, name, scope, source, installed_by)
        values (${id}, ${pkg}, 'deployment', '{}'::jsonb, ${fixture.userId})
      `.execute(database);
    }
    const pvDirty = `plv_${crypto.randomUUID()}`;
    const pvClean = `plv_${crypto.randomUUID()}`;
    const manifestDirty = {
      name: "pkg-dirty",
      keepKey: "untouched",
      extensions: { "com.opensteer": { device: { kind: "other", name: dirty, extra: 1 } } },
    };
    const manifestClean = {
      name: "pkg-clean",
      keepKey: "untouched",
      extensions: { "com.opensteer": { device: { kind: "other", name: cleanKeep, extra: 1 } } },
    };
    for (const [id, pluginId, manifest] of [
      [pvDirty, pluginDirty, manifestDirty],
      [pvClean, pluginClean, manifestClean],
    ] as const) {
      await sql`
        insert into plugin_versions (id, plugin_id, digest, manifest)
        values (${id}, ${pluginId}, ${`dig-${id}`}, ${JSON.stringify(manifest)}::jsonb)
      `.execute(database);
    }
    const instDirty = `ins_${crypto.randomUUID()}`;
    const instClean = `ins_${crypto.randomUUID()}`;
    for (const [id, pluginId, title, manifest, pkg] of [
      [instDirty, pluginDirty, dirty, manifestDirty, "pkg-dirty"],
      [instClean, pluginClean, cleanKeep, manifestClean, "pkg-clean"],
    ] as const) {
      await sql`
        insert into integration_installations (id, name, title, description, plugin_id,
          source_kind, trust, manifest, provenance, status, revision, created_by, updated_by)
        values (${id}, ${pkg}, ${title}, '', ${pluginId}, 'plugin', 'administrator-approved',
          ${JSON.stringify(manifest)}::jsonb, '{}'::jsonb, 'active', 1, ${fixture.userId}, ${fixture.userId})
      `.execute(database);
    }
    const srvId = `srv_${crypto.randomUUID()}`;
    await sql`
      insert into integration_servers (id, installation_id, name, transport, connection_requirement,
        status, tool_generation)
      values (${srvId}, ${instDirty}, 'srv-name', '{}'::jsonb, '{}'::jsonb, 'active', 1)
    `.execute(database);
    const toolDirty = `itl_${crypto.randomUUID()}`;
    const toolClean = `itl_${crypto.randomUUID()}`;
    for (const [id, title, annotations] of [
      [toolDirty, dirty, { title: dirty, readOnlyHint: true }],
      [toolClean, cleanKeep, { title: cleanKeep, readOnlyHint: true }],
    ] as const) {
      await sql`
        insert into integration_tools (id, server_id, name, title, description, input_schema,
          annotations, schema_digest, status)
        values (${id}, ${srvId}, ${`machine\u200DName-${id}`}, ${title}, '', '{}'::jsonb,
          ${JSON.stringify(annotations)}::jsonb, ${`sd-${id}`}, 'active')
      `.execute(database);
    }
    const grantDirty = `igr_${crypto.randomUUID()}`;
    const grantClean = `igr_${crypto.randomUUID()}`;
    for (const [id, alias] of [
      [grantDirty, dirty],
      [grantClean, cleanKeep],
    ] as const) {
      await sql`
        insert into integration_grants (id, owner_user_id, installation_id, connection_id,
          alias, access, is_default, created_by, status)
        values (${id}, ${fixture.userId}, ${instDirty}, ${connAppDirty},
          ${alias}, 'read', false, ${fixture.userId}, 'active')
      `.execute(database);
    }

    // 7. computer_app_setup_requests.server -> installationTitle
    const setupDirty = `csr_${crypto.randomUUID()}`;
    const setupClean = `csr_${crypto.randomUUID()}`;
    for (const [id, installationTitle] of [
      [setupDirty, dirty],
      [setupClean, cleanKeep],
    ] as const) {
      await sql`
        insert into computer_app_setup_requests (id, kind, deployment_id, owner_user_id,
          runner_id, definition_id, definition_digest, access, server)
        values (${id}, 'server', ${deployment.id}, ${fixture.userId}, ${devDirty},
          'def-1', 'dig-1', 'read',
          ${JSON.stringify({ installationTitle, name: "srv-name", serverId: srvId })}::jsonb)
      `.execute(database);
    }

    // 8. requests.presentation (computer.app.access title & detail, harness.approval title)
    const runFixture = await storeFixture.startRunFixture("sol-stored-run");
    const reqAppDirty = `req_${crypto.randomUUID()}`;
    const reqAppClean = `req_${crypto.randomUUID()}`;
    const reqHarnDirty = `req_${crypto.randomUUID()}`;
    const reqHarnClean = `req_${crypto.randomUUID()}`;
    for (const [id, kind, presentation] of [
      [
        reqAppDirty,
        "computer.app.access",
        {
          kind: "external",
          title: dirty,
          detail: dirty,
          subject: { id: "sub-1", kind: "computer-app" },
        },
      ],
      [
        reqAppClean,
        "computer.app.access",
        {
          kind: "external",
          title: cleanKeep,
          detail: cleanKeep,
          subject: { id: "sub-2", kind: "computer-app" },
        },
      ],
      [
        reqHarnDirty,
        "harness.approval",
        {
          kind: "choice",
          title: dirty,
          options: [{ id: "allow", label: "Allow", hint: "allow-once" }],
        },
      ],
      [
        reqHarnClean,
        "harness.approval",
        {
          kind: "choice",
          title: cleanKeep,
          options: [{ id: "allow", label: "Allow", hint: "allow-once" }],
        },
      ],
    ] as const) {
      await sql`
        insert into requests (id, originating_thread_id, originating_run_id, call_id, kind, mode,
          required_actor, requested_by, status, presentation, payload)
        values (${id}, ${runFixture.threadId}, ${runFixture.run.id}, ${`call-${id}`}, ${kind},
          'durable', 'requester', ${runFixture.userId}, 'pending',
          ${JSON.stringify(presentation)}::jsonb, ${JSON.stringify({ kind })}::jsonb)
      `.execute(database);
    }

    // 9. tool_calls.integration -> computerApp -> app
    const tcDirty = `tcl_${crypto.randomUUID()}`;
    const tcClean = `tcl_${crypto.randomUUID()}`;
    for (const [id, appName] of [
      [tcDirty, dirty],
      [tcClean, cleanKeep],
    ] as const) {
      await sql`
        insert into tool_calls (id, thread_id, run_id, call_id, origin, tool, integration,
          arguments, status, started_at)
        values (${id}, ${runFixture.threadId}, ${runFixture.run.id}, ${`call-${id}`}, 'host-computer',
          '{"name":"computer"}'::jsonb,
          ${JSON.stringify({ kind: "computer-app", connectionId: connAppDirty, computerApp: { app: appName, bundleId: "com.example.App" } })}::jsonb,
          '{}'::jsonb, 'open', now())
      `.execute(database);
    }

    // 10. browser_profiles.name + personal_tabs (title, profile_name) + browser_history_entries.title + browser_session_uses.page_title
    const bpDirty = await createBrowserProfile(database, {
      homeRunnerId: null,
      idempotencyKey: "sol-bp-dirty",
      name: "seed-dirty",
      ownerId: fixture.userId,
    });
    const bpClean = await createBrowserProfile(database, {
      homeRunnerId: null,
      idempotencyKey: "sol-bp-clean",
      name: "seed-clean",
      ownerId: fixture.userId,
    });
    const bpEmpty = await createBrowserProfile(database, {
      homeRunnerId: null,
      idempotencyKey: "sol-bp-empty",
      name: "seed-empty",
      ownerId: fixture.userId,
    });
    await sql`update browser_profiles set name = ${dirty} where id = ${bpDirty.id}`.execute(
      database,
    );
    await sql`update browser_profiles set name = ${cleanKeep} where id = ${bpClean.id}`.execute(
      database,
    );
    await sql`update browser_profiles set name = ${controlOnly} where id = ${bpEmpty.id}`.execute(
      database,
    );

    const tabDirty = `tab_${crypto.randomUUID()}`;
    const tabClean = `tab_${crypto.randomUUID()}`;
    for (const [id, title, profileId, profileName] of [
      [tabDirty, dirty, bpDirty.id, dirty],
      [tabClean, cleanKeep, bpClean.id, cleanKeep],
    ] as const) {
      await sql`
        insert into personal_tabs (id, owner_id, kind, computer_id, title, url, profile_id,
          profile_name, opened_by)
        values (${id}, ${fixture.userId}, 'page', ${devDirty}, ${title},
          ${`https://example.com/${id}`}, ${profileId}, ${profileName}, '"person"'::jsonb)
      `.execute(database);
    }

    const histUrlDirty = "https://example.com/hist-dirty";
    const histUrlClean = "https://example.com/hist-clean";
    await sql`
      insert into browser_history_entries (profile_id, url, origin, title, typed_count, visit_count)
      values (${bpDirty.id}, ${histUrlDirty}, 'https://example.com', ${dirty}, 0, 1),
             (${bpClean.id}, ${histUrlClean}, 'https://example.com', ${cleanKeep}, 0, 1)
    `.execute(database);

    const bsnDirty = `bsn_${crypto.randomUUID()}`;
    const bsnClean = `bsn_${crypto.randomUUID()}`;
    for (const [id, profileId] of [
      [bsnDirty, bpDirty.id],
      [bsnClean, bpClean.id],
    ] as const) {
      await sql`
        insert into browser_sessions (id, tab_group_id, origin, profile_id, placement_key,
          runner_id, runtime_id, state)
        values (${id}, ${id}, 'agent', ${profileId}, ${`pk-${id}`}, ${rDirty}, ${`rt-${id}`}, 'ready')
      `.execute(database);
    }
    const bsuDirty = `bsu_${crypto.randomUUID()}`;
    const bsuClean = `bsu_${crypto.randomUUID()}`;
    for (const [id, sessionId, pageTitle] of [
      [bsuDirty, bsnDirty, dirty],
      [bsuClean, bsnClean, cleanKeep],
    ] as const) {
      await sql`
        insert into browser_session_uses (id, session_id, thread_id, page_title, page_site)
        values (${id}, ${sessionId}, ${runFixture.threadId}, ${pageTitle}, 'https://example.com')
      `.execute(database);
    }

    // 11. runs.latest_place, threads.latest_place, threads.title (external worker), transcript_items (kind='place' body & view), triggers.name
    const runCleanFixture = await storeFixture.startRunFixture("sol-stored-run-clean");
    const extConnId = `mcn_${crypto.randomUUID()}`;
    await sql`
      insert into agent_connections (id, user_id, label, client_name, access_mode, resource,
        created_at, expires_at, "grant", grant_revision, consent_version)
      values (${extConnId}, ${runFixture.userId}, 'Clean agent', 'Clean agent', 'approval-required',
        'opensteer:mcp', now(), now() + interval '1 day',
        '{"scope":"selected","tasks":true,"resources":[]}'::jsonb, 2, 2)
    `.execute(database);
    const placeDirty = { tabId: tabDirty, title: dirty, site: "https://example.com" };
    const placeClean = { tabId: tabClean, title: cleanKeep, site: "https://example.com" };
    await sql`update runs set latest_place = ${JSON.stringify(placeDirty)}::jsonb where id = ${runFixture.run.id}`.execute(
      database,
    );
    await sql`update runs set latest_place = ${JSON.stringify(placeClean)}::jsonb where id = ${runCleanFixture.run.id}`.execute(
      database,
    );
    await sql`update threads set latest_place = ${JSON.stringify(placeDirty)}::jsonb, worker = 'external', origin_connection_id = ${extConnId}, title = ${controlOnly} where id = ${runFixture.threadId}`.execute(
      database,
    );
    await sql`update threads set latest_place = ${JSON.stringify(placeClean)}::jsonb, worker = 'external', origin_connection_id = ${extConnId}, title = ${cleanKeep} where id = ${runCleanFixture.threadId}`.execute(
      database,
    );
    const tiDirty = `tri_${crypto.randomUUID()}`;
    const tiClean = `tri_${crypto.randomUUID()}`;
    for (const [id, threadId, runId, place] of [
      [tiDirty, runFixture.threadId, runFixture.run.id, placeDirty],
      [tiClean, runCleanFixture.threadId, runCleanFixture.run.id, placeClean],
    ] as const) {
      await sql`
        insert into transcript_items (id, thread_id, run_id, kind, position, revision, visible,
          is_turn_start, created_at, body, view)
        values (${id}, ${threadId}, ${runId}, 'place', 999999, 1, true, false, now(),
          ${JSON.stringify(place)}::jsonb,
          ${JSON.stringify({ title: place.title, preview: "https://example.com" })}::jsonb)
      `.execute(database);
    }

    const triggers = new TriggerStore(database);
    const trigDirty = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "sol-trig-dirty",
      name: "seed-trig-dirty",
      script: {
        interpreter: null,
        text: "console.log('ok')",
      },
      source: {
        kind: "schedule",
        schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
      },
    });
    const trigClean = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "sol-trig-clean",
      name: "seed-trig-clean",
      script: {
        interpreter: null,
        text: "console.log('ok')",
      },
      source: {
        kind: "schedule",
        schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
      },
    });
    await sql`update triggers set name = ${dirty} where id = ${trigDirty.trigger.id}`.execute(
      database,
    );
    await sql`update triggers set name = ${cleanKeep} where id = ${trigClean.trigger.id}`.execute(
      database,
    );

    // Re-run 0109 directly on this populated database.
    await restoreRoutes(database);
    await replayFromChatRoutesEnd(database);

    const readOne = async <T>(query: ReturnType<typeof sql<T>>) =>
      (await query.execute(database)).rows[0]!;

    // Assert every forged row is cleaned and every already-clean row is byte-for-byte unchanged.
    expect(
      (
        await readOne<{ v: string }>(
          sql`select name as v from runner_enrollments where id = ${reDirty}`,
        )
      ).v,
    ).toBe(expectedClean);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select name as v from runner_enrollments where id = ${reClean}`,
        )
      ).v,
    ).toBe(cleanKeep);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select name as v from runner_enrollments where id = ${reEmpty}`,
        )
      ).v,
    ).toBe("Computer");

    expect(
      (await readOne<{ v: string }>(sql`select name as v from runners where id = ${rDirty}`)).v,
    ).toBe(expectedClean);
    expect(
      (await readOne<{ v: string }>(sql`select name as v from runners where id = ${rClean}`)).v,
    ).toBe(cleanKeep);

    expect(
      (await readOne<{ v: string }>(sql`select name as v from devices where id = ${devDirty}`)).v,
    ).toBe(expectedClean);
    expect(
      (await readOne<{ v: string }>(sql`select name as v from devices where id = ${devClean}`)).v,
    ).toBe(cleanKeep);

    expect(
      (
        await readOne<{ v: string }>(
          sql`select name as v from execution_environments where id = ${envDirty}`,
        )
      ).v,
    ).toBe(expectedClean);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select name as v from execution_environments where id = ${envClean}`,
        )
      ).v,
    ).toBe(cleanKeep);

    expect(
      (
        await readOne<{ v: string }>(
          sql`select display_name as v from integration_connections where id = ${connCompDirty}`,
        )
      ).v,
    ).toBe(expectedClean);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select display_name as v from integration_connections where id = ${connCompClean}`,
        )
      ).v,
    ).toBe(cleanKeep);
    const appConnRow = await readOne<{ v: string; app: unknown }>(
      sql`select display_name as v, computer_app as app from integration_connections where id = ${connAppDirty}`,
    );
    expect(appConnRow.v).toBe(expectedClean);
    // Reviewed Mac app identity JSON is compared for identity and must stay untouched.
    expect(appConnRow.app).toEqual(appIdentity);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select display_name as v from integration_connections where id = ${connAppClean}`,
        )
      ).v,
    ).toBe(cleanKeep);

    expect(
      (
        await readOne<{ v: string }>(
          sql`select alias as v from integration_grants where id = ${grantDirty}`,
        )
      ).v,
    ).toBe(expectedClean);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select alias as v from integration_grants where id = ${grantClean}`,
        )
      ).v,
    ).toBe(cleanKeep);

    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select presentation as v from requests where id = ${reqAppDirty}`,
        )
      ).v,
    ).toEqual({
      kind: "external",
      title: expectedClean,
      detail: expectedClean,
      subject: { id: "sub-1", kind: "computer-app" },
    });
    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select presentation as v from requests where id = ${reqAppClean}`,
        )
      ).v,
    ).toEqual({
      kind: "external",
      title: cleanKeep,
      detail: cleanKeep,
      subject: { id: "sub-2", kind: "computer-app" },
    });
    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select presentation as v from requests where id = ${reqHarnDirty}`,
        )
      ).v,
    ).toEqual({
      kind: "choice",
      title: expectedClean,
      options: [{ id: "allow", label: "Allow", hint: "allow-once" }],
    });
    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select presentation as v from requests where id = ${reqHarnClean}`,
        )
      ).v,
    ).toEqual({
      kind: "choice",
      title: cleanKeep,
      options: [{ id: "allow", label: "Allow", hint: "allow-once" }],
    });

    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select integration as v from tool_calls where id = ${tcDirty}`,
        )
      ).v,
    ).toEqual({
      kind: "computer-app",
      connectionId: connAppDirty,
      computerApp: { app: expectedClean, bundleId: "com.example.App" },
    });
    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select integration as v from tool_calls where id = ${tcClean}`,
        )
      ).v,
    ).toEqual({
      kind: "computer-app",
      connectionId: connAppDirty,
      computerApp: { app: cleanKeep, bundleId: "com.example.App" },
    });

    expect(
      await readOne<{ title: string; pn: string }>(
        sql`select title, profile_name as pn from personal_tabs where id = ${tabDirty}`,
      ),
    ).toEqual({
      title: expectedClean,
      pn: expectedClean,
    });
    expect(
      await readOne<{ title: string; pn: string }>(
        sql`select title, profile_name as pn from personal_tabs where id = ${tabClean}`,
      ),
    ).toEqual({
      title: cleanKeep,
      pn: cleanKeep,
    });

    expect(
      (
        await readOne<{ v: string }>(
          sql`select title as v from browser_history_entries where profile_id = ${bpDirty.id} and url = ${histUrlDirty}`,
        )
      ).v,
    ).toBe(expectedClean);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select title as v from browser_history_entries where profile_id = ${bpClean.id} and url = ${histUrlClean}`,
        )
      ).v,
    ).toBe(cleanKeep);

    expect(
      (
        await readOne<{ v: string }>(
          sql`select page_title as v from browser_session_uses where id = ${bsuDirty}`,
        )
      ).v,
    ).toBe(expectedClean);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select page_title as v from browser_session_uses where id = ${bsuClean}`,
        )
      ).v,
    ).toBe(cleanKeep);

    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select latest_place as v from runs where id = ${runFixture.run.id}`,
        )
      ).v,
    ).toEqual({
      tabId: tabDirty,
      title: expectedClean,
      site: "https://example.com",
    });
    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select latest_place as v from runs where id = ${runCleanFixture.run.id}`,
        )
      ).v,
    ).toEqual(placeClean);

    expect(
      await readOne<{ p: unknown; title: string }>(
        sql`select latest_place as p, title from threads where id = ${runFixture.threadId}`,
      ),
    ).toEqual({
      p: { tabId: tabDirty, title: expectedClean, site: "https://example.com" },
      title: "Agent",
    });
    expect(
      await readOne<{ p: unknown; title: string }>(
        sql`select latest_place as p, title from threads where id = ${runCleanFixture.threadId}`,
      ),
    ).toEqual({
      p: placeClean,
      title: cleanKeep,
    });

    expect(
      await readOne<{ b: unknown; v: unknown }>(
        sql`select body as b, view as v from transcript_items where id = ${tiDirty}`,
      ),
    ).toEqual({
      b: { tabId: tabDirty, title: expectedClean, site: "https://example.com" },
      v: { title: expectedClean, preview: "https://example.com" },
    });
    expect(
      await readOne<{ b: unknown; v: unknown }>(
        sql`select body as b, view as v from transcript_items where id = ${tiClean}`,
      ),
    ).toEqual({
      b: placeClean,
      v: { title: cleanKeep, preview: "https://example.com" },
    });

    expect(
      await readOne<{ title: string; manifest: unknown; name: string }>(
        sql`select title, manifest, name from integration_installations where id = ${instDirty}`,
      ),
    ).toEqual({
      title: expectedClean,
      name: "pkg-dirty",
      manifest: {
        name: "pkg-dirty",
        keepKey: "untouched",
        extensions: {
          "com.opensteer": { device: { kind: "other", name: expectedClean, extra: 1 } },
        },
      },
    });
    expect(
      await readOne<{ title: string; manifest: unknown }>(
        sql`select title, manifest from integration_installations where id = ${instClean}`,
      ),
    ).toEqual({
      title: cleanKeep,
      manifest: manifestClean,
    });

    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select manifest as v from plugin_versions where id = ${pvDirty}`,
        )
      ).v,
    ).toEqual({
      name: "pkg-dirty",
      keepKey: "untouched",
      extensions: { "com.opensteer": { device: { kind: "other", name: expectedClean, extra: 1 } } },
    });
    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select manifest as v from plugin_versions where id = ${pvClean}`,
        )
      ).v,
    ).toEqual(manifestClean);

    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select server as v from computer_app_setup_requests where id = ${setupDirty}`,
        )
      ).v,
    ).toEqual({
      installationTitle: expectedClean,
      name: "srv-name",
      serverId: srvId,
    });
    expect(
      (
        await readOne<{ v: unknown }>(
          sql`select server as v from computer_app_setup_requests where id = ${setupClean}`,
        )
      ).v,
    ).toEqual({
      installationTitle: cleanKeep,
      name: "srv-name",
      serverId: srvId,
    });

    expect(
      await readOne<{ name: string; title: string; annotations: unknown }>(
        sql`select name, title, annotations from integration_tools where id = ${toolDirty}`,
      ),
    ).toEqual({
      name: `machine\u200DName-${toolDirty}`,
      title: expectedClean,
      annotations: { title: expectedClean, readOnlyHint: true },
    });
    expect(
      await readOne<{ name: string; title: string; annotations: unknown }>(
        sql`select name, title, annotations from integration_tools where id = ${toolClean}`,
      ),
    ).toEqual({
      name: `machine\u200DName-${toolClean}`,
      title: cleanKeep,
      annotations: { title: cleanKeep, readOnlyHint: true },
    });

    expect(
      (
        await readOne<{ v: string }>(
          sql`select name as v from triggers where id = ${trigDirty.trigger.id}`,
        )
      ).v,
    ).toBe(expectedClean);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select name as v from triggers where id = ${trigClean.trigger.id}`,
        )
      ).v,
    ).toBe(cleanKeep);

    expect(
      (
        await readOne<{ v: string }>(
          sql`select name as v from browser_profiles where id = ${bpDirty.id}`,
        )
      ).v,
    ).toBe(expectedClean);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select name as v from browser_profiles where id = ${bpClean.id}`,
        )
      ).v,
    ).toBe(cleanKeep);
    expect(
      (
        await readOne<{ v: string }>(
          sql`select name as v from browser_profiles where id = ${bpEmpty.id}`,
        )
      ).v,
    ).toBe("Browser profile");
  });

  it("never attributes a stranger's cancelled channel-ingress input to the person in 0109", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const bridge = await storeFixture.createBridgeFixture("y4-cancelled-stranger");
    const { configured, fixture } = bridge;
    const { upsertChannelIdentity } = await import("./channel-store.js");
    const { commitPersonalMutation } = await import("./personal-mutation.js");
    const me = await database
      .selectFrom("channelIdentities")
      .select(["id", "principalId"])
      .where("accountId", "=", configured.account.id)
      .where("linkedUserId", "=", fixture.userId)
      .executeTakeFirstOrThrow();
    const stranger = await commitPersonalMutation(database, (tx) =>
      upsertChannelIdentity(tx, {
        accountId: configured.account.id,
        displayName: "Stranger",
        externalUserId: "U-Y4-STRANGER",
      }),
    );
    const { thread: ownThread } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "y4-own-dm-thread",
      modelSelection: testModelSelection,
      title: "Personal DM task",
    });
    const ownInput = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: ownThread.id,
      content: [{ type: "text", text: "My own DM" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "y4-own-dm-input",
    });
    const strangerInput = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: ownThread.id,
      content: [{ type: "text", text: "Stranger cancelled message" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "y4-stranger-cancelled-input",
    });

    await restoreRoutes(database);
    const route = `chb_${crypto.randomUUID()}`;
    await sql`insert into channel_bindings (id, account_id, created_by, selector, execution_policy,
        access_policy, revision, status)
      values (${route}, ${configured.account.id}, ${fixture.userId}, '{}'::jsonb, '{}'::jsonb,
        ${JSON.stringify(testChannelAccessPolicy("owner"))}::jsonb, 1, 'active')`.execute(database);
    const dmConv = createChannelId("conversation");
    await sql`insert into channel_conversations (id, account_id, provider, external_account_id,
        binding_id, binding_revision, external_conversation_id, conversation_type,
        active_thread_id, provider_state, personal_context)
      values (${dmConv}, ${configured.account.id}, 'slack', 'T-y4-dm', ${route}, 1, ${dmConv},
        'dm', ${ownThread.id}, '{}'::jsonb, true)`.execute(database);
    await sql`update thread_inputs set
      authority_source = ${JSON.stringify({ kind: "channel-ingress", conversationId: dmConv })}::jsonb,
      actor_principal_id = ${me.principalId}
      where message_id = ${ownInput.message.id}`.execute(database);
    await sql`update thread_inputs set
      authority_source = ${JSON.stringify({ kind: "channel-ingress", conversationId: dmConv })}::jsonb,
      actor_principal_id = ${stranger.principalId},
      state = 'cancelled',
      cancel_reason = 'cancelled'
      where message_id = ${strangerInput.message.id}`.execute(database);

    await replayFromChatRoutesEnd(database);

    // The person's own task stays theirs and their own DM input becomes user-session.
    expect(
      (
        await database
          .selectFrom("threads")
          .select("originConnectionId")
          .where("id", "=", ownThread.id)
          .executeTakeFirstOrThrow()
      ).originConnectionId,
    ).toBeNull();
    expect(
      (
        await database
          .selectFrom("threadInputs")
          .select(["state", "authoritySource"])
          .where("messageId", "=", ownInput.message.id)
          .executeTakeFirstOrThrow()
      ).authoritySource,
    ).toEqual({ kind: "user-session", userId: fixture.userId });

    // The stranger's cancelled input stays cancelled and is NEVER attributed to user-session!
    const strangerRow = await database
      .selectFrom("threadInputs")
      .select(["state", "authoritySource", "connectionId"])
      .where("messageId", "=", strangerInput.message.id)
      .executeTakeFirstOrThrow();
    expect(strangerRow.state).toBe("cancelled");
    expect(strangerRow.authoritySource).toMatchObject({ kind: "connection" });
    expect(strangerRow.connectionId).not.toBeNull();
    // Under 0114, the cancelled stranger input carries the ended chat's connection_id truthfully
    // without tainting the person's own task lineage.
    const { threadContextLineage } = await import("./run-personal-context.js");
    expect(await threadContextLineage(database, ownThread.id, fixture.userId)).toEqual({
      fromChat: false,
      personLineage: true,
      personalContext: true,
    });
  });

  it("preserves integers above 2^53 and sibling keys in JSON paths, cleans across a >500-row batch boundary, and is a no-op on a second run", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const bridge = await storeFixture.createBridgeFixture("y5-json-batch-noop");
    const { configured, fixture } = bridge;
    const bigInt = "9007199254740993";

    // 1. agent_connections.identity_at_consent with >2^53 integer + dirty clientName
    const connId = `mcn_${crypto.randomUUID()}`;
    await sql`
      insert into agent_connections (id, user_id, label, client_name, access_mode, resource,
        created_at, expires_at, "grant", grant_revision, consent_version, identity_at_consent)
      values (${connId}, ${fixture.userId}, 'Clean', 'Clean', 'approval-required', 'opensteer:mcp',
        now(), now() + interval '1 day', '{"scope":"selected","tasks":true,"resources":[]}'::jsonb, 2, 2,
        ${`{"bigId":${bigInt},"clientName":"Bad\\u202E\\nAgent","platformName":"Clean","nested":{"keep":${bigInt}}}`}::jsonb)
    `.execute(database);

    // 2. channel_ingress_events.event with >2^53 integer + dirty actor & conversation names
    const ingressId = createChannelId("ingress");
    await sql`
      insert into channel_ingress_events (id, account_id, provider_event_id, lane_key, event, status, next_attempt_at)
      values (${ingressId}, ${configured.account.id}, 'evt-bigint', 'lane-bigint',
        ${`{"providerSeq":${bigInt},"actor":{"displayName":"Bad\\u202E\\nSender","externalUserId":"U1"},"conversation":{"displayName":"Bad\\u202E\\nRoom","externalConversationId":"C1"}}`}::jsonb,
        'adopted', now())
    `.execute(database);

    // 3. 510 dirty apps rows with identical timestamps across the 500-row batch boundary
    const batchNow = new Date("2026-11-23T12:00:00.000Z");
    const appIds: string[] = [];
    for (let i = 0; i < 510; i++) {
      appIds.push(`app_${String(i).padStart(4, "0")}_${crypto.randomUUID()}`);
    }
    await sql`
      insert into apps (id, owner_id, computer_id, name, created_at, updated_at)
      select u.id, ${fixture.userId}, ${fixture.runnerId}, ${"Dirty\u202E\nApp"}, ${batchNow}, ${batchNow}
      from unnest(${appIds}::text[]) as u(id)
    `.execute(database);

    await restoreRoutes(database);
    await replayFromChatRoutesEnd(database);

    // Raw JSONB text must keep 9007199254740993 exact (not 9007199254740992) while cleaning names.
    const rawConn = (
      await sql<{ readonly text: string; readonly clientName: string }>`
        select identity_at_consent::text as text, identity_at_consent->>'clientName' as "clientName"
        from agent_connections where id = ${connId}
      `.execute(database)
    ).rows[0]!;
    expect(rawConn.clientName).toBe("Bad Agent");
    expect(rawConn.text).toContain(bigInt);
    expect(rawConn.text).not.toContain("9007199254740992");

    const rawIngress = (
      await sql<{ readonly text: string; readonly actor: string; readonly room: string }>`
        select event::text as text,
          event->'actor'->>'displayName' as actor,
          event->'conversation'->>'displayName' as room
        from channel_ingress_events where id = ${ingressId}
      `.execute(database)
    ).rows[0]!;
    expect(rawIngress.actor).toBe("Bad Sender");
    expect(rawIngress.room).toBe("Bad Room");
    expect(rawIngress.text).toContain(bigInt);
    expect(rawIngress.text).not.toContain("9007199254740992");

    // All 510 rows across the 500-row batch boundary were cleaned.
    const dirtyRemaining = (
      await sql<{ readonly count: string }>`
        select count(*)::text as count from apps
        where id = any(${appIds}::text[]) and name <> 'Dirty App'
      `.execute(database)
    ).rows[0]!;
    expect(dirtyRemaining.count).toBe("0");

    // Second run on an already-clean database touches zero rows (xmin stays identical).
    const beforeXmins = (
      await sql<{
        readonly connXmin: string;
        readonly ingressXmin: string;
        readonly appXmin: string;
      }>`
        select
          (select xmin::text from agent_connections where id = ${connId}) as "connXmin",
          (select xmin::text from channel_ingress_events where id = ${ingressId}) as "ingressXmin",
          (select xmin::text from apps where id = ${appIds[0]!}) as "appXmin"
      `.execute(database)
    ).rows[0]!;
    await restoreRoutes(database);
    await replayFromChatRoutesEnd(database);
    const afterXmins = (
      await sql<{
        readonly connXmin: string;
        readonly ingressXmin: string;
        readonly appXmin: string;
      }>`
        select
          (select xmin::text from agent_connections where id = ${connId}) as "connXmin",
          (select xmin::text from channel_ingress_events where id = ${ingressId}) as "ingressXmin",
          (select xmin::text from apps where id = ${appIds[0]!}) as "appXmin"
      `.execute(database)
    ).rows[0]!;
    expect(afterXmins).toEqual(beforeXmins);
  });
});
