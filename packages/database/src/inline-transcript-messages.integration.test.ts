import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect, test } from "vitest";
import { createPersonalStateFixture } from "./personal-state.test-support.js";
import { jsonValue } from "./store-primitives.js";
import { readPersonalScopeCut, readTranscriptItem, readTranscriptPage } from "./personal-sync-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { writeExecutionItem } from "./execution-changes.js";
import { describeTranscriptMessage, transcriptPreview } from "./transcript-store.js";
import {
  applyInlineTranscriptMessages,
  inlineTranscriptMessagesMigrationName,
} from "./personal-state-schema.js";

test("inline message and subagent text ships whole on pages and live changes, deduplicates detail reads, and admits oversized single rows", async () => {
  const fixture = await createPersonalStateFixture("inline-prose-suite");
  const { database, run, attemptId } = fixture;
  try {
    const scope = { kind: "thread" as const, threadId: run.threadId };
    const query = { viewerId: run.userId, scope };
    const templateMessage = await database
      .selectFrom("messages")
      .selectAll()
      .where("threadId", "=", run.threadId)
      .limit(1)
      .executeTakeFirstOrThrow();

    const beforeCut = await readPersonalScopeCut(database, {
      viewerId: run.userId,
      scope,
      snapshot: async () => ({ ok: true }),
    });
    const longReply = `${"Long assistant reply paragraph. ".repeat(500)}END_OF_LONG_REPLY`;
    const linkedReply = "Check [notes.md](file:///tmp/notes.md) and [item](opensteer://task/123).";
    const assistantAuthor = {
      kind: "agent" as const,
      displayName: "Opensteer",
      threadId: run.threadId,
      runId: run.runId,
    };
    const longId = createId("message");
    const linkedId = createId("message");
    const manyRefsId = createId("message");
    const manyAttachments = Array.from({ length: 8 }, (_, index) => ({
      type: "artifact" as const,
      artifactId: `artifact-${index}`,
      mediaType: "image/png",
      name: `shot-${index}.png`,
    }));
    const boundaryAttachments = Array.from({ length: 7 }, (_, index) => ({
      type: "artifact" as const,
      artifactId: `boundary-artifact-${index}`,
      mediaType: "image/png",
      name: `boundary-${index}.png`,
    }));
    const boundaryHead = "B".repeat(200 * 1024);
    const boundarySkeleton = [
      { type: "text" as const, text: boundaryHead },
      { type: "text" as const, text: "" },
      ...boundaryAttachments,
    ];
    const boundaryFillerLen = 358_400 - Buffer.byteLength(JSON.stringify(boundarySkeleton));
    const boundaryContent = [
      { type: "text" as const, text: boundaryHead },
      { type: "text" as const, text: "Z".repeat(boundaryFillerLen) },
      ...boundaryAttachments,
    ];
    const boundaryId = createId("message");
    const hugeId = createId("message");
    const hugeReply = `${"H".repeat(500 * 1024)}END_HUGE`;
    const nodeId = createId("executionNode");
    const nodeMessageId = `node-message:${createId("message")}`;
    const longNodeText = `${"Subagent finding. ".repeat(400)}END_OF_SUBAGENT`;

    await database
      .insertInto("executionNodes")
      .values({
        id: nodeId,
        attemptId,
        runId: run.runId,
        status: "running",
        kind: "subagent",
        effort: null,
        phaseIndex: null,
        phases: sql`'[]'::jsonb`,
        title: "Researcher",
        startedAt: new Date(),
        endedAt: null,
        nativeRef: "fixture",
        originCallId: null,
        parentNodeId: null,
        prompt: "Check it",
        result: null,
        sessionRef: null,
        model: null,
      })
      .execute();

    await commitPersonalMutation(database, async (tx, mutation) => {
      for (const [id, content, sequence] of [
        [longId, [{ type: "text" as const, text: longReply }], "100"],
        [linkedId, [{ type: "text" as const, text: linkedReply }], "101"],
        [manyRefsId, [{ type: "text" as const, text: "Eight shots" }, ...manyAttachments], "102"],
        [boundaryId, boundaryContent, "103"],
        [hugeId, [{ type: "text" as const, text: hugeReply }], "104"],
      ] as const) {
        await tx
          .insertInto("messages")
          .values({
            ...templateMessage,
            id,
            threadId: run.threadId,
            runId: run.runId,
            sequence,
            kind: "assistant",
            author: jsonValue(assistantAuthor),
            content: jsonValue(content),
            published: true,
            createdAt: new Date(),
          })
          .execute();
        const described = describeTranscriptMessage({
          kind: "assistant",
          content,
          author: assistantAuthor,
          edited: false,
          admittedSeed: false,
          seedInRun: false,
          assigned: false,
        });
        await writeExecutionItem(
          tx,
          mutation,
          {
            id,
            kind: "message",
            messageId: id,
            createdAt: new Date(),
            threadId: run.threadId,
            runId: run.runId,
            attemptId,
            nodeId: null,
            visible: true,
            isTurnStart: false,
            view: described.view,
            refs: described.refs,
          },
          undefined,
          undefined,
          described.messageText,
        );
      }
      await writeExecutionItem(tx, mutation, {
        id: nodeMessageId,
        kind: "node-message",
        createdAt: new Date(),
        threadId: run.threadId,
        runId: run.runId,
        attemptId,
        nodeId,
        visible: true,
        isTurnStart: false,
        body: longNodeText,
        view: transcriptPreview({ preview: longNodeText }),
      });
    });

    // Live replay (`client_changes`) delivers the 16 KiB reply and linked reply whole.
    const replay = await readPersonalScopeCut(database, {
      viewerId: run.userId,
      scope,
      cursor: {
        deploymentId: beforeCut.state.deploymentId,
        epoch: beforeCut.state.epoch,
        viewerId: run.userId,
        scopeKey: `thread:${run.threadId}`,
        afterSequence: beforeCut.state.sequence,
      },
      snapshot: async () => ({ ok: true }),
    });
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") throw new Error("Expected live replay");
    const pushed = replay.commits.flatMap((commit) => commit.changes);
    const pushedLong = pushed.find((change) => change.entityId === longId)?.value as
      | Record<string, unknown>
      | undefined;
    expect(pushedLong?.text).toBe(longReply);
    expect((pushedLong?.view as Record<string, unknown> | undefined)?.truncated).toBeUndefined();
    const pushedLinked = pushed.find((change) => change.entityId === linkedId)?.value as
      | Record<string, unknown>
      | undefined;
    expect(pushedLinked?.text).toBe(linkedReply);
    expect((pushedLinked?.view as Record<string, unknown> | undefined)?.truncated).toBeUndefined();

    // `readTranscriptPage` returns inline text for ordinary/linked replies and keeps extra refs
    // + > 480 KiB rows flagged truncated.
    const page = await readTranscriptPage(database, query);
    expect(page.kind).toBe("page");
    if (page.kind !== "page") throw new Error("Expected page");
    const pageLong = page.items.find((item) => item.id === longId);
    expect(pageLong).toMatchObject({ kind: "message", text: longReply });
    expect(pageLong?.view.truncated).toBeUndefined();
    const pageLinked = page.items.find((item) => item.id === linkedId);
    expect(pageLinked).toMatchObject({ kind: "message", text: linkedReply });
    expect(pageLinked?.view.truncated).toBeUndefined();
    const pageManyRefs = page.items.find((item) => item.id === manyRefsId);
    expect(pageManyRefs).toMatchObject({ kind: "message", text: "Eight shots" });
    expect(pageManyRefs?.view.truncated).toBe(true);

    // `readTranscriptItem` omits duplicate `item.text` while returning the full `body`.
    const manyRefsDetail = await readTranscriptItem(database, { ...query, itemId: manyRefsId });
    expect(manyRefsDetail).toMatchObject({
      kind: "item",
      truncated: false,
      body: {
        kind: "message",
        message: {
          id: manyRefsId,
          content: [{ type: "text", text: "Eight shots" }, ...manyAttachments],
        },
      },
    });
    expect(
      manyRefsDetail.kind === "item" && manyRefsDetail.item.kind === "message"
        ? manyRefsDetail.item.text
        : undefined,
    ).toBeUndefined();

    // A valid 358,400-byte message with 7 attachments (whose PostgreSQL `jsonb::text` exceeds
    // 358,400 due to formatting spaces) still hydrates completely through `readTranscriptItem`.
    const boundaryDetail = await readTranscriptItem(database, { ...query, itemId: boundaryId });
    expect(boundaryDetail).toMatchObject({
      kind: "item",
      truncated: false,
      body: {
        kind: "message",
        message: {
          id: boundaryId,
          content: boundaryContent,
        },
      },
    });

    // Oversized legacy > 480 KiB message omits inline text on page and degrades cleanly to
    // `{ body: null, truncated: true }` instead of throwing on detail read.
    const pageHuge = page.items.find((item) => item.id === hugeId);
    expect(pageHuge?.kind === "message" ? pageHuge.text : undefined).toBeUndefined();
    expect(pageHuge?.view.truncated).toBe(true);
    const hugeDetail = await readTranscriptItem(database, { ...query, itemId: hugeId });
    expect(hugeDetail).toMatchObject({ kind: "item", body: null, truncated: true });

    // Subagent `node-message` ships whole inline and omits duplicate text on detail read.
    const nodePage = await readTranscriptPage(database, {
      viewerId: run.userId,
      scope: { kind: "node", threadId: run.threadId, nodeId },
    });
    expect(nodePage.kind).toBe("page");
    if (nodePage.kind !== "page") throw new Error("Expected node page");
    const nodeItem = nodePage.items.find((item) => item.id === nodeMessageId);
    expect(nodeItem).toMatchObject({ kind: "node-message", text: longNodeText });
    expect(nodeItem?.view.truncated).toBeUndefined();
    const nodeDetail = await readTranscriptItem(database, {
      viewerId: run.userId,
      scope: { kind: "node", threadId: run.threadId, nodeId },
      itemId: nodeMessageId,
    });
    expect(nodeDetail).toMatchObject({
      kind: "item",
      truncated: false,
      body: { kind: "text", text: longNodeText },
    });
    expect(
      nodeDetail.kind === "item" && nodeDetail.item.kind === "node-message"
        ? nodeDetail.item.text
        : undefined,
    ).toBeUndefined();

    // Whole-row guarantee: even with a tight 8 KiB budget, a single 16 KiB reply is still admitted
    // whole so pagination never stalls with an empty page.
    const tightPage = await readTranscriptPage(database, {
      ...query,
      cursor: {
        deploymentId: beforeCut.state.deploymentId,
        epoch: beforeCut.state.epoch,
        viewerId: run.userId,
        threadId: run.threadId,
        nodeId: null,
        beforePosition: pageLinked!.position,
        beforeId: pageLinked!.id,
      },
      limit: 5,
      maxBytes: 8192,
    });
    expect(tightPage.kind).toBe("page");
    if (tightPage.kind !== "page") throw new Error("Expected tight page");
    expect(tightPage.items).toHaveLength(1);
    expect(tightPage.items[0]).toMatchObject({ id: longId, text: longReply });
  } finally {
    await fixture.close();
  }
});

test("migration 0043 upgrades an 0042 8 KiB client_changes constraint, preserves retained rows and rotates epoch", async () => {
  const fixture = await createPersonalStateFixture("upgrade-0042-0043");
  const { database, run } = fixture;
  try {
    // Simulate a pre-0043 database with the original 8 KiB check and a retained feed row.
    await sql`
      alter table client_changes drop constraint client_changes_byte_count_check;
      alter table client_changes add constraint client_changes_byte_count_check
        check (byte_count <= 8192);
    `.execute(database);
    const before = await database
      .selectFrom("clientSyncState")
      .select(["deploymentId", "epoch", "sequence"])
      .executeTakeFirstOrThrow();
    const retainedCountBefore = await database
      .selectFrom("clientChanges")
      .select(sql<number>`count(*)::int`.as("count"))
      .executeTakeFirstOrThrow();

    await applyInlineTranscriptMessages(database);
    expect(inlineTranscriptMessagesMigrationName).toBe("0043_inline_transcript_messages");

    const after = await database
      .selectFrom("clientSyncState")
      .select(["deploymentId", "epoch", "sequence"])
      .executeTakeFirstOrThrow();
    expect(after.epoch).not.toBe(before.epoch);
    const retainedCountAfter = await database
      .selectFrom("clientChanges")
      .select(sql<number>`count(*)::int`.as("count"))
      .executeTakeFirstOrThrow();
    expect(retainedCountAfter.count).toBe(retainedCountBefore.count);

    // A cursor from before 0043 falls back to a fresh snapshot because the epoch rotated.
    const cut = await readPersonalScopeCut(database, {
      viewerId: run.userId,
      scope: { kind: "thread", threadId: run.threadId },
      cursor: {
        deploymentId: before.deploymentId,
        epoch: before.epoch,
        viewerId: run.userId,
        scopeKey: `thread:${run.threadId}`,
        afterSequence: before.sequence,
      },
      snapshot: async () => ({ fresh: true }),
    });
    expect(cut).toMatchObject({ kind: "snapshot", snapshot: { fresh: true } });

    // `client_changes` now admits > 8 KiB payloads up to 512 KiB.
    await database
      .insertInto("clientChanges")
      .values({
        deploymentId: after.deploymentId,
        sequence: String(BigInt(after.sequence) + 100n),
        scopeKey: `thread:${run.threadId}`,
        ordinal: 0,
        entityKind: "item",
        entityId: createId("message"),
        operation: "upsert",
        payload: { text: "x".repeat(32 * 1024) },
        createdAt: new Date(),
      })
      .execute();
  } finally {
    await fixture.close();
  }
});
