import assert from "node:assert/strict";
import { ClientOperationError, clientScopeKey } from "@opensteer/client/connections";
import {
  createMessageOutbox,
  createMessageOutboxStorage,
  type MessageOutboxStorage,
  type MessageRecordStorage,
  type PendingSendCommand,
  type StoredMessage,
} from "@opensteer/client/host";
import { controlledClientSession } from "@opensteer/client/test-support";
import { createId, ModelSelectionSchema } from "@opensteer/core";
import { afterEach, expect, it, vi } from "vitest";
import { createComposerDraftStore } from "../composer-drafts.js";
import { draftTaskStart, startTask } from "./task-start.js";

function disk() {
  const records = new Map<string, string>();
  let interrupted = false;
  const port = {
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => void records.set(key, value),
    remove: async (key) => void records.delete(key),
    mutate: async (key, change) => {
      const before = records.get(key) ?? null;
      const value = change(before);
      if (interrupted && value !== before) {
        interrupted = false;
        throw new Error("injected disk failure");
      }
      if (value === null) records.delete(key);
      else records.set(key, value);
    },
  } satisfies MessageRecordStorage;
  return {
    records,
    port,
    interrupt: (value: boolean) => {
      interrupted = value;
    },
  };
}

function draftDisk() {
  const contents = new Map<string, string>();
  return {
    getItem: (key: string) => contents.get(key) ?? null,
    key: (index: number) => [...contents.keys()][index] ?? null,
    get length() {
      return contents.size;
    },
    removeItem: (key: string) => void contents.delete(key),
    setItem: (key: string, raw: string) => void contents.set(key, raw),
  };
}

const scope = controlledClientSession().connection.getSnapshot().scope!;
const threadId = createId("thread");
const message = (key: string, text = key): PendingSendCommand => ({
  type: "thread.sendMessage",
  threadId,
  idempotencyKey: key,
  delivery: "queue",
  content: [{ type: "text", text }],
});
const refused = () =>
  new ClientOperationError("Refused", "blocked", {
    kind: "rejection",
    provenance: "host",
    retryable: false,
  });

afterEach(() => vi.useRealTimers());

it("settles an orphaned claim on reopen when the replay is refused", async () => {
  vi.useFakeTimers();
  const { port } = disk();
  const session = controlledClientSession();
  const accepted = new Map<string, string>();
  const outbox = (dispatch: Parameters<typeof createMessageOutbox>[0]["dispatch"]) =>
    createMessageOutbox({
      session,
      storage: createMessageOutboxStorage(port),
      drafts: { restore: async () => "restored" },
      dispatch,
    });
  const interrupted = Promise.withResolvers<{ messageId: string }>();
  const first = outbox(() => interrupted.promise);
  await first.enqueue(message("abandoned"));
  await first.enqueue(message("next"));
  await vi.advanceTimersByTimeAsync(0);
  expect(first.getSnapshot().messages[0]?.phase).toBe("sending");
  first.dispose();

  const second = outbox(async ({ idempotencyKey }) => {
    const prior = accepted.get(idempotencyKey);
    if (prior) return { messageId: prior };
    if (idempotencyKey === "abandoned") throw refused();
    const messageId = "host-" + idempotencyKey;
    accepted.set(idempotencyKey, messageId);
    return { messageId };
  });
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(second.getSnapshot().messages[0]).toMatchObject({
      localId: "abandoned",
      phase: "rejected",
      rejection: { code: "unconfirmed" },
    });
    await expect(second.restoreDraft("abandoned")).resolves.toBe("sent");
    await second.removeUnconfirmed("abandoned");
    await vi.advanceTimersByTimeAsync(0);
    expect(accepted.has("next")).toBe(true);
  } finally {
    second.dispose();
  }
});

const draftKey = "opensteer:composer-draft:v1:deployment:viewer:task:home";
const creation = {
  accessMode: "auto" as const,
  environmentId: "env",
  generateTitle: true as const,
  harnessInstanceId: "harness",
  modelSelection: ModelSelectionSchema.parse({
    modelId: "claude",
    options: {},
    providerId: "anthropic",
  }),
  title: "Task",
};

it.each(["receipt", "completed journal"])(
  "preserves a revised Home draft after interruption at the %s",
  async (boundary) => {
    const { records, port } = disk();
    const draftStorage = draftDisk();
    const session = controlledClientSession();
    session.change({ phase: "recovering" });
    const outbox = createMessageOutbox({
      session,
      storage: createMessageOutboxStorage(port),
      dispatch: async () => ({ messageId: "unused" }),
      drafts: { restore: async () => "restored" },
    });
    const first = createComposerDraftStore(() => draftStorage);
    const second = createComposerDraftStore(() => draftStorage);
    const tasks = new Map<string, string>();
    let tries = 0;
    const journalKey = JSON.stringify([clientScopeKey(scope), draftKey]);
    const start = async (draft: typeof first) => {
      const generation = draft.taskStartGeneration(draftKey)!;
      const assertCurrent = () => {
        if (draft.read(draftKey)?.startGeneration !== generation) throw new Error("stale draft");
      };
      const result = await startTask({
        records: draftTaskStart(journalKey, generation, port.mutate),
        creation,
        creationKey: () => "creation-" + ++tries,
        createThread: async ({ idempotencyKey }) => {
          const id = tasks.get(idempotencyKey!) ?? createId("thread");
          tasks.set(idempotencyKey!, id);
          return { id };
        },
        messageKey: "message-" + tries,
        message: { content: [{ type: "text", text: draft.read(draftKey)!.text }] },
        assertCurrent,
        enqueue: (cmd) => outbox.enqueue(cmd, { handoff: true, assertCurrent }),
        hasLegacyHandoff: (key) => outbox.hasHandoff(scope, key, "legacy"),
      });
      return { ...result, generation };
    };
    try {
      first.update(draftKey, { text: "Original words" });
      const original = await start(first);
      if (boundary === "completed journal") {
        await port.mutate(`task-start:${journalKey}`, () =>
          JSON.stringify({ generation: original.generation, completedThreadId: original.id }),
        );
      }
      expect(tasks.size).toBe(1);
      expect(outbox.getSnapshot().messages).toHaveLength(1);
      expect(records.size).toBe(2);
      second.update(draftKey, { text: "" });
      second.update(draftKey, { text: "Revised words" });
      const settled = await start(second);
      expect(settled).toMatchObject({ id: original.id, preserveDraft: true });
      second.finishTaskStart(draftKey, settled.generation);
      expect(second.read(draftKey)?.text).toBe("Revised words");
      expect(second.read(draftKey)?.startGeneration).not.toBe(settled.generation);
      expect(tasks.size).toBe(1);
      await start(second);
      expect(tasks.size).toBe(2);
      expect(outbox.getSnapshot().messages.map((row) => row.command.content)).toEqual([
        [{ type: "text", text: "Original words" }],
        [{ type: "text", text: "Revised words" }],
      ]);
    } finally {
      outbox.dispose();
    }
  },
);

const otherScope = { ...scope, loginId: "replacement" };
const accounts = [scope, otherScope] as const;
const epoch = Date.UTC(2026, 0, 1);
const holdMs = 100;
type Claim = NonNullable<Awaited<ReturnType<MessageOutboxStorage["claim"]>>>;

function randomInt(seed: number) {
  let state = seed;
  return (max: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % Math.max(1, max);
  };
}

function queued(command: PendingSendCommand): StoredMessage {
  return {
    localId: command.idempotencyKey,
    command,
    createdAt: new Date(epoch).toISOString(),
    order: 0,
    attempted: false,
    phase: "waiting",
  };
}

/**
 * Drive the actual durable transitions directly so several thousand schedules
 * need no real timers. The tests above exercise the app-lifetime scheduler and
 * composer retry through the two reported crash boundaries.
 */
async function runSeed(seed: number, clock: { now: number }) {
  const choose = randomInt(seed);
  const database = disk();
  const drafts = draftDisk();
  const window = (login = 0) => ({
    login,
    online: true,
    closed: false,
    storage: createMessageOutboxStorage(database.port),
    draft: createComposerDraftStore(() => drafts),
  });
  type Window = ReturnType<typeof window>;
  const windows = Array.from({ length: 2 + choose(2) }, () => window());
  const store = createMessageOutboxStorage(database.port);
  const owned = new Map<string, { login: number; command: PendingSendCommand }>();
  const accepted = new Map<string, PendingSendCommand>();
  const attempts: { owner: Window; login: number; claim: Claim; sent: boolean }[] = [];
  const removed = new Set<string>();
  const takenBack = new Set<string>();
  const returned = new Map<string, PendingSendCommand>();
  const tasks = new Map<string, { id: string; creationKey: string }>();
  const trace: string[] = [];
  const visible: (readonly StoredMessage[])[] = [[], []];
  let sequence = 0;

  const add = async (owner: Window, command: PendingSendCommand, legacy = false) => {
    const row = queued(command);
    const saved = await owner.storage.put(
      accounts[owner.login]!,
      legacy
        ? { ...row, attempted: true, phase: "rejected", rejection: { code: "unconfirmed" } }
        : row,
      legacy ? { migrated: true } : { append: true },
    );
    if (saved) owned.set(row.localId, { login: owner.login, command });
  };

  const acquire = async (owner: Window, row: StoredMessage) => {
    const login = owner.login;
    const ownerScope = accounts[login]!;
    const claim = await owner.storage.claim(
      ownerScope,
      row,
      globalThis.crypto.randomUUID(),
      holdMs,
      choose(2) === 0 ? true : undefined,
      () => !owner.closed && owner.online && owner.login === login,
    );
    if (claim) {
      assert.equal(claim.row.lease?.expiresAt, clock.now + holdMs);
      if (row.attempted) assert.equal(claim.row.inTranscript, row.inTranscript);
      attempts.push({ owner, login, claim, sent: false });
    }
  };

  const startRequest = async (attempt: (typeof attempts)[number]) => {
    const { owner, claim, login } = attempt;
    if (attempt.sent || owner.closed || !owner.online || owner.login !== login) return;
    if (claim.row.lease!.expiresAt <= clock.now) return;
    const row = (await owner.storage.load(accounts[login]!)).find(
      (row) => row.localId === claim.row.localId,
    );
    if (!row) {
      assert(accepted.has(claim.row.localId));
      return;
    }
    assert.equal(row.lease?.id, claim.row.lease?.id);
    assert.deepEqual(row.command, claim.row.command);
    assert.equal(owned.get(row.localId)?.login, login);
    assert(!takenBack.has(row.localId));
    attempt.sent = true;
  };

  const reply = async (attempt: (typeof attempts)[number], outcome: "ack" | "lost" | "refuse") => {
    if (!attempt.sent) return;
    const { row } = attempt.claim;
    const ownerScope = accounts[attempt.login]!;
    if (outcome === "ack" || outcome === "lost") {
      assert(!takenBack.has(row.localId), "a taken-back request reached the Host");
      assert.deepEqual(accepted.get(row.localId) ?? row.command, row.command);
      accepted.set(row.localId, row.command);
    }
    if (!attempt.owner.closed) {
      if (outcome === "ack" || (outcome === "refuse" && accepted.has(row.localId)))
        await attempt.owner.storage.remove(ownerScope, row.localId);
      else await attempt.claim.settle(outcome === "refuse" ? { code: "rejected" } : "uncertain");
    }
  };

  const edit = async (owner: Window, row: StoredMessage, cleanup: boolean) => {
    const canEdit =
      !row.lease &&
      (row.phase === "restoring" ||
        (row.phase === "waiting" && !row.attempted) ||
        (row.phase === "rejected" && row.rejection?.code === "rejected"));
    if (!canEdit) return;
    const ownerScope = accounts[owner.login]!;
    const restore = { ...row, phase: "restoring" as const };
    if (!(await owner.storage.replace(ownerScope, row, restore))) return;
    assert(!accepted.has(row.localId), "take-back succeeded after Host admission");
    assert(
      !attempts.some((attempt) => attempt.sent && attempt.claim.row.localId === row.localId),
      "take-back succeeded with a request still in transit",
    );
    if (!cleanup) return; // The renderer closed before the draft write.
    returned.set(row.localId, row.command);
    takenBack.add(row.localId);
    await owner.storage.replace(ownerScope, restore, null, true);
  };

  const start = async (owner: Window, keepReceipt: boolean, loseCreateReply: boolean) => {
    const draft = owner.draft.read(draftKey);
    if (!draft?.text || !owner.online) return;
    const login = owner.login;
    const ownerScope = accounts[login]!;
    const scopeKey = clientScopeKey(ownerScope)!;
    const generation = owner.draft.taskStartGeneration(draftKey, scopeKey);
    if (!generation) {
      assert.notEqual(draft.startScope, scopeKey);
      return;
    }
    const assertCurrent = () => {
      assert.equal(owner.login, login);
      assert.equal(owner.draft.durableTaskStartGeneration(draftKey), generation);
    };
    const result = await startTask({
      records: draftTaskStart(
        JSON.stringify([scopeKey, draftKey]),
        generation,
        database.port.mutate,
      ),
      creation,
      creationKey: () => "creation-" + ++sequence,
      messageKey: "message-" + ++sequence,
      message: { content: [{ type: "text", text: draft.text }] },
      createThread: async ({ idempotencyKey }) => {
        const previous = tasks.get(generation);
        if (previous) assert.equal(previous.creationKey, idempotencyKey);
        const id = previous?.id ?? createId("thread");
        tasks.set(generation, { id, creationKey: idempotencyKey! });
        if (loseCreateReply) throw new Error("injected lost creation reply");
        return { id };
      },
      assertCurrent,
      enqueue: async (command) => {
        const row = await owner.storage.put(ownerScope, queued(command), {
          handoff: true,
          append: true,
          assertCurrent,
        });
        if (row) owned.set(row.localId, { login, command });
      },
    });
    if (keepReceipt) return; // The first message is durable and the composer never heard back.
    owner.draft.finishTaskStart(draftKey, generation, result.preserveDraft ? undefined : draft);
    const next = owner.draft.read(draftKey);
    assert.notEqual(next?.startGeneration, generation, "Home remained bound after completion");
    if (result.preserveDraft) assert.equal(next?.text, draft.text);
  };

  const verify = async () => {
    const rows = new Map<string, StoredMessage>();
    for (const [login, identity] of accounts.entries()) {
      const entries = await store.load(identity);
      visible[login] = entries;
      for (const row of entries) {
        assert.equal(owned.get(row.localId)?.login, login);
        assert.deepEqual(owned.get(row.localId)?.command, row.command);
        assert(!rows.has(row.localId), "a message crossed logins");
        if (row.lease) assert(Number.isFinite(row.lease.expiresAt));
        if (takenBack.has(row.localId)) assert.equal(row.phase, "restoring");
        rows.set(row.localId, row);
      }
    }
    for (const [key, { command }] of owned) {
      const held = rows.get(key)?.command ?? accepted.get(key) ?? returned.get(key);
      if (!removed.has(key)) assert.deepEqual(held, command, "durable content was lost");
      if (takenBack.has(key)) assert(!accepted.has(key));
    }
  };

  try {
    clock.now = epoch;
    let legacy: PendingSendCommand | undefined;
    const actions = [
      "enqueue",
      "claim",
      "send",
      "reply",
      "clock",
      "close",
      "login",
      "take-back",
      "discard",
      "observe",
      "legacy",
      "edit-home",
      "start",
      "offline",
    ] as const;
    for (let step = 0; step < 26; step++) {
      const index = choose(windows.length);
      const owner = windows[index]!;
      const action = actions[choose(actions.length)]!;
      trace.push(`${index}/${owner.login}:${action}`);
      const ownerScope = accounts[owner.login]!;
      const rows = visible[owner.login]!;
      const candidate = rows[choose(rows.length)];
      const attempt = attempts[choose(attempts.length)];
      database.interrupt(choose(8) === 0);
      try {
        switch (action) {
          case "enqueue":
            await add(owner, message("message-" + ++sequence));
            break;
          case "claim":
            if (candidate) await acquire(owner, candidate);
            break;
          case "send":
            if (attempt) await startRequest(attempt);
            break;
          case "reply":
            if (attempt) {
              const at = attempts.indexOf(attempt);
              await reply(attempt, (["ack", "lost", "refuse"] as const)[choose(3)]!);
              attempts.splice(at, 1);
            }
            break;
          case "clock":
            clock.now += holdMs * (1 + choose(4));
            break;
          case "close":
            owner.closed = true;
            windows[index] = window(owner.login);
            break;
          case "login":
            owner.login = 1 - owner.login;
            break;
          case "take-back":
            if (candidate) await edit(owner, candidate, choose(3) !== 0);
            break;
          case "discard":
            if (
              candidate &&
              ((candidate.phase === "waiting" && !candidate.attempted) ||
                candidate.phase === "rejected")
            ) {
              if (await owner.storage.replace(ownerScope, candidate, null, true)) {
                removed.add(candidate.localId);
                if (candidate.rejection?.code !== "unconfirmed") takenBack.add(candidate.localId);
              }
            }
            break;
          case "observe":
            if (candidate && accepted.has(candidate.localId))
              await owner.storage.remove(ownerScope, candidate.localId);
            break;
          case "legacy":
            if (!legacy) {
              legacy = message("legacy-" + ++sequence);
              await add(owner, legacy, true);
            }
            break;
          case "edit-home": {
            const existing = owner.draft.read(draftKey);
            if (!existing?.startScope || existing.startScope === clientScopeKey(ownerScope)) {
              const text = choose(3) === 0 ? "" : `Draft revision ${++sequence}`;
              assert(owner.draft.update(draftKey, { text }));
              assert.equal(owner.draft.read(draftKey)?.text ?? "", text);
            }
            break;
          }
          case "start":
            await start(owner, choose(2) === 0, choose(4) === 0);
            break;
          case "offline":
            owner.online = !owner.online;
            break;
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !(
            error.message === "injected disk failure" ||
            error.message === "injected lost creation reply" ||
            error.message === "Message storage is unavailable."
          )
        )
          throw error;
      } finally {
        database.interrupt(false);
      }
      await verify();
    }

    // Give every outstanding state an exit once storage, the clock and the Host cooperate.
    // Creation may need one press to retire an earlier receipt and a second for the revision.
    for (const [login, identity] of accounts.entries()) {
      const reopened = window(login);
      const draft = reopened.draft.read(draftKey);
      if (draft?.startScope === clientScopeKey(identity) && !draft?.text)
        assert(reopened.draft.update(draftKey, { text: "Retyped after reload" }));
      await start(reopened, false, false);
      await start(reopened, false, false);
      assert.notEqual(reopened.draft.read(draftKey)?.startScope, clientScopeKey(identity));
      const rows = await store.load(identity);
      for (const row of rows) {
        if (row.phase === "restoring") await edit(reopened, row, true);
      }
      for (const row of rows) {
        if (row.phase === "restoring") continue;
        clock.now += holdMs + 1;
        if (accepted.has(row.localId)) {
          await store.remove(identity, row.localId);
        } else if (row.rejection?.code === "rejected") {
          await edit(reopened, row, true);
        } else {
          const candidate =
            row.rejection?.code === "unconfirmed"
              ? {
                  ...row,
                  phase: "waiting" as const,
                  rejection: undefined,
                  uncertain: true as const,
                }
              : row;
          if (candidate !== row) assert(await store.replace(identity, row, candidate));
          await acquire(reopened, candidate);
          const attempt = attempts.pop()!;
          assert.equal(attempt.claim.row.localId, row.localId);
          await startRequest(attempt);
          await reply(attempt, "ack");
        }
        await verify();
      }
      assert.deepEqual(await store.load(identity), []);
    }
  } catch (error) {
    throw new Error(
      `Outbox model seed ${seed}. Replay with OPENSTEER_OUTBOX_MODEL_SEED=${seed}.\n${trace.join(" ")}`,
      { cause: error },
    );
  }
}

it("keeps durable message and draft invariants across seeded windows, failures and reopens", async () => {
  const clock = { now: epoch };
  const now = vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  const only = process.env.OPENSTEER_OUTBOX_MODEL_SEED;
  try {
    if (only !== undefined) await runSeed(Number(only), clock);
    else for (let seed = 1; seed <= 2_500; seed++) await runSeed(seed, clock);
  } finally {
    now.mockRestore();
  }
}, 10_000);
