import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "./mock-host-client.js";
import { conversationSubagents } from "../host/subagent-model.js";
import { ExecutionNodeIdSchema, RunIdSchema } from "@opensteer/core";

let client: MockHostClient | undefined;
afterEach(() => {
  client?.dispose();
  client = undefined;
});
it("opens real mock node history without adding detail to its conversation", async () => {
  client = new MockHostClient({ places: "absent" });
  const before = client.getSnapshot();
  const thread = before.threads.find((thread) => thread.title === "Subagents everywhere")!;
  const card = conversationSubagents(before, thread.id).cards.find(
    (card) => card.title === "Trace the client",
  )!;
  if (card.open.kind !== "node-detail") throw new Error("Expected node detail");
  const detail = client.watchNode(thread.id, card.open.nodeId);
  await vi.waitFor(() => expect(detail.getSnapshot().status).toBe("ready"));
  expect(detail.getSnapshot().entries.map((entry) => entry.kind)).toEqual([
    "node-message",
    "node",
    "reasoning",
    "tool",
  ]);
  const page = await client.rpc["node.events.list"]({
    threadId: thread.id,
    nodeId: ExecutionNodeIdSchema.parse(card.open.nodeId),
    limit: 2,
  });
  expect(page.ok).toBe(true);
  if (page.ok) expect(page.data.window).toMatchObject({ hasMore: true, itemCount: 2 });
  const attempts = await client.rpc["run.attempts.list"]({ runId: RunIdSchema.parse(card.runId) });
  expect(attempts.ok).toBe(true);
  if (attempts.ok) expect(attempts.data.nodes.length).toBeGreaterThan(0);
  expect(client.getSnapshot().transcripts[thread.id]).toEqual(before.transcripts[thread.id]);
  detail.release();
  expect(detail.getSnapshot().status).toBe("closed");
});
