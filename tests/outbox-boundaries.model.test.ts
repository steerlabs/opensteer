import assert from "node:assert/strict";
import { classifyClientFailure, clientScopeKey } from "../packages/client/src/connections/index.js";
import {
  createMessageOutbox,
  createMessageOutboxStorage,
  HttpHostClient,
  enqueueDraftReply,
  initializeMessageOutbox,
  type ConsumedDraftRevision,
  type MessageRecordStorage,
  type PendingSendCommand,
} from "../packages/client/src/host/index.js";
import {
  controlledClientSession,
  MemoryPrivateFilesystem,
} from "../packages/client/src/test-support/index.js";
import {
  BrowserPageContentPartSchema,
  createId,
  ModelSelectionSchema,
} from "../packages/core/src/index.js";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { insertDictationText } from "../packages/client/src/dictation/index.js";
import { afterEach, it, vi } from "vitest";
import {
  createThreadDraftStore,
  newTaskDraftKey,
  threadDraftRevision,
  type ThreadDraft,
} from "../apps/mobile/src/client/thread-drafts.js";
import {
  composerDraftKey,
  createComposerDraftStore,
  reserveComposerTaskStart,
  transactionalComposerDrafts,
} from "../apps/web/src/components/composer-drafts.js";
import { restoreComposerDraft } from "../apps/web/src/host/message-outbox.js";
import { browserDraftHandoffKey } from "../apps/web/src/host/message-outbox-records.js";
import { draftTaskStart, startTask } from "../apps/web/src/components/home/task-start.js";

const original = controlledClientSession().connection.getSnapshot().scope!;
const replacement = { ...original, loginId: "replacement" };
const draftScope = { deploymentId: "deployment", userId: "viewer" };
const draftKey = composerDraftKey(draftScope, { kind: "task", draftId: "home" });
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
const message = (key: string, text = "The saved words"): PendingSendCommand => ({
  type: "thread.sendMessage",
  idempotencyKey: key,
  threadId: createId("thread"),
  content: [{ type: "text", text }],
  delivery: "queue",
});

function disk() {
  const records = new Map<string, string>();
  const edits = new MutationQueue();
  let afterEdit: ((raw: string | null) => void | Promise<void>) | undefined;
  let committed: (() => void) | undefined;
  const port = {
    read: async (key) => records.get(key) ?? null,
    write: async (key, raw) => void records.set(key, raw),
    remove: async (key) => void records.delete(key),
    mutate: (key, edit, consumedDraft?: ConsumedDraftRevision) =>
      edits.run(async () => {
        const previous = records.get(key) ?? null;
        const next = edit(previous);
        const checkpoint = afterEdit;
        afterEdit = undefined;
        await checkpoint?.(next);
        if (next === null) records.delete(key);
        else records.set(key, next);
        if (consumedDraft && next !== previous)
          records.set(browserDraftHandoffKey(consumedDraft.key), consumedDraft.revision);
        committed?.();
      }),
  } satisfies MessageRecordStorage;
  return {
    port,
    afterCommit(next: (() => void) | undefined) {
      committed = next;
    },
    afterEdit(next: (raw: string | null) => void | Promise<void>) {
      afterEdit = next;
    },
  };
}

function webDrafts(database: ReturnType<typeof disk>) {
  const data = new Map<string, string>();
  const local = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  return () =>
    transactionalComposerDrafts(
      createComposerDraftStore(() => local),
      database.port.mutate,
    );
}

const interrupted = new Error("renderer crashed");
type Drafts = ReturnType<ReturnType<typeof webDrafts>>;

function home(
  database: ReturnType<typeof disk>,
  tasks = new Map<string, { id: string; payload: string }>(),
  created?: () => void,
) {
  const scope = clientScopeKey(original)!;
  const session = controlledClientSession();
  session.change({ phase: "recovering" });
  const outbox = createMessageOutbox({
    session,
    storage: createMessageOutboxStorage(database.port),
    dispatch: async () => ({ messageId: "unexpected" }),
    drafts: { restore: async () => "restored" },
  });
  return {
    tasks,
    outbox,
    async start(
      drafts: Drafts,
      editor: NonNullable<ReturnType<Drafts["read"]>>,
      beforeEnqueue?: () => void,
      key = draftKey,
    ) {
      assert(editor.revision);
      const { generation, assertCurrent, beginCreation } = await reserveComposerTaskStart(
        drafts,
        key,
        scope,
        editor.revision,
        () => {},
      );
      const result = await startTask({
        records: draftTaskStart(JSON.stringify([scope, key]), generation, database.port.mutate),
        creation,
        creationKey: () => "creation-" + globalThis.crypto.randomUUID(),
        createThread: (input) =>
          beginCreation(async () => {
            const previous = tasks.get(input.idempotencyKey!);
            const payload = JSON.stringify(input);
            if (previous) assert.equal(previous.payload, payload);
            const task = previous ?? { id: createId("thread"), payload };
            tasks.set(input.idempotencyKey!, task);
            created?.();
            return task;
          }),
        messageKey: "message-" + globalThis.crypto.randomUUID(),
        message: { content: [{ type: "text", text: editor.text }] },
        enqueue: (command) => {
          beforeEnqueue?.();
          return outbox.enqueue(command, {
            handoff: true,
            expectedLogin: original,
            assertCurrent,
            consumedDraft: { key, revision: editor.revision! },
          });
        },
        assertCurrent,
      });
      await drafts.finishTaskStart(key, generation, editor, result.preserveDraft);
      return result;
    },
  };
}

// Merge independent actor lanes in seeded order. Hooks expose the storage
// callback/commit boundary and the interval when the initiating renderer is gone.
function schedule<T>(seed: number, ...lanes: readonly (readonly T[])[]): T[] {
  let state = Math.imul(seed, 0x9e3779b9);
  const pending = lanes.map((lane) => [...lane]);
  const result: T[] = [];
  while (pending.length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const i = (state >>> 0) % pending.length;
    const lane = pending[i]!;
    result.push(lane.shift()!);
    if (lane.length === 0) pending.splice(i, 1);
  }
  return result;
}

async function seeds<T>(
  lanes: readonly (readonly T[])[],
  run: (events: readonly T[], seed: number) => Promise<void>,
) {
  for (let seed = 1; seed <= 24; seed++) {
    const events = schedule(seed, ...lanes);
    try {
      await run(events, seed);
    } catch (cause) {
      throw new Error(`Seed ${seed}: ${events.join(" → ")}`, { cause });
    }
  }
}

afterEach(() => vi.useRealTimers());

it("P1.1 admits queued work only for the shared credential that owns it", async () => {
  vi.useFakeTimers();
  await seeds(
    [
      ["enqueue", "dispatch", "admit"],
      ["replace-cookie", "refresh-view"],
    ],
    async (events) => {
      let cookie = original.loginId;
      const admissions: string[] = [];
      const accepted = new Set<string>();
      let hostCooperates = false;
      const wire = Promise.withResolvers<void>();
      let create: Promise<unknown> | undefined;
      let enqueued = false;
      const session = controlledClientSession();
      const secondWindow = controlledClientSession();
      const storage = createMessageOutboxStorage(disk().port);
      session.change({ phase: "recovering" });
      const host = new HttpHostClient({
        baseUrl: "https://host.test",
        bindMutationsToSession: true,
        fetch: async (url, init) => {
          if (!String(url).endsWith("/commands.dispatch")) return Response.error();
          await wire.promise;
          assert.equal(init?.credentials, "include");
          const headers = new Headers(init?.headers);
          headers.set("cookie", `session=${cookie}`);
          const authenticated = headers.get("cookie")!.slice("session=".length);
          const expected = headers.get("x-opensteer-expected-session");
          const admission = !expected || expected === authenticated;
          if (admission) admissions.push(authenticated);
          if (admission && hostCooperates) {
            const command = JSON.parse(String(init?.body)) as PendingSendCommand;
            assert.equal(command.type, "thread.sendMessage");
            accepted.add(command.idempotencyKey);
            // Admission survived a lost response. The event stream can settle it.
            return Response.error();
          }
          return Response.json(
            {
              ok: false,
              error: {
                code: "forbidden",
                reason: admission ? "refused" : "session-changed",
                message: "Refused",
                retryable: false,
              },
            },
            { status: 403 },
          );
        },
      });
      vi.spyOn(host.connection, "getSnapshot").mockImplementation(session.connection.getSnapshot);
      const outbox = initializeMessageOutbox(host, {
        session,
        storage,
        drafts: { restore: async () => "restored" },
      });
      try {
        for (const event of events) {
          if (event === "enqueue") {
            // Window A recorded the old credential. B's sign-in arrives separately.
            if (session.connection.getSnapshot().scope?.loginId === original.loginId) {
              await outbox.enqueue(message("owned"));
              enqueued = true;
            }
          } else if (event === "replace-cookie") {
            secondWindow.change({ scope: replacement });
            cookie = secondWindow.connection.getSnapshot().scope!.loginId;
          } else if (event === "refresh-view") {
            session.change({ scope: replacement });
          } else if (event === "admit") {
            wire.resolve();
            await create;
            await vi.advanceTimersByTimeAsync(0);
          } else {
            session.change({ phase: "ready", readyRevision: 2 });
            if (session.connection.getSnapshot().scope?.loginId === original.loginId) {
              create = host
                .createThread(
                  {
                    ...creation,
                    environmentId: createId("environment"),
                    harnessInstanceId: createId("harnessInstance"),
                    idempotencyKey: "create-1",
                  },
                  original,
                )
                .catch(() => {});
            }
            await vi.advanceTimersByTimeAsync(0);
          }
        }
        assert(
          !admissions.includes(replacement.loginId),
          "queued under the old login, admitted under the new cookie",
        );
        assert.deepEqual(await storage.load(replacement), []);
        const [held] = await storage.load(original);
        if (enqueued) assert.equal(held?.localId, "owned");
        if (held && held.phase !== "rejected") {
          hostCooperates = true;
          cookie = original.loginId;
          session.change({ scope: original, phase: "ready", readyRevision: 3 });
          await vi.advanceTimersByTimeAsync(100_000);
          assert.deepEqual([...accepted], ["owned"]);
          outbox.observe([{ id: createId("message"), clientSendKey: "owned" }]);
          await vi.advanceTimersByTimeAsync(0);
          assert.deepEqual(await storage.load(original), []);
        }
      } finally {
        wire.resolve();
        outbox.dispose();
        host.dispose();
      }
    },
  );
});

it("P1.2 gives handoff, revision and discard one commit order", async () => {
  await seeds([["begin-handoff", "commit-handoff"], ["edit"]], async (events, seed) => {
    const database = disk();
    const reopen = webDrafts(database);
    const a = reopen(),
      b = reopen();
    await a.update(draftKey, { text: "The saved words" });
    const editor = a.read(draftKey)!;
    const controller = home(database);
    const entered = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const revise = seed % 2 === 0;
    let send: Promise<unknown> | undefined;
    let edit: Promise<boolean> | undefined;
    let changedBeforeCommit = false;
    let didCommit = false;
    try {
      for (const event of events) {
        if (event === "edit") {
          edit = (
            revise
              ? b.update(draftKey, { text: "B" })
              : b.discard(draftKey, editor.revision).then((result) => result === "discarded")
          ).then((result) => {
            changedBeforeCommit = !didCommit;
            return result;
          });
          if (!send) await edit;
        } else if (event === "begin-handoff") {
          send = controller
            .start(a, editor, () =>
              database.afterEdit(async () => {
                entered.resolve();
                await commit.promise;
                didCommit = true;
              }),
            )
            .catch(() => {});
          await Promise.race([entered.promise, send]);
        } else {
          commit.resolve();
          await send;
        }
      }
      if (revise) assert.equal(await edit, true);
      else assert.equal(await edit, changedBeforeCommit);
      const [first] = controller.outbox.getSnapshot().messages;
      assert.equal(Boolean(first), !changedBeforeCommit);
      if (first)
        assert.deepEqual(first.command.content, [{ type: "text", text: "The saved words" }]);
      if (revise) assert.equal(b.read(draftKey)?.text, "B");
    } finally {
      commit.resolve();
      controller.outbox.dispose();
    }
  });
});

it("a reply's originating login cannot be replaced between tap and enqueue", async () => {
  await seeds([["tap", "enqueue"], ["replace-login"]], async (events) => {
    const session = controlledClientSession();
    session.change({ phase: "recovering" });
    const storage = createMessageOutboxStorage(disk().port);
    const outbox = createMessageOutbox({
      session,
      storage,
      dispatch: async () => ({ messageId: "unexpected" }),
      drafts: { restore: async () => "restored" },
    });
    let tapped = original;
    let keptFor: typeof original | null = null;
    try {
      for (const event of events) {
        if (event === "tap") tapped = session.connection.getSnapshot().scope!;
        else if (event === "replace-login") session.change({ scope: replacement });
        else {
          if (session.connection.getSnapshot().scope?.loginId === tapped.loginId) keptFor = tapped;
          await enqueueDraftReply(outbox, tapped, message("reply"), {
            revision: "saved-reply",
            assertCurrent: () => {},
          }).catch(() => {});
        }
      }
      for (const scope of [original, replacement]) {
        const rows = await storage.load(scope);
        assert.equal(rows.length, Number(keptFor?.loginId === scope.loginId));
      }
    } finally {
      outbox.dispose();
    }
  });
});

it("P1.3 refuses a dormant editor after the same draft has started", async () => {
  await seeds(
    [
      ["open-stale", "stale-start"],
      ["first-start", "reopen"],
    ],
    async (events) => {
      const database = disk();
      const reopen = webDrafts(database);
      let a = reopen();
      const b = reopen();
      await a.update(draftKey, { text: "The saved words" });
      const originalDraft = a.read(draftKey)!;
      const controller = home(database);
      let editor: typeof originalDraft | null = null;
      try {
        for (const event of events) {
          if (event === "open-stale") editor = b.read(draftKey);
          else if (event === "reopen") a = reopen();
          else if (event === "first-start" || editor)
            await controller
              .start(
                event === "first-start" ? a : b,
                event === "first-start" ? originalDraft : editor!,
              )
              .catch(() => {});
        }
        assert.equal(controller.tasks.size, 1, "the same editor revision must produce one task");
        await b.update(draftKey, { text: "A fresh draft" });
        await controller.start(b, b.read(draftKey)!);
        assert.equal(controller.tasks.size, 2);
        assert.equal(b.read(draftKey), null);
      } finally {
        controller.outbox.dispose();
      }
    },
  );
});

class ModelPrivateFilesystem extends MemoryPrivateFilesystem {
  refuseNextWrite = false;

  override async writeFileAtomic(path: string, content: Uint8Array | string): Promise<void> {
    if (this.refuseNextWrite) {
      this.refuseNextWrite = false;
      throw interrupted;
    }
    await super.writeFileAtomic(path, content);
  }
}

function mobile(files = new ModelPrivateFilesystem()) {
  return {
    files,
    drafts: createThreadDraftStore({
      privateFiles: files,
      filePath: "/drafts.json",
      now: () => new Date(),
      saveRetryDelaysMs: [],
    }),
  };
}

it.each(["after", "during"] as const)(
  "keeps dictation when the next edit arrives %s its save",
  async (when) => {
    const { files, drafts } = mobile();
    const args = [original.deploymentId, original.viewerId, createId("thread")] as const;
    await drafts.load();
    await drafts.writeDraft(...args, "Old saved words");
    files.refuseNextWrite = true;
    await assert.rejects(drafts.writeDraft(...args, "New typed words"), interrupted);
    const before = drafts.readDraft(...args)!.text;
    const transcript = "and new speech";
    const end = before.length;
    const merged = insertDictationText(before, { start: end, end }, transcript).text;
    let edit: Promise<void> | undefined;
    if (when === "during") {
      const write = files.writeFileAtomic.bind(files);
      vi.spyOn(files, "writeFileAtomic").mockImplementationOnce((path, content) => {
        edit = drafts.writeDraft(...args, `${drafts.readDraft(...args)!.text}.`);
        return write(path, content);
      });
    }
    const keptInline = await drafts.keepDictation(
      drafts.captureEdit(...args),
      before,
      merged,
      transcript,
    );
    if (when === "after") {
      assert.equal(drafts.readDraft(...args)?.text, "New typed words and new speech");
      assert.equal(drafts.readDraftUnsaved(...args), false);
      edit = drafts.writeDraft(...args, `${drafts.readDraft(...args)!.text}.`);
    }
    assert(edit);
    await edit;
    assert.equal(drafts.readDraftUnsaved(...args), false);
    const reopened = mobile(files).drafts;
    await reopened.load();
    assert.equal(
      reopened.readDraft(...args)?.text,
      when === "after" ? "New typed words and new speech." : "New typed words.",
    );
    assert.equal(
      reopened.readDictatedText(...args)?.text ?? "",
      when === "after" ? "" : transcript,
    );
    assert.equal(keptInline, when === "after");
  },
);

it("preserves stored and incoming mobile input when their merge would exceed a draft limit", async () => {
  await seeds(
    [
      ["reserve", "leave", "speech"],
      ["fill", "return-edit"],
    ],
    async (events) => {
      const { files, drafts } = mobile();
      const args = [original.deploymentId, original.viewerId, createId("thread")] as const;
      const fullText = "x".repeat(15_990);
      const transcript = "All the spoken words must survive.";
      const attachment = (name: string) => ({
        attachmentId: createId("attachment"),
        localUri: null,
        mediaType: "text/plain",
        name,
        sizeBytes: 1,
        status: "ready" as const,
      });
      const originals = Array.from({ length: 10 }, (_, i) => attachment(`${i}.txt`));
      await drafts.load();
      let target: ReturnType<typeof drafts.captureEdit> | undefined;
      let overflow = false;
      let expectedText = "";
      const waitingText = "Words still in the waiting editor";
      const waitingFile = attachment("waiting.txt");
      for (const event of events) {
        if (event === "reserve") target = drafts.captureEdit(...args);
        else if (event === "fill") {
          await drafts.writeDraft(...args, fullText);
          await drafts.writeDraftAttachments(...args, originals);
          expectedText = fullText;
        } else if (event === "return-edit") {
          const patch = {
            text: waitingText,
            attachments: [...originals, waitingFile],
          };
          await assert.rejects(
            drafts.reserveEdit(...args)(() => patch),
            (error) => classifyClientFailure(error).reason === "draft-files-full",
          );
          assert.equal(patch.text, waitingText);
        } else if (event === "speech") {
          assert(target);
          overflow = expectedText === fullText;
          const end = expectedText.length;
          const next = insertDictationText(expectedText, { start: end, end }, transcript).text;
          assert.equal(
            await drafts.keepDictation(target, expectedText, next, transcript),
            !overflow,
          );
          if (!overflow) expectedText = next;
        }
        assert.equal(drafts.readDraft(...args)?.text ?? "", expectedText);
      }
      const reopened = mobile(files).drafts;
      await reopened.load();
      assert.deepEqual(reopened.readDraft(...args)?.attachments, originals);
      assert.equal(reopened.readDraft(...args)?.text, expectedText);
      assert.equal(reopened.readDictatedText(...args)?.text ?? "", overflow ? transcript : "");
      await reopened.writeDraft(...args, "Shortened reply");
      const remaining = originals.slice(0, -1);
      await reopened.writeDraftAttachments(...args, remaining);
      await reopened.reserveEdit(...args)((reply) => ({
        text: `${reply?.text}\n${waitingText}`,
        attachments: [...(reply?.attachments ?? []), waitingFile],
      }));
      assert.equal(reopened.readDraft(...args)?.text, `Shortened reply\n${waitingText}`);
      assert.deepEqual(reopened.readDraft(...args)?.attachments, [...remaining, waitingFile]);
    },
  );
});

it("P1.4 preserves the newer mobile draft when an old submission reaches the claim", async () => {
  await seeds([["capture", "claim"], ["revise"]], async (events, seed) => {
    const { files, drafts } = mobile();
    const key = newTaskDraftKey("home");
    const input = [original.deploymentId, original.viewerId, key] as const;
    const edits = [
      () => drafts.discardDraft(...input),
      () =>
        drafts.writeDraftAttachments(...input, [
          {
            attachmentId: "att_model",
            localUri: null,
            mediaType: "text/plain",
            name: "notes.txt",
            sizeBytes: 1,
            status: "ready",
          },
        ]),
      () => drafts.writeDraft(...input, "B"),
      () =>
        drafts.writeDraftPage(
          ...input,
          BrowserPageContentPartSchema.parse({
            type: "browser-page",
            sessionId: "bsn_00000000-0000-4000-8000-000000000001",
            tabId: "page",
            title: "Notes",
            url: "https://example.com/",
          }),
        ),
    ];
    await drafts.writeDraft(...input, "A");
    let captured: Awaited<ReturnType<typeof drafts.readSavedDraft>> = null;
    let remaining: ThreadDraft | null | undefined;
    let claimed = false;
    for (const event of events) {
      if (event === "capture") captured = await drafts.readSavedDraft(...input);
      else if (event === "revise") await edits[seed % edits.length]!();
      else if (captured) {
        const current = await drafts.readSavedDraft(...input);
        const revision = threadDraftRevision(captured);
        claimed = threadDraftRevision(current) === revision;
        if (!claimed) remaining = current;
        await drafts
          .claimTaskStart(
            ...input,
            {
              text: captured.text,
              threadId: key,
              idempotencyKey: "first",
            },
            revision,
          )
          .catch(() => {});
      }
    }
    const reopened = mobile(files).drafts;
    await reopened.load();
    if (remaining !== undefined)
      assert.equal(JSON.stringify(reopened.readDraft(...input)), JSON.stringify(remaining));
    assert.equal(reopened.readTaskStart(...input)?.idempotencyKey, claimed ? "first" : undefined);
  });
});

it.each(["web", "mobile"] as const)(
  "P1.5 reuses the reply revision across %s cleanup and reopen",
  async (platform) => {
    vi.useFakeTimers();
    await seeds([["enqueue", "cleanup"], ["crash"]], async (events, seed) => {
      const database = disk();
      const { files } = mobile();
      const openMobile = async () => {
        const { drafts } = mobile(files);
        await drafts.load();
        return drafts;
      };
      let native = await openMobile();
      const openWeb = webDrafts(database);
      let browser = openWeb();
      const storage = createMessageOutboxStorage(database.port);
      const threadId = createId("thread");
      const { deploymentId, viewerId } = original;
      const keyForReply = draftKey.replace("task:home", `thread:${threadId}`);
      if (platform === "mobile") await native.writeDraft(deploymentId, viewerId, threadId, "reply");
      else await browser.update(keyForReply, { text: "reply" });
      const savedReply = () =>
        platform === "mobile"
          ? native.readDraft(deploymentId, viewerId, threadId)
          : browser.durableDraft(keyForReply);
      const revision = () => {
        const saved = savedReply();
        return saved?.text ? saved.revision! : null;
      };
      const session = controlledClientSession();
      session.change({ phase: "recovering" });
      const accepted = new Map<string, { id: string; command: PendingSendCommand }>();
      const open = () =>
        createMessageOutbox({
          session,
          storage,
          dispatch: async (command) => {
            const key = command.idempotencyKey;
            const previous = accepted.get(key);
            if (previous) assert.deepEqual(previous.command, command);
            const admitted = previous ?? { id: createId("message"), command };
            accepted.set(key, admitted);
            return { messageId: admitted.id };
          },
          drafts: {
            restore: (scope, entry, isCurrent) =>
              platform === "mobile"
                ? native.restoreMessage(scope, entry, isCurrent)
                : browser.transaction((store) =>
                    isCurrent() ? restoreComposerDraft(store, scope, entry) : "occupied",
                  ),
          },
        });
      let owner = open();
      let firstKey: string | undefined;
      let crashed = false;
      let bound = false;
      const keys = new Set<string>();
      const deliver = async () => {
        session.change({ phase: "ready" });
        await vi.advanceTimersByTimeAsync(0);
      };
      const send = async (key: string, scope = original, cutAfterBinding = false) => {
        const saved = revision();
        if (!saved) return;
        if (cutAfterBinding && platform === "web")
          database.afterEdit(() => {
            throw interrupted;
          });
        const id = await enqueueDraftReply(
          owner,
          scope,
          {
            ...message(key, "reply"),
            threadId,
            compaction: key === "reply-a" ? "compactFirst" : "keepFullHistory",
          },
          {
            revision: saved,
            ...(platform === "web" ? { draftKey: keyForReply } : {}),
            assertCurrent: () => {
              if (platform === "web") browser.bindReply(keyForReply, clientScopeKey(scope)!, saved);
            },
            ...(platform === "mobile"
              ? {
                  async bindDraft() {
                    await native.bindReply(scope, threadId, saved);
                    if (cutAfterBinding) throw interrupted;
                  },
                }
              : {}),
          },
        );
        keys.add(id);
        return id;
      };
      const consume = async (sendKey: string) => {
        const saved = revision();
        if (!saved) return false;
        const cleared =
          platform === "mobile"
            ? await native.consumeReply(deploymentId, viewerId, threadId, saved).catch(() => false)
            : await browser.consumeReply(keyForReply, saved, () => {});
        if (cleared) await owner.forgetHandoff(original, sendKey);
        return cleared;
      };
      try {
        for (const event of events) {
          if (event === "enqueue" && !crashed) {
            if (seed % 5 === 0 && events[1] === "crash") {
              await assert.rejects(send("reply-a", original, true), interrupted);
              assert.deepEqual(await storage.load(original), []);
            } else {
              firstKey = await send("reply-a");
              // The Host's ack can remove the active row before source cleanup.
              if (seed % 2 === 0) await deliver();
            }
            bound = true;
          } else if (event === "cleanup" && firstKey && !crashed) {
            if (seed % 3 === 0 && platform === "mobile") {
              files.refuseNextWrite = true;
              assert.equal(await consume(firstKey), false);
              assert.equal(await send("reply-after-failure"), firstKey);
            }
            assert.equal(await consume(firstKey), true);
          } else if (event === "crash") {
            crashed = true;
            owner.dispose();
            owner = open();
            native = await openMobile();
            browser = openWeb();
            if (bound && revision()) {
              session.change({ scope: replacement });
              await assert.rejects(
                send("reply-after-replacement-login", replacement),
                /belongs to another sign-in/,
              );
              assert.deepEqual(await storage.load(replacement), []);
              session.change({ scope: original });
              if (firstKey && seed % 2 === 1) {
                await vi.advanceTimersByTimeAsync(0);
                const prior = revision();
                assert.equal(await owner.restoreDraft(firstKey), "restored");
                assert.notEqual(revision(), prior);
                assert.equal(savedReply()?.text, "reply");
                keys.delete(firstKey);
              }
            }
            const id = await send("reply-b");
            if (id) assert.equal(await consume(id), true);
          }
        }
        await deliver();
        assert.equal(keys.size, 1);
        assert.deepEqual([...accepted.keys()], [...keys]);
        if (firstKey && keys.has(firstKey))
          assert.equal(accepted.get(firstKey)?.command.compaction, "compactFirst");
        assert.deepEqual(await storage.load(original), []);
        assert.equal(revision(), null);
      } finally {
        owner.dispose();
      }
    });
  },
);

it("recovers the Home handoff at each committed step, including the Host's creation", async () => {
  // Count both the local commit notifications and the Host's independently
  // durable creation. Each cut kills the renderer before its next transition.
  for (let cut = 1; cut <= 7; cut++) {
    const database = disk();
    const open = webDrafts(database);
    const first = open();
    await first.update(draftKey, { text: "Survives the cut" });
    let commits = 0;
    let crashed = false;
    const checkpoint = () => {
      commits++;
      if (commits === cut) {
        crashed = true;
        throw interrupted;
      }
    };
    const firstOwner = home(database, undefined, checkpoint);
    database.afterCommit(checkpoint);
    try {
      await firstOwner.start(first, first.read(draftKey)!).catch((error) => {
        if (!crashed) throw error;
      });
      assert(crashed, `no renderer crash at durable step ${cut}`);
    } finally {
      firstOwner.outbox.dispose();
      database.afterCommit(undefined);
    }
    const second = open();
    const reopened = home(database, firstOwner.tasks);
    try {
      const draft = second.read(draftKey);
      if (draft) await reopened.start(second, draft);
      assert.equal(firstOwner.tasks.size, 1, `duplicate or missing task at cut ${cut}`);
      const queue = await createMessageOutboxStorage(database.port).load(original);
      assert.equal(queue.length, 1, `duplicate or missing first message at cut ${cut}`);
      assert.equal(queue[0]?.phase, "waiting", `first message held after resuming at cut ${cut}`);
      assert.deepEqual(queue[0]?.command.content, [{ type: "text", text: "Survives the cut" }]);
      assert.equal(second.read(draftKey), null);
    } finally {
      reopened.outbox.dispose();
    }
  }
});

it.each(["created", "enqueued"] as const)("resumes a v1 Home start after it %s", async (step) => {
  const database = disk();
  const open = webDrafts(database);
  const writer = open();
  const shippedKey = "opensteer:composer-draft:v1:deployment:viewer:task:home";
  await writer.update(shippedKey, { text: "Resume the original task" });
  const originalOwner = home(database);
  try {
    await assert.rejects(
      originalOwner.start(
        writer,
        writer.read(shippedKey)!,
        () => {
          if (step === "created") throw interrupted;
          database.afterCommit(() => {
            throw interrupted;
          });
        },
        shippedKey,
      ),
    );
  } finally {
    database.afterCommit(undefined);
    originalOwner.outbox.dispose();
  }
  const [originalTask] = originalOwner.tasks.values();
  assert(originalTask);
  const storage = createMessageOutboxStorage(database.port);
  const [sent] = await storage.load(original);
  if (step === "enqueued") {
    assert(sent);
    // An acknowledgement can remove the row before the first window clears the draft.
    await storage.remove(original, sent.localId);
  }
  const reader = open();
  const resumed = home(database, originalOwner.tasks);
  try {
    assert.equal((await resumed.start(reader, reader.read(draftKey)!)).id, originalTask.id);
    assert.equal(resumed.tasks.size, 1);
    const pending = await storage.load(original);
    assert.equal(pending.length, step === "created" ? 1 : 0);
    if (step === "created") assert.equal(pending[0]!.command.threadId, originalTask.id);
    assert.equal(reader.read(draftKey), null);
  } finally {
    resumed.outbox.dispose();
  }
});

it("reopens a lease committed just before its owner could dispatch", async () => {
  vi.useFakeTimers();
  await seeds([["enqueue", "claim", "dispatch"], ["crash"]], async (events) => {
    const db = disk();
    const storage = createMessageOutboxStorage(db.port);
    const session = controlledClientSession();
    session.change({ phase: "recovering" });
    const acknowledgements = new Map<string, string>();
    const open = () =>
      createMessageOutbox({
        session,
        storage,
        dispatch: async (command) => {
          const key = command.idempotencyKey;
          const id = acknowledgements.get(key) ?? "one-host-message";
          acknowledgements.set(key, id);
          return { messageId: id };
        },
        drafts: { restore: async () => "restored" },
      });
    let outbox = open();
    const held = Promise.withResolvers<void>();
    try {
      for (const event of events) {
        if (event === "enqueue") await outbox.enqueue(message("leased"));
        else if (event === "claim") {
          db.afterEdit(() => held.promise);
          session.change({ phase: "ready", readyRevision: 2 });
          await vi.advanceTimersByTimeAsync(0);
        } else if (event === "dispatch") {
          held.resolve();
          await vi.advanceTimersByTimeAsync(0);
        } else {
          outbox.dispose();
          outbox = open();
        }
      }
      held.resolve();
      await vi.advanceTimersByTimeAsync(100_000);
      assert.deepEqual([...acknowledgements.keys()], ["leased"]);
      assert.deepEqual(await storage.load(original), []);
    } finally {
      held.resolve();
      outbox.dispose();
    }
  });
});

it.each(["web", "mobile"] as const)(
  "only the owning %s draft receives input that completes after its editor leaves",
  async (platform) => {
    await seeds(
      [
        ["capture", "leave", "complete"],
        ["intervene", "reopen"],
      ],
      async (events, seed) => {
        const reopen = webDrafts(disk());
        let browser = reopen();
        const { drafts: phone } = mobile();
        const { deploymentId, viewerId } = original;
        const threadId = createId("thread");
        const key = draftKey.replace("task:home", `thread:${threadId}`);
        const args = [deploymentId, viewerId, threadId] as const;
        const keep = async (text: string) => {
          if (platform === "web") await browser.update(key, { text });
          else await phone.writeDraft(...args, text);
        };
        const read = () =>
          (platform === "web" ? browser.read(key) : phone.readDraft(...args))?.text ?? "";
        const action = (["edit", "discard", "send"] as const)[seed % 3]!;
        let expected = seed % 2 === 0 || action === "send" ? "original" : "";
        if (expected) await keep(expected);
        let epoch = 0;
        let captured = -1;
        let left = false;
        let complete: (() => Promise<boolean>) | undefined;
        const late = (text: string) => (text ? `${text} continued` : "continued");

        for (const event of events) {
          if (event === "capture") {
            captured = epoch;
            if (platform === "web") {
              const editor = browser;
              const id = await editor.reserveEdit(key);
              assert(id);
              complete = () => editor.handBack(key, { edit: late }, id);
            } else {
              const commit = phone.reserveEdit(...args);
              complete = () => commit((draft) => ({ text: late(draft?.text ?? "") }));
            }
          } else if (event === "leave") {
            left = true;
          } else if (event === "reopen") {
            browser = reopen();
          } else if (event === "intervene") {
            if (action === "send") {
              if (platform === "web") await browser.clear(key);
              else {
                const revision = threadDraftRevision(phone.readDraft(...args));
                assert(revision);
                assert(await phone.consumeReply(...args, revision));
              }
              epoch++;
              expected = "";
            } else if (action === "discard") {
              if (platform === "web") await browser.clear(key);
              else await phone.discardDraft(...args);
              epoch++;
              expected = "replacement draft";
              await keep(expected);
            } else {
              expected = "newer words";
              await keep(expected);
            }
          } else {
            assert(left);
            const owned = captured === epoch;
            assert.equal(await complete?.(), owned);
            if (owned) expected = late(expected);
          }
          assert.equal(read(), expected);
        }
      },
    );
  },
);
