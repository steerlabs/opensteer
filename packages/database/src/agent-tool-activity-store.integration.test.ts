import { expect } from "vitest";
import { createToolOutput } from "@opensteer/core";
import { describeStore } from "./store.integration.test-support.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import { AgentToolActivityStore } from "./agent-tool-activity-store.js";

describeStore("Harness tool activity", (it) => {
  it("persists one pair across concurrent retries and restart, detects changed arguments and fences a stale attempt", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("harness-activity");
    const activity = new AgentToolActivityStore(database, appendHostDeploymentEvent);
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
    expect(starts[0]!.started.eventId).toBe(starts[1]!.started.eventId);
    const output = createToolOutput(
      JSON.stringify({ content: [{ type: "text", text: "result" }] }),
    );
    const completed = await Promise.all(
      starts.map((start) => activity.complete(start.started, output, false)),
    );
    expect(completed[0]!.eventId).toBe(completed[1]!.eventId);
    const restarted = new AgentToolActivityStore(database, appendHostDeploymentEvent);
    expect(await restarted.start(context, callId, "tab_list", { query: "work" })).toMatchObject({
      replay: true,
      completed: { eventId: completed[0]!.eventId },
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
    const rows = await database
      .selectFrom("deploymentEvents")
      .select(["type", "data"])
      .where("runId", "=", context.runId)
      .where("type", "in", ["tool.started", "tool.completed"])
      .execute();
    expect(rows.map((row) => row.type)).toEqual(["tool.started", "tool.completed"]);
    expect(rows[0]!.data).toMatchObject({
      callId,
      tool: { namespace: "opensteer", name: "tab_list" },
      arguments: { query: "work" },
    });
  });
  it("completes cancellation once even when the Run has ended", async ({ storeFixture }) => {
    const f = await storeFixture.startRunFixture("harness-cancel");
    const activity = new AgentToolActivityStore(storeFixture.database, appendHostDeploymentEvent);
    const context = {
      runId: f.run.id,
      threadId: f.thread.id,
      environmentId: f.environmentId,
      bindingGeneration: f.bindingGeneration,
    };
    const callId = `harness:${context.runId}:${context.bindingGeneration}:${crypto.randomUUID()}`;
    const { started } = await activity.start(context, callId, "tab_open", {
      target: { kind: "page", guest: true, url: "https://example.test" },
    });
    const orphanId = `harness:${context.runId}:${context.bindingGeneration}:${crypto.randomUUID()}`;
    await activity.start(context, orphanId, "tab_list", {});
    await storeFixture.database
      .updateTable("runs")
      .set({ status: "interrupted" })
      .where("id", "=", f.run.id)
      .execute();
    const output = createToolOutput(
      '{"error":{"code":"outcome_unknown","message":"Cancelled","next":null}}',
    );
    const one = await activity.complete(started, output, true);
    expect((await activity.complete(started, output, true)).eventId).toBe(one.eventId);
    expect(await activity.finalize(context.runId)).toMatchObject([
      { data: { callId: orphanId, isError: true } },
    ]);
    expect(await activity.finalize(context.runId)).toEqual([]);
    await expect(
      activity.start(
        context,
        `harness:${context.runId}:${context.bindingGeneration}:${crypto.randomUUID()}`,
        "tab_list",
        {},
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
