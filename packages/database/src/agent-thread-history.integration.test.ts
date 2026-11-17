import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { latestRunPlace, recordRunTabPlace } from "./browser-session-store.js";
import { createId } from "@opensteer/core";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";
import "./connection.js";
import { readAgentThreadActivity, readAgentThreadRecent } from "./agent-thread-history.js";
import { readThreadWaitSnapshot } from "./thread-wait.js";
describeStore("agent Thread history", (it) => {
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
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("agent-wait-more");
    const sent: Awaited<ReturnType<typeof store.enqueueThreadInput>>[] = [];
    for (let index = 0; index < 102; index += 1)
      sent.push(
        await store.enqueueThreadInput({
          threadId: f.thread.id,
          requestedBy: f.userId,
          policy: "report",
          content: [
            {
              type: "text",
              text: `Report ${index}`,
            },
          ],
          source: {
            kind: "human",
          },
          idempotencyKey: `wait-more-${index}`,
        }),
      );
    const read = (afterMessageId: (typeof sent)[number]["message"]["id"]) =>
      readThreadWaitSnapshot(database, {
        threadId: f.thread.id,
        userId: f.userId,
        afterMessageId,
      });
    const first = await read(sent[0]!.message.id);
    expect(first).toMatchObject({
      hasMore: true,
    });
    expect(first.messages).toHaveLength(100);
    const rest = await read(first.messages.at(-1)!.id);
    expect(rest).toMatchObject({
      hasMore: false,
    });
    expect(rest.messages.map(({ id }) => id)).toEqual([sent[101]!.message.id]);
  });
});
