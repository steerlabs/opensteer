import {
  DeploymentIdSchema,
  ExecutionNodeIdSchema,
  RequestIdSchema,
  RunAttemptIdSchema,
  RunIdSchema,
  TaskPurposeSchema,
  ThreadIdSchema,
  ThreadStatusSchema,
  UserIdSchema,
  utf8ByteLength,
} from "@opensteer/core";
import { z } from "zod";
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
  TranscriptPlaceSchema,
} from "./transcript.js";

export const scopedPersonalApiVersion = 62;
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
  purpose: TaskPurposeSchema,
  askedAt: z.iso.datetime(),
  doneAt: z.iso.datetime().nullable(),
  pendingRequestCount: z.int().nonnegative(),
  lastReplyPreview: z.string().max(1120).nullable(),
  failurePreview: z.string().max(1120).nullable(),
  latestRunCompletedAt: z.iso.datetime().nullable(),
});
const detailThread = task.extend({ latestPlace: TranscriptPlaceSchema.nullable().optional() });
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
const request = z.strictObject({
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
        latestPlace: TranscriptPlaceSchema.nullable().optional(),
        createdAt: z.iso.datetime().optional(),
        runOrdinal: z.int().nonnegative().optional(),
      }),
    )
    .max(2),
  paused: z.boolean(),
});
export const PersonalDetailSnapshotSchema = z.strictObject({
  thread: detailThread,
  node: z
    .strictObject({
      id: ExecutionNodeIdSchema,
      title: z.string().max(240),
      status: z.string().max(80),
    })
    .optional(),
  orderRevision: PersonalRevisionSchema,
  inputQueueRevision: PersonalRevisionSchema,
  queue: queue.optional(),
  items: z.array(TranscriptItemSchema).max(50),
  pendingRequests: z.array(request).max(20),
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

export const PersonalChangeSchema = z
  .union([
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
    upsert("thread", detailThread),
    upsert("run-queue", queue),
    upsert("request", request),
    upsert("item", TranscriptItemSchema),
  ])
  .refine((row) => {
    if (row.operation !== "upsert") return true;
    if ("id" in row.value) return row.entityId === row.value.id;
    if (row.entityKind === "visit") return row.entityId === row.value.threadId;
    return true;
  });

function changeMatchesScope(
  row: z.infer<typeof PersonalChangeSchema>,
  scope: z.infer<typeof PersonalScopeSchema>,
) {
  if (row.entityKind === "collection") return true;
  if (scope.kind === "shell")
    return (
      row.entityKind === "task" || row.entityKind === "visit" || row.entityKind === "attention"
    );
  switch (row.entityKind) {
    case "thread":
      return row.entityId === scope.threadId;
    case "request":
      return row.operation !== "upsert" || row.value.threadId === scope.threadId;
    case "run-queue":
      return scope.kind === "thread";
    case "item":
      return (
        row.operation !== "upsert" ||
        row.value.nodeId === (scope.kind === "node" ? scope.nodeId : null)
      );
    default:
      return false;
  }
}

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
          utf8ByteLength(JSON.stringify(value)) <= (value.scope.kind === "shell" ? 96 : 128) * 1024,
      ),
    z
      .strictObject({
        type: z.literal("host.changes"),
        ...durableAddress,
        fromSequence: PersonalRevisionSchema,
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
              changeMatchesScope(row, frame.scope) &&
              (index === 0 || row.ordinal > frame.changes[index - 1]!.ordinal),
          ) &&
          utf8ByteLength(JSON.stringify(frame)) <= 64 * 1024,
      ),
    z.strictObject({ type: z.literal("host.synchronized"), ...durableAddress }),
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
      .refine((value) => utf8ByteLength(JSON.stringify(value)) <= 16 * 1024),
  ])
  .refine(
    (frame) =>
      !("scope" in frame) || (frame.scope.kind === "shell") === (frame.subscriptionId === "shell"),
  );

export type PersonalScope = z.infer<typeof PersonalScopeSchema>;
export type PersonalResumeCursor = z.infer<typeof PersonalResumeCursorSchema>;
export type PersonalChange = z.infer<typeof PersonalChangeSchema>;
export type ScopedHostMessage = z.infer<typeof ScopedHostMessageSchema>;
export type ScopedClientMessage = z.infer<typeof ScopedClientMessageSchema>;
