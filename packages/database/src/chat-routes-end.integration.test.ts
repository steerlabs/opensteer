import { createChannelId } from "@opensteer/channel-core";
import { sql, type Kysely } from "kysely";
import { expect } from "vitest";
import { PERSONAL_TEAM_BASELINE_SQL } from "./baseline-schema.js";
import { chatRoutesEndMigrationName } from "./chat-routes-end-migration.js";
import { migrateToLatest } from "./migrations.js";
import { chatEndedMessage, lineagePersonalContext } from "./resource-access.js";
import type { DatabaseSchema } from "./schema.js";
import {
  describeStore,
  testChannelAccessPolicy,
  testModelSelection,
} from "./store.integration.test-support.js";

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
        script: {
          interpreter: null,
          text: "console.log('tick')",
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
});
