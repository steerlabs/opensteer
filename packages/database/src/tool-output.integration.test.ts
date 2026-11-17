import { readTranscriptItem, readTranscriptPage } from "./personal-sync-store.js";
import { createId } from "@opensteer/core";
import { expect } from "vitest";
import { describeStore, pendingEvent } from "./store.integration.test-support.js";
describeStore("on-demand tool output", (it) => {
  it("reads exact stored output only for the active personal owner and the matching node", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("tool-output");
    const text = "output 🙂\n".repeat(2000);
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerId: f.runnerId,
      runnerBootId: f.runnerBootId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        environmentId: f.environmentId,
        ordinal: 1,
        runId: f.run.id,
        threadId: f.thread.id,
        type: "tool.completed",
        data: {
          callId: "call",
          isError: false,
          output: {
            text,
          },
        },
      }),
    });
    const nodeId = createId("executionNode");
    for (const [ordinal, event] of [
      [
        2,
        {
          type: "node.started",
          data: {
            nodeId,
            kind: "subagent",
            model: null,
            title: "Research",
            nativeRef: "child",
            sessionRef: null,
            originCallId: null,
            parentNodeId: null,
            prompt: null,
          },
        },
      ],
      [
        3,
        {
          type: "tool.completed",
          data: {
            nodeId,
            callId: "call",
            isError: false,
            output: {
              text: `child ${text}`,
            },
          },
        },
      ],
    ] as const) {
      await store.commitRunnerEvent({
        environmentId: f.environmentId,
        runnerId: f.runnerId,
        runnerBootId: f.runnerBootId,
        event: pendingEvent({
          ...event,
          bindingGeneration: f.bindingGeneration,
          environmentId: f.environmentId,
          ordinal,
          runId: f.run.id,
          threadId: f.thread.id,
        }),
      });
    }
    const threadScope = { kind: "thread", threadId: f.thread.id } as const;
    const nodeScope = { kind: "node", threadId: f.thread.id, nodeId } as const;
    for (const [scope, expected] of [
      [threadScope, text],
      [nodeScope, `child ${text}`],
    ] as const) {
      const page = await readTranscriptPage(database, { viewerId: f.userId, scope });
      if (page.kind !== "page") throw new Error("Expected transcript page");
      const items = page.items.filter((item) => item.kind === "tool");
      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.view.status).toBe("completed");
      expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(Buffer.byteLength(expected));
      expect(
        await readTranscriptItem(database, { viewerId: f.userId, scope, itemId: item.id }),
      ).toMatchObject({ kind: "item", body: { kind: "tool", output: { text: expected } } });
      const otherScope = scope.kind === "thread" ? nodeScope : threadScope;
      expect(
        await readTranscriptItem(database, {
          viewerId: f.userId,
          scope: otherScope,
          itemId: item.id,
        }),
      ).toEqual({ kind: "unavailable" });
      await expect(
        readTranscriptItem(database, {
          viewerId: await store.createUser("Outsider"),
          scope,
          itemId: item.id,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", f.userId)
      .execute();
    await expect(
      readTranscriptPage(database, { viewerId: f.userId, scope: threadScope }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
