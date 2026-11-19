import { createId } from "@opensteer/core";
import { PersonalSyncSocket } from "@opensteer/orchestration";
import {
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  type RunnerToHostMessage,
} from "@opensteer/protocol";
import { ScopedHostMessageSchema, type ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";
import { PersonalLiveText } from "./personal-live-text.js";

let fixture: Awaited<ReturnType<typeof liveFixture>>;

beforeEach(async () => {
  vi.useFakeTimers();
  fixture = await liveFixture();
});

afterEach(() => {
  fixture.live.close();
  fixture.socket.close("test complete");
  vi.useRealTimers();
});

it.each([
  ["paragraph", "First paragraph.\n\n", "Second paragraph"],
  ["list item", "- First item\n", "- Second item"],
  ["fence", "```ts\nfirst()\n\nlast()\n```\n", "After the fence"],
  ["heading", "Previous content\n", "## Next section\n"],
])("flushes at a Markdown %s boundary", async (_kind, first, rest) => {
  fixture.append(first + rest);
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.frames().map(({ update }) => update)).toEqual([
    { operation: "replace", offset: 0, totalLength: first.length, incomplete: false, text: first },
  ]);
});

it("releases an unfinished block at 400 ms during continued output", async () => {
  fixture.append("A");
  await vi.advanceTimersByTimeAsync(200);
  fixture.append(" longer");
  await vi.advanceTimersByTimeAsync(199);
  expect(fixture.frames()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.frames()[0]?.update).toMatchObject({ text: "A longer", totalLength: 8 });
});

it("releases a quiet unfinished suffix after 800 ms and appends at UTF-16 offsets", async () => {
  fixture.append("🙂\n\nA");
  await vi.advanceTimersByTimeAsync(799);
  expect(fixture.frames()).toHaveLength(1);
  expect(fixture.frames()[0]?.update).toMatchObject({ text: "🙂\n\n", totalLength: 4 });
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.frames()[1]?.update).toEqual({
    operation: "append",
    text: "A",
    offset: 4,
    totalLength: 5,
  });
});

it("sends a Runner replacement as a replacement even when its new text is longer", async () => {
  fixture.append("🙂\n\n");
  await vi.advanceTimersByTimeAsync(0);
  fixture.accept({ stream: "assistant", op: "replace", text: "Repaired!", length: 9 });
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.frames()[1]?.update).toEqual({
    operation: "replace",
    text: "Repaired!",
    offset: 0,
    totalLength: 9,
    incomplete: false,
  });
});

it("bounds encoded replacements and keeps the newest UTF-16 tail", async () => {
  const text = "\u0001".repeat(6_000) + "🙂";
  fixture.accept({ stream: "assistant", op: "replace", text, length: text.length });
  await vi.advanceTimersByTimeAsync(0);
  const frame = fixture.frames()[0]!;
  expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(16 * 1024);
  expect(frame.update).toMatchObject({
    operation: "replace",
    totalLength: text.length,
    incomplete: true,
  });
  if (frame.update.operation !== "replace") throw new Error("Expected a live replacement");
  expect(frame.update.text).toBe(text.slice(frame.update.offset));
  expect(frame.update.text.endsWith("🙂")).toBe(true);
});

it("applies paragraph timing to reasoning and retains the short tool coalescing delay", async () => {
  fixture.accept({
    stream: "reasoning",
    blockId: "reasoning",
    op: "append",
    at: 0,
    text: "Thinking.",
  });
  fixture.accept({ stream: "tool", callId: "tool", op: "append", at: 0, text: "Output" });
  await vi.advanceTimersByTimeAsync(49);
  expect(fixture.frames()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.frames()).toHaveLength(1);
  expect(fixture.frames()[0]?.update).toMatchObject({ text: "Output" });
  await vi.advanceTimersByTimeAsync(750);
  expect(fixture.frames()[1]?.item).toMatchObject({ kind: "reasoning" });
  expect(fixture.frames()[1]?.update).toMatchObject({ text: "Thinking." });
});

it("sends the durable item before its close and discards the pending suffix", async () => {
  fixture.append("Live text.\n\nUnfinished preview.");
  await vi.advanceTimersByTimeAsync(0);
  fixture.finalize("Final assistant text.");
  fixture.append(" Late.");
  await vi.advanceTimersByTimeAsync(800);
  expect(fixture.deliveries).toMatchObject([
    { type: "host.synchronized", throughSequence: "1" },
    { type: "host.live", itemId: fixture.itemId, update: { text: "Live text.\n\n" } },
    {
      type: "host.changes",
      throughSequence: "2",
      changes: [
        { entityId: fixture.itemId, value: { view: { preview: "Final assistant text." } } },
      ],
    },
    {
      type: "host.live",
      itemId: fixture.itemId,
      afterSequence: "2",
      update: { operation: "close" },
    },
  ]);
  expect(fixture.live.read(fixture.scope)).toEqual([]);
});

it("holds a provisional reply until its thread's tail is known, then draws it after every durable card", async () => {
  fixture.live.close();
  fixture.socket.close("replaced");
  fixture = await liveFixture({ tail: null });
  fixture.accept({ stream: "assistant", op: "replace", text: "Reply", length: 5 });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fixture.frames()).toEqual([]);
  fixture.live.observeTail(fixture.threadId, "5");
  await vi.advanceTimersByTimeAsync(100);
  expect(fixture.frames()[0]).toMatchObject({
    type: "host.live",
    item: { id: fixture.itemId, position: "6" },
    update: { operation: "replace", text: "Reply" },
  });
});

it("moves a provisional reply past a tool step that committed before it", async () => {
  fixture.accept({ stream: "assistant", op: "replace", text: "Reply", length: 5 });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fixture.frames()[0]).toMatchObject({ item: { position: "3" } });
  fixture.live.observeTail(fixture.threadId, "7");
  await vi.advanceTimersByTimeAsync(100);
  const moved = fixture.frames().at(-1);
  expect(moved).toMatchObject({ type: "host.live", item: { id: fixture.itemId, position: "8" } });
  fixture.accept({ stream: "assistant", op: "append", at: 5, text: " more" });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fixture.frames().at(-1)).toMatchObject({ item: { position: "8" } });
});

async function liveFixture(options: { readonly tail?: string | null } = {}) {
  const runId = createId("run");
  const threadId = createId("thread");
  const attemptId = createId("runAttempt");
  const itemId = createId("message");
  const scope = { kind: "thread", threadId } as const;
  const cursor = {
    deploymentId: createId("deployment"),
    viewerId: createId("user"),
    epoch: crypto.randomUUID(),
    scopeKey: `thread:${threadId}` as const,
  };
  const fence = {
    bootId: RunnerBootIdSchema.parse(`rbt_${crypto.randomUUID()}`),
    connectionId: RunnerConnectionIdSchema.parse(`rcn_${crypto.randomUUID()}`),
    connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${crypto.randomUUID()}`),
    connectionGeneration: 1,
    runnerId: createId("runner"),
    environmentId: createId("environment"),
    bindingGeneration: 1,
  };
  let finalText: string | undefined;
  type LiveDelivery = Extract<ScopedHostMessage, { type: "host.live" }>;
  const deliveries: ScopedHostMessage[] = [];
  const socket = new PersonalSyncSocket({
    async read(_scope, resume) {
      const throughSequence = finalText === undefined ? "1" : "2";
      return {
        throughSequence,
        cursor: { ...cursor, afterSequence: throughSequence },
        frames:
          finalText === undefined || !resume
            ? []
            : [
                {
                  type: "host.changes",
                  scope,
                  throughSequence,
                  fromSequence: resume.afterSequence,
                  changes: [
                    {
                      operation: "upsert",
                      entityKind: "item",
                      entityId: itemId,
                      ordinal: 0,
                      sequence: throughSequence,
                      value: {
                        id: itemId,
                        kind: "message",
                        messageId: itemId,
                        messageKind: "assistant",
                        runId,
                        attemptId,
                        nodeId: null,
                        revision: throughSequence,
                        position: "3",
                        createdAt: new Date().toISOString(),
                        isTurnStart: false,
                        view: { preview: finalText },
                      },
                    },
                  ],
                },
              ],
      };
    },
    async send(encoded, current) {
      if (!current()) return false;
      deliveries.push(ScopedHostMessageSchema.parse(JSON.parse(encoded)));
      return true;
    },
    close() {},
  });
  const live = new PersonalLiveText({ publishLive: socket.offerLive.bind(socket) }, () => {});
  live.track(runId, { attemptId, bindingGeneration: 1, threadId });
  // The runtime reads the tail when it tracks a Run.
  if (options.tail !== null) live.observeTail(threadId, options.tail ?? "2");
  socket.subscribe({ type: "client.subscribe", subscriptionId: "detail:0", generation: 1, scope });
  await vi.advanceTimersByTimeAsync(0);
  expect(deliveries[0]?.type).toBe("host.synchronized");
  const accept = (
    item: Extract<RunnerToHostMessage, { type: "runner.live" }>["progress"]["items"][number],
  ) => {
    live.accept(
      {
        type: "runner.live",
        ...fence,
        assistantMessageId: itemId,
        progress: { runId, threadId, items: [item] },
      },
      "1",
    );
  };
  let at = 0;
  return {
    live,
    socket,
    scope,
    threadId,
    itemId,
    deliveries,
    accept,
    /** Live frames with each handle frame read as the stream its `host.live` named. */
    frames: () => {
      const named = new Map<number, LiveDelivery>();
      return deliveries.flatMap((frame): LiveDelivery[] => {
        if (frame.type === "host.live") {
          named.set(frame.handle, frame);
          return [frame];
        }
        if (frame.type !== "host.text") return [];
        const stream = named.get(frame.h)!;
        const text = { offset: frame.o, totalLength: frame.n, text: frame.t };
        return [
          {
            ...stream,
            update:
              frame.incomplete === undefined
                ? { operation: "append", ...text }
                : { operation: "replace", ...text, incomplete: frame.incomplete },
          },
        ];
      });
    },
    append(text: string) {
      accept({ op: "append", stream: "assistant", at, text });
      at += text.length;
    },
    finalize(text: string) {
      finalText = text;
      socket.wake("2");
      live.closeItem({
        type: "liveClosed",
        itemId,
        runId,
        threadId,
        attemptId,
        bindingGeneration: 1,
        nodeId: null,
        afterSequence: "2",
      });
    },
  };
}
