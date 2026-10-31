import { createId } from "@opensteer/core";
import type { RealtimeSink } from "@opensteer/orchestration";
import type { HostToClientMessage, ScreenPresentationInput } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenPresentationRegistry } from "./screen-presentation-registry.js";

const registries: ScreenPresentationRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  vi.useRealTimers();
});
function fixture() {
  let now = 500;
  const registry = new ScreenPresentationRegistry({ now: () => now });
  registries.push(registry);
  const ownerId = createId("user");
  const sessionId = createId("authSession");
  const threadId = createId("thread");
  const messages: HostToClientMessage[] = [];
  const sink: RealtimeSink = {
    id: "first",
    close: vi.fn(),
    send: vi.fn(async (m) => {
      messages.push(m);
    }),
  };
  const endpoint = registry.open({ ownerId, sessionId, sink });
  const context: ScreenPresentationInput = {
    endpointRef: endpoint.ready.endpointRef,
    voiceSessionId: "00000000-0000-4000-8000-000000000001",
    utteranceSequence: 1,
    interactionRevision: 2,
  };
  const messageId = createId("message");
  registry.register({ ownerId, sessionId, threadId, messageId, context });
  return {
    registry,
    ownerId,
    sessionId,
    threadId,
    messages,
    sink,
    endpoint,
    context,
    messageId,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("message-scoped presentation registry", () => {
  it("delivers and accepts acknowledgement only on the exact socket, including sockets in one login", async () => {
    const f = fixture();
    const other = { ...f.sink, id: "other", send: vi.fn(async () => undefined) };
    const target = { conversationId: createId("thread") };
    const result = f.registry.show(f.messageId, target);
    const frame = f.messages[0];
    expect(frame?.type).toBe("host.screen.show");
    if (frame?.type !== "host.screen.show") throw new Error("No presentation frame");
    f.registry.acknowledge(other, {
      type: "client.screen.done",
      operationId: frame.operationId,
      receipt: { outcome: "applied" },
    });
    expect(f.registry.pendingCount).toBe(1);
    f.registry.acknowledge(f.sink, {
      type: "client.screen.done",
      operationId: frame.operationId,
      receipt: { outcome: "applied" },
    });
    await expect(result).resolves.toEqual({ outcome: "applied" });
    expect(other.send).not.toHaveBeenCalled();
  });
  it("reserves once, shares an identical pending or settled result, and refuses a changed target", async () => {
    const f = fixture();
    const target = { conversationId: createId("thread") };
    const first = f.registry.show(f.messageId, target);
    expect(f.registry.show(f.messageId, target)).toBe(first);
    await expect(
      f.registry.show(f.messageId, { conversationId: createId("thread") }),
    ).resolves.toEqual({ outcome: "unavailable", reason: "already-requested" });
    expect(f.messages).toHaveLength(1);
    const frame = f.messages[0];
    if (frame?.type !== "host.screen.show") throw new Error("No presentation frame");
    f.registry.acknowledge(f.sink, {
      type: "client.screen.done",
      operationId: frame.operationId,
      receipt: { outcome: "superseded" },
    });
    await expect(first).resolves.toEqual({ outcome: "superseded" });
    expect(f.registry.show(f.messageId, target)).toBe(first);
    expect(f.messages).toHaveLength(1);
  });
  it("losing an acknowledgement settles unconfirmed and never dispatches a replacement", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const target = { conversationId: createId("thread") };
    const first = f.registry.show(f.messageId, target);
    f.advance(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toEqual({ outcome: "unconfirmed" });
    await expect(f.registry.show(f.messageId, target)).resolves.toEqual({ outcome: "unconfirmed" });
    const frame = f.messages[0];
    if (frame?.type !== "host.screen.show") throw new Error("No presentation frame");
    f.registry.acknowledge(f.sink, {
      type: "client.screen.done",
      operationId: frame.operationId,
      receipt: { outcome: "applied" },
    });
    await expect(first).resolves.toEqual({ outcome: "unconfirmed" });
    expect(f.messages).toHaveLength(1);
  });
  it("cannot bind another person, a different login, a closed endpoint, or an already committed message", () => {
    const f = fixture();
    expect(f.registry.hasEndpoint(f.context.endpointRef, createId("user"), f.sessionId)).toBe(
      false,
    );
    expect(f.registry.hasEndpoint(f.context.endpointRef, f.ownerId, createId("authSession"))).toBe(
      false,
    );
    const other = f.registry.open({
      ownerId: f.ownerId,
      sessionId: f.sessionId,
      sink: { ...f.sink, id: "other" },
    });
    f.registry.register({ ...f, context: { ...f.context, endpointRef: other.ready.endpointRef } });
    f.endpoint.close();
    expect(f.registry.contextFor(f.messageId)).toBeUndefined();
    expect(f.registry.hasEndpoint(f.context.endpointRef, f.ownerId, f.sessionId)).toBe(false);
  });
  it("uses one monotonic clock and eligibility never revives after reconnect or expiry", async () => {
    const f = fixture();
    expect(f.endpoint.ready.serverTime).toBe(500);
    expect(f.registry.contextFor(f.messageId)).toEqual({});
    f.advance(120_000);
    await expect(f.registry.show(f.messageId, { conversationId: f.threadId })).resolves.toEqual({
      outcome: "unavailable",
      reason: "expired",
    });
    expect(f.registry.contextFor(f.messageId)).toBeUndefined();
    expect(f.messages).toHaveLength(0);
    f.registry.close();
    await expect(f.registry.show(f.messageId, { conversationId: f.threadId })).resolves.toEqual({
      outcome: "unavailable",
      reason: "interaction-ended",
    });
  });
});

it("does not inherit history across Run attempts and records the exact steer hand-off", () => {
  const f = fixture();
  const runId = createId("run");
  const commandId = createId("command");
  expect(f.registry.inputWasSent(f.messageId, runId, 1)).toBe(false);
  f.registry.noteInputsSending([f.messageId], runId, 1);
  expect(f.registry.inputWasSent(f.messageId, runId, 1)).toBe(true);
  expect(f.registry.inputWasSent(f.messageId, runId, 2)).toBe(false);
  expect(f.registry.inputWasSent(f.messageId, runId, 1, commandId)).toBe(false);
  f.registry.noteInputsSending([f.messageId], runId, 1, commandId);
  expect(f.registry.inputWasSent(f.messageId, runId, 1, commandId)).toBe(true);
  expect(f.registry.inputWasSent(f.messageId, runId, 1, createId("command"))).toBe(false);
});

it("bounds registrations and endpoint issuance without evicting live operations", async () => {
  const f = fixture();
  const registry = new ScreenPresentationRegistry({ maximumEndpoints: 1, maximumEntries: 1 });
  registries.push(registry);
  const endpoint = registry.open({ ownerId: f.ownerId, sessionId: f.sessionId, sink: f.sink });
  expect(() => registry.open({ ownerId: f.ownerId, sessionId: f.sessionId, sink: f.sink })).toThrow(
    /capacity/,
  );
  registry.register({ ...f, context: { ...f.context, endpointRef: endpoint.ready.endpointRef } });
  const excess = createId("message");
  registry.register({
    ...f,
    messageId: excess,
    context: { ...f.context, endpointRef: endpoint.ready.endpointRef },
  });
  expect(registry.contextFor(excess)).toBeUndefined();
  expect(registry.contextFor(f.messageId)).toEqual({});
  const pending = registry.show(f.messageId, { conversationId: f.threadId });
  registry.close();
  await expect(pending).resolves.toEqual({ outcome: "unconfirmed" });
});
