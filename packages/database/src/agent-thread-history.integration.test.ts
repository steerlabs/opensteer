import { commitPersonalMutation } from "./personal-mutation.js";
import { syncTranscriptMessage } from "./message-visibility.js";
import { readTranscriptItem, readTranscriptPage } from "./personal-sync-store.js";
import { sql } from "kysely";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { latestRunPlace, recordRunTabPlace } from "./browser-session-store.js";
import { createId, MessageIdSchema } from "@opensteer/core";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";
import "./connection.js";
import { readAgentThreadActivity, readAgentThreadRecent } from "./agent-thread-history.js";
import { readThreadWaitSnapshot } from "./thread-wait.js";
describeStore("agent Thread history", (it) => {
  it("keeps model-control messages hidden and preserves the recovery continuation", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("model-control");
    const ids = await commitPersonalMutation(database, async (tx) => {
      const base = await tx
        .selectFrom("messages")
        .select("actorPrincipalId")
        .where("id", "=", f.turn.message.id)
        .executeTakeFirstOrThrow();
      const controls = [
        { kind: "run-result", cause: "assignment-result" },
        { kind: "continuation", cause: "context-window" },
        { kind: "input", cause: "claude-compaction" },
        { kind: "continuation", cause: "run-recovery" },
      ] as const;
      const ids = [];
      for (const [index, { kind, cause }] of controls.entries()) {
        const id = createId("message");
        await tx
          .insertInto("messages")
          .values({
            id,
            threadId: f.thread.id,
            runId: f.run.id,
            sequence: String(100 + index),
            kind,
            actorPrincipalId: base.actorPrincipalId,
            author: { kind: "platform", cause },
            content: sql`${JSON.stringify([{ type: "text", text: "Control payload" }])}::jsonb`,
          })
          .execute();
        await syncTranscriptMessage(tx, id);
        ids.push({ id, visible: cause === "run-recovery" });
      }
      return ids;
    });
    const read = { viewerId: f.userId, scope: { kind: "thread", threadId: f.thread.id } as const };
    const page = await readTranscriptPage(database, read);
    if (page.kind !== "page") throw new Error("Expected model task history");
    for (const { id, visible } of ids) {
      const item = page.items.find((item) => item.id === id);
      const body = await readTranscriptItem(database, { ...read, itemId: id });
      if (visible) {
        expect(item).toMatchObject({
          kind: "message",
          messageKind: "continuation",
          isTurnStart: false,
        });
        const { text: _inlineText, ...header } =
          item && item.kind === "message" ? item : { text: undefined };
        expect(body).toMatchObject({ kind: "item", item: header, body: { kind: "message" } });
      } else {
        expect(item).toBeUndefined();
        expect(body).toEqual({ kind: "unavailable" });
      }
    }
  });
  it("orders published messages by their retained item and reads the canonical body", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("agent-history");
    const queued = await store.enqueueThreadInput({
      threadId: f.thread.id,
      requestedBy: f.userId,
      policy: "queue",
      content: [
        {
          type: "text",
          text: "Waiting work",
        },
      ],
      source: {
        kind: "human",
      },
      idempotencyKey: "waiting-work",
    });
    const hidden = await readAgentThreadActivity(database, {
      ownerId: f.userId,
      threadId: f.thread.id,
      limit: 100,
    });
    expect(
      hidden?.items.some(
        (item) => item.type === "message" && item.message.id === queued.message.id,
      ),
    ).toBe(false);
    await database
      .updateTable("threadInputs")
      .set({
        state: "delivered",
        runId: f.run.id,
        deliveredAt: new Date(),
      })
      .where("messageId", "=", queued.message.id)
      .execute();
    await database
      .updateTable("messages")
      .set({ published: true })
      .where("id", "=", queued.message.id)
      .execute();
    const position = "1000";
    await database
      .insertInto("transcriptItems")
      .values({
        id: queued.message.id,
        threadId: f.thread.id,
        runId: f.run.id,
        attemptId: null,
        nodeId: null,
        kind: "message",
        position,
        messageId: queued.message.id,
        visible: true,
        isTurnStart: false,
        createdAt: new Date(),
        view: { preview: "Forged preview" },
      })
      .onConflict((conflict) => conflict.column("id").doUpdateSet({ position, visible: true }))
      .execute();
    const visible = await readAgentThreadActivity(database, {
      ownerId: f.userId,
      threadId: f.thread.id,
      limit: 100,
    });
    const messages = visible!.items.flatMap((item) => (item.type === "message" ? [item] : []));
    expect(messages.filter((item) => item.message.id === queued.message.id)).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      position,
      message: {
        id: queued.message.id,
        content: [
          {
            type: "text",
            text: "Waiting work",
          },
        ],
      },
    });
    expect(visible!.items.map((item) => BigInt(item.position))).toEqual(
      visible!.items
        .map((item) => BigInt(item.position))
        .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)),
    );
    expect(
      (await readAgentThreadActivity(database, {
        ownerId: f.userId,
        threadId: f.thread.id,
        limit: 1,
        itemId: "9".repeat(255),
      }))!.items,
    ).toEqual([]);
    await expect(
      readAgentThreadActivity(database, {
        ownerId: createId("user"),
        threadId: f.thread.id,
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("bounds recent places by newest Runs and newest entries before deduplication", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("agent-recent");
    for (let i = 0; i < 12; i++)
      expect(
        await recordRunTabPlace(database, {
          runId: f.run.id,
          bindingGeneration: f.bindingGeneration,
          data: {
            tabId: BrowserSurfaceIdSchema.parse("native-tab-" + i),
            title: String(i),
            site: null,
          },
        }),
      ).toBe(true);
    expect(
      await recordRunTabPlace(database, {
        runId: f.run.id,
        bindingGeneration: f.bindingGeneration,
        data: {
          tabId: BrowserSurfaceIdSchema.parse("native-tab-11"),
          title: "Repeated",
          site: null,
        },
      }),
    ).toBe(false);
    await expect(
      recordRunTabPlace(database, {
        runId: f.run.id,
        bindingGeneration: f.bindingGeneration + 1,
        data: { tabId: BrowserSurfaceIdSchema.parse("stale-tab"), title: "Stale", site: null },
      }),
    ).resolves.toBe(false);
    const place = { tabId: "native-tab-11", title: "11", site: null };
    await expect(latestRunPlace(database, f.run.id)).resolves.toEqual(place);
    await expect(
      database
        .selectFrom("threads")
        .select("latestPlace")
        .where("id", "=", f.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ latestPlace: place });
    const recent = await readAgentThreadRecent(database, {
      ownerId: f.userId,
      threadId: f.thread.id,
      runLimit: 1,
    });
    expect(recent?.runs).toHaveLength(1);
    expect(recent?.places.map((e) => e.title)).toEqual(["11", "10", "9", "8", "7", "6", "5", "4"]);
    await expect(
      readAgentThreadRecent(database, {
        ownerId: createId("user"),
        threadId: f.thread.id,
        runLimit: 1,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("says a wait has more when messages after it were left unread", async ({ storeFixture }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("agent-wait-more");
    const author = await database
      .selectFrom("messages")
      .select(["actorPrincipalId", "author"])
      .where("id", "=", f.turn.message.id)
      .executeTakeFirstOrThrow();
    const ids = await sql<{ id: string }>`
      with batch as (
        insert into messages (id,thread_id,sequence,kind,actor_principal_id,author,content,published)
        select 'msg_90000000-0000-4000-8000-'||lpad(n::text,12,'0'), ${f.thread.id}, n+1,
          'input', ${author.actorPrincipalId}, ${JSON.stringify(author.author)}::jsonb,
          jsonb_build_array(jsonb_build_object('type','text','text','Report '||n)), true
        from generate_series(1,102) n returning id,sequence
      ) select id from batch order by sequence
    `.execute(database);
    const sent = ids.rows.map(({ id }) => MessageIdSchema.parse(id));
    const read = (afterMessageId: (typeof sent)[number]) =>
      readThreadWaitSnapshot(database, {
        threadId: f.thread.id,
        userId: f.userId,
        afterMessageId,
      });
    const first = await read(sent[0]!);
    expect(first).toMatchObject({
      hasMore: true,
    });
    expect(first.messages).toHaveLength(100);
    const rest = await read(first.messages.at(-1)!.id);
    expect(rest).toMatchObject({
      hasMore: false,
    });
    expect(rest.messages.map(({ id }) => id)).toEqual([sent[101]!]);
  });
});
