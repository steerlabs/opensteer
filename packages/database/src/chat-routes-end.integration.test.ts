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
    const route = createChannelId("binding");
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

    await migrateToLatest(database);

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

    // At start, what routes queued is cancelled, in its task's queue, never run.
    const { cancelChatMessagesFromBeforeTheUpdate } = await import("./execution-recovery.js");
    await cancelChatMessagesFromBeforeTheUpdate(database);
    expect(
      await database
        .selectFrom("threadInputs")
        .select(["messageId", "state"])
        .where("messageId", "in", [fromChannel, fromDirect] as never)
        .orderBy("messageId")
        .execute(),
    ).toEqual(
      [fromChannel, fromDirect].sort().map((messageId) => ({ messageId, state: "cancelled" })),
    );

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

  it("keeps only the most recently used of several identities linked before the update", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("routes-me", {
      bridge: false,
    });
    const { upsertChannelIdentity } = await import("./channel-store.js");
    const { commitPersonalMutation } = await import("./personal-mutation.js");
    const identity = async (externalUserId: string) =>
      (
        await commitPersonalMutation(database, (tx) =>
          upsertChannelIdentity(tx, {
            accountId: configured.account.id,
            displayName: externalUserId,
            externalUserId,
          } as never),
        )
      ).id as string;
    // What the release before chats allowed: the phone and the email address both "me".
    await sql`drop index channel_identities_one_me`.execute(database);
    const phone = await identity("+14155550100");
    const email = await identity("owner@example.com");
    for (const [id, at] of [
      [phone, new Date(Date.now() - 60_000)],
      [email, new Date()],
    ] as const)
      await database
        .updateTable("channelIdentities")
        .set({ status: "linked", linkedUserId: fixture.userId, updatedAt: at })
        .where("id", "=", id as never)
        .execute();
    await restoreRoutes(database);
    await migrateToLatest(database);
    expect(
      await database
        .selectFrom("channelIdentities")
        .select("externalUserId")
        .where("accountId", "=", configured.account.id)
        .where("status", "=", "linked")
        .execute(),
    ).toEqual([{ externalUserId: "owner@example.com" }]);
  });
});
