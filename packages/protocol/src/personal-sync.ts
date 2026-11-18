import {
  AuthSessionIdSchema,
  DeploymentIdSchema,
  ExecutionNodeIdSchema,
  RequestIdSchema,
  RunAttemptIdSchema,
  RunIdSchema,
  TaskPurposeSchema,
  ThreadIdSchema,
  ThreadStatusSchema,
  ThreadViewSchema,
  UserIdSchema,
  utf8ByteLength,
} from "@opensteer/core";
import { z } from "zod";
import {
  AuthenticatedUserViewSchema,
  PersonalCapabilitiesViewSchema,
  PersonalSessionSurfaceSchema,
} from "./bootstrap.js";
import {
  InstalledResourceRevisionsSchema,
  PersonalResourceInterestsSchema,
  PersonalResourceKindSchema,
  PersonalResourceRevisionsSchema,
  PersonalResourceViewSchema,
  PersonalRevisionSchema,
} from "./resources.js";
import {
  TranscriptItemIdSchema,
  TranscriptItemSchema,
  TranscriptOrderCursorSchema,
} from "./transcript.js";

export const scopedPersonalApiVersion = 63;
export const personalClientFrameMaxBytes = 32 * 1024;
export const personalChangesFrameMaxBytes = 64 * 1024;
export const personalLiveFrameMaxBytes = 16 * 1024;
export const personalResourceFrameMaxBytes = 32 * 1024;
export const personalShellFrameMaxBytes = 96 * 1024;
export const personalDetailFrameMaxBytes = 128 * 1024;
export const personalControlFrameMaxBytes = 4 * 1024;

export function personalHostFrameMaxBytes(frame: ScopedHostMessage): number {
  switch (frame.type) {
    case "host.snapshot":
      return frame.scope.kind === "shell"
        ? personalShellFrameMaxBytes
        : personalDetailFrameMaxBytes;
    case "host.changes":
      return personalChangesFrameMaxBytes;
    case "host.live":
      return personalLiveFrameMaxBytes;
    case "host.resource":
      return personalResourceFrameMaxBytes;
    default:
      return personalControlFrameMaxBytes;
  }
}
export const PersonalScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("shell") }),
  z.strictObject({ kind: z.literal("thread"), threadId: ThreadIdSchema }),
  z.strictObject({
    kind: z.literal("node"),
    threadId: ThreadIdSchema,
    nodeId: ExecutionNodeIdSchema,
  }),
]);
const detailScope = z.discriminatedUnion(
  "kind",
  PersonalScopeSchema.options.slice(1) as [
    (typeof PersonalScopeSchema.options)[1],
    (typeof PersonalScopeSchema.options)[2],
  ],
);
export const PersonalSubscriptionIdSchema = z.enum([
  "shell",
  "detail:0",
  "detail:1",
  "detail:2",
  "detail:3",
]);
const detailId = PersonalSubscriptionIdSchema.exclude(["shell"]);
const address = {
  subscriptionId: PersonalSubscriptionIdSchema,
  generation: z.int().positive(),
};
const scopeKey = z.union([
  z.literal("shell"),
  z.templateLiteral(["thread:", z.string().min(1).max(255)]),
  z.templateLiteral(["node:", z.string().min(1).max(255)]),
]);
export const PersonalResumeCursorSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  epoch: z.uuid(),
  viewerId: UserIdSchema,
  scopeKey,
  afterSequence: PersonalRevisionSchema,
});

const detailSubscription = z.strictObject({
  ...address,
  subscriptionId: detailId,
  scope: detailScope,
  cursor: PersonalResumeCursorSchema.optional(),
  anchorItemId: TranscriptItemIdSchema.optional(),
});

export const ScopedClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("client.attach"),
    apiVersion: z.literal(scopedPersonalApiVersion),
    generation: address.generation,
    cursor: PersonalResumeCursorSchema.optional(),
    interests: PersonalResourceInterestsSchema,
    installed: InstalledResourceRevisionsSchema,
    selected: detailSubscription.extend({ scope: PersonalScopeSchema.options[1] }).optional(),
  }),
  z
    .strictObject({
      type: z.literal("client.subscribe"),
      ...address,
      scope: PersonalScopeSchema,
      cursor: PersonalResumeCursorSchema.optional(),
      anchorItemId: TranscriptItemIdSchema.optional(),
    })
    .refine((value) => (value.subscriptionId === "shell") === (value.scope.kind === "shell")),
  z.strictObject({ type: z.literal("client.unsubscribe"), ...address }),
  z.strictObject({
    type: z.literal("client.ack"),
    ...address,
    throughSequence: PersonalRevisionSchema,
  }),
  z.strictObject({
    type: z.literal("client.resources.watch"),
    ...address,
    subscriptionId: z.literal("shell"),
    interests: PersonalResourceInterestsSchema,
    installed: InstalledResourceRevisionsSchema,
  }),
  z.strictObject({
    type: z.literal("client.live.resync"),
    ...address,
    subscriptionId: detailId,
    runId: RunIdSchema,
    streamIds: z.array(z.string().min(1).max(600)).min(1).max(16),
  }),
  z.strictObject({ type: z.literal("client.ping"), nonce: z.string().min(1).max(256) }),
]);

const task = z.strictObject({
  id: ThreadIdSchema,
  title: z.string().max(240),
  revision: PersonalRevisionSchema,
  status: ThreadStatusSchema,
  inputQueuePaused: z.boolean().optional(),
  purpose: TaskPurposeSchema,
  askedAt: z.iso.datetime(),
  doneAt: z.iso.datetime().nullable(),
  pendingRequestCount: z.int().nonnegative(),
  lastReplyPreview: z.string().max(1120).nullable(),
  failurePreview: z.string().max(1120).nullable(),
  latestRunCompletedAt: z.iso.datetime().nullable(),
  thread: ThreadViewSchema.optional(),
});
const visit = z.strictObject({
  threadId: ThreadIdSchema,
  lastVisitedAt: z.iso.datetime(),
  revision: PersonalRevisionSchema,
});
const attention = z.strictObject({
  id: z.string().min(1).max(600),
  kind: z.enum(["request", "team-ask", "failed-ask"]),
  threadId: ThreadIdSchema.nullable(),
  revision: PersonalRevisionSchema,
  title: z.string().max(240),
  preview: z.string().max(500).optional(),
});
export const PersonalRequestSummarySchema = z.strictObject({
  id: RequestIdSchema,
  revision: PersonalRevisionSchema,
  status: z.string().max(80),
  kind: z.string().max(80),
  title: z.string().max(240),
  threadId: ThreadIdSchema,
});
const queue = z.strictObject({
  revision: PersonalRevisionSchema,
  runs: z
    .array(
      z.strictObject({
        id: RunIdSchema,
        revision: PersonalRevisionSchema,
        status: z.string().max(80),
        finishing: z.boolean(),
        createdAt: z.iso.datetime().optional(),
        runOrdinal: z.int().nonnegative().optional(),
      }),
    )
    .max(2),
  paused: z.boolean(),
});
export const PersonalDetailSnapshotSchema = z.strictObject({
  thread: task,
  orderRevision: PersonalRevisionSchema,
  inputQueueRevision: PersonalRevisionSchema,
  nodeSubject: TranscriptItemSchema.optional(),
  queue: queue.optional(),
  items: z.array(TranscriptItemSchema).max(50),
  pendingRequests: z.array(PersonalRequestSummarySchema).max(20),
  activeItems: z.array(TranscriptItemSchema).max(20),
  nextBefore: TranscriptOrderCursorSchema.nullable(),
  nextAfter: TranscriptOrderCursorSchema.nullable().optional(),
  anchorItemId: TranscriptItemIdSchema.nullable().optional(),
  overlayCursors: z
    .strictObject({
      requests: z.string().max(4096).optional(),
      tools: z.string().max(4096).optional(),
      nodes: z.string().max(4096).optional(),
    })
    .optional(),
});
const counts = z.strictObject({
  pendingRequestCount: z.int().nonnegative(),
  needsYouCount: z.int().nonnegative(),
  unreadTaskCount: z.int().nonnegative(),
});
export const PersonalShellSnapshotSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  viewerId: UserIdSchema,
  epoch: z.uuid(),
  tasks: z.array(task).max(36),
  visits: z.array(visit).max(36),
  attention: z.array(attention).max(20),
  counts,
  resourceRevisions: PersonalResourceRevisionsSchema,
  session: z
    .strictObject({
      sessionId: AuthSessionIdSchema,
      user: AuthenticatedUserViewSchema,
      sessionSurface: PersonalSessionSurfaceSchema,
      can: PersonalCapabilitiesViewSchema,
    })
    .optional(),
  nextBefore: z.string().max(4096).nullable().optional(),
  recentTaskIds: z.array(ThreadIdSchema).max(25).optional(),
  activeTaskIds: z.array(ThreadIdSchema).max(10).optional(),
  resources: z
    .array(
      z.strictObject({
        kind: PersonalResourceKindSchema,
        revision: PersonalRevisionSchema,
        view: PersonalResourceViewSchema,
      }),
    )
    .max(15)
    .optional(),
});

export const PersonalNetworkShellSnapshotSchema = PersonalShellSnapshotSchema.extend({
  session: PersonalShellSnapshotSchema.shape.session.unwrap(),
}).refine(({ session, viewerId }) => session.user.id === viewerId);

const change = {
  sequence: PersonalRevisionSchema,
  ordinal: z.int().min(0).max(127),
  entityId: z.string().min(1).max(600),
};
const entityKind = z.enum([
  "task",
  "visit",
  "attention",
  "collection",
  "thread",
  "run-queue",
  "request",
  "item",
]);
function upsert<Kind extends z.infer<typeof entityKind>, Value extends z.ZodType>(
  kind: Kind,
  value: Value,
) {
  return z.strictObject({
    ...change,
    operation: z.literal("upsert"),
    entityKind: z.literal(kind),
    value,
  });
}

export const PersonalChangeSchema = z.union([
  z.strictObject({ ...change, operation: z.literal("remove"), entityKind }),
  z.strictObject({
    ...change,
    operation: z.literal("invalidate"),
    entityKind: z.literal("collection"),
    value: z.strictObject({ revision: PersonalRevisionSchema.optional() }),
  }),
  upsert("task", task),
  upsert("visit", visit),
  upsert("attention", attention),
  upsert("thread", task),
  upsert("run-queue", queue),
  upsert("request", PersonalRequestSummarySchema),
  upsert("item", TranscriptItemSchema),
]);

const shellProgress = z.strictObject({
  counts,
  resourceRevisions: PersonalResourceRevisionsSchema,
});
const durableAddress = {
  ...address,
  scope: PersonalScopeSchema,
  throughSequence: PersonalRevisionSchema,
};
const liveAddress = {
  ...address,
  subscriptionId: detailId,
  scope: detailScope,
  liveBootId: z.uuid(),
  runId: RunIdSchema,
  attemptId: RunAttemptIdSchema,
  bindingGeneration: z.int().positive(),
  streamId: z.string().min(1).max(600),
  itemId: TranscriptItemIdSchema,
  afterSequence: PersonalRevisionSchema,
  item: TranscriptItemSchema.optional(),
};
const liveText = {
  text: z.string().max(16 * 1024),
  offset: z.int().nonnegative(),
  totalLength: z.int().nonnegative(),
};
export const ScopedHostMessageSchema = z
  .discriminatedUnion("type", [
    z
      .strictObject({
        type: z.literal("host.snapshot"),
        ...durableAddress,
        snapshot: z.union([PersonalShellSnapshotSchema, PersonalDetailSnapshotSchema]),
      })
      .refine(
        (value) =>
          (value.scope.kind === "shell") === "tasks" in value.snapshot &&
          utf8ByteLength(JSON.stringify(value)) <=
            (value.scope.kind === "shell"
              ? personalShellFrameMaxBytes
              : personalDetailFrameMaxBytes),
      ),
    z
      .strictObject({
        type: z.literal("host.changes"),
        ...durableAddress,
        fromSequence: PersonalRevisionSchema,
        shellProgress: shellProgress.optional(),
        changes: z.array(PersonalChangeSchema).max(128),
      })
      .refine(
        (frame) =>
          (frame.fromSequence.length < frame.throughSequence.length ||
            (frame.fromSequence.length === frame.throughSequence.length &&
              frame.fromSequence < frame.throughSequence)) &&
          frame.changes.every(
            (row, index) =>
              row.sequence === frame.throughSequence &&
              (index === 0 || row.ordinal > frame.changes[index - 1]!.ordinal),
          ) &&
          utf8ByteLength(JSON.stringify(frame)) <= personalChangesFrameMaxBytes,
      ),
    z.strictObject({
      type: z.literal("host.synchronized"),
      ...durableAddress,
      shellProgress: shellProgress.optional(),
    }),
    z.strictObject({
      type: z.literal("host.snapshot-required"),
      ...durableAddress,
      reason: z.enum([
        "scope-changed",
        "cursor-unavailable",
        "scope-invalidated",
        "replay-overflow",
        "pressure",
      ]),
    }),
    z.strictObject({
      type: z.literal("host.removed"),
      ...address,
      scope: detailScope,
      reason: z.literal("unavailable"),
    }),
    z.strictObject({
      type: z.literal("host.resource"),
      ...address,
      subscriptionId: z.literal("shell"),
      kind: PersonalResourceKindSchema,
      revision: PersonalRevisionSchema,
      view: PersonalResourceViewSchema,
    }),
    z
      .strictObject({
        type: z.literal("host.live"),
        ...liveAddress,
        update: z.discriminatedUnion("operation", [
          z.strictObject({ operation: z.literal("append"), ...liveText }),
          z.strictObject({ operation: z.literal("replace"), ...liveText, incomplete: z.boolean() }),
          z.strictObject({ operation: z.literal("close") }),
        ]),
      })
      .refine((value) => utf8ByteLength(JSON.stringify(value)) <= personalLiveFrameMaxBytes),
  ])
  .refine((frame) => {
    if (frame.type === "host.resource")
      return utf8ByteLength(JSON.stringify(frame)) <= personalResourceFrameMaxBytes;
    if (
      frame.type === "host.synchronized" ||
      frame.type === "host.snapshot-required" ||
      frame.type === "host.removed"
    ) {
      if (utf8ByteLength(JSON.stringify(frame)) > personalControlFrameMaxBytes) return false;
    }
    const isShell = frame.scope.kind === "shell";
    if ((frame.subscriptionId === "shell") !== isShell) return false;
    if ("shellProgress" in frame && frame.shellProgress && !isShell) return false;
    if (frame.type === "host.snapshot") {
      if ("tasks" in frame.snapshot) {
        const snapshot = frame.snapshot;
        if (snapshot.session && snapshot.session.user.id !== snapshot.viewerId) return false;
        const ids = new Set(snapshot.tasks.map(({ id }) => id));
        return (
          [...(snapshot.recentTaskIds ?? []), ...(snapshot.activeTaskIds ?? [])].every((id) =>
            ids.has(id),
          ) &&
          [...snapshot.tasks, ...snapshot.visits, ...snapshot.attention].every(({ revision }) =>
            withinCut(revision, frame.throughSequence),
          ) &&
          snapshot.tasks.every((task) => !task.thread || task.thread.id === task.id)
        );
      }
      if (frame.scope.kind === "shell") return false;
      const snapshot = frame.snapshot;
      const scope = frame.scope;
      return (
        snapshot.thread.id === scope.threadId &&
        (!snapshot.thread.thread || snapshot.thread.thread.id === scope.threadId) &&
        [
          snapshot.thread.revision,
          snapshot.orderRevision,
          snapshot.inputQueueRevision,
          snapshot.queue?.revision ?? "0",
          ...(snapshot.queue?.runs.map(({ revision }) => revision) ?? []),
        ].every((revision) => withinCut(revision, frame.throughSequence)) &&
        (!snapshot.nodeSubject ||
          (scope.kind === "node" &&
            snapshot.nodeSubject.kind === "node" &&
            snapshot.nodeSubject.executionNodeId === scope.nodeId &&
            withinCut(snapshot.nodeSubject.revision, frame.throughSequence))) &&
        [...snapshot.items, ...snapshot.activeItems].every(
          (item) =>
            item.nodeId === (scope.kind === "node" ? scope.nodeId : null) &&
            withinCut(item.revision, frame.throughSequence),
        ) &&
        snapshot.pendingRequests.every(
          (request) =>
            request.threadId === scope.threadId &&
            withinCut(request.revision, frame.throughSequence),
        )
      );
    }
    if (frame.type === "host.live" && frame.item) {
      return (
        frame.update.operation !== "close" &&
        frame.item.id === frame.itemId &&
        frame.item.runId === frame.runId &&
        frame.item.attemptId === frame.attemptId &&
        frame.item.nodeId === (frame.scope.kind === "node" ? frame.scope.nodeId : null)
      );
    }
    if (frame.type !== "host.changes") return true;
    const scope = frame.scope;
    return frame.changes.every((row) => {
      if (row.entityKind === "collection")
        return (
          row.operation !== "invalidate" ||
          row.value.revision === undefined ||
          withinCut(row.value.revision, frame.throughSequence)
        );
      const shellEntity =
        row.entityKind === "task" || row.entityKind === "visit" || row.entityKind === "attention";
      if (shellEntity !== isShell) return false;
      if (row.operation !== "upsert") return true;
      if (!withinCut(row.value.revision, frame.throughSequence)) return false;
      if (row.entityKind === "run-queue")
        return (
          row.entityId === "run-queue" &&
          row.value.runs.every(({ revision }) => withinCut(revision, row.value.revision))
        );
      if (row.entityKind === "visit") return row.entityId === row.value.threadId;
      if (row.entityId !== row.value.id) return false;
      if (row.entityKind === "thread")
        return (
          scope.kind !== "shell" &&
          scope.threadId === row.entityId &&
          (!row.value.thread || row.value.thread.id === row.entityId)
        );
      if (row.entityKind === "request")
        return scope.kind !== "shell" && scope.threadId === row.value.threadId;
      if (row.entityKind === "item")
        return row.value.nodeId === (scope.kind === "node" ? scope.nodeId : null);
      if (row.entityKind === "task")
        return !row.value.thread || row.value.thread.id === row.entityId;
      return true;
    });
  });

function withinCut(revision: string, through: string) {
  return (
    revision.length < through.length || (revision.length === through.length && revision <= through)
  );
}

export type PersonalScope = z.infer<typeof PersonalScopeSchema>;
export type PersonalResumeCursor = z.infer<typeof PersonalResumeCursorSchema>;
export type PersonalChange = z.infer<typeof PersonalChangeSchema>;
export type ScopedHostMessage = z.infer<typeof ScopedHostMessageSchema>;
export type ScopedClientMessage = z.infer<typeof ScopedClientMessageSchema>;

const authorityChanged = "Personal authority changed";
export type PersonalSubscriptionId = z.infer<typeof PersonalSubscriptionIdSchema>;

export function personalAuthorityChangedReason(affected: readonly PersonalSubscriptionId[]) {
  return affected.length ? `${authorityChanged}: ${affected.join(",")}` : authorityChanged;
}

export function affectedPersonalSubscriptions(
  reason: string,
): readonly PersonalSubscriptionId[] | null {
  if (reason === authorityChanged) return [];
  if (!reason.startsWith(`${authorityChanged}: `)) return null;
  const ids = z
    .array(PersonalSubscriptionIdSchema)
    .min(1)
    .max(5)
    .safeParse(reason.slice(authorityChanged.length + 2).split(","));
  return ids.success ? ids.data : [];
}
