import { ScopedClientMessageSchema } from "@opensteer/protocol/personal-sync";
import { afterEach, expect, it, vi } from "vitest";
import { HttpHostClient } from "../host/host-session-client.js";
import { MockPersonalHost } from "./mock-personal-host.js";
import { MockHostClient } from "./mock-host-client.js";
import { reviewHostAction } from "../host/action-review.js";
import { conversationSubagents } from "../host/subagent-model.js";
import { createId, ExecutionNodeIdSchema, RunIdSchema, ThreadIdSchema } from "@opensteer/core";

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
  const page = await client.rpc["node.items.page"]({
    threadId: thread.id,
    nodeId: ExecutionNodeIdSchema.parse(card.opens.nodeId),
    limit: 2,
  });
  expect(page.ok).toBe(true);
  if (!page.ok || page.data.kind !== "page") throw new Error("Missing node page");
  expect(page.data).toMatchObject({ hasMore: true, nodeId: card.opens.nodeId });
  expect(page.data.items).toHaveLength(2);
  const earlier = await client.rpc["node.items.page"]({
    threadId: thread.id,
    nodeId: ExecutionNodeIdSchema.parse(card.opens.nodeId),
    before: page.data.nextBefore!,
    limit: 2,
  });
  expect(earlier).toMatchObject({
    ok: true,
    data: {
      kind: "page",
      items: [
        expect.objectContaining({ kind: "node-message" }),
        expect.objectContaining({ kind: "node" }),
      ],
    },
  });
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

it("shares the scoped subject, ordered cards and live text until the last node holder releases", async () => {
  const mock = new MockHostClient({ latencyMs: 0, places: "absent" });
  const root = mock.getSnapshot().threads.find(({ title }) => title === "Subagents everywhere")!;
  const subject = mock
    .getSnapshot()
    .transcripts[root.id]?.find(
      (entry) => entry.kind === "node" && entry.title === "Trace the client",
    );
  if (subject?.kind !== "node") throw new Error("Missing node fixture");
  const transport = new MockPersonalHost(mock);
  let failure: "internal" | "forbidden" | undefined;
  const network = new HttpHostClient({
    baseUrl: "http://mock-host",
    fetch: (url, options) =>
      failure && new URL(String(url)).pathname.endsWith("/node.items.page")
        ? Promise.resolve(
            Response.json(
              {
                ok: false,
                error: {
                  code: failure,
                  message: "Node page refused",
                  retryable: failure === "internal",
                },
              },
              { status: failure === "forbidden" ? 403 : 500 },
            ),
          )
        : transport.fetch(url, options),
    webSocketFactory: transport.connect,
  });
  const watch = network.watchNode(root.id, subject.nodeId);
  const second = network.watchNode(root.id, subject.nodeId);
  try {
    await network.load();
    await vi.waitFor(() => expect(watch.getSnapshot().node?.title).toBe(subject.title));
    expect(network.getThreadTranscript(root.id)).toBeUndefined();
    const socket = [...transport.sockets][0]!;
    const scope = {
      kind: "node" as const,
      threadId: ThreadIdSchema.parse(root.id),
      nodeId: ExecutionNodeIdSchema.parse(subject.nodeId),
    };
    const [subscription] = socket.sent
      .map((frame) => ScopedClientMessageSchema.parse(JSON.parse(frame)))
      .filter((frame) => frame.type === "client.subscribe" && frame.scope.kind === "node");
    if (
      !subscription ||
      subscription.type !== "client.subscribe" ||
      subscription.subscriptionId === "shell"
    )
      throw new Error("Missing node subscription");
    const previous = watch.getSnapshot();
    expect(second.getSnapshot()).toEqual(previous);
    expect(
      socket.sent
        .map((frame) => JSON.parse(frame))
        .filter(({ type, scope }) => type === "client.subscribe" && scope?.kind === "node"),
    ).toHaveLength(1);
    second.release();
    second.release();
    expect(second.getSnapshot()).toMatchObject({ status: "closed", node: null, entries: [] });
    expect(watch.getSnapshot()).toBe(previous);
    const runId = RunIdSchema.parse(subject.runId);
    const attemptId = createId("runAttempt");
    const afterSequence = network.deploymentPosition()!;
    const item = {
      kind: "node-message" as const,
      id: "node-live-fixture",
      nodeId: scope.nodeId,
      runId,
      attemptId,
      revision: "0",
      position: "999",
      createdAt: subject.createdAt,
      isTurnStart: false,
      view: {},
    };
    const live = {
      type: "host.live" as const,
      handle: 1,
      scope,
      subscriptionId: subscription.subscriptionId,
      generation: subscription.generation,
      afterSequence,
      runId,
      attemptId,
      bindingGeneration: 1,
      liveBootId: crypto.randomUUID(),
      streamId: "live-node",
      itemId: item.id,
    };
    socket.deliver({
      ...live,
      item,
      update: {
        operation: "replace",
        text: "Working",
        totalLength: 9,
        offset: 2,
        incomplete: true,
      },
    });
    expect(watch.getSnapshot().entries.at(-1)?.id).toBe(item.id);
    expect(network.getThreadItemText(root.id, subject.nodeId)?.get(item.id)).toMatchObject({
      text: "Working",
      incomplete: true,
    });
    const throughSequence = String(BigInt(afterSequence) + 1n);
    socket.deliver({
      type: "host.changes",
      scope,
      subscriptionId: subscription.subscriptionId,
      generation: subscription.generation,
      fromSequence: afterSequence,
      throughSequence,
      changes: [
        {
          operation: "upsert",
          entityKind: "item",
          entityId: item.id,
          ordinal: 0,
          sequence: throughSequence,
          value: { ...item, revision: throughSequence, view: { preview: "Complete" } },
        },
      ],
    });
    const final = watch.getSnapshot();
    expect(final.entries.at(-1)).toMatchObject({ id: item.id, text: "Complete" });
    expect(final.entries[0]).toBe(previous.entries[0]);
    expect(network.getThreadItemText(root.id, subject.nodeId)?.get(item.id)).toBeUndefined();
    // The subject's own progress reaches its leaf through the text store, not the pane.
    const notified = vi.fn();
    const stop = watch.subscribe(notified);
    socket.deliver({
      ...live,
      handle: 2,
      afterSequence: throughSequence,
      streamId: "node-progress",
      itemId: `node:${subject.nodeId}`,
      update: {
        operation: "replace",
        text: "Reading",
        totalLength: 7,
        offset: 0,
        incomplete: false,
      },
    });
    expect(
      network.getThreadItemText(root.id, subject.nodeId)?.get(`node:${subject.nodeId}`)?.text,
    ).toBe("Reading");
    expect(notified).not.toHaveBeenCalled();
    expect(watch.getSnapshot()).toBe(final);
    stop();
    failure = "internal";
    watch.retry();
    await vi.waitFor(() =>
      expect(watch.getSnapshot()).toMatchObject({ status: "error", error: expect.any(String) }),
    );
    failure = "forbidden";
    watch.retry();
    await vi.waitFor(() =>
      expect(watch.getSnapshot()).toMatchObject({
        status: "missing",
        node: null,
        entries: [],
        error: null,
      }),
    );
    failure = undefined;
    watch.retry();
    await vi.waitFor(() =>
      expect(watch.getSnapshot()).toMatchObject({
        status: "ready",
        node: { title: subject.title },
        entries: expect.arrayContaining([previous.entries[0]]),
      }),
    );
    watch.release();
    expect(watch.getSnapshot()).toMatchObject({ status: "closed", node: null, entries: [] });
    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual(
      expect.objectContaining({
        type: "client.unsubscribe",
        subscriptionId: subscription.subscriptionId,
      }),
    );
  } finally {
    second.release();
    watch.release();
    network.dispose();
    transport.dispose();
  }
});
