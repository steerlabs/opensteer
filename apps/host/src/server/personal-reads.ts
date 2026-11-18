import type { TranscriptItem } from "@opensteer/protocol/transcript";
import type { MessageId } from "@opensteer/core";
import { OpensteerError, SequenceSchema, ThreadIdSchema, type ThreadId } from "@opensteer/core";
import {
  decorateQueueEntries,
  findPersonalSettings,
  isEligibleBrowserRunner,
  readPersonalDetailSnapshot,
  readPersonalShellSnapshot,
  readPersonalTaskPage,
  readTaskPageThreads,
  readTranscriptItem,
  readTranscriptOverlays,
  readTranscriptPage,
} from "@opensteer/database";
import { personalScopeKey, withPersonalSyncRead } from "@opensteer/database/personal-sync-store";
import {
  hostApi,
  rpcSuccess,
  type HostApiHandlers,
  type WaitingInputView,
} from "@opensteer/protocol";
import {
  PersonalChangeSchema,
  type PersonalResumeCursor,
  type PersonalScope,
  type ScopedHostMessage,
} from "@opensteer/protocol/personal-sync";
import { z } from "zod";
import { requireSession } from "./rpc-context.js";
import type { AuthenticatedHostSession } from "../identity/auth.js";
import type { HostServerDependencies } from "../server.js";
import type { PersonalResources } from "./personal-resources.js";

type Session = AuthenticatedHostSession["session"];
type CutFrame = Extract<
  ScopedHostMessage,
  { type: "host.snapshot" | "host.changes" | "host.removed" }
>;
type UnaddressedFrame<T> = T extends CutFrame ? Omit<T, "subscriptionId" | "generation"> : never;
type DetailScope = Exclude<PersonalScope, { kind: "shell" }>;

function detailScope(input: {
  threadId: ThreadId;
  nodeId?: Extract<DetailScope, { kind: "node" }>["nodeId"] | undefined;
}): DetailScope {
  return input.nodeId
    ? { kind: "node", threadId: input.threadId, nodeId: input.nodeId }
    : { kind: "thread", threadId: input.threadId };
}

function unavailable(): never {
  throw new OpensteerError({ code: "not_found", message: "The selected content is unavailable." });
}

function changed(): never {
  throw new OpensteerError({
    code: "conflict",
    message: "The selected content changed.",
    retryable: true,
  });
}

function taskBoundary(before: string | undefined, window: "recent" | "active" | "done") {
  if (!before) return {};
  try {
    const cursor = z
      .strictObject({
        at: z.iso.datetime(),
        id: ThreadIdSchema,
        window: z.enum(["recent", "active", "done"]),
      })
      .parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8")));
    if (cursor.window !== window) throw new Error("Wrong task window");
    return { before: cursor };
  } catch {
    throw new OpensteerError({ code: "bad_request", message: "Invalid task page cursor." });
  }
}

export function createPersonalReads(
  dependencies: HostServerDependencies,
  resources: PersonalResources,
  readSendKeys = (session: Session) => (ids: readonly MessageId[]) =>
    dependencies.store.personalMessageSendKeys(session.user.id, session.id, ids),
) {
  const { store } = dependencies;
  const database = store.database;
  const decorateItems = async (session: Session, items: readonly TranscriptItem[]) => {
    const keys = await readSendKeys(session)(
      items.flatMap((item) =>
        item.kind === "message" && item.author?.kind === "human" ? [item.messageId] : [],
      ),
    );
    return items.map((item) => decorateItem(item, keys));
  };
  const decorateDetail = async <
    Snapshot extends {
      readonly items: readonly TranscriptItem[];
      readonly activeItems: readonly TranscriptItem[];
      readonly inputQueue?: readonly WaitingInputView[] | undefined;
    },
  >(
    session: Session,
    snapshot: Snapshot,
  ): Promise<Snapshot> => {
    const items = await decorateItems(session, [...snapshot.items, ...snapshot.activeItems]);
    const inputQueue = snapshot.inputQueue
      ? await decorateQueueEntries(
          database,
          session.id,
          snapshot.inputQueue,
          await readSendKeys(session)(snapshot.inputQueue.map(({ message }) => message.id)),
        )
      : undefined;
    return {
      ...snapshot,
      items: items.slice(0, snapshot.items.length),
      activeItems: items.slice(snapshot.items.length),
      ...(inputQueue ? { inputQueue } : {}),
    };
  };
  const shell = async (
    session: Session,
    surface: AuthenticatedHostSession["surface"],
    cursor: PersonalResumeCursor | null,
    selectedThreadId?: ThreadId,
  ) =>
    withPersonalSyncRead(database, async (tx) => {
      const cut = await readPersonalShellSnapshot(tx, {
        viewerId: session.user.id,
        ...(cursor ? { cursor } : {}),
        ...(selectedThreadId ? { selectedThreadId } : {}),
        readResources: (sql, viewerId) => resources.initial(sql, viewerId),
      });
      if (cut.kind !== "snapshot") return cut;
      const opened = (await findPersonalSettings(tx)) !== null;
      return {
        ...cut,
        snapshot: {
          ...cut.snapshot,
          session: {
            sessionId: session.id,
            sessionSurface: surface,
            user: session.user,
            can: {
              createTasks: opened,
              useVoice: opened,
              manageComputers: true,
              managePrivateResources: true,
            },
          },
        },
      };
    });
  const detail = (
    session: Session,
    scope: DetailScope,
    cursor?: PersonalResumeCursor,
    anchorItemId?: string,
  ) =>
    withPersonalSyncRead(database, async (tx) => {
      const cut = await readPersonalDetailSnapshot(tx, {
        viewerId: session.user.id,
        scope,
        ...(cursor ? { cursor } : {}),
        ...(anchorItemId ? { anchorItemId } : {}),
      });
      return cut;
    });

  const readCut = async (
    session: Session,
    surface: AuthenticatedHostSession["surface"],
    scope: PersonalScope,
    cursor: PersonalResumeCursor | null,
    anchorItemId?: string,
    selectedThreadId?: string,
  ) => {
    const cut =
      scope.kind === "shell"
        ? await shell(
            session,
            surface,
            cursor,
            selectedThreadId ? ThreadIdSchema.parse(selectedThreadId) : undefined,
          )
        : await detail(session, scope, cursor ?? undefined, anchorItemId);
    await dependencies.onPersonalScopeCut?.(scope);
    const { state } = cut;
    const throughSequence = state.sequence;
    const next: PersonalResumeCursor = {
      deploymentId: state.deploymentId,
      epoch: state.epoch,
      viewerId: session.user.id,
      scopeKey: personalScopeKey(scope),
      afterSequence: throughSequence,
    };
    const shellProgress =
      scope.kind === "shell"
        ? {
            counts: {
              pendingRequestCount: state.pendingRequestCount,
              needsYouCount: state.needsYouCount,
              unreadTaskCount: state.unreadTaskCount,
            },
            resourceRevisions: state.resourceRevisions,
          }
        : undefined;
    const frames: UnaddressedFrame<CutFrame>[] = [];
    switch (cut.kind) {
      case "removed":
        if (scope.kind === "shell") return unavailable();
        frames.push({ type: "host.removed", scope, reason: "unavailable" });
        break;
      case "snapshot":
        if ("items" in cut.snapshot) {
          frames.push({
            type: "host.snapshot",
            scope,
            throughSequence,
            snapshot: await decorateDetail(session, cut.snapshot),
          });
        } else
          frames.push({ type: "host.snapshot", scope, throughSequence, snapshot: cut.snapshot });
        break;
      case "replay": {
        const framesByCommit = cut.commits.map((commit) =>
          commit.changes.map((change) => PersonalChangeSchema.parse(change)),
        );
        const rows = framesByCommit.flat();
        const keys = await readSendKeys(session)(
          rows.flatMap((row) =>
            row.operation !== "upsert"
              ? []
              : row.entityKind === "item" &&
                  row.value.kind === "message" &&
                  row.value.author?.kind === "human"
                ? [row.value.messageId]
                : row.entityKind === "queue-entry"
                  ? [row.value.message.id]
                  : [],
          ),
        );
        const entries = new Map(
          (
            await decorateQueueEntries(
              database,
              session.id,
              rows.flatMap((row) =>
                row.operation === "upsert" && row.entityKind === "queue-entry" ? [row.value] : [],
              ),
              keys,
            )
          ).map((entry) => [entry.message.id, entry]),
        );
        for (const [index, commit] of cut.commits.entries())
          frames.push({
            type: "host.changes",
            scope,
            ...commit,
            changes: framesByCommit[index]!.map((row) =>
              row.operation !== "upsert"
                ? row
                : row.entityKind === "item"
                  ? { ...row, value: decorateItem(row.value, keys) }
                  : row.entityKind === "queue-entry"
                    ? { ...row, value: entries.get(row.value.message.id) ?? row.value }
                    : row,
            ),
            ...(shellProgress && commit.throughSequence === throughSequence
              ? { shellProgress }
              : {}),
          });
        break;
      }
    }
    return {
      throughSequence,
      cursor: cut.kind === "replay" || cut.kind === "snapshot" ? next : null,
      frames,
      ...(shellProgress ? { shellProgress } : {}),
    };
  };

  const itemPage = async (
    input: Parameters<HostApiHandlers["thread.items.page"]>[0] & {
      nodeId?: Extract<DetailScope, { kind: "node" }>["nodeId"];
    },
    context: Parameters<HostApiHandlers["thread.items.page"]>[1],
  ) => {
    const result = await readTranscriptPage(database, {
      viewerId: requireSession(context).user.id,
      scope: detailScope(input),
      ...(input.before ? { cursor: input.before } : {}),
      ...(input.after ? { after: input.after } : {}),
      ...(input.anchorItemId || input.aroundMessageId
        ? { anchorItemId: input.anchorItemId ?? input.aroundMessageId! }
        : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
    if (result.kind === "unavailable") return unavailable();
    if (result.kind === "history-reset") return rpcSuccess(result);
    const { anchorItemId: _anchor, ...page } = result;
    return rpcSuccess(
      hostApi["thread.items.page"].success.parse({
        ...page,
        items: await decorateItems(requireSession(context), page.items),
        threadId: input.threadId,
        nodeId: input.nodeId ?? null,
      }),
    );
  };

  const handlers = {
    "personal.shell.get": async (input, context) => {
      dependencies.ownerProfile?.refreshSoon();
      const cut = await shell(
        requireSession(context),
        context.surface ?? "canonical",
        null,
        input.selectedThreadId,
      );
      return rpcSuccess(
        hostApi["personal.shell.get"].success.parse(
          cut.kind === "snapshot" ? cut.snapshot : unavailable(),
        ),
      );
    },
    "personal.readiness.get": async (input, context) => {
      const viewerId = requireSession(context).user.id;
      const ready = await withPersonalSyncRead(database, async (tx) => {
        await resources.authorize(tx, viewerId);
        const environment = await tx
          .selectFrom("executionEnvironments")
          .select("runnerId")
          .where("id", "=", input.environmentId)
          .executeTakeFirst();
        const runnerId = environment?.runnerId;
        if (!runnerId) return false;
        if (input.kind === "runner")
          return (
            input.runnerId === runnerId &&
            dependencies.runners.identityForEnvironment(input.environmentId)?.runnerId === runnerId
          );
        return (
          (await isEligibleBrowserRunner(tx, viewerId, runnerId)) &&
          dependencies.browser.isPlacementReady(runnerId, input.runtimeId)
        );
      });
      return rpcSuccess({ ready });
    },
    "tasks.page": async (input, context) => {
      const viewerId = requireSession(context).user.id;
      const window = input.done ? "done" : "recent";
      const result = await withPersonalSyncRead(database, async (tx) => {
        const page = await readPersonalTaskPage(tx, {
          viewerId,
          window,
          ...(input.limit ? { limit: input.limit } : {}),
          ...taskBoundary(input.before, window),
        });
        const threads = await readTaskPageThreads(
          tx,
          viewerId,
          page.tasks.map(({ id }) => id),
        );
        const tasks = [];
        let last: { at: string; id: ThreadId; window: typeof window } | null = null;
        let byteCount = 2;
        for (const task of page.tasks) {
          const thread = threads.get(task.id);
          if (!thread) return unavailable();
          const entry = {
            thread,
            failure: task.failurePreview?.slice(0, 280) ?? null,
            lastReply: task.lastReplyPreview?.slice(0, 280) ?? null,
          };
          const bytes = Buffer.byteLength(JSON.stringify(entry)) + (tasks.length ? 1 : 0);
          if (byteCount + bytes > 63 * 1024) {
            if (!last) throw new Error("A single task exceeded the page budget");
            break;
          }
          byteCount += bytes;
          tasks.push(entry);
          last = { at: task.cursorAt, id: task.id, window };
        }
        const hasMore = page.hasMore || tasks.length < page.tasks.length;
        return {
          asOfSequence: SequenceSchema.parse(page.revision),
          tasks,
          window: {
            hasMore,
            itemCount: tasks.length,
            totalItems: tasks.length,
            byteCount,
            nextBefore:
              hasMore && last ? Buffer.from(JSON.stringify(last)).toString("base64url") : null,
          },
        };
      });
      return rpcSuccess(result);
    },
    "thread.snapshot.get": async (input, context) => {
      const cut = await detail(requireSession(context), detailScope(input));
      if (cut.kind !== "snapshot") return unavailable();
      return rpcSuccess(await decorateDetail(requireSession(context), cut.snapshot));
    },
    "thread.items.page": itemPage,
    "node.items.page": itemPage,
    "thread.overlays.page": async (input, context) => {
      const result = await readTranscriptOverlays(database, {
        viewerId: requireSession(context).user.id,
        scope: detailScope(input),
        kind: input.kind,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      if (result.kind === "unavailable") return unavailable();
      if (
        result.kind === "overlay-reset" ||
        (input.expectedRevision && BigInt(result.revision) < BigInt(input.expectedRevision))
      )
        return changed();
      return rpcSuccess({
        threadId: input.threadId,
        nodeId: input.nodeId ?? null,
        kind: input.kind,
        revision: result.revision,
        entries: result.entries,
        next: result.next,
      });
    },
    "transcript.item.get": async (input, context) => {
      const result = await readTranscriptItem(database, {
        viewerId: requireSession(context).user.id,
        scope: detailScope(input),
        itemId: input.itemId,
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
      });
      if (result.kind === "unavailable") return unavailable();
      if (result.kind === "revision-conflict") return changed();
      return rpcSuccess(
        hostApi["transcript.item.get"].success.parse({
          item: (await decorateItems(requireSession(context), [result.item]))[0]!,
          body: result.body,
          truncated: result.truncated,
          threadId: input.threadId,
          nodeId: input.nodeId ?? null,
        }),
      );
    },
    "resources.get": async (input, context) =>
      rpcSuccess(await resources.get(requireSession(context), input.kind)),
    "resources.detail.get": async (input, context) =>
      rpcSuccess(await resources.detail(requireSession(context), input)),
  } satisfies Pick<
    HostApiHandlers,
    | "personal.shell.get"
    | "personal.readiness.get"
    | "tasks.page"
    | "thread.snapshot.get"
    | "thread.items.page"
    | "node.items.page"
    | "thread.overlays.page"
    | "transcript.item.get"
    | "resources.get"
    | "resources.detail.get"
  >;

  return { handlers, readCut };
}

function decorateItem(item: TranscriptItem, keys: ReadonlyMap<string, string>): TranscriptItem {
  if (item.kind !== "message") return item;
  const { clientSendKey: _discard, ...view } = item;
  const key = keys.get(item.messageId);
  return key ? { ...view, clientSendKey: key } : view;
}
