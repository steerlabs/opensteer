import { createId, SequenceSchema, type AgentEventView as AgentEvent } from "@opensteer/core";
import type { NodeEventPage } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { NodeDetailStore } from "./node-detail.js";
import type { NodeEntry } from "./client.js";

const workspaceId = createId("workspace");
const threadId = createId("thread");
const runId = createId("run");
const nodeId = createId("executionNode");
const now = "2026-11-10T14:00:00.000Z";
const seq = (value: number) => SequenceSchema.parse(String(value));
function event<Type extends AgentEvent["type"]>(
  type: Type,
  sequence: number,
  data: Extract<AgentEvent, { type: Type }>["data"],
): AgentEvent {
  return {
    type,
    data,
    sequence: seq(sequence),
    threadId,
    runId,
    workspaceId,
    environmentId: createId("environment"),
    eventId: createId("event"),
    createdAt: now,
  } as AgentEvent;
}
function page(events: AgentEvent[], nextBefore: string | null = null): NodeEventPage {
  return {
    nodeId,
    threadId,
    events,
    window: {
      byteCount: 0,
      totalItems: events.length,
      itemCount: events.length,
      hasMore: nextBefore !== null,
      nextBefore,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("node detail watch", () => {
  it("holds events and live tool output behind the page, orders them once and clears the watch on release", async () => {
    const first = deferred<NodeEventPage>();
    const sends: (string | null)[] = [];
    const read = vi.fn(() => first.promise);
    const store = new NodeDetailStore({
      available: () => true,
      read,
      nodes: () => [],
      sendWatch: (_workspace, id) => {
        sends.push(id);
        return true;
      },
    });
    const detail = store.open(threadId, nodeId, workspaceId);
    expect(sends).toEqual([nodeId]);
    expect(read).not.toHaveBeenCalled();
    store.watched(workspaceId, nodeId, seq(2));
    expect(read).toHaveBeenCalledWith({ nodeId, threadId, through: seq(2), limit: 100 });
    const message = event("node.message", 1, { nodeId, text: "Starting" });
    const tool = event("tool.started", 2, {
      nodeId,
      callId: "read",
      tool: { namespace: "functions", name: "read" },
      arguments: {},
    });
    const reasoning = event("reasoning.completed", 3, {
      nodeId,
      blockId: "reason",
      text: "Checking the race",
    });
    store.accept(reasoning);
    store.accept(tool);
    store.accept(reasoning);
    store.acceptLive({
      afterSequence: seq(3),
      progress: {
        workspaceId,
        threadId,
        runId,
        items: [
          { stream: "tool", nodeId, callId: "read", op: "replace", length: 7, text: "partial" },
        ],
      },
    });
    expect(detail.getSnapshot().entries).toEqual([]);
    first.resolve(page([message, tool]));
    await vi.waitFor(() => expect(detail.getSnapshot().status).toBe("ready"));
    expect(detail.getSnapshot().entries.map((entry) => entry.kind)).toEqual([
      "node-message",
      "tool",
      "reasoning",
    ]);
    expect(detail.getSnapshot().entries[1]).toMatchObject({
      streamText: "partial",
      state: "running",
    });
    store.accept(
      event("tool.completed", 4, {
        nodeId,
        callId: "read",
        output: { text: "final" },
        isError: false,
      }),
    );
    expect(detail.getSnapshot().entries).toHaveLength(3);
    expect(detail.getSnapshot().entries[1]).toMatchObject({
      output: { text: "final" },
      state: "done",
    });
    detail.release();
    expect(sends).toEqual([nodeId, null]);
    expect(detail.getSnapshot()).toMatchObject({ status: "closed", entries: [] });
  });

  it("rewatches on reconnect and fills a gap larger than a page without losing older history", async () => {
    const all = [event("node.message", 1, { nodeId, text: "Before disconnect" })];
    const reads: { before?: string }[] = [];
    const sends: (string | null)[] = [];
    const store = new NodeDetailStore({
      available: () => true,
      nodes: () => [],
      sendWatch: (_workspace, id) => {
        sends.push(id);
        return true;
      },
      read: async (input) => {
        reads.push(input);
        const eligible = all.filter(
          (item) =>
            Number(item.sequence) <= Number(input.through) &&
            (!input.before || Number(item.sequence) < Number(input.before)),
        );
        const events = eligible.slice(-input.limit);
        return page(events, eligible.length > events.length ? events[0]!.sequence : null);
      },
    });
    const detail = store.open(threadId, nodeId, workspaceId);
    store.watched(workspaceId, nodeId, seq(1));
    await vi.waitFor(() => expect(detail.getSnapshot().status).toBe("ready"));
    store.disconnected(workspaceId);
    for (let index = 2; index <= 106; index += 1)
      all.push(event("node.message", index, { nodeId, text: `Message ${index}` }));
    store.connected(workspaceId);
    store.watched(workspaceId, nodeId, seq(106));
    const after = event("node.message", 107, { nodeId, text: "After watch" });
    store.accept(after);
    await vi.waitFor(() => expect(detail.getSnapshot().status).toBe("ready"));
    expect(detail.getSnapshot().entries).toHaveLength(107);
    expect(detail.getSnapshot().entries[0]).toMatchObject({ text: "Before disconnect" });
    expect(detail.getSnapshot().entries.at(-1)).toMatchObject({ text: "After watch" });
    store.accept(after);
    expect(detail.getSnapshot().entries).toHaveLength(107);
    expect(sends).toEqual([nodeId, nodeId]);
    expect(reads).toHaveLength(3);
    detail.release();
  });

  it("loads older work on demand and ignores a replaced watch's late response", async () => {
    const old = deferred<NodeEventPage>();
    const reads = vi.fn(async (input: { nodeId: string; before?: string }) => {
      if (input.nodeId !== nodeId) return old.promise;
      return input.before
        ? page([event("node.message", 1, { nodeId, text: "Older" })])
        : page([event("node.message", 2, { nodeId, text: "Newer" })], "2");
    });
    const child: NodeEntry = {
      id: "child",
      nodeId: "child",
      kind: "node",
      nodeKind: "subagent",
      title: "Nested",
      status: "running",
      runId,
      createdAt: now,
      completedAt: null,
      model: null,
      effort: null,
      phaseIndex: null,
      phases: [],
      progress: null,
      parentNodeId: nodeId,
      originCallId: null,
      prompt: null,
      result: null,
    };
    const own: NodeEntry = {
      ...child,
      id: `node:${nodeId}`,
      nodeId,
      parentNodeId: null,
      status: "completed",
      completedAt: now,
      result: "Final outcome",
    };
    const store = new NodeDetailStore({
      available: () => true,
      read: reads,
      nodes: () => [],
      readNodes: async () => [own, child],
      sendWatch: () => true,
    });
    const replacedId = createId("executionNode");
    const replaced = store.open(threadId, replacedId, workspaceId);
    store.watched(workspaceId, replacedId, seq(2));
    const current = store.open(threadId, nodeId, workspaceId);
    store.watched(workspaceId, nodeId, seq(2));
    await vi.waitFor(() => expect(current.getSnapshot().status).toBe("ready"));
    expect(current.getSnapshot().hasMore).toBe(true);
    await current.loadOlder();
    expect(
      current.getSnapshot().entries.filter((entry) => entry.kind === "node-message"),
    ).toMatchObject([{ text: "Older" }, { text: "Newer" }]);
    expect(current.getSnapshot().entries).toContainEqual(child);
    expect(current.getSnapshot().node).toEqual(own);
    expect(current.getSnapshot().entries).toContainEqual({
      kind: "node-result",
      id: `result:${nodeId}`,
      createdAt: now,
      text: "Final outcome",
    });
    expect(current.getSnapshot().hasMore).toBe(false);
    old.resolve({ ...page([]), nodeId: replacedId });
    await old.promise;
    expect(replaced.getSnapshot().status).toBe("closed");
    expect(current.getSnapshot().entries).toHaveLength(4);
    replaced.release();
    expect(current.getSnapshot().status).toBe("ready");
    current.release();
  });

  it("reports unavailable without the capability and clears an open watch if it is withdrawn", async () => {
    let available = false;
    const sendWatch = vi.fn(() => true);
    const read = vi.fn(async () =>
      page([event("node.message", 1, { nodeId, text: "Private work" })]),
    );
    const store = new NodeDetailStore({
      available: () => available,
      read,
      sendWatch,
      nodes: () => [],
    });
    const detail = store.open(threadId, nodeId, workspaceId);
    expect(detail.getSnapshot().status).toBe("unavailable");
    expect(sendWatch).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    available = true;
    store.capabilitiesChanged();
    store.watched(workspaceId, nodeId, seq(1));
    await vi.waitFor(() => expect(detail.getSnapshot().status).toBe("ready"));
    expect(detail.getSnapshot().entries).toHaveLength(1);
    available = false;
    store.capabilitiesChanged();
    expect(detail.getSnapshot()).toMatchObject({ status: "unavailable", entries: [], node: null });
    expect(sendWatch).toHaveBeenLastCalledWith(workspaceId, null);
    detail.release();
    expect(sendWatch).toHaveBeenCalledTimes(2);
  });
});
