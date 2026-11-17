import { createId, type UserId } from "@opensteer/core";
import { BrowserSurfaceIdSchema, type HostToClientMessage } from "@opensteer/protocol";
import { ScopedHostMessageSchema } from "@opensteer/protocol/personal-sync";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import { PersonalSyncSocket } from "./personal-sync.js";
import { RealtimeHub } from "./realtime-hub.js";

function connect(
  hub: RealtimeHub,
  userId: UserId,
  sessionId = createId("authSession"),
  send?: (message: HostToClientMessage) => Promise<void>,
) {
  const deploymentId = createId("deployment");
  const epoch = crypto.randomUUID();
  const threadId = createId("thread");
  const messages: HostToClientMessage[] = [];
  const frames: unknown[] = [];
  const ready = Promise.withResolvers<void>();
  const selected = Promise.withResolvers<void>();
  const close = vi.fn();
  const sync = new PersonalSyncSocket({
    async read(scope, _cursor) {
      return {
        cursor: {
          deploymentId,
          epoch,
          viewerId: userId,
          scopeKey: scope.kind === "shell" ? "shell" : `thread:${scope.threadId}`,
          afterSequence: "1",
        },
        throughSequence: "1",
        frames: [],
      };
    },
    async send(encoded, current) {
      if (!current()) return false;
      const frame = ScopedHostMessageSchema.parse(JSON.parse(encoded));
      frames.push(frame);
      if (frame.type === "host.synchronized") {
        if (frame.scope.kind === "shell") ready.resolve();
        else selected.resolve();
      }
      return true;
    },
    close() {},
  });
  const unregister = hub.registerConnection({
    userId,
    sessionId,
    sync,
    sink: {
      id: crypto.randomUUID(),
      close,
      send:
        send ??
        (async (message) => {
          messages.push(message);
        }),
    },
  });
  return {
    close,
    frames,
    messages,
    threadId,
    unregister,
    async attach(withSelected = false) {
      sync.attach({
        type: "client.attach",
        apiVersion: 62,
        generation: 1,
        interests: [],
        installed: {},
        ...(withSelected
          ? {
              selected: {
                scope: { kind: "thread" as const, threadId },
                subscriptionId: "detail:0" as const,
                generation: 1,
              },
            }
          : {}),
      });
      await withTimeout(withSelected ? selected.promise : ready.promise, 1000, {
        timeoutError: () => new Error("The personal socket did not synchronize its scope."),
      });
      await Promise.resolve();
    },
  };
}

it("ends every socket and pending read from one session before sending later notices", async () => {
  const hub = new RealtimeHub();
  const userId = createId("user");
  const endedSession = createId("authSession");
  const survivingSession = createId("authSession");
  const first = connect(hub, userId, endedSession);
  const second = connect(hub, userId, endedSession);
  const survivor = connect(hub, userId, survivingSession);
  await Promise.all([first.attach(), survivor.attach()]);
  const endedRead = hub.guardRead([`session:${endedSession}`]);
  const survivingRead = hub.guardRead([`session:${survivingSession}`]);
  hub.closeSession(endedSession);
  hub.publishTriggersChanged();
  expect(first.close).toHaveBeenCalledExactlyOnceWith(4003, "Session ended");
  expect(second.close).toHaveBeenCalledExactlyOnceWith(4003, "Session ended");
  expect(survivor.close).not.toHaveBeenCalled();
  expect(first.messages).toEqual([]);
  expect(second.messages).toEqual([]);
  expect(survivor.messages).toEqual([{ type: "host.triggers-changed" }]);
  expect(endedRead.current()).toBe(false);
  expect(survivingRead.current()).toBe(true);
});

it("reports connection changes to Host observers with zero client sockets", () => {
  const hub = new RealtimeHub();
  const observed = vi.fn();
  const release = hub.observe(observed);
  hub.publishConnectionsChanged(createId("user"));
  expect(observed).toHaveBeenCalledExactlyOnceWith({ type: "host.connections-changed" });
  release();
  hub.publishConnectionsChanged(createId("user"));
  expect(observed).toHaveBeenCalledTimes(1);
});

it("delivers notices to healthy sockets even when another fails", async () => {
  const hub = new RealtimeHub();
  const userId = createId("user");
  const broken = connect(hub, userId, undefined, async () => {
    throw new Error("Socket closed");
  });
  const healthy = connect(hub, userId);
  await Promise.all([broken.attach(), healthy.attach()]);
  hub.publishTriggersChanged();
  await Promise.resolve();
  expect(healthy.messages).toEqual([{ type: "host.triggers-changed" }]);
  expect(broken.close).toHaveBeenCalledExactlyOnceWith(1011, "Personal notice delivery failed");
});

it("gives scoped browser usage notices only to a synchronized viewer of that task", async () => {
  const hub = new RealtimeHub();
  const ownerId = createId("user");
  const selected = connect(hub, ownerId);
  const elsewhere = connect(hub, ownerId);
  await Promise.all([selected.attach(true), elsewhere.attach(true)]);
  hub.publishBrowserUsageChanged([selected.threadId, selected.threadId]);
  expect(selected.messages).toEqual([
    { type: "host.browser-usage-changed", threadIds: [selected.threadId] },
  ]);
  expect(elsewhere.messages).toEqual([]);
  elsewhere.unregister();
  selected.unregister();
  hub.publishBrowserUsageChanged([selected.threadId]);
  expect(selected.messages).toHaveLength(1);
  expect(selected.close).not.toHaveBeenCalled();
});

it("sends show to attached sessions of the person once and leaves reconnects empty", async () => {
  const hub = new RealtimeHub();
  const ownerId = createId("user");
  const selected = connect(hub, ownerId);
  const waiting = connect(hub, ownerId);
  const other = connect(hub, createId("user"));
  await Promise.all([selected.attach(), other.attach()]);
  const message = {
    type: "host.show" as const,
    runId: createId("run"),
    threadId: selected.threadId,
    target: { tabId: BrowserSurfaceIdSchema.parse("gmail") },
  };
  expect(await hub.showToPerson(ownerId, message)).toBe(1);
  expect(selected.messages).toEqual([message]);
  expect(waiting.messages).toEqual([]);
  expect(other.messages).toEqual([]);
  selected.unregister();
  await waiting.attach();
  expect(waiting.messages).toEqual([]);
  waiting.unregister();
  expect(await hub.showToPerson(ownerId, message)).toBe(0);
});

it("fences pending reads while authority changes and invalidates them on commit", () => {
  const hub = new RealtimeHub();
  const first = `thread:${createId("thread")}` as const;
  const second = `thread:${createId("thread")}` as const;
  const affected = hub.guardRead([first]);
  const unaffected = hub.guardRead([second]);
  const rolledBack = hub.suspendAuthority(new Set([first]));
  expect(affected.current()).toBe(false);
  expect(unaffected.current()).toBe(true);
  rolledBack.rolledBack();
  expect(affected.current()).toBe(true);
  const committed = hub.suspendAuthority(new Set([first]));
  committed.committed();
  expect(affected.current()).toBe(false);
  expect(unaffected.current()).toBe(true);
  expect(hub.guardRead([first]).current()).toBe(true);
});
