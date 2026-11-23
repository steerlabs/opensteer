import { createId, SequenceSchema, type ThreadId } from "@opensteer/core";
import {
  migrateToLatest,
  readAgentThreadActivity,
  readAgentThreadRecent,
  readThreadWaitSnapshot,
} from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { createPersonalRunFixturePort } from "@opensteer/database/test-support/personal-run";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { startPrivateMachineHost } from "./private-machine-host.test-support.js";

const teamId = createId("deployment");
const channelId = `tch_${crypto.randomUUID()}`;

/**
 * Writes, by SQL, every shape a previous release kept on a Home that used teams: a task a
 * teammate's ask opened, a teammate's delivered message and one still awaiting the owner,
 * their inputs with team source and team reply target, the link and its requests, the asks in
 * Needs you and the count that included them.
 */
async function writeTeamEra(
  home: Awaited<ReturnType<typeof startPrivateMachineHost>>["store"]["database"],
  threadId: ThreadId,
  messages: { readonly delivered: string; readonly waiting: string },
) {
  // These columns were written once, when the row was made; their guards forbid a later change.
  await home.transaction().execute(async (database) => {
    await sql`set local session_replication_role = replica`.execute(database);
    await writeRows(database, threadId, messages);
  });
}

async function writeRows(
  database: Parameters<
    Parameters<
      ReturnType<
        Awaited<ReturnType<typeof startPrivateMachineHost>>["store"]["database"]["transaction"]
      >["execute"]
    >[0]
  >[0],
  threadId: ThreadId,
  messages: { readonly delivered: string; readonly waiting: string },
) {
  const author = {
    kind: "team-member",
    actor: "human",
    teamId,
    teamUserId: createId("user"),
    displayName: "Sam (Acme)",
  };
  const source = { teamId, channelId, threadRootId: "1", messageId: "2" };
  const replyTarget = {
    kind: "team-thread",
    teamId,
    channelId,
    threadRootId: "1",
    requestId: `tar_${crypto.randomUUID()}`,
  };
  const asks = [
    { id: `tar_${crypto.randomUUID()}`, kind: "team-ask", expires: true, input: messages.waiting },
    {
      id: `tar_${crypto.randomUUID()}`,
      kind: "failed-ask",
      expires: false,
      input: messages.delivered,
    },
  ];
  // Rows of one table are written in ascending key order, as the Home locks them.
  const inputs = (
    [
      [messages.delivered, "delivered", true],
      [messages.waiting, "awaiting-approval", false],
    ] as const
  ).toSorted(([left], [right]) => left.localeCompare(right));
  // In the Home's lock order. The previous release counted both asks in Needs you.
  await sql`update client_sync_state set needs_you_count=needs_you_count+2`.execute(database);
  await sql`update threads set team_id=${teamId}, channel_id=${channelId}, thread_root_id=1
    where id=${threadId}`.execute(database);
  for (const [messageId, state] of inputs)
    await sql`update thread_inputs set team_request_id=${`tar_${crypto.randomUUID()}`},
      team_source=${JSON.stringify(source)}::jsonb,
      reply_target=${JSON.stringify(replyTarget)}::jsonb, state=${state}
      where message_id=${messageId}`.execute(database);
  for (const [messageId, , published] of inputs)
    await sql`update messages set author=${JSON.stringify(author)}::jsonb, published=${published}
      where id=${messageId}`.execute(database);
  for (const ask of asks)
    await sql`insert into personal_team_requests(team_deployment_id,request_id,trigger_message_id,
        local_task_id,local_input_id,publication_state,source)
      values(${teamId},${ask.id},1,${threadId},${ask.input},'pending',
        ${JSON.stringify(source)}::jsonb)`.execute(database);
  await sql`insert into personal_team_links(id,team_deployment_id,team_host_instance_id,
      host_key_fingerprint,approved_origin,authority_envelope,state)
    values(${`ptl_${crypto.randomUUID()}`},${teamId},${createId("hostInstance")},
      ${`sha256:${"A".repeat(43)}`},'https://acme.example','{}'::jsonb,'active')`.execute(database);
  for (const ask of asks)
    await sql`insert into personal_attention(id,kind,team_deployment_id,team_request_id,thread_id,
        sort_at,expires_at)
      values(${`${ask.kind}:${ask.id}`},${ask.kind},${teamId},${ask.id},${threadId},now(),
        ${ask.expires ? sql`now() + interval '1 day'` : null})`.execute(database);
}

function data<Value>(
  result:
    | { readonly ok: true; readonly data: Value }
    | { readonly ok: false; readonly error: { readonly message: string } },
): Value {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

it("keeps a Home that used teams working: its old rows read without error and every count is what shows", async () => {
  const database = await cloneTestDatabase("host");
  const host = await startPrivateMachineHost(database.url, { logger: false });
  try {
    const { store } = host;
    const tasks = createPersonalRunFixturePort(store);
    // The person's own task, and one a teammate's ask opened.
    const own = await tasks.createTask({ ownerId: host.ownerId, suffix: "own" });
    const ownStart = await tasks.startTask(own.threadId, "My own request");
    const { threadId } = await tasks.createTask({ ownerId: host.ownerId, suffix: "team-era" });
    const delivered = (await tasks.startTask(threadId, "A teammate's delivered message")).turn;
    const input = (text: string, key: string) =>
      store.enqueueThreadInput({
        requestedBy: host.ownerId,
        threadId,
        content: [{ type: "text", text }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: key,
      });
    const waiting = await input("A teammate's ask awaiting the owner", "team-era-waiting");
    await writeTeamEra(store.database, threadId, {
      delivered: delivered.message.id,
      waiting: waiting.message.id,
    });

    // The Home's start runs this release's migrations over that database.
    await sql`delete from kysely_migration where name >= '0051_needs_you_counts_requests'`.execute(
      store.database,
    );
    await migrateToLatest(store.database);

    // What a client reads at startup.
    const shell = data(await host.api["personal.shell.get"]({}));
    const attention = data(await host.api["attention.get"]({}));
    // The task a teammate's ask opened is listed with the person's other running tasks.
    expect(JSON.stringify(shell)).toContain(threadId);
    data(await host.api["tasks.page"]({ active: true }));
    data(await host.api["tasks.page"]({}));

    // Needs you: the count is the rows it shows.
    const needsYou = data(await host.api["needsYou.get"]({}));
    expect(needsYou.entries).toEqual([]);
    expect(needsYou.count).toBe(needsYou.entries.length);
    expect(attention.needsYou).toBe(needsYou.entries.length);
    expect(JSON.stringify(shell)).not.toContain("team-member");

    // Opening the task: the teammate's text shows, without a team author or source.
    const items = data(await host.api["thread.items.page"]({ threadId }));
    if (items.kind !== "page") throw new Error("The task's transcript did not page");
    const texts = JSON.stringify(items);
    expect(texts).toContain("A teammate's delivered message");
    expect(texts).not.toContain("team-member");
    expect(texts).not.toContain(teamId);
    const details: unknown[] = [];
    for (const item of items.items)
      details.push(data(await host.api["transcript.item.get"]({ threadId, itemId: item.id })));
    // Each item's detail opens; the teammate's message keeps its text, not its author.
    expect(JSON.stringify(details)).toContain("A teammate's delivered message");
    expect(JSON.stringify(details)).not.toContain("team-member");

    // History as the person: Messages carry an author, so a teammate's is left out.
    const history = data(await host.api["thread.messages.list"]({ threadId }));
    expect(history.messages.map(({ id }) => id)).not.toContain(delivered.message.id);
    const ownHistory = data(await host.api["thread.messages.list"]({ threadId: own.threadId }));
    expect(ownHistory.messages.map(({ id }) => id)).toContain(ownStart.turn.message.id);
    const around = await host.api["thread.messages.list"]({
      threadId,
      aroundMessageId: delivered.message.id,
    });
    expect(around).toMatchObject({ ok: false, error: { code: "not_found" } });

    // History as an agent.
    const recent = await readAgentThreadRecent(store.database, {
      threadId,
      ownerId: host.ownerId,
      runLimit: 25,
    });
    expect(JSON.stringify(recent)).not.toContain("team-member");
    const activity = await readAgentThreadActivity(store.database, {
      threadId,
      ownerId: host.ownerId,
      limit: 100,
    });
    expect(JSON.stringify(activity)).not.toContain("team-member");
    const waited = await readThreadWaitSnapshot(store.database, {
      threadId,
      userId: host.ownerId,
      afterSequence: SequenceSchema.parse("0"),
    });
    expect(JSON.stringify(waited)).not.toContain("team-member");
  } finally {
    await host.close();
  }
});
