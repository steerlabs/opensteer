import { createId, previewToolOutput } from "@opensteer/core";
import { expect } from "vitest";
import { describeStore, pendingEvent } from "./store.integration.test-support.js";

describeStore("on-demand tool output", (it) => {
  it("reads exact stored output only for an active member and the matching node", async ({
    storeFixture,
  }) => {
    const { store, startRunFixture } = storeFixture;
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
        workspaceId: f.workspace.id,
        type: "tool.completed",
        data: { callId: "call", isError: false, output: { text } },
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
          data: { nodeId, callId: "call", isError: false, output: { text: `child ${text}` } },
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
          workspaceId: f.workspace.id,
        }),
      });
    }
    const input = { ownerId: f.userId, threadId: f.thread.id, runId: f.run.id, callId: "call" };
    expect(await store.toolOutputForOwner(input)).toEqual({ text });
    expect(await store.toolOutputForOwner({ ...input, nodeId })).toEqual({ text: `child ${text}` });
    const nodePage = await store.nodeEventPageForOwner({ ...input, nodeId, maxItems: 1 });
    expect(nodePage!.events).toHaveLength(1);
    expect(nodePage!.events[0]).toMatchObject({
      type: "tool.completed",
      data: { output: { text: `child ${text}` } },
    });
    expect(nodePage!.events.map(previewToolOutput)[0]).toMatchObject({
      data: { outputPreview: { bytes: Buffer.byteLength(`child ${text}`), cut: true } },
    });

    expect(
      await store.toolOutputForOwner({ ...input, ownerId: await store.createUser("Outsider") }),
    ).toBeNull();
    expect(
      await store.toolOutputForOwner({ ...input, nodeId: createId("executionNode") }),
    ).toBeNull();
    const page = await store.threadEventPageForOwner(input);
    const completed = page!.events.find((event) => event.type === "tool.completed")!;
    expect(completed.type === "tool.completed" && completed.data.output.text).toBe(text);
    const projected = previewToolOutput(completed);
    expect(projected.type === "tool.completed" && projected.data.outputPreview).toEqual({
      bytes: new TextEncoder().encode(text).byteLength,
      cut: true,
      digest: expect.any(String),
    });
  });
});
