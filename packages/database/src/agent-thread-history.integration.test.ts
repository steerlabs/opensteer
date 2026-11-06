import { createId } from "@opensteer/core";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { withDatabaseTransaction } from "./connection.js";
import { readAgentThreadActivity, readAgentThreadRecent } from "./agent-thread-history.js";
import { readThreadWaitSnapshot } from "./thread-wait.js";

describeStore("agent Thread history", (it) => {
  it("orders messages by their newest published event marker and never event content", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("agent-history");
    const queued = await store.enqueueThreadInput({
      threadId: f.thread.id,
      requestedBy: f.userId,
      policy: "queue",
      content: [{ type: "text", text: "Waiting work" }],
      source: { kind: "human" },
      idempotencyKey: "waiting-work",
    });
    const originalMarker = await database
      .selectFrom("workspaceEvents")
      .selectAll()
      .where("type", "=", "message.created")
      .where("threadId", "=", f.thread.id)
      .orderBy("sequence", "desc")
      .executeTakeFirstOrThrow();
    const append = async () => {
      const sequence = String(BigInt(originalMarker.sequence) + 100n);
      await database
        .insertInto("workspaceEvents")
        .values({
          ...originalMarker,
          type: "message.placed",
          sequence,
          eventId: createId("event"),
          data: {
            message: {
              id: queued.message.id,
              content: [{ type: "text", text: "Forged event content" }],
            },
          },
        })
        .execute();
      return { sequence };
    };
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
      .set({ state: "delivered", runId: f.run.id, deliveredAt: new Date() })
      .where("messageId", "=", queued.message.id)
      .execute();
    const last = await append();
    const visible = await readAgentThreadActivity(database, {
      ownerId: f.userId,
      threadId: f.thread.id,
      limit: 100,
    });
    const messages = visible!.items.flatMap((item) => (item.type === "message" ? [item] : []));
    expect(messages.filter((item) => item.message.id === queued.message.id)).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      sequence: last.sequence,
      message: { id: queued.message.id, content: [{ type: "text", text: "Waiting work" }] },
    });
    expect(visible!.items.map((item) => BigInt(item.sequence))).toEqual(
      visible!.items
        .map((item) => BigInt(item.sequence))
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
    expect(
      await readAgentThreadActivity(database, {
        ownerId: createId("user"),
        threadId: f.thread.id,
        limit: 10,
      }),
    ).toBeNull();
  });

  it("bounds recent places by newest Runs and newest entries before deduplication", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("agent-recent");
    for (let i = 0; i < 12; i++)
      await withDatabaseTransaction(database, (tx) =>
        appendHostWorkspaceEvent(tx, {
          workspaceId: f.workspace.id,
          threadId: f.thread.id,
          runId: f.run.id,
          environmentId: f.environmentId,
          type: "place.entered",
          data: {
            place: { kind: "app", machineId: f.runnerId, appKey: "com.test." + i },
            title: String(i),
            site: null,
          },
        }),
      );
    const recent = await readAgentThreadRecent(database, {
      ownerId: f.userId,
      threadId: f.thread.id,
      runLimit: 1,
    });
    expect(recent?.runs).toHaveLength(1);
    expect(recent?.places.map((e) => e.data.title)).toEqual([
      "11",
      "10",
      "9",
      "8",
      "7",
      "6",
      "5",
      "4",
    ]);
    expect(
      await readAgentThreadRecent(database, {
        ownerId: createId("user"),
        threadId: f.thread.id,
        runLimit: 1,
      }),
    ).toBeNull();
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
          content: [{ type: "text", text: `Report ${index}` }],
          source: { kind: "human" },
          idempotencyKey: `wait-more-${index}`,
        }),
      );
    const read = (afterMessageId: (typeof sent)[number]["message"]["id"]) =>
      readThreadWaitSnapshot(database, { threadId: f.thread.id, userId: f.userId, afterMessageId });
    const first = await read(sent[0]!.message.id);
    expect(first).toMatchObject({ hasMore: true });
    expect(first.messages).toHaveLength(100);
    const rest = await read(first.messages.at(-1)!.id);
    expect(rest).toMatchObject({ hasMore: false });
    expect(rest.messages.map(({ id }) => id)).toEqual([sent[101]!.message.id]);
  });
});
