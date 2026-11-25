import {
  AssignmentSummarySchema,
  AuthSessionIdSchema,
  DeploymentIdSchema,
  AgentSessionEndReasonSchema,
  AgentSessionIdSchema,
  EnvironmentIdSchema,
  ExecutionNodeIdSchema,
  HarnessInstanceIdSchema,
  MessageIdSchema,
  RequestIdSchema,
  RunAttemptIdSchema,
  RunIdSchema,
  RunRetryViewSchema,
  RunStartHoldReasonSchema,
  TaskPurposeSchema,
  ThreadIdSchema,
  ThreadStatusSchema,
  ThreadDoneReasonSchema,
  ThreadViewSchema,
  UserIdSchema,
} from "@opensteer/core";
import { z } from "zod";
import { AgentConnectionIdSchema } from "./agent-connections.js";
import { AgentConnectionIdentityAtConsentViewSchema } from "@opensteer/control-plane-protocol";
import {
  AuthenticatedUserViewSchema,
  PersonalCapabilitiesViewSchema,
  PersonalSessionSurfaceSchema,
} from "./bootstrap.js";
import { WaitingInputViewSchema } from "./personal-input-queue.js";
import {
  InstalledResourceRevisionsSchema,
  PersonalResourceInterestsSchema,
  PersonalRevisionSchema,
} from "./resources.js";
import {
  TranscriptItemIdSchema,
  TranscriptItemSchema,
  TranscriptOrderCursorViewSchema,
} from "./transcript.js";

/**
 * The hold reasons apps inside the wire window read. A Run that waits for another Run to finish
 * (`waiting-for-run`) is sent as `runWaitingForRun` / `waitingForRun` instead, which they ignore.
 */
const WireRunStartHoldReasonSchema = RunStartHoldReasonSchema.extract([
  "previous-stop-unconfirmed",
]);

export const scopedPersonalApiVersion = 66;
export const personalClientFrameMaxBytes = 32 * 1024;
export const personalChangesFrameMaxBytes = 512 * 1024;
export const personalLiveFrameMaxBytes = 16 * 1024;
export const personalShellFrameMaxBytes = 128 * 1024;
export const personalDetailFrameMaxBytes = 1024 * 1024;
export const personalControlFrameMaxBytes = 4 * 1024;
/** Flow-control credit budgets shared by PersonalSyncSocket and the WebSocket transport. */
export const personalScopeBudget = 2 * 1024 * 1024;
export const personalSocketBudget = 4 * 1024 * 1024;
/** The most streams one live reset names; any other open stream is named again when it next changes. */
export const personalLiveResetMaxStreams = 16;

/** A frame's encoded size limit; senders and receivers measure the encoded bytes against it. */
export function personalHostFrameMaxBytes(frame: {
  readonly type: ScopedHostMessage["type"];
  readonly scope?: PersonalScope;
}): number {
  switch (frame.type) {
    case "host.snapshot":
      return frame.scope?.kind === "shell"
        ? personalShellFrameMaxBytes
        : personalDetailFrameMaxBytes;
    case "host.changes":
      return personalChangesFrameMaxBytes;
    case "host.live":
    case "host.text":
    case "host.live-reset":
      return personalLiveFrameMaxBytes;
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
    expectedSessionId: AuthSessionIdSchema.optional(),
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
  /**
   * Where the reader is: a later repair snapshot of this detail centres on this item, or on the
   * latest messages when it is absent. Sends nothing back.
   */
  z.strictObject({
    type: z.literal("client.anchor"),
    ...address,
    subscriptionId: detailId,
    anchorItemId: TranscriptItemIdSchema.optional(),
  }),
  z.strictObject({ type: z.literal("client.ping"), nonce: z.string().min(1).max(256) }),
]);

/** A connected agent's own task, with its session retained after it ends. */
export const PersonalTaskExternalWorkSchema = z.object({
  sessionId: AgentSessionIdSchema,
  status: z.enum(["active", "ended"]),
  endReason: AgentSessionEndReasonSchema.nullable(),
  connection: z.object({
    id: z.string().min(1).max(255),
    label: z.string().max(200),
    clientName: z.string().max(200),
    client: z
      .object({
        fingerprint: z.string().max(128).nullable(),
        redirectOrigin: z.string().max(2048).nullable(),
      })
      .optional(),
    identityAtConsent: AgentConnectionIdentityAtConsentViewSchema.nullable().optional(),
  }),
});
export type PersonalTaskExternalWork = z.infer<typeof PersonalTaskExternalWorkSchema>;

const task = z.object({
  /** A task's connection lineage, for the person's own task views. */
  originConnectionId: AgentConnectionIdSchema.optional(),
  id: ThreadIdSchema,
  title: z.string().max(240),
  revision: PersonalRevisionSchema,
  status: ThreadStatusSchema,
  inputQueuePaused: z.boolean().optional(),
  purpose: TaskPurposeSchema,
  askedAt: z.iso.datetime(),
  doneAt: z.iso.datetime().nullable(),
  /** `quiet` when the task moved to Done by itself rather than by a person or its agent. */
  doneReason: ThreadDoneReasonSchema.nullable(),
  pendingRequestCount: z.int().nonnegative(),
  lastReplyPreview: z.string().max(1120).nullable(),
  failureCode: z.string().max(255).nullable().optional(),
  failurePreview: z.string().max(1120).nullable(),
  latestRunCompletedAt: z.iso.datetime().nullable(),
  /** Where it runs and on which account: a task list says when that account is getting ready. */
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  /** A Run waits to start and none is executing. */
  runQueued: z.boolean(),
  /** Why a queued Run is being held back from starting on its device. */
  runStartHoldReason: WireRunStartHoldReasonSchema.nullable().optional(),
  /** Its queued Run waits for another Run on its computer to finish (that Runner runs all it may). */
  runWaitingForRun: z.boolean().optional(),
  /** A connected agent is working this task itself; Stop it with `agent.session.stop`. */
  agentSessionId: AgentSessionIdSchema.nullable().optional(),
  externalWork: PersonalTaskExternalWorkSchema.nullable().optional(),
  /** Active provider retry on the earliest executing Run, when retrying. */
  retry: RunRetryViewSchema.nullable().optional(),
});
/** A task row plus the full Thread detail view, return hint included. */
export const PersonalDetailThreadSchema = task.extend({
  thread: ThreadViewSchema,
  /** The chat or connected agent that started this task has ended, so it takes no new messages. */
  endedOrigin: z.enum(["chat", "agent"]).nullable().optional(),
});
const visit = z.object({
  threadId: ThreadIdSchema,
  lastVisitedAt: z.iso.datetime(),
  revision: PersonalRevisionSchema,
});
const attention = z.object({
  id: z.string().min(1).max(600),
  kind: z.literal("request"),
  threadId: ThreadIdSchema.nullable(),
  revision: PersonalRevisionSchema,
  title: z.string().max(240),
  preview: z.string().max(500).optional(),
});
export const PersonalRequestSummarySchema = z.object({
  id: RequestIdSchema,
  revision: PersonalRevisionSchema,
  status: z.string().max(80),
  kind: z.string().max(80),
  title: z.string().max(240),
  threadId: ThreadIdSchema,
});
export const personalInputQueueMaxEntries = 100;
const queue = z.object({
  revision: PersonalRevisionSchema,
  runs: z
    .array(
      z.object({
        id: RunIdSchema,
        revision: PersonalRevisionSchema,
        status: z.string().max(80),
        finishing: z.boolean(),
        startHoldReason: WireRunStartHoldReasonSchema.nullable().optional(),
        /** It waits for another Run on its computer to finish. */
        waitingForRun: z.boolean().optional(),
        createdAt: z.iso.datetime().optional(),
        runOrdinal: z.int().nonnegative().optional(),
      }),
    )
    .max(2),
  paused: z.boolean(),
  /** The Run a waiting message can be steered into now. */
  steerRunId: RunIdSchema.nullable(),
  /** Every waiting message in queue order; `queue-entry` rows carry their values. */
  inputs: z.array(MessageIdSchema).max(personalInputQueueMaxEntries),
});
const nodeSubject = TranscriptItemSchema.refine(
  (item) => item.kind === "node" && item.node !== undefined,
);
export const PersonalDetailSnapshotSchema = z.object({
  thread: PersonalDetailThreadSchema,
  nodeSubject: nodeSubject.optional(),
  queue: queue.optional(),
  /** Values for `queue.inputs`, oldest first, while they fit the frame. */
  inputQueue: z.array(WaitingInputViewSchema).max(personalInputQueueMaxEntries).optional(),
  /** False when `inputQueue` stops short of `queue.inputs`; read the rest with `thread.inputQueue.get`. */
  inputQueueComplete: z.boolean().optional(),
  items: z.array(TranscriptItemSchema).max(50),
  /** The Run cards of the Runs `items` belong to that `items` does not hold (see the page's). */
  runs: z.array(TranscriptItemSchema).max(50).optional(),
  pendingRequests: z.array(PersonalRequestSummarySchema).max(20),
  activeItems: z.array(TranscriptItemSchema).max(20),
  nextBefore: TranscriptOrderCursorViewSchema.nullable(),
  nextAfter: TranscriptOrderCursorViewSchema.nullable().optional(),
  anchorItemId: TranscriptItemIdSchema.nullable().optional(),
  overlayCursors: z
    .object({
      requests: z.string().max(4096).optional(),
      tools: z.string().max(4096).optional(),
      nodes: z.string().max(4096).optional(),
    })
    .optional(),
});
const counts = z.object({
  pendingRequestCount: z.int().nonnegative(),
  /**
   * The commit that last changed the set of pending Requests or anything `requests.list` shows
   * for one (a Request opening, updating, resolving, cancelling or expiring, device access
   * included; its asker's name or place; the title or listing of a task it sits in). Equal to the
   * `pendingRequestsRevision` of a `requests.list` page read at or after that commit.
   */
  pendingRequestsRevision: PersonalRevisionSchema,
  needsYouCount: z.int().nonnegative(),
  unreadTaskCount: z.int().nonnegative(),
});
export const personalShellSettledTasks = 25;
export const PersonalShellSnapshotSchema = z.object({
  deploymentId: DeploymentIdSchema,
  viewerId: UserIdSchema,
  epoch: z.uuid(),
  tasks: z.array(task).max(256),
  visits: z.array(visit).max(256),
  /** Every pending attention row unless `attentionHasMore`. */
  attention: z.array(attention).max(200),
  attentionHasMore: z.boolean(),
  counts,
  session: z
    .object({
      sessionId: AuthSessionIdSchema,
      user: AuthenticatedUserViewSchema,
      /** The signed-in person's relation to this Home, from the session. Absent from older Homes. */
      role: z.enum(["owner", "member"]).optional(),
      sessionSurface: PersonalSessionSurfaceSchema,
      can: PersonalCapabilitiesViewSchema,
    })
    .optional(),
  /** Running and waiting tasks, newest first; `activeNextBefore` pages any rest (`tasks.page` active). */
  activeTaskIds: z.array(ThreadIdSchema).max(200),
  activeNextBefore: z.string().max(4096).nullable(),
  /** The newest settled open tasks; `nextBefore` pages the rest with `tasks.page`. */
  recentTaskIds: z.array(ThreadIdSchema).max(personalShellSettledTasks),
  nextBefore: z.string().max(4096).nullable(),
  /** Bounded counts: each window counts at most 10,000 (draw more as "10,000+"). */
  taskCounts: z.object({ active: z.int().nonnegative(), open: z.int().nonnegative() }),
});

export const PersonalNetworkShellSnapshotSchema = PersonalShellSnapshotSchema.extend({
  session: PersonalShellSnapshotSchema.shape.session.unwrap(),
}).refine(({ session, viewerId }) => session.user.id === viewerId);

const change = {
  sequence: PersonalRevisionSchema,
  ordinal: z.int().min(0).max(127),
  entityId: z.string().min(1).max(600),
};
export const personalShellEntityKinds = ["task", "visit", "attention"] as const;
export const personalDetailEntityKinds = [
  "thread",
  "run-queue",
  "queue-entry",
  "assignment",
  "request",
  "item",
  "node",
] as const;
export const PersonalEntityKindSchema = z.enum([
  ...personalShellEntityKinds,
  ...personalDetailEntityKinds,
]);
type EntityKind = z.infer<typeof PersonalEntityKindSchema>;
function upsert<Kind extends EntityKind, Value extends z.ZodType>(kind: Kind, value: Value) {
  return z.strictObject({
    ...change,
    operation: z.literal("upsert"),
    entityKind: z.literal(kind),
    value,
  });
}

/** One keyed entity's bounded current value, or its removal. */
export const PersonalChangeSchema = z.union([
  z.strictObject({
    ...change,
    operation: z.literal("remove"),
    entityKind: PersonalEntityKindSchema,
  }),
  upsert("task", task),
  upsert("visit", visit),
  upsert("attention", attention),
  upsert("thread", PersonalDetailThreadSchema),
  upsert("run-queue", queue),
  upsert("queue-entry", WaitingInputViewSchema),
  upsert("assignment", AssignmentSummarySchema),
  upsert("request", PersonalRequestSummarySchema),
  upsert("item", TranscriptItemSchema),
  upsert("node", nodeSubject),
]);

const shellProgress = z.strictObject({ counts });
const durableAddress = {
  ...address,
  scope: PersonalScopeSchema,
  throughSequence: PersonalRevisionSchema,
};
const liveHandle = z.int().positive();
const liveText = {
  text: z.string().max(16 * 1024),
  offset: z.int().nonnegative(),
  totalLength: z.int().nonnegative(),
};
/**
 * More text for a live stream its `host.live` frame named: `h` is that frame's `handle`, `o` the
 * offset of `t` and `n` the total length. With `incomplete` it replaces the text; otherwise it
 * appends. A stream's close is always a full `host.live` frame.
 */
const liveTextFrame = z.strictObject({
  type: z.literal("host.text"),
  h: liveHandle,
  o: z.int().nonnegative(),
  n: z.int().nonnegative(),
  t: z.string().max(16 * 1024),
  incomplete: z.boolean().optional(),
});
export const ScopedHostMessageSchema = z
  .discriminatedUnion("type", [
    z
      .strictObject({
        type: z.literal("host.snapshot"),
        ...durableAddress,
        snapshot: z.union([PersonalShellSnapshotSchema, PersonalDetailSnapshotSchema]),
      })
      .refine((value) => (value.scope.kind === "shell") === "tasks" in value.snapshot),
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
          ),
      ),
    z.strictObject({
      type: z.literal("host.synchronized"),
      ...durableAddress,
      shellProgress: shellProgress.optional(),
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
      /**
       * The current revision of each watched kind that differs from what the client installed.
       * Never empty on a live push; empty on a reply when nothing moved.
       */
      revisions: InstalledResourceRevisionsSchema,
      /**
       * This frame answers the client's `client.attach` or `client.resources.watch`. The Host sends
       * exactly one per attach or watch, with empty `revisions` when nothing moved; every other
       * `host.resource` frame is a live push.
       */
      reply: z.literal(true).optional(),
    }),
    /** Names a live stream on this socket with `handle`; later text for it is `host.text`. */
    z.strictObject({
      type: z.literal("host.live"),
      subscriptionId: detailId,
      generation: address.generation,
      handle: liveHandle,
      scope: detailScope,
      liveBootId: z.uuid(),
      runId: RunIdSchema,
      attemptId: RunAttemptIdSchema,
      bindingGeneration: z.int().positive(),
      streamId: z.string().min(1).max(600),
      itemId: TranscriptItemIdSchema,
      afterSequence: PersonalRevisionSchema,
      item: TranscriptItemSchema.optional(),
      update: z.discriminatedUnion("operation", [
        z.strictObject({ operation: z.literal("append"), ...liveText }),
        z.strictObject({ operation: z.literal("replace"), ...liveText, incomplete: z.boolean() }),
        z.strictObject({ operation: z.literal("close") }),
      ]),
    }),
    liveTextFrame,
    /**
     * This scope's queued live state was dropped. Clear every live stream and provisional item of
     * the scope except those in `open`; each of those is named again by a `host.live` replace. An
     * open stream left out (past the count or the reread budget) is dropped too and comes back,
     * with its whole tail, the next time it changes.
     */
    z.strictObject({
      type: z.literal("host.live-reset"),
      subscriptionId: detailId,
      generation: address.generation,
      scope: detailScope,
      open: z
        .array(z.strictObject({ runId: RunIdSchema, streamId: z.string().min(1).max(600) }))
        .max(personalLiveResetMaxStreams),
    }),
  ])
  .refine((frame) => {
    if (frame.type === "host.resource" || frame.type === "host.text") return true;
    const isShell = frame.scope.kind === "shell";
    if ((frame.subscriptionId === "shell") !== isShell) return false;
    if ("shellProgress" in frame && frame.shellProgress && !isShell) return false;
    if (frame.type === "host.snapshot") {
      if ("tasks" in frame.snapshot) {
        const snapshot = frame.snapshot;
        if (snapshot.session && snapshot.session.user.id !== snapshot.viewerId) return false;
        const ids = new Set(snapshot.tasks.map(({ id }) => id));
        return (
          [...snapshot.recentTaskIds, ...snapshot.activeTaskIds].every((id) => ids.has(id)) &&
          [...snapshot.tasks, ...snapshot.visits, ...snapshot.attention].every(({ revision }) =>
            withinCut(revision, frame.throughSequence),
          )
        );
      }
      if (frame.scope.kind === "shell") return false;
      const snapshot = frame.snapshot;
      const scope = frame.scope;
      const queued = new Set(snapshot.queue?.inputs);
      return (
        snapshot.thread.id === scope.threadId &&
        snapshot.thread.thread.id === scope.threadId &&
        [
          snapshot.thread.revision,
          snapshot.queue?.revision ?? "0",
          ...(snapshot.queue?.runs.map(({ revision }) => revision) ?? []),
        ].every((revision) => withinCut(revision, frame.throughSequence)) &&
        (!snapshot.inputQueue ||
          (scope.kind === "thread" &&
            snapshot.inputQueue.every((entry) => queued.has(entry.message.id)))) &&
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
    return frame.changes.every((row) =>
      personalChangeFitsScope(frame.scope, row, frame.throughSequence),
    );
  });

/** Whether a change may appear in a scope's feed at a cut. */
export function personalChangeFitsScope(
  scope: PersonalScope,
  row: PersonalChange,
  through: string,
): boolean {
  const shellEntity = (personalShellEntityKinds as readonly string[]).includes(row.entityKind);
  if (shellEntity !== (scope.kind === "shell")) return false;
  if (row.operation === "remove") return true;
  if (scope.kind === "shell") {
    switch (row.entityKind) {
      case "task":
        return row.entityId === row.value.id && withinCut(row.value.revision, through);
      case "visit":
        return row.entityId === row.value.threadId && withinCut(row.value.revision, through);
      case "attention":
        return row.entityId === row.value.id && withinCut(row.value.revision, through);
      default:
        return false;
    }
  }
  switch (row.entityKind) {
    case "thread":
      return (
        scope.threadId === row.entityId &&
        row.value.id === row.entityId &&
        row.value.thread.id === row.entityId &&
        withinCut(row.value.revision, through)
      );
    case "run-queue":
      return (
        scope.kind === "thread" &&
        row.entityId === scope.threadId &&
        withinCut(row.value.revision, through) &&
        row.value.runs.every(({ revision }) => withinCut(revision, row.value.revision))
      );
    case "queue-entry":
      return scope.kind === "thread" && row.entityId === row.value.message.id;
    case "assignment":
      return (
        scope.kind === "thread" &&
        row.entityId === row.value.id &&
        row.value.parentThreadId === scope.threadId
      );
    case "request":
      return (
        row.entityId === row.value.id &&
        row.value.threadId === scope.threadId &&
        withinCut(row.value.revision, through)
      );
    case "item":
      return (
        row.entityId === row.value.id &&
        row.value.nodeId === (scope.kind === "node" ? scope.nodeId : null) &&
        withinCut(row.value.revision, through)
      );
    case "node":
      return (
        scope.kind === "node" &&
        row.entityId === scope.nodeId &&
        row.value.kind === "node" &&
        row.value.executionNodeId === scope.nodeId &&
        withinCut(row.value.revision, through)
      );
    default:
      return false;
  }
}

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
