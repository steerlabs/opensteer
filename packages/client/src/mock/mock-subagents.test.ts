import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "./mock-host-client.js";
import { reviewHostAction } from "../host/action-review.js";
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
  const card = conversationSubagents(before, thread.id).now.find(
    (card) => card.title === "Trace the client",
  )!;
  if (card.opens?.kind !== "subagent") throw new Error("Expected node detail");
  const detail = client.watchNode(thread.id, card.opens.nodeId);
  await vi.waitFor(() => expect(detail.getSnapshot().status).toBe("ready"));
  expect(detail.getSnapshot().entries.map((entry) => entry.kind)).toEqual([
    "node-message",
    "node",
    "reasoning",
    "tool",
  ]);
  const page = await client.rpc["node.events.list"]({
    threadId: thread.id,
    nodeId: ExecutionNodeIdSchema.parse(card.opens.nodeId),
    limit: 2,
  });
  expect(page.ok).toBe(true);
  if (page.ok) expect(page.data.window).toMatchObject({ hasMore: true, itemCount: 2 });
  const nodeId = card.opens.nodeId;
  const node = before.transcripts[thread.id]!.find(
    (entry) => entry.kind === "node" && entry.nodeId === nodeId,
  );
  if (node?.kind !== "node") throw new Error("Missing node");
  const attempts = await client.rpc["run.attempts.list"]({ runId: RunIdSchema.parse(node.runId) });
  expect(attempts.ok).toBe(true);
  if (attempts.ok) expect(attempts.data.nodes.length).toBeGreaterThan(0);
  expect(client.getSnapshot().transcripts[thread.id]).toEqual(before.transcripts[thread.id]);
  detail.release();
  expect(detail.getSnapshot().status).toBe("closed");
});

it("stops one mock subagent while its Run and siblings keep working", async () => {
  client = new MockHostClient({ places: "absent" });
  await client.load();
  const before = client.getSnapshot();
  const thread = before.threads.find((thread) => thread.title === "Subagents everywhere")!;
  const nodes = before.transcripts[thread.id]!.filter(
    (entry) => entry.kind === "node" && entry.status === "running",
  );
  const target = nodes[0]!;
  if (target.kind !== "node") throw new Error("Expected node");
  const review = reviewHostAction(client, {
    kind: "stop-node",
    threadId: thread.id,
    nodeId: target.nodeId,
  });
  expect(review).not.toBeNull();
  await client.stopNode(thread.id, target.nodeId);
  expect(review!.current()).toBe(false);
  expect(await review!.confirm()).toBe(false);
  const after = client.getSnapshot();
  expect(after.runQueue).toEqual(before.runQueue);
  expect(after.threads).toEqual(before.threads);
  expect(
    after.transcripts[thread.id]!.filter(
      (entry) => entry.kind === "node" && entry.nodeId !== target.nodeId,
    ),
  ).toEqual(
    before.transcripts[thread.id]!.filter(
      (entry) => entry.kind === "node" && entry.nodeId !== target.nodeId,
    ),
  );
  expect(
    after.transcripts[thread.id]!.find(
      (entry) => entry.kind === "node" && entry.nodeId === target.nodeId,
    ),
  ).toMatchObject({ status: "interrupted", stopping: false });
});

it("stops a mock workflow with its members while other subagents keep working", async () => {
  client = new MockHostClient({ places: "absent" });
  const before = client.getSnapshot();
  const thread = before.threads.find((thread) => thread.title === "Subagents everywhere")!;
  const entries = before.transcripts[thread.id]!;
  const workflow = entries.find((entry) => entry.kind === "node" && entry.nodeKind === "workflow");
  if (workflow?.kind !== "node") throw new Error("Expected workflow");
  const memberIds = entries.flatMap((entry) =>
    entry.kind === "node" && entry.parentNodeId === workflow.nodeId ? [entry.nodeId] : [],
  );
  expect(memberIds.length).toBeGreaterThan(0);
  await client.stopNode(thread.id, workflow.nodeId);
  const after = client.getSnapshot().transcripts[thread.id]!;
  expect(
    after.flatMap((entry) =>
      entry.kind === "node" && memberIds.includes(entry.nodeId)
        ? [{ nodeId: entry.nodeId, status: entry.status }]
        : [],
    ),
  ).toEqual(
    entries.flatMap((entry) =>
      entry.kind === "node" && memberIds.includes(entry.nodeId)
        ? [
            {
              nodeId: entry.nodeId,
              status: entry.status === "running" ? "interrupted" : entry.status,
            },
          ]
        : [],
    ),
  );
  expect(
    after.filter(
      (entry) =>
        entry.kind === "node" &&
        entry.nodeId !== workflow.nodeId &&
        !memberIds.includes(entry.nodeId),
    ),
  ).toEqual(
    entries.filter(
      (entry) =>
        entry.kind === "node" &&
        entry.nodeId !== workflow.nodeId &&
        !memberIds.includes(entry.nodeId),
    ),
  );
  expect(client.getSnapshot().runQueue).toEqual(before.runQueue);
});
