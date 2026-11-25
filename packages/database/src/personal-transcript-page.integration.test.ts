import { createId } from "@opensteer/core";
import { expect, test } from "vitest";
import { createStoreFixture } from "./store.integration.test-support.js";
import { jsonValue } from "./store-primitives.js";
import { readTranscriptItem, readTranscriptPage } from "./personal-sync-store.js";

test("an anchored read reserves its turn and can continue paging older turns", async () => {
  const fixture = await createStoreFixture();
  const { database } = fixture;
  try {
    const run = await fixture.startRunFixture("anchored-page");
    await database
      .updateTable("transcriptItems")
      .set({ visible: false, isTurnStart: false })
      .where("threadId", "=", run.threadId)
      .execute();
    const message = await database
      .selectFrom("messages")
      .selectAll()
      .where("threadId", "=", run.threadId)
      .limit(1)
      .executeTakeFirstOrThrow();
    const ids = Array.from({ length: 22 }, () => createId("message"));
    await database
      .insertInto("messages")
      .values(
        ids.map((id, index) => ({
          ...message,
          content: jsonValue(message.content),
          id,
          sequence: String(index + 20),
        })),
      )
      .execute();
    await database
      .insertInto("transcriptItems")
      .values(
        ids.map((id, index) => ({
          id,
          messageId: id,
          threadId: run.threadId,
          runId: run.runId,
          attemptId: null,
          nodeId: null,
          position: String(index + 1),
          kind: "message" as const,
          visible: true,
          isTurnStart: true,
          createdAt: message.createdAt,
          view: { preview: "Turn" },
        })),
      )
      .execute();
    const query = {
      viewerId: run.userId,
      scope: { kind: "thread" as const, threadId: run.threadId },
    };
    const anchorItemId = ids[1]!;
    const page = await readTranscriptPage(database, {
      ...query,
      anchorItemId,
      maxTurns: 10,
      limit: 50,
    });
    expect(page.kind).toBe("page");
    if (page.kind !== "page") throw new Error("The anchor must have a page");
    expect(page.items.map((item) => item.id)).toEqual(ids.slice(1, 11));
    expect(page.nextBefore?.beforeId).toBe(anchorItemId);
    const older = await readTranscriptPage(database, { ...query, cursor: page.nextBefore! });
    expect(older).toMatchObject({ kind: "page", items: [{ id: ids[0] }], hasMore: false });
    const newer = await readTranscriptPage(database, { ...query, after: page.nextAfter! });
    expect(newer).toMatchObject({
      kind: "page",
      items: ids.slice(11).map((id) => expect.objectContaining({ id })),
      nextAfter: null,
    });
    await database
      .updateTable("transcriptItems")
      .set({ view: { preview: "x".repeat(1024) } })
      .where("threadId", "=", run.threadId)
      .execute();
    const bytePage = await readTranscriptPage(database, { ...query, limit: 20, maxBytes: 8192 });
    if (bytePage.kind !== "page" || !bytePage.nextBefore)
      throw new Error("Expected a trimmed page");
    expect(bytePage.items.length).toBeGreaterThan(0);
    expect(bytePage.items.length).toBeLessThan(20);
    expect(Buffer.byteLength(JSON.stringify(bytePage))).toBeLessThanOrEqual(8192);
    expect(bytePage.nextBefore.beforeId).toBe(bytePage.items[0]?.id);
    const byteOlder = await readTranscriptPage(database, { ...query, cursor: bytePage.nextBefore });
    if (byteOlder.kind !== "page") throw new Error("Expected an older page");
    expect([...byteOlder.items, ...bytePage.items].map(({ id }) => id)).toEqual(ids);
    await database
      .updateTable("transcriptItems")
      .set({ revision: "9" })
      .where("id", "=", anchorItemId)
      .execute();
    expect(
      await readTranscriptItem(database, { ...query, itemId: anchorItemId, expectedRevision: "8" }),
    ).toEqual({ kind: "revision-conflict", revision: "9" });
    await database
      .updateTable("messages")
      .set({ content: jsonValue([{ type: "text", text: "x".repeat(1_100_000) }] as const) })
      .where("id", "=", anchorItemId)
      .execute();
    expect(await readTranscriptItem(database, { ...query, itemId: anchorItemId })).toMatchObject({
      kind: "item",
      body: null,
      truncated: true,
      item: { id: anchorItemId },
    });
  } finally {
    await fixture.close();
  }
});

test("a page carries the Run cards of its rows that it does not hold, beside its order", async () => {
  const fixture = await createStoreFixture();
  const { database } = fixture;
  try {
    const run = await fixture.startRunFixture("run-cards");
    await database
      .updateTable("transcriptItems")
      .set({ visible: false, isTurnStart: false })
      .where("threadId", "=", run.threadId)
      .execute();
    const card = await database
      .updateTable("transcriptItems")
      .set({ visible: true, position: "1" })
      .where("threadId", "=", run.threadId)
      .where("kind", "=", "run")
      .where("runId", "=", run.runId)
      .returning("id")
      .executeTakeFirstOrThrow();
    const message = await database
      .selectFrom("messages")
      .selectAll()
      .where("threadId", "=", run.threadId)
      .limit(1)
      .executeTakeFirstOrThrow();
    const ids = Array.from({ length: 40 }, () => createId("message"));
    await database
      .insertInto("messages")
      .values(
        ids.map((id, index) => ({
          ...message,
          content: jsonValue(message.content),
          id,
          sequence: String(index + 20),
        })),
      )
      .execute();
    await database
      .insertInto("transcriptItems")
      .values(
        ids.map((id, index) => ({
          id,
          messageId: id,
          threadId: run.threadId,
          runId: run.runId,
          attemptId: null,
          nodeId: null,
          position: String(index + 2),
          kind: "message" as const,
          visible: true,
          isTurnStart: false,
          createdAt: message.createdAt,
          view: { preview: "Step" },
        })),
      )
      .execute();
    const query = {
      viewerId: run.userId,
      scope: { kind: "thread" as const, threadId: run.threadId },
    };
    // The latest page starts far below the Run's card: it carries the card beside its rows.
    const latest = await readTranscriptPage(database, { ...query, limit: 10 });
    if (latest.kind !== "page") throw new Error("The thread must have a page");
    expect(latest.items.map(({ id }) => id)).toEqual(ids.slice(30));
    expect(latest.runs?.map(({ id }) => id)).toEqual([card.id]);
    // A newer page from an anchor, and an older page, carry it too until a page holds it.
    const around = await readTranscriptPage(database, {
      ...query,
      anchorItemId: ids[20]!,
      limit: 10,
    });
    if (around.kind !== "page") throw new Error("The anchor must have a page");
    expect(around.runs?.map(({ id }) => id)).toEqual([card.id]);
    const newer = await readTranscriptPage(database, { ...query, after: around.nextAfter! });
    expect(newer).toMatchObject({ kind: "page", runs: [expect.objectContaining({ id: card.id })] });
    const all = await readTranscriptPage(database, { ...query, limit: 100 });
    if (all.kind !== "page") throw new Error("The thread must have a page");
    expect(all.items[0]?.id).toBe(card.id);
    expect(all.runs).toBeUndefined();
    // The cards count against the page's bytes: a page that would overflow with them gives up
    // rows at its far end, and its cursor continues from the rows it kept.
    await database
      .updateTable("transcriptItems")
      .set({ view: { preview: "y".repeat(50) } })
      .where("threadId", "=", run.threadId)
      .where("kind", "=", "message")
      .execute();
    const maxBytes = 8 * 1024;
    const tight = await readTranscriptPage(database, { ...query, limit: 40, maxBytes });
    if (tight.kind !== "page") throw new Error("The thread must have a page");
    const size = (items: readonly unknown[]) =>
      items.reduce<number>((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
    expect(tight.runs?.map(({ id }) => id)).toEqual([card.id]);
    expect(size(tight.items) + size(tight.runs ?? [])).toBeLessThanOrEqual(maxBytes - 1024);
    expect(tight.hasMore).toBe(true);
    expect(tight.nextBefore?.beforeId).toBe(tight.items[0]!.id);
    const after = await readTranscriptPage(database, {
      ...query,
      after: { ...tight.nextBefore!, beforeId: ids[0]!, beforePosition: "2" },
      limit: 40,
      maxBytes,
    });
    if (after.kind !== "page") throw new Error("The thread must have a page");
    expect(size(after.items) + size(after.runs ?? [])).toBeLessThanOrEqual(maxBytes - 1024);
    expect(after.nextAfter?.beforeId).toBe(after.items.at(-1)!.id);
  } finally {
    await fixture.close();
  }
});

test("acceptDeferredWork folds settled work bursts and view=work hydrates them in order", async () => {
  const fixture = await createStoreFixture();
  const { database } = fixture;
  try {
    const run = await fixture.startRunFixture("deferred-work");
    await database
      .updateTable("transcriptItems")
      .set({ visible: false, isTurnStart: false })
      .where("threadId", "=", run.threadId)
      .execute();
    await database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("id", "=", run.runId)
      .execute();
    await database
      .updateTable("transcriptItems")
      .set({ visible: true, position: "1", view: jsonValue({ status: "completed" }) })
      .where("threadId", "=", run.threadId)
      .where("kind", "=", "run")
      .where("runId", "=", run.runId)
      .execute();
    const message = await database
      .selectFrom("messages")
      .selectAll()
      .where("threadId", "=", run.threadId)
      .limit(1)
      .executeTakeFirstOrThrow();
    const replyId = createId("message");
    await database
      .insertInto("messages")
      .values({ ...message, content: jsonValue(message.content), id: replyId, sequence: "100" })
      .execute();
    const baseMs = Date.parse("2026-11-23T10:00:00.000Z");
    const toolCallIds = Array.from({ length: 40 }, (_, index) => `tc_deferred_${index + 1}`);
    await database
      .insertInto("toolCalls")
      .values(
        toolCallIds.map((toolCallId, index) => ({
          id: toolCallId,
          threadId: run.threadId,
          runId: run.runId,
          attemptId: null,
          bindingGeneration: null,
          nodeId: null,
          callId: `call_${index + 1}`,
          origin: "host-harness" as const,
          tool: jsonValue({ namespace: "codex", name: "shell" }),
          integration: null,
          arguments: jsonValue({ command: `echo ${index + 1}` }),
          argumentDigest: null,
          provisional: false,
          status: "completed" as const,
          output: jsonValue({ text: `ok ${index + 1}` }),
          isError: false,
          startedAt: new Date(baseMs + index * 60_000),
          completedAt: new Date(baseMs + (index + 1) * 60_000),
          completionOrder: String(index + 1),
        })),
      )
      .execute();
    const toolRows = toolCallIds.map((toolCallId, index) => ({
      id: `tool:${toolCallId}`,
      threadId: run.threadId,
      runId: run.runId,
      attemptId: null,
      nodeId: null,
      position: String(index + 2),
      kind: "tool" as const,
      toolCallId,
      visible: true,
      isTurnStart: false,
      createdAt: new Date(baseMs + index * 60_000),
      view: jsonValue({
        status: "completed",
        title: `Tool ${index + 1}`,
        completedAt: new Date(baseMs + (index + 1) * 60_000).toISOString(),
      }),
    }));
    const anchorId = toolRows[0]!.id;
    await database
      .insertInto("transcriptItems")
      .values([
        ...toolRows,
        {
          id: replyId,
          messageId: replyId,
          threadId: run.threadId,
          runId: run.runId,
          attemptId: null,
          nodeId: null,
          position: "42",
          kind: "message" as const,
          toolCallId: null,
          visible: true,
          isTurnStart: false,
          createdAt: new Date(baseMs + 41 * 60_000),
          view: jsonValue({ preview: "All done" }),
        },
      ])
      .execute();

    const query = {
      viewerId: run.userId,
      scope: { kind: "thread" as const, threadId: run.threadId },
    };
    const folded = await readTranscriptPage(database, {
      ...query,
      acceptDeferredWork: true,
      limit: 50,
    });
    if (folded.kind !== "page") throw new Error("Expected folded page");
    // Run card + 1 folded anchor tool + reply (40 tools collapsed to 1 anchor).
    expect(folded.items.map(({ id }) => id)).toEqual([`run:${run.runId}`, anchorId, replyId]);
    const anchor = folded.items[1]!;
    expect(anchor.kind).toBe("tool");
    if (anchor.kind === "tool") {
      expect(anchor.deferredWork).toEqual({
        itemCount: 39,
        startedAt: new Date(baseMs).toISOString(),
        endedAt: new Date(baseMs + 40 * 60_000).toISOString(),
        onlyThinking: false,
      });
    }

    // Hydrate the folded stretch across multiple view="work" pages.
    const hydrated: string[] = [];
    let cursor = undefined;
    for (;;) {
      const workPage = await readTranscriptPage(database, {
        ...query,
        view: "work",
        workAnchorId: anchorId,
        limit: 15,
        ...(cursor ? { cursor } : {}),
      });
      if (workPage.kind !== "page") throw new Error("Expected deferred work page");
      hydrated.unshift(...workPage.items.map(({ id }) => id));
      if (!workPage.hasMore) {
        expect(workPage.nextBefore).toBeNull();
        break;
      }
      cursor = workPage.nextBefore!;
    }
    expect(hydrated).toEqual(toolRows.slice(1).map(({ id }) => id));

    // Active (non-terminal) runs are never folded.
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", run.runId)
      .execute();
    const active = await readTranscriptPage(database, {
      ...query,
      acceptDeferredWork: true,
      limit: 50,
    });
    if (active.kind !== "page") throw new Error("Expected active page");
    expect(active.items).toHaveLength(42);

    // throughItemId rejects unknown ids immediately with history-reset + anchorUnavailable.
    const missing = await readTranscriptPage(database, {
      ...query,
      throughItemId: createId("message"),
      acceptDeferredWork: true,
    });
    expect(missing).toEqual({ kind: "history-reset", anchorUnavailable: true });
  } finally {
    await fixture.close();
  }
});
