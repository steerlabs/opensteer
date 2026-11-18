import { createMessageOutboxStorage } from "./message-outbox-storage.js";
import { groupTranscriptEntries } from "./agent-activity-model.js";
import { splitLocalMessages, waitingMessageRows } from "./message-delivery-view.js";
import { visibleTranscript } from "./transcript.js";
import type { TranscriptEntry } from "./client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  createMessageOutbox,
  projectMessageOutbox,
  sameTranscript,
  type StoredMessage,
} from "./message-outbox.js";
import { controlledClientSession } from "../test-support/client-connection.js";
import { HostClientRequestError } from "./client.js";
import { HostTransportError } from "../connections/host-transport-error.js";
import type { PendingSendCommand } from "./pending-send.js";
import { clientScopeKey } from "../connections/connection-controller.js";

const threadId = createId("thread");
const quotedId = createId("message");
const command = (key: string) => ({
  type: "thread.sendMessage" as const,
  threadId,
  content: [{ type: "text" as const, text: key }],
  delivery: "queue" as const,
  idempotencyKey: key,
});
function storage() {
  const records = new Map<string, string>();
  let refuse = false;
  let refuseRemoval = false;
  const port = createMessageOutboxStorage({
    async read(key) {
      return records.get(key) ?? null;
    },
    async write(key, value) {
      if (refuse) throw new Error("disk unavailable");
      if (refuseRemoval && JSON.parse(value).entries.length === 0) throw new Error("disk full");
      records.set(key, value);
    },
    async remove(key) {
      if (refuse) throw new Error("disk unavailable");
      records.delete(key);
    },
  });
  return {
    port,
    refuse(value: boolean) {
      refuse = value;
    },
    refuseRemoval(value: boolean) {
      refuseRemoval = value;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("app lifetime message delivery", () => {
  it("queues FIFO offline and blocks the thread behind a rejected head until Edit succeeds", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    session.change({ phase: "recovering" });
    const store = storage();
    const sent: string[] = [];
    let occupied = true;
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      drafts: { restore: async () => (occupied ? "occupied" : "restored") },
      dispatch: async (cmd) => {
        sent.push(cmd.idempotencyKey);
        if (cmd.idempotencyKey === "first")
          throw new HostClientRequestError({
            code: "forbidden",
            message: "secret",
            status: 403,
            retryable: false,
          });
        return { messageId: "server-second" };
      },
    });
    await outbox.enqueue(command("first"));
    await outbox.enqueue(command("second"));
    expect(sent).toEqual([]);
    session.change({ phase: "ready", readyRevision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.getSnapshot().messages.map((row) => row.phase)).toEqual(["rejected", "waiting"]);
    expect(sent).toEqual(["first"]);
    await outbox.restoreDraft("first");
    expect(outbox.getSnapshot().messages).toHaveLength(2);
    occupied = false;
    await outbox.restoreDraft("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["first", "second"]);
    expect(outbox.getSnapshot().messages).toEqual([]);
    outbox.dispose();
  });
  it("replays the same frozen command after a lost ack and restart without cross-login sending", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    const accepted = new Map<string, string>();
    const sent: unknown[] = [];
    let loseAck = true;
    const dispatch = async (cmd: PendingSendCommand) => {
      sent.push(structuredClone(cmd));
      accepted.set(cmd.idempotencyKey, "message");
      if (loseAck) throw new HostTransportError("timed-out");
      return { messageId: "message" };
    };
    const options = {
      session,
      storage: store.port,
      drafts: { restore: async () => "restored" as const },
      dispatch,
    };
    let outbox = createMessageOutbox(options);
    await outbox.enqueue(command("same-key"));
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.getSnapshot().messages[0]).toMatchObject({ attempted: true, phase: "waiting" });
    await expect(outbox.discard("same-key")).rejects.toThrow();
    outbox.dispose();
    session.change({
      scope: { ...session.connection.getSnapshot().scope!, loginId: "different-login" },
      epoch: 2,
    });
    outbox = createMessageOutbox(options);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(1);
    outbox.dispose();
    session.change({
      scope: { ...session.connection.getSnapshot().scope!, loginId: "login" },
      epoch: 3,
    });
    loseAck = false;
    outbox = createMessageOutbox(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([command("same-key"), command("same-key")]);
    expect(accepted.size).toBe(1);
    expect(outbox.getSnapshot().messages).toEqual([]);
    outbox.dispose();
  });
  it("does not dispatch before durable storage and resumes a crash after persist", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    session.change({ phase: "recovering" });
    const store = storage();
    let sent = 0;
    const options = {
      session,
      storage: store.port,
      drafts: { restore: async () => "restored" as const },
      dispatch: async () => {
        sent++;
        return { messageId: "message" };
      },
    };
    let outbox = createMessageOutbox(options);
    store.refuse(true);
    await expect(outbox.enqueue(command("not-persisted"))).rejects.toThrow();
    expect(sent).toBe(0);
    store.refuse(false);
    await outbox.enqueue(command("persisted"));
    outbox.dispose();
    outbox = createMessageOutbox(options);
    session.change({ phase: "ready", readyRevision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toBe(1);
    expect(outbox.getSnapshot().messages).toEqual([]);
    outbox.dispose();
  });
  it("requires review of an unscoped legacy message and settles it from a verified Host observation", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    let legacy = [command("legacy")];
    const sent: string[] = [];
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      legacy: {
        load: async () => legacy.map((command) => ({ command })),
        remove: async (_scope, key) => {
          legacy = legacy.filter((entry) => entry.idempotencyKey !== key);
        },
      },
      drafts: { restore: async () => "occupied" },
      dispatch: async (command) => {
        sent.push(command.idempotencyKey);
        return { messageId: command.idempotencyKey };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await outbox.enqueue(command("new"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    expect(outbox.getSnapshot().messages[0]).toMatchObject({
      phase: "rejected",
      attempted: true,
      rejection: { code: "unconfirmed" },
    });
    await outbox.restoreDraft("legacy");
    expect(outbox.getSnapshot().messages).toHaveLength(2);
    await expect(outbox.discard("legacy")).rejects.toThrow();
    outbox.observe([{ id: "existing-server-message", clientSendKey: "legacy" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["new"]);
    expect(outbox.getSnapshot().messages).toEqual([]);
    expect(legacy).toEqual([]);
    outbox.dispose();
  });
  it("recovers unavailable storage without resending a refused head", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    let sends = 0;
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      drafts: { restore: async () => "restored" },
      dispatch: async () => {
        sends++;
        store.refuse(true);
        throw new HostClientRequestError({
          code: "forbidden",
          status: 403,
          message: "Private refusal",
          retryable: false,
        });
      },
    });
    await outbox.enqueue(command("refused"));
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.getSnapshot()).toMatchObject({
      issue: { code: "storage-unavailable" },
      messages: [{ phase: "rejected" }],
    });
    store.refuse(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(outbox.getSnapshot()).toMatchObject({ issue: null, messages: [{ phase: "rejected" }] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sends).toBe(1);
    outbox.dispose();
  });
  it("keeps delivery confirmed when post-ack housekeeping fails", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    let sends = 0;
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      drafts: { restore: async () => "restored" },
      onConfirmed: async () => {
        throw new Error("notification registration failed");
      },
      onDiscarded: () => {
        throw new Error("file cleanup failed");
      },
      dispatch: async () => {
        sends++;
        return { messageId: "delivered" };
      },
    });
    await outbox.enqueue(command("confirmed"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outbox.getSnapshot()).toMatchObject({ messages: [], issue: null });
    expect(sends).toBe(1);
    outbox.dispose();
  });
  it("bounds the queue without replacing an earlier message", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    session.change({ phase: "recovering" });
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      drafts: { restore: async () => "restored" },
      dispatch: async () => {
        throw new Error("Must stay local while offline");
      },
    });
    for (let i = 0; i < 20; i++) await outbox.enqueue(command(`entry-${i}`));
    await expect(outbox.enqueue(command("overflow"))).rejects.toThrow();
    expect(outbox.getSnapshot().issue?.code).toBe("queue-full");
    expect(outbox.getSnapshot().messages.map((entry) => entry.localId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `entry-${i}`),
    );
    outbox.dispose();
  });
  it("fences dispatch when the login changes during persistence", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    let persist!: () => void;
    const put = store.port.put;
    store.port.put = async (scope, entry, options) => {
      const saved = await put(scope, entry, options);
      await new Promise<void>((resolve) => {
        persist = resolve;
      });
      return saved;
    };
    let sent = 0;
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      drafts: { restore: async () => "restored" },
      dispatch: async () => {
        sent++;
        return { messageId: "message" };
      },
    });
    const pending = outbox.enqueue(command("old-login"));
    await vi.advanceTimersByTimeAsync(0);
    session.change({
      scope: { ...session.connection.getSnapshot().scope!, loginId: "another-login" },
      epoch: 2,
    });
    persist();
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toBe(0);
    expect(outbox.getSnapshot().messages).toEqual([]);
    outbox.dispose();
  });
  it("moves a waiting message to the draft whole, and lets go of it only once the draft holds it", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    session.change({ phase: "recovering" });
    const restored: StoredMessage[] = [];
    let draftWrite: { resolve: () => void; reject: (error: Error) => void } | null = null;
    const sent: string[] = [];
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      drafts: {
        restore: (_scope, entry) =>
          new Promise((resolve, reject) => {
            draftWrite = {
              resolve: () => {
                restored.push(entry);
                resolve("restored");
              },
              reject,
            };
          }),
      },
      dispatch: async (cmd) => {
        sent.push(cmd.idempotencyKey);
        return { messageId: `server-${cmd.idempotencyKey}` };
      },
    });
    const quoted = { ...command("quoted"), quotedMessageId: quotedId };
    await outbox.enqueue(quoted, { localAttachmentUris: ["file:///copy"] });
    await outbox.enqueue(command("later"));
    // A draft write that fails leaves the message queued, as it was.
    const failed = outbox.restoreDraft("quoted");
    const failure = expect(failed).rejects.toThrow("disk full");
    await vi.advanceTimersByTimeAsync(0);
    draftWrite!.reject(new Error("disk full"));
    await failure;
    expect(outbox.getSnapshot().messages.map((row) => row.localId)).toEqual(["quoted", "later"]);
    // The connection returns while the draft is being written: nothing goes.
    const edit = outbox.restoreDraft("quoted");
    session.change({ phase: "ready", readyRevision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    expect(outbox.getSnapshot().messages).toHaveLength(2);
    draftWrite!.resolve();
    await expect(edit).resolves.toBe("restored");
    expect(restored[0]).toMatchObject({
      command: { quotedMessageId: quotedId },
      localAttachmentUris: ["file:///copy"],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["later"]);
    expect(await store.port.load(session.connection.getSnapshot().scope!)).toEqual([]);
    outbox.dispose();
  });
  it("leaves a message whose send began in the queue when Edit arrives too late", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    let lose!: () => void;
    const restore = vi.fn(async () => "restored" as const);
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      drafts: { restore },
      dispatch: () =>
        new Promise((_resolve, reject) => {
          lose = () => reject(new HostTransportError("timed-out"));
        }),
    });
    await outbox.enqueue(command("in-flight"));
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.getSnapshot().messages[0]).toMatchObject({ phase: "sending", attempted: true });
    await expect(outbox.restoreDraft("in-flight")).resolves.toBe("sent");
    lose();
    await vi.advanceTimersByTimeAsync(0);
    expect(restore).not.toHaveBeenCalled();
    expect(outbox.getSnapshot().messages).toMatchObject([{ localId: "in-flight" }]);
    outbox.dispose();
  });
  it("sends an unsettled legacy message again under its own key only when asked", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    const sent: string[] = [];
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      legacy: { load: async () => [{ command: command("legacy") }], remove: async () => {} },
      drafts: { restore: async () => "restored" },
      dispatch: async (cmd) => {
        sent.push(cmd.idempotencyKey);
        return { messageId: "existing-server-message" };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    await expect(outbox.restoreDraft("legacy")).resolves.toBe("sent");
    await outbox.retry("legacy");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["legacy"]);
    expect(outbox.getSnapshot().messages).toEqual([]);
    outbox.dispose();
  });
  it("keeps a task's projection when only another task's queue changes", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    session.change({ phase: "recovering" });
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      drafts: { restore: async () => "restored" },
      dispatch: async () => ({ messageId: "message" }),
    });
    const viewer = createId("user");
    const other = createId("thread");
    const entries: TranscriptEntry[] = [];
    const empty = projectMessageOutbox(outbox.getSnapshot(), threadId, entries, viewer);
    await outbox.enqueue({ ...command("elsewhere"), threadId: other });
    expect(projectMessageOutbox(outbox.getSnapshot(), threadId, entries, viewer)).toBe(empty);
    await outbox.enqueue(command("here"));
    const here = projectMessageOutbox(outbox.getSnapshot(), threadId, entries, viewer);
    await outbox.enqueue({ ...command("elsewhere-2"), threadId: other });
    const after = projectMessageOutbox(outbox.getSnapshot(), threadId, entries, viewer);
    expect(after).not.toBe(here);
    expect(sameTranscript(here, after)).toBe(here);
    outbox.dispose();
  });
  it("honors Don't send while a dispatch claim is still being persisted", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession(),
      store = storage();
    let sent = 0;
    const paused = Promise.withResolvers<void>();
    const claim = store.port.claim;
    store.port.claim = async (...args) => {
      const saved = await claim(...args);
      await paused.promise;
      return saved;
    };
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      drafts: { restore: async () => "restored" },
      dispatch: async () => {
        sent++;
        return { messageId: "message" };
      },
    });
    await outbox.enqueue(command("cancel-before-dispatch"));
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.getSnapshot().messages[0]?.attempted).toBe(false);
    const cancelled = outbox.discard("cancel-before-dispatch");
    paused.resolve();
    await cancelled;
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toBe(0);
    expect(outbox.getSnapshot().messages).toEqual([]);
    outbox.dispose();
  });
  it("does not discard a send claimed by another window", async () => {
    vi.useFakeTimers();
    const first = controlledClientSession(),
      second = controlledClientSession(),
      store = storage();
    first.change({ phase: "recovering" });
    second.change({ phase: "recovering" });
    let lose!: () => void;
    const sender = createMessageOutbox({
      session: first,
      storage: store.port,
      drafts: { restore: async () => "restored" },
      dispatch: () =>
        new Promise((_resolve, reject) => {
          lose = () => reject(new HostTransportError("unreachable"));
        }),
    });
    await sender.enqueue(command("shared-window"));
    const observer = createMessageOutbox({
      session: second,
      storage: store.port,
      drafts: { restore: async () => "restored" },
      dispatch: async () => {
        throw new Error("The offline window must not dispatch");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getSnapshot().messages[0]?.attempted).toBe(false);
    first.change({ phase: "ready", readyRevision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    const discard = observer.discard("shared-window").catch((error) => error);
    lose();
    await vi.advanceTimersByTimeAsync(0);
    expect(await discard).toMatchObject({ failure: { reason: "message-unconfirmed" } });
    expect(await store.port.load(first.connection.getSnapshot().scope!)).toMatchObject([
      { localId: "shared-window", attempted: true },
    ]);
    sender.dispose();
    observer.dispose();
  });
  it.each([true, false])(
    "reconciles event before ack (sender key available: %s)",
    async (includesKey) => {
      vi.useFakeTimers();
      const session = controlledClientSession(),
        store = storage();
      let acknowledge!: (value: { messageId: string }) => void;
      const outbox = createMessageOutbox({
        session,
        storage: store.port,
        drafts: { restore: async () => "restored" },
        dispatch: () =>
          new Promise((resolve) => {
            acknowledge = resolve;
          }),
      });
      await outbox.enqueue(command("row-key"));
      await vi.advanceTimersByTimeAsync(0);
      const viewer = createId("user");
      const project = (entries: readonly TranscriptEntry[]) =>
        visibleTranscript(
          projectMessageOutbox(outbox.getSnapshot(), threadId, entries, viewer),
          null,
        );
      const pending = project([]);
      expect(groupTranscriptEntries(pending).map((row) => row.key)).toEqual(["row-key"]);
      const local = pending[0]!;
      if (local.kind !== "message") throw new Error("Pending message was not visible");
      const { localDelivery: _local, clientSendKey: _key, ...server } = local;
      const delivered = {
        ...server,
        id: "server-message",
        ...(includesKey ? { clientSendKey: "row-key" } : {}),
      };
      if (includesKey)
        expect(groupTranscriptEntries(project([delivered])).map((row) => row.key)).toEqual([
          "row-key",
        ]);
      acknowledge({ messageId: "server-message" });
      await vi.advanceTimersByTimeAsync(0);
      const final = groupTranscriptEntries(project([delivered]));
      expect(final).toMatchObject([{ kind: "message", key: "row-key" }]);
      expect(final).toHaveLength(1);
      expect(delivered).not.toHaveProperty("localDelivery");
      outbox.dispose();
    },
  );
});

it("keeps a stream-first queued acknowledgement under the same key and ahead of newer local work", () => {
  const viewer = createId("user");
  const state = {
    acknowledged: new Map<string, string>(),
    issue: null,
    loading: false,
    messages: ["first", "second"].map((key, order): StoredMessage => ({
      command: command(key),
      localId: key,
      order,
      createdAt: new Date().toISOString(),
      phase: "waiting",
      attempted: false,
    })),
  };
  const place = (entries: readonly TranscriptEntry[]) =>
    splitLocalMessages(projectMessageOutbox(state, threadId, entries, viewer), true);
  const local = place([]);
  expect(waitingMessageRows([], local.afterQueue)).toMatchObject([
    { key: "first" },
    { key: "second" },
  ]);
  const { localDelivery: _local, ...pending } = local.afterQueue[0]!;
  const acknowledged = { ...pending, id: "message-id", queuePending: true as const };
  const afterEvent = place([acknowledged]);
  expect(afterEvent.transcript).toEqual([]);
  expect(waitingMessageRows([], afterEvent.afterQueue)).toMatchObject([
    { key: "first", entry: { id: "message-id" } },
    { key: "second", entry: { id: "second" } },
  ]);
});

it("surfaces a full legacy queue and imports the remainder when a slot is freed", async () => {
  vi.useFakeTimers();
  const session = controlledClientSession();
  session.change({ phase: "recovering" });
  const legacy = new Map(
    Array.from({ length: 49 }, (_, index) => {
      const cmd = { ...command(`legacy-${index}`), threadId: createId("thread") };
      return [cmd.idempotencyKey, { command: cmd }];
    }),
  );
  const outbox = createMessageOutbox({
    session,
    storage: storage().port,
    drafts: { restore: async () => "restored" },
    dispatch: async () => {
      throw new Error("Never dispatch a legacy record automatically");
    },
    legacy: {
      load: async () => [...legacy.values()],
      remove: async (_scope, id) => {
        legacy.delete(id);
      },
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.getSnapshot()).toMatchObject({ loading: false, issue: null });
    expect(outbox.getSnapshot().messages).toHaveLength(48);
    expect(legacy.size).toBe(1);
    outbox.observe([{ id: "existing-message", clientSendKey: "legacy-0" }]);
    session.change({ phase: "ready", readyRevision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.getSnapshot().messages).toHaveLength(48);
    expect(outbox.getSnapshot().messages.some((row) => row.localId === "legacy-48")).toBe(true);
    expect(legacy.size).toBe(0);
  } finally {
    outbox.dispose();
  }
});

it("delivers an older fallback head before draining a full current queue", async () => {
  vi.useFakeTimers();
  const session = controlledClientSession();
  const scope = session.connection.getSnapshot().scope!;
  const records = new Map<string, string>();
  const port = createMessageOutboxStorage({
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => void records.set(key, value),
    remove: async (key) => void records.delete(key),
  });
  const row = (key: string, order: number): StoredMessage => ({
    localId: key,
    command: command(key),
    order,
    phase: "waiting",
    attempted: false,
    createdAt: new Date().toISOString(),
  });
  for (let i = 1; i <= 20; i++) await port.put(scope, row(`new-${i}`, i));
  let fallback = [row("older", 0)];
  const ack = Promise.withResolvers<{ messageId: string }>();
  const dispatch = vi.fn(() => ack.promise);
  const outbox = createMessageOutbox({
    session,
    storage: port,
    dispatch,
    drafts: { restore: async () => "restored" },
    legacy: {
      load: async () => fallback,
      remove: async () => {
        fallback = [];
      },
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(command("older"), scope);
  } finally {
    outbox.dispose();
    ack.resolve({ messageId: "delivered" });
  }
});

it("reclaims absent migration receipts while enforcing the active queue byte limit", async () => {
  const scope = controlledClientSession().connection.getSnapshot().scope!;
  const row = (id: string, text: string, more = ""): StoredMessage => ({
    localId: id,
    phase: "waiting",
    attempted: false,
    order: 1,
    createdAt: new Date().toISOString(),
    command: {
      ...command(id),
      threadId: createId("thread"),
      content: [{ type: "text", text }, ...(more ? [{ type: "text" as const, text: more }] : [])],
    },
  });
  const receipts = Array.from({ length: 390 }, (_, index) => String(index).padStart(255, "0"));
  const first = "x".repeat(245_000);
  const more = "y".repeat(110_000);
  let record = JSON.stringify({
    version: 1,
    scope: clientScopeKey(scope),
    entries: Array.from({ length: 29 }, (_, index) => row(`large-${index}`, first, more)),
    migrated: receipts,
  });
  const storage = createMessageOutboxStorage({
    read: async () => record,
    write: async (_key, value) => {
      record = value;
    },
    remove: async () => {
      record = "";
    },
  });
  const session = controlledClientSession();
  session.change({ phase: "recovering" });
  const outbox = createMessageOutbox({
    session,
    storage,
    drafts: { restore: async () => "restored" },
    dispatch: async () => {
      throw new Error("Offline");
    },
    legacy: { load: async () => [], remove: async () => {} },
  });
  try {
    const fits = row("fits", "a".repeat(160_000));
    await outbox.enqueue(fits.command);
    expect(JSON.parse(record).migrated ?? []).toEqual([]);
    expect(await storage.load(scope)).toHaveLength(30);
    await expect(outbox.enqueue(row("too-large", "b".repeat(40_000)).command)).rejects.toThrow();
    expect(await storage.load(scope)).toHaveLength(30);
  } finally {
    outbox.dispose();
  }
});

describe("durable outbox interleavings", () => {
  it("never dispatches an edited message after cleanup fails, including after reopen", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    session.change({ phase: "recovering" });
    const store = storage();
    store.refuseRemoval(true);
    const restore = vi.fn(async () => "restored" as const);
    const dispatch = vi.fn(async () => ({ messageId: "delivered" }));
    const options = { session, storage: store.port, drafts: { restore }, dispatch };
    let outbox = createMessageOutbox(options);
    try {
      await outbox.enqueue(command("edit-before-cleanup"));
      store.refuse(true);
      await expect(outbox.restoreDraft("edit-before-cleanup")).rejects.toThrow("disk unavailable");
      expect(restore).not.toHaveBeenCalled();
      expect(outbox.getSnapshot().messages[0]?.phase).toBe("waiting");
      store.refuse(false);
      await expect(outbox.restoreDraft("edit-before-cleanup")).rejects.toThrow("disk full");
      expect(restore).toHaveBeenCalledOnce();
      outbox.dispose();
      store.refuseRemoval(false);
      outbox = createMessageOutbox(options);
      session.change({ phase: "ready", readyRevision: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).not.toHaveBeenCalled();
      await expect(outbox.restoreDraft("edit-before-cleanup")).resolves.toBe("restored");
    } finally {
      outbox.dispose();
    }
  });

  it("does not restore an acknowledged migration when the source survives cleanup and reopen", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    const records = new Map<string, string>();
    const port = {
      read: async (key: string) => records.get(key) ?? null,
      write: async (key: string, value: string) => {
        records.set(key, value);
      },
      remove: async (key: string) => {
        records.delete(key);
      },
    };
    let source = true;
    let cleanupFails = true;
    const dispatch = vi.fn(async () => ({ messageId: "delivered" }));
    const options = {
      session,
      storage: createMessageOutboxStorage(port),
      drafts: { restore: async () => "restored" as const },
      dispatch,
      legacy: {
        load: async () => (source ? [{ command: command("surviving-legacy") }] : []),
        remove: async () => {
          if (cleanupFails) throw new Error("legacy disk full");
          source = false;
        },
      },
    };
    let outbox = createMessageOutbox(options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await outbox.retry("surviving-legacy");
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledOnce();
      outbox.dispose();
      outbox = createMessageOutbox({ ...options, storage: createMessageOutboxStorage(port) });
      await vi.advanceTimersByTimeAsync(0);
      expect(outbox.getSnapshot().messages).toEqual([]);
      cleanupFails = false;
      outbox.dispose();
      outbox = createMessageOutbox({ ...options, storage: createMessageOutboxStorage(port) });
      await vi.advanceTimersByTimeAsync(0);
      expect(source).toBe(false);
      expect(records.size).toBe(0);
    } finally {
      outbox.dispose();
    }
  });

  it("does not reinsert a settled message when another window presses Send again", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    const store = storage();
    const dispatch = vi.fn(async () => ({ messageId: "delivered" }));
    const scope = session.connection.getSnapshot().scope!;
    await store.port.put(scope, {
      command: command("ambiguous"),
      localId: "ambiguous",
      attempted: true,
      createdAt: new Date().toISOString(),
      order: 0,
      phase: "rejected",
      rejection: { code: "unconfirmed" },
    });
    const options = {
      session,
      storage: store.port,
      drafts: { restore: async () => "restored" as const },
      dispatch,
    };
    const first = createMessageOutbox(options);
    const second = createMessageOutbox(options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await first.retry("ambiguous");
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledOnce();
      await second.retry("ambiguous");
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(second.getSnapshot().messages).toEqual([]);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("keeps the first placement when an uncertain send is replayed after the task changes", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    let idle = true;
    const second = Promise.withResolvers<{ messageId: string }>();
    const dispatch = vi
      .fn(async () => ({ messageId: "accepted" }))
      .mockRejectedValueOnce(new HostTransportError("timed-out"))
      .mockImplementationOnce(() => second.promise);
    const outbox = createMessageOutbox({
      session,
      storage: storage().port,
      drafts: { restore: async () => "restored" },
      startsRun: () => idle,
      dispatch,
    });
    try {
      await outbox.enqueue(command("same-placement"));
      await vi.advanceTimersByTimeAsync(0);
      expect(outbox.getSnapshot().messages[0]).toMatchObject({
        phase: "waiting",
        inTranscript: true,
      });
      idle = false;
      await vi.advanceTimersByTimeAsync(500);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(outbox.getSnapshot().messages[0]).toMatchObject({
        phase: "sending",
        inTranscript: true,
      });
    } finally {
      outbox.dispose();
      second.resolve({ messageId: "accepted" });
    }
  });

  it("keeps a transcript by reference through lease updates and changes to another task", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    session.change({ phase: "recovering" });
    const store = storage();
    let changed!: () => void;
    store.port.subscribe = (listener) => {
      changed = listener;
      return () => {};
    };
    const outbox = createMessageOutbox({
      session,
      storage: store.port,
      drafts: { restore: async () => "restored" },
      dispatch: async () => ({ messageId: "unexpected" }),
    });
    try {
      await outbox.enqueue(command("in-view"));
      const scope = session.connection.getSnapshot().scope!;
      const viewer = createId("user");
      const project = () => projectMessageOutbox(outbox.getSnapshot(), threadId, [], viewer);
      const waiting = outbox.getSnapshot().messages[0]!;
      const held = {
        ...waiting,
        attempted: true,
        phase: "sending" as const,
        lease: { id: globalThis.crypto.randomUUID(), expiresAt: Date.now() + 30_000 },
      };
      await store.port.put(scope, held);
      changed();
      await vi.advanceTimersByTimeAsync(0);
      const before = project();
      await store.port.put(scope, {
        ...held,
        lease: { id: globalThis.crypto.randomUUID(), expiresAt: Date.now() + 60_000 },
      });
      await store.port.put(scope, {
        ...waiting,
        localId: "another-task",
        command: { ...command("another-task"), threadId: createId("thread") },
      });
      changed();
      await vi.advanceTimersByTimeAsync(0);
      expect(outbox.getSnapshot().messages).toHaveLength(2);
      expect(sameTranscript(before, project())).toBe(before);
    } finally {
      outbox.dispose();
    }
  });
});
