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
import { migrateToLatest } from "./migrations.js";
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
  // Its migration has not run on this database yet.
  await sql`delete from kysely_migration where name = ${chatRoutesEndMigrationName}`.execute(
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
        program: {
          toolContractVersion: 5,
          language: "javascript",
          source: "export default async () => null",
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

    await migrateToLatest(database);

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
    await migrateToLatest(database);
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

    await migrateToLatest(database);

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

  it("cleans every stored name column and JSON place in 0053 with outsideName", async ({
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
      program: {
        toolContractVersion: 5,
        language: "javascript",
        source: "export default async () => null",
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
    await migrateToLatest(database);

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

    await migrateToLatest(database);

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

    await migrateToLatest(database);

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
});
