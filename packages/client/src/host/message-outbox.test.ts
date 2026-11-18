import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { groupTranscriptEntries } from "./agent-activity-model.js";
import { visibleTranscript } from "./transcript.js";
import { placeLocalMessages, splitLocalMessages } from "./message-delivery-view.js";
import type { TranscriptEntry } from "./client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  createMessageOutbox,
  projectMessageOutbox,
  sameTranscript,
  type MessageOutboxStorage,
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
  const scopes = new Map<string, StoredMessage[]>();
  let refuse = false;
  const port: MessageOutboxStorage = {
    async load(scope) {
      return structuredClone(scopes.get(clientScopeKey(scope)!) ?? []);
    },
    async put(scope, entry) {
      if (refuse) throw new Error("disk unavailable");
      const key = clientScopeKey(scope)!;
      scopes.set(
        key,
        [
          ...(scopes.get(key) ?? []).filter((row) => row.localId !== entry.localId),
          structuredClone(entry),
        ].sort((a, b) => a.order - b.order),
      );
    },
    async remove(scope, id) {
      if (refuse) throw new Error("disk unavailable");
      const key = clientScopeKey(scope)!;
      scopes.set(
        key,
        (scopes.get(key) ?? []).filter((row) => row.localId !== id),
      );
    },
  };
  return {
    port,
    refuse(value: boolean) {
      refuse = value;
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
    store.port.put = async (scope, entry) => {
      await new Promise<void>((resolve) => {
        persist = resolve;
      });
      await put(scope, entry);
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
    draftWrite!.reject(new Error("disk full"));
    await expect(failed).rejects.toThrow("disk full");
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
    outbox.retry("legacy");
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
    let release!: () => void,
      puts = 0,
      sent = 0;
    const put = store.port.put;
    store.port.put = async (scope, entry) => {
      if (++puts === 2)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await put(scope, entry);
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
    release();
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
      store = storage(),
      lock = new MutationQueue();
    first.change({ phase: "recovering" });
    second.change({ phase: "recovering" });
    store.port.delivery = (_scope, _thread, work) => lock.run(work);
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

describe("where a task's waiting messages stand", () => {
  it("keeps a message sent behind work after the queue, even once the task is at rest", async () => {
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
    const project = () => projectMessageOutbox(outbox.getSnapshot(), threadId, [], viewer);
    await outbox.enqueue(command("behind-work"));
    let placed = placeLocalMessages(new Map(), project(), true);
    await outbox.enqueue(command("next"));
    // The task came to rest before the second was sent: only that one starts a turn.
    placed = placeLocalMessages(placed, project(), false);
    const { transcript, afterQueue } = splitLocalMessages(project(), placed);
    expect(afterQueue.map((row) => row.id)).toEqual(["behind-work"]);
    expect(transcript.map((row) => row.id)).toEqual(["next"]);
    expect(placeLocalMessages(placed, project(), false)).toBe(placed);
    outbox.dispose();
  });
});
