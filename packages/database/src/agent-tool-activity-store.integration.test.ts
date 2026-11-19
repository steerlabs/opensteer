import { expect } from "vitest";
import { createToolOutput } from "@opensteer/core";
import { describeStore } from "./store.integration.test-support.js";
import { AgentToolActivityStore } from "./agent-tool-activity-store.js";

describeStore("Harness tool activity", (it) => {
  it("reuses the effect and card across retries, detects changed arguments and fences a stale attempt", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("harness-activity");
    const activity = new AgentToolActivityStore(database);
    const context = {
      runId: f.run.id,
      threadId: f.thread.id,
      environmentId: f.environmentId,
      bindingGeneration: f.bindingGeneration,
    };
    const callId = `harness:${context.runId}:${context.bindingGeneration}:${crypto.randomUUID()}`;
    const starts = await Promise.all([
      activity.start(context, callId, "tab_list", { query: "work" }),
      activity.start(context, callId, "tab_list", { query: "work" }),
    ]);
    expect(starts.map((start) => start.replay).sort()).toEqual([false, true]);
    expect(starts[0]!.handle).toEqual(starts[1]!.handle);
    const output = createToolOutput(
      JSON.stringify({ content: [{ type: "text", text: "result" }] }),
    );
    const completed = await Promise.all(
      starts.map((start) => activity.complete(start.handle, output, false)),
    );
    expect(completed.map((entry) => entry.completed).sort()).toEqual([false, true]);
    expect(completed.every((entry) => entry.call.id === starts[0]!.handle.toolCallId)).toBe(true);
    const restarted = new AgentToolActivityStore(database);
    expect(await restarted.start(context, callId, "tab_list", { query: "work" })).toMatchObject({
      replay: true,
      completed: { output, isError: false },
    });
    await expect(
      restarted.start(context, callId, "tab_list", { query: "changed" }),
    ).rejects.toMatchObject({ code: "conflict" });
    const stale = { ...context, bindingGeneration: context.bindingGeneration + 1 };
    await expect(
      restarted.start(
        stale,
        `harness:${stale.runId}:${stale.bindingGeneration}:${crypto.randomUUID()}`,
        "tab_list",
        {},
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await database
        .selectFrom("toolCalls")
        .select(["callId", "tool", "arguments", "status", "output"])
        .where("runId", "=", context.runId)
        .execute(),
    ).toEqual([
      {
        callId,
        tool: { namespace: "opensteer", name: "tab_list" },
        arguments: { query: "work" },
        status: "completed",
        output,
      },
    ]);
    expect(
      await database
        .selectFrom("transcriptItems")
        .select("id")
        .where("runId", "=", context.runId)
        .where("kind", "=", "tool")
        .execute(),
    ).toEqual([{ id: `tool:${starts[0]!.handle.toolCallId}` }]);
  });

  it("interrupts a missing Host effect receipt once and discards late results", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const f = await storeFixture.startRunFixture("harness-cancel");
    const activity = new AgentToolActivityStore(database);
    const context = {
      runId: f.run.id,
      threadId: f.thread.id,
      environmentId: f.environmentId,
      bindingGeneration: f.bindingGeneration,
    };
    const callId = `harness:${context.runId}:${context.bindingGeneration}:${crypto.randomUUID()}`;
    const { handle } = await activity.start(context, callId, "tab_open", {
      target: { kind: "page", guest: true, url: "https://example.test" },
    });
    await activity.finalize(context.runId);
    await activity.finalize(context.runId);
    const late = await activity.complete(handle, createToolOutput("Late output"), false);
    expect(late).toMatchObject({
      completed: false,
      call: { id: handle.toolCallId, status: "interrupted", output: null },
    });
    expect(
      await activity.start(context, callId, "tab_open", {
        target: { kind: "page", guest: true, url: "https://example.test" },
      }),
    ).toMatchObject({ replay: true, completed: null });
  });
});
