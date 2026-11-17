import { OpensteerError, SequenceSchema, ThreadIdSchema, type ThreadId } from "@opensteer/core";
import {
  findPersonalSettings,
  getThreadForOwner,
  readPersonalDetailSnapshot,
  readPersonalShellSnapshot,
  readPersonalTaskPage,
  readTranscriptItem,
  readTranscriptOverlays,
  readTranscriptPage,
} from "@opensteer/database";
import { personalScopeKey, withPersonalSyncRead } from "@opensteer/database/personal-sync-store";
import { hostApi, rpcSuccess, type HostApiHandlers } from "@opensteer/protocol";
import {
  PersonalChangeSchema,
  type PersonalResumeCursor,
  type PersonalScope,
  type ScopedHostMessage,
} from "@opensteer/protocol/personal-sync";
import { z } from "zod";
import { requireSession } from "../integrations/integration-rpc-context.js";
import type { AuthenticatedHostSession } from "../identity/auth.js";
import type { HostServerDependencies } from "../server.js";
import type { PersonalResources } from "./personal-resources.js";

type Session = AuthenticatedHostSession["session"];
type CutFrame = Extract<
  ScopedHostMessage,
  {
    type: "host.snapshot" | "host.changes" | "host.snapshot-required" | "host.removed";
  }
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

function taskBoundary(before: string | undefined) {
  if (!before) return {};
  try {
    return {
      before: z
        .strictObject({ at: z.iso.datetime(), id: ThreadIdSchema })
        .parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8"))),
    };
  } catch {
    throw new OpensteerError({ code: "bad_request", message: "Invalid task page cursor." });
  }
}

export function createPersonalReads(
  dependencies: HostServerDependencies,
  resources: PersonalResources,
) {
  const { store } = dependencies;
  const database = store.database;
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
      if (cut.kind !== "snapshot") return cut;
      const thread = await getThreadForOwner(tx, scope.threadId, session.user.id);
      return thread
        ? { ...cut, snapshot: { ...cut.snapshot, thread: { ...cut.snapshot.thread, thread } } }
        : cut;
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
      case "snapshot-required":
        frames.push({ type: "host.snapshot-required", scope, throughSequence, reason: cut.reason });
        break;
      case "snapshot":
        frames.push({ type: "host.snapshot", scope, throughSequence, snapshot: cut.snapshot });
        break;
      case "replay":
        for (const commit of cut.commits)
          frames.push({
            type: "host.changes",
            scope,
            ...commit,
            changes: commit.changes.map((change) => PersonalChangeSchema.parse(change)),
            ...(shellProgress && commit.throughSequence === throughSequence
              ? { shellProgress }
              : {}),
          });
        break;
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
      await withPersonalSyncRead(database, (tx) =>
        resources.authorize(tx, requireSession(context).user.id),
      );
      const ready =
        input.kind === "runner"
          ? dependencies.runners.identityForEnvironment(input.environmentId)?.runnerId ===
            input.runnerId
          : (
              await dependencies.browser.workspaceBootstrap(requireSession(context).user.id)
            ).placements.some(
              (entry) =>
                entry.environmentIds.includes(input.environmentId) &&
                entry.runtimeId === input.runtimeId &&
                entry.available,
            );
      return rpcSuccess({ ready });
    },
    "tasks.page": async (input, context) => {
      const viewerId = requireSession(context).user.id;
      const page = await readPersonalTaskPage(database, {
        viewerId,
        window: input.done ? "done" : "recent",
        ...(input.limit ? { limit: input.limit } : {}),
        ...taskBoundary(input.before),
      });
      const tasks = await Promise.all(
        page.tasks.map(async (task) => {
          const thread = await store.getThreadForOwner(task.id, viewerId);
          return thread
            ? {
                thread,
                failure: task.failurePreview?.slice(0, 280) ?? null,
                lastReply: task.lastReplyPreview?.slice(0, 280) ?? null,
              }
            : null;
        }),
      );
      return rpcSuccess({
        asOfSequence: SequenceSchema.parse(page.revision),
        tasks: tasks.filter((task) => task !== null),
        window: {
          hasMore: page.hasMore,
          itemCount: tasks.filter((task) => task !== null).length,
          totalItems: tasks.filter((task) => task !== null).length,
          byteCount: Buffer.byteLength(JSON.stringify(tasks)),
          nextBefore: page.nextBefore
            ? Buffer.from(JSON.stringify(page.nextBefore)).toString("base64url")
            : null,
        },
      });
    },
    "thread.snapshot.get": async (input, context) => {
      const cut = await detail(requireSession(context), detailScope(input));
      return rpcSuccess(cut.kind === "snapshot" ? cut.snapshot : unavailable());
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
          item: result.item,
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
