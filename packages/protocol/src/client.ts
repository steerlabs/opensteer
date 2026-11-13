import { NeedsYouPageSchema } from "./needs-you.js";
import { AppTabsSchema } from "./bootstrap.js";
import { HostedBrowserBootstrapSchema } from "./browser.js";
import { DeploymentIdSchema, DeploymentResumeCursorSchema } from "@opensteer/core";
import { BrowserGroupStreamSchema, BrowserClientTabStreamSchema } from "./browser-tabs.js";
import { ComputerViewChangedSchema, ComputerViewRemovedSchema } from "./computer-view.js";
import {
  AgentEventViewSchema,
  type AgentEventView,
  PlaceEnteredEventViewSchema,
  LiveRunProgressViewSchema,
  MessageViewSchema,
  NotificationViewSchema,
  PendingRequestViewSchema,
  readableRequestList,
  SequenceSchema,
  ThreadRunQueueEntryViewSchema,
  ThreadIdSchema,
  ThreadViewSchema,
  ThreadReadStateSchema,
} from "@opensteer/core";
import {
  BrowserProfileIdSchema,
  BrowserSessionIdSchema,
  ExecutionNodeIdSchema,
  ExecutionNodeViewSchema,
  RunnerIdSchema,
} from "@opensteer/core";
import { z } from "zod";
import {
  PersonShowMessageSchema,
  ThreadPlaceChangedSchema,
  PlaceActivityNoticeViewSchema,
} from "./places.js";
import { ProtocolErrorSchema, type RealtimeFrameDiagnostic } from "./common.js";
import { ComputerUseSessionIdSchema, computerUseMaxSessionApps } from "./computer-use.js";
import { ShellCloseReasonSchema, ShellSessionSummarySchema } from "./shell.js";

const clientMessageBase = {} as const;

export const deploymentSnapshotMaxThreads = 100;
export const deploymentSnapshotMaxMessages = 500;
export const deploymentSnapshotMaxPendingRequests = 32;
/** Transport bound only; PostgreSQL enforces the per-Thread active and queued Run limits. */
export const deploymentSnapshotMaxRunQueueEntries = 500;
export const deploymentSnapshotMaxSerializedBytes = 900 * 1_024;
export const threadPageMaxItems = 100;
export const messagePageMaxItems = 100;
export const eventPageMaxItems = 200;
/**
 * A page of whole turns (`history-turns-v1`) may hold more events than an
 * older reader's 200, so only a request that asks for turns receives one.
 */
export const turnPageMaxItems = 1_000;
export const turnPageMaxTurns = 20;
export const deploymentPageMaxItems = 100;
export const durableWindowCursorMaxCharacters = 512;

export const DurableWindowCursorSchema = z
  .string()
  .min(1)
  .max(durableWindowCursorMaxCharacters)
  .regex(/^[A-Za-z0-9_-]+$/);

export const DurableWindowSchema = z.object({
  byteCount: z.number().int().nonnegative().max(deploymentSnapshotMaxSerializedBytes),
  hasMore: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  nextBefore: DurableWindowCursorSchema.nullable(),
  totalItems: z.number().int().nonnegative(),
});
export type DurableWindow = z.infer<typeof DurableWindowSchema>;

export const ThreadMessageWindowSchema = DurableWindowSchema.extend({
  threadId: ThreadIdSchema,
});
export type ThreadMessageWindow = z.infer<typeof ThreadMessageWindowSchema>;

/**
 * The close code that means "these two do not speak the same protocol".
 *
 * What stops the client is the `host.error` sent immediately before the close:
 * it is non-retryable, and a non-retryable refusal is never reconnected over.
 * The code exists so the reason survives the close frame — a socket that ended
 * on an epoch mismatch is distinguishable in a log, and in a proxy that never
 * saw the message, from one that ended on a resync or a revoked grant.
 */
export const unsupportedVersionCloseCode = 4011;

export const ClientToHostMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("client.browser.resync"),
    continuation: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    groupId: BrowserSessionIdSchema.optional(),
  }),
  z.strictObject({
    ...clientMessageBase,
    type: z.literal("client.subscribe"),
    cursor: DeploymentResumeCursorSchema,
    // Optional on the wire so that a frame from a client predating negotiation
    // is answered with the epoch refusal a person can act on, rather than
    // rejected as malformed JSON. The Host requires it either way.
    apiVersion: z.number().int().positive().optional(),
    /** Requires `snapshot-messages-omit-v1`; absence retains message history. */
    snapshotMessages: z.literal("omit").optional(),
    /** Requires `devices-v1`; legacy subscribers cannot parse these Requests. */
    deviceAccessRequests: z.literal("include").optional(),
    placeEvents: z.literal("include").optional(),
    toolOutputs: z.literal("preview").optional(),
    /** Requires `person-show-v1`; old subscribers receive no navigation requests. */
    personShow: z.literal("accept").optional(),
    threadId: ThreadIdSchema.nullable(),
  }),
  z.strictObject({
    ...clientMessageBase,
    type: z.literal("client.ack"),
    sequence: SequenceSchema,
  }),
  z.strictObject({
    ...clientMessageBase,
    type: z.literal("client.ping"),
    nonce: z.string().max(255),
  }),
  /**
   * Names the one subagent whose own events this subscriber also receives, or
   * none. A subscriber otherwise receives only what a subagent's card shows.
   * Requires `node-detail-v1`.
   */
  z.strictObject({
    ...clientMessageBase,
    type: z.literal("client.watch-node"),
    nodeId: ExecutionNodeIdSchema.nullable(),
  }),
]);

export const DeploymentSnapshotSchema = z
  .object({
    tasks: z.object({
      recent: z.lazy(() => TaskPageSchema),
      active: z.lazy(() => TaskPageSchema),
      done: z.lazy(() => TaskPageSchema),
    }),
    needsYou: z.lazy(() => NeedsYouPageSchema),
    resources: z.object({ appTabs: AppTabsSchema, browser: HostedBrowserBootstrapSchema }),
    readStates: z.array(ThreadReadStateSchema).max(deploymentSnapshotMaxThreads),
    messages: z.array(MessageViewSchema).max(deploymentSnapshotMaxMessages),
    messageWindows: z.array(ThreadMessageWindowSchema).max(deploymentSnapshotMaxThreads),
    /** History was not loaded; the empty arrays do not mean an empty conversation. */
    messagesOmitted: z.literal(true).optional(),
    pendingRequests: readableRequestList(
      PendingRequestViewSchema,
      deploymentSnapshotMaxPendingRequests,
    ),
    pendingRequestWindow: DurableWindowSchema,
    runQueue: z.array(ThreadRunQueueEntryViewSchema).max(deploymentSnapshotMaxRunQueueEntries),
    /**
     * Each nonterminal Run's newest `place.entered`, whatever the transcript
     * window holds. Sent only to a subscriber that asked for place events;
     * absence means the Host does not say, not that no Run is anywhere.
     */
    runPlaces: z
      .array(PlaceEnteredEventViewSchema)
      .max(deploymentSnapshotMaxRunQueueEntries)
      .optional(),
    sequence: SequenceSchema,
    serializedBytes: z.number().int().positive().max(deploymentSnapshotMaxSerializedBytes),
    threadWindow: DurableWindowSchema,
    threads: z.array(ThreadViewSchema).max(deploymentSnapshotMaxThreads),
    deploymentId: DeploymentIdSchema,
  })
  .refine(
    (snapshot) =>
      !snapshot.messagesOmitted ||
      (snapshot.messages.length === 0 && snapshot.messageWindows.length === 0),
    {
      message: "Omitted history cannot include messages or message windows",
      path: ["messagesOmitted"],
    },
  );
export type DeploymentSnapshot = z.infer<typeof DeploymentSnapshotSchema>;

/** The most characters of a task's last reply or failure a task list carries. */
export const taskLineMaxLength = 280;

/**
 * One task as its reader's task list shows it: the Thread, what it last said,
 * and why its latest Run failed when it did. Both lines are plain text cut to
 * `taskLineMaxLength`, read from the latest published reply and latest Run.
 */
export const TaskEntryViewSchema = z.object({
  failure: z.string().max(taskLineMaxLength).nullable(),
  lastReply: z.string().max(taskLineMaxLength).nullable(),
  thread: ThreadViewSchema,
});
export type TaskEntryView = z.infer<typeof TaskEntryViewSchema>;

export const TaskPageSchema = z.object({
  readStates: z.array(ThreadReadStateSchema).max(threadPageMaxItems),
  tasks: z.array(TaskEntryViewSchema).max(threadPageMaxItems),
  window: DurableWindowSchema,
});
export type TaskPage = z.infer<typeof TaskPageSchema>;

export const ThreadMessagePageSchema = z.object({
  messages: z.array(MessageViewSchema).max(messagePageMaxItems),
  threadId: ThreadIdSchema,
  window: ThreadMessageWindowSchema,
});
export type ThreadMessagePage = z.infer<typeof ThreadMessagePageSchema>;

export const ThreadEventPageSchema = z.object({
  readState: ThreadReadStateSchema,
  thread: ThreadViewSchema,
  events: z
    .array(z.unknown())
    .max(turnPageMaxItems)
    .transform((events) =>
      events.flatMap((event) => {
        const header = z.object({ type: z.string() }).safeParse(event);
        if (
          header.success &&
          !AgentEventViewSchema.options.some(
            (variant) => variant.shape.type.value === header.data.type,
          )
        )
          return [];
        return [event];
      }),
    )
    .pipe(z.array(AgentEventViewSchema)),
  threadId: ThreadIdSchema,
  window: ThreadMessageWindowSchema,
});
export type ThreadEventPage = z.infer<typeof ThreadEventPageSchema>;

/**
 * One subagent's own events, oldest first within a page and paged newest
 * first: what it said, thought and called. Needs `node-detail-v1`.
 */
export const NodeEventPageSchema = z.object({
  events: ThreadEventPageSchema.shape.events,
  /** The subagent itself, so its view never depends on how much of its conversation is loaded. */
  node: ExecutionNodeViewSchema,
  nodeId: ExecutionNodeIdSchema,
  threadId: ThreadIdSchema,
  window: DurableWindowSchema,
});
export type NodeEventPage = z.infer<typeof NodeEventPageSchema>;

const ProtocolErrorViewSchema = z.object(ProtocolErrorSchema.shape);

export const HostToClientMessageSchema = z.discriminatedUnion("type", [
  PersonShowMessageSchema,
  ComputerViewChangedSchema,
  ComputerViewRemovedSchema,
  z.object({
    type: z.literal("host.read-states"),

    states: z.array(ThreadReadStateSchema).max(100),
  }),
  z.object({
    type: z.literal("host.read-markers"),

    markers: z.array(z.object({ threadId: ThreadIdSchema, readSequence: SequenceSchema })).max(100),
  }),

  z.object({
    ...clientMessageBase,
    type: z.literal("host.snapshot"),
    snapshot: DeploymentSnapshotSchema,
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.events"),
    throughSequence: SequenceSchema,
    events: z.array(AgentEventViewSchema).max(2_000),
  }),
  /**
   * A Run's streams before they complete. It follows every durable event
   * through `afterSequence`, so a reader never sees progress for a stream the
   * completing event has already replaced. Nothing replays it: a reconnect gets
   * each active stream again as one `replace` item.
   */
  z.object({
    ...clientMessageBase,
    afterSequence: SequenceSchema,
    progress: LiveRunProgressViewSchema,
    type: z.literal("host.live"),
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.synchronized"),
    sequence: SequenceSchema,
  }),
  /**
   * Answers `client.watch-node`. Every event of the subagent's own after
   * `sequence` follows in `host.events`, in order with everything else;
   * `node.events.list` reads the ones through it.
   */
  z.object({
    ...clientMessageBase,
    type: z.literal("host.node-watched"),
    nodeId: ExecutionNodeIdSchema.nullable(),
    sequence: SequenceSchema,
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.triggers-changed"),
  }),
  z.object({ ...clientMessageBase, type: z.literal("host.app-tabs-changed") }),
  ThreadPlaceChangedSchema,
  z.object({
    ...clientMessageBase,
    type: z.literal("host.browser-groups"),
    stream: BrowserGroupStreamSchema,
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.browser-tabs"),
    groupId: BrowserSessionIdSchema,
    stream: BrowserClientTabStreamSchema,
  }),
  ...PlaceActivityNoticeViewSchema.options,
  z.object({
    ...clientMessageBase,
    type: z.literal("host.browser-sessions-changed"),
  }),
  // These conversations gained a browser page in their durable usage record:
  // a Run used a new session or tab, or a person opened one there. A client
  // rereads usage only for the ones it shows.
  z.object({
    ...clientMessageBase,
    threadIds: z.array(ThreadIdSchema).min(1).max(100),
    type: z.literal("host.browser-usage-changed"),
  }),
  // Which apps on a Mac an agent is acting in now, for each changed computer
  // use session. Sent only to the Mac's owner, whose machines list carries the
  // sessions themselves.
  z.object({
    ...clientMessageBase,
    sessions: z
      .array(
        z.object({
          actingDisplay: z.boolean().optional(),
          actingAppKeys: z.array(z.string().min(1).max(255)).max(computerUseMaxSessionApps),
          sessionId: ComputerUseSessionIdSchema,
        }),
      )
      .min(1)
      .max(100),
    type: z.literal("host.computer-presence"),
  }),
  // The computers list changed — a Runner connected or disconnected, a computer
  // was added, renamed, or removed, or an access policy was written. It names
  // nothing: every client rereads the list, which is where authorization lives.
  z.object({
    ...clientMessageBase,
    type: z.literal("host.machines.changed"),
  }),
  z.object({ ...clientMessageBase, type: z.literal("host.plugins-changed") }),
  // A pending Request opened, changed or ended somewhere on this Host. It names
  // nothing: clients reread the deployment Needs-you page.

  z.object({
    ...clientMessageBase,
    type: z.literal("host.requests-changed"),
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.personal-remote-access-changed"),
  }),
  // The reader approved or revoked a connected agent, on any device. It names
  // nothing: a client showing the list rereads `connections.list`.
  z.object({
    ...clientMessageBase,
    type: z.literal("host.connections-changed"),
  }),
  // A listed Thread was created or changed what a task list shows of it — its
  // title, status, last reply or failure — somewhere on this Host, or this
  // reader placed a task. It names nothing: every client rereads
  // `tasks.list`.
  z.object({
    ...clientMessageBase,
    type: z.literal("host.tasks-changed"),
  }),
  // The reader's own browser profile gained, lost or retitled history, on any
  // device. Clients holding that profile's history reread `browser.history.get`.
  z.object({
    ...clientMessageBase,
    profileId: BrowserProfileIdSchema,
    type: z.literal("host.browser-history-changed"),
  }),
  // Sent once, to each socket of the person it is for, as it is decided: the
  // Host has already checked their notification preference and read position. Nothing
  // replays it — what it points at stays unread in its Thread.
  z.object({
    ...clientMessageBase,
    notification: NotificationViewSchema,
    type: z.literal("host.notification"),
  }),
  // Delivered only to a viewer who manages the machine. The summary carries who
  // is connected and how much has moved, never a command or a path.
  z.object({
    ...clientMessageBase,
    runnerId: RunnerIdSchema,
    session: ShellSessionSummarySchema,
    type: z.literal("host.machine.access.session.started"),
  }),
  z.object({
    ...clientMessageBase,
    endReason: ShellCloseReasonSchema,
    runnerId: RunnerIdSchema,
    session: ShellSessionSummarySchema,
    type: z.literal("host.machine.access.session.ended"),
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.resync-required"),
    reason: z.enum(["cursor-ahead", "cursor-expired", "slow-consumer", "buffer-overflow"]),
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.pong"),
    nonce: z.string().max(255),
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.error"),
    error: ProtocolErrorViewSchema,
  }),
]);
export type HostToClientMessage = z.infer<typeof HostToClientMessageSchema>;

export const realtimeEnvelopeTypes: ReadonlySet<string> = new Set(
  HostToClientMessageSchema.options.map((schema) => schema.shape.type.value),
);

function collectFieldNames(value: unknown, names: Set<string>, seen: Set<unknown>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFieldNames(item, names, seen);
    return;
  }
  if (!(value instanceof z.core.$ZodType) || seen.has(value)) return;
  seen.add(value);
  const def = (value as z.core.$ZodTypes)._zod.def;
  if (def.type === "object") {
    for (const [name, field] of Object.entries(def.shape)) {
      names.add(name);
      collectFieldNames(field, names, seen);
    }
  }
  if (def.type === "lazy") collectFieldNames(def.getter(), names, seen);
  for (const child of Object.values(def)) collectFieldNames(child, names, seen);
}

let realtimeWireFields: ReadonlySet<string> | undefined;

/** Walked on first use: a healthy client never pays for it. */
export function isRealtimeWireField(part: string): boolean {
  if (!realtimeWireFields) {
    const names = new Set<string>();
    collectFieldNames(HostToClientMessageSchema, names, new Set());
    realtimeWireFields = names;
  }
  return realtimeWireFields.has(part);
}

/** Whether a diagnostic says only what the wire schemas declare, so it is safe to keep. */
export function isRealtimeFrameMetadata(
  record: Pick<RealtimeFrameDiagnostic, "envelopeType" | "issuePaths">,
): boolean {
  return (
    (record.envelopeType === "unknown" || realtimeEnvelopeTypes.has(record.envelopeType)) &&
    record.issuePaths.every(
      (path) =>
        path === "$" ||
        path.split(".").every((part) => part === "[]" || part === "*" || isRealtimeWireField(part)),
    )
  );
}

export function isDeviceAccessRequestEvent(event: AgentEventView): boolean {
  return (
    (event.type === "request.opened" ||
      event.type === "request.updated" ||
      event.type === "request.resolved") &&
    event.data.request.kind === "device.access"
  );
}
