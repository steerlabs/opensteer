import { ComputerViewChangedSchema, ComputerViewRemovedSchema } from "./computer-view.js";
import {
  AgentEventViewSchema,
  EnvironmentIdSchema,
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
  WorkspaceNotificationPreferenceSchema,
  WorkspaceIconNameSchema,
  MarkColorSchema,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
  type Workspace,
} from "@opensteer/core";
import { BrowserProfileIdSchema, RunnerIdSchema } from "@opensteer/core";
import { z } from "zod";
import { ThreadPlaceChangedSchema, PlaceActivityNoticeViewSchema } from "./places.js";
import { BrowserTabsChangedSchema, BrowserPresenceSchema } from "./browser.js";
import { ProtocolErrorSchema } from "./common.js";
import { ComputerUseSessionIdSchema, computerUseMaxSessionApps } from "./computer-use.js";
import { ShellCloseReasonSchema, ShellSessionSummarySchema } from "./shell.js";

const clientMessageBase = {} as const;

export const workspaceSnapshotMaxThreads = 100;
export const workspaceSnapshotMaxMessages = 500;
export const workspaceSnapshotMaxPendingRequests = 32;
/** Transport bound only; PostgreSQL enforces the per-Thread active and queued Run limits. */
export const workspaceSnapshotMaxRunQueueEntries = 500;
export const workspaceSnapshotMaxSerializedBytes = 900 * 1_024;
export const threadPageMaxItems = 100;
export const messagePageMaxItems = 100;
export const eventPageMaxItems = 200;
/**
 * A page of whole turns (`history-turns-v1`) may hold more events than an
 * older reader's 200, so only a request that asks for turns receives one.
 */
export const turnPageMaxItems = 1_000;
export const turnPageMaxTurns = 20;
export const workspacePageMaxItems = 100;
export const durableWindowCursorMaxCharacters = 512;

export const DurableWindowCursorSchema = z
  .string()
  .min(1)
  .max(durableWindowCursorMaxCharacters)
  .regex(/^[A-Za-z0-9_-]+$/);

export const DurableWindowSchema = z.object({
  byteCount: z.number().int().nonnegative().max(workspaceSnapshotMaxSerializedBytes),
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

export const WorkspaceViewSchema = z.object({
  homeThreadId: ThreadIdSchema.nullable(),
  capacity: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("host-filesystem") }),
    z.object({ kind: z.literal("managed-quota") }),
  ]),
  createdAt: z.iso.datetime({ offset: true }),
  icon: WorkspaceIconNameSchema.nullable(),
  /** The colour its mark is drawn in; absent from older Hosts, and a colour a newer Host added reads as none. */
  color: MarkColorSchema.optional().catch(undefined),
  id: WorkspaceIdSchema,
  kind: WorkspaceKindSchema,
  // A local directory lives on one identified machine, which is not
  // necessarily the reader's. `name` is presentation only: the Host fills it in
  // when it serves the view, and it stays null where that machine is unknown.
  location: z.discriminatedUnion("kind", [
    z.object({
      environmentId: EnvironmentIdSchema,
      kind: z.literal("machine"),
      name: z.string().trim().min(1).max(120).nullable(),
    }),
    z.object({ kind: z.literal("shared-storage") }),
  ]),
  name: z.string().trim().min(1).max(160),
  restoreProgressPermille: z.number().int().min(0).max(1_000).optional(),
  status: z.enum([
    "provisioning",
    "ready",
    "archiving",
    "archived",
    "unavailable",
    "failed",
    "deleting",
    "deleted",
  ]),
  storageIssue: z
    .object({
      code: z.string().trim().min(1).max(120),
      message: z.string().trim().min(1).max(500),
      occurredAt: z.iso.datetime({ offset: true }),
      retryable: z.boolean(),
    })
    .nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;

/**
 * Project the internal Workspace aggregate onto its public client shape.
 *
 * Storage binding identities and quota values are authority-bearing details;
 * this is the single protocol-level boundary that deliberately omits them.
 */
export function workspaceViewFromWorkspace(workspace: Workspace): WorkspaceView {
  return WorkspaceViewSchema.parse({
    homeThreadId: workspace.homeThreadId,
    capacity: {
      kind:
        workspace.capacityPolicy.kind === "host-filesystem" ? "host-filesystem" : "managed-quota",
    },
    createdAt: workspace.createdAt,
    icon: workspace.icon,
    color: workspace.color,
    id: workspace.id,
    kind: workspace.kind,
    location:
      workspace.backing.kind === "local-directory"
        ? {
            environmentId: workspace.backing.ownerEnvironmentId,
            kind: "machine",
            // The aggregate carries no directory of machine names, so the name
            // is filled in by whoever serves the view to a reader.
            name: null,
          }
        : { kind: "shared-storage" },
    name: workspace.name,
    status: workspace.status,
    storageIssue: workspace.storageIssue,
    updatedAt: workspace.updatedAt,
  });
}

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
    ...clientMessageBase,
    type: z.literal("client.subscribe"),
    afterSequence: SequenceSchema,
    // Optional on the wire so that a frame from a client predating negotiation
    // is answered with the epoch refusal a person can act on, rather than
    // rejected as malformed JSON. The Host requires it either way.
    apiVersion: z.number().int().positive().optional(),
    /** Requires `snapshot-messages-omit-v1`; absence retains message history. */
    snapshotMessages: z.literal("omit").optional(),
    threadId: ThreadIdSchema.nullable(),
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    ...clientMessageBase,
    type: z.literal("client.ack"),
    sequence: SequenceSchema,
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    ...clientMessageBase,
    type: z.literal("client.ping"),
    nonce: z.string().max(255),
  }),
]);

export const WorkspaceSnapshotSchema = z
  .object({
    readStates: z.array(ThreadReadStateSchema).max(workspaceSnapshotMaxThreads),
    notificationPreferences: z.array(WorkspaceNotificationPreferenceSchema).max(1),
    messages: z.array(MessageViewSchema).max(workspaceSnapshotMaxMessages),
    messageWindows: z.array(ThreadMessageWindowSchema).max(workspaceSnapshotMaxThreads),
    /** History was not loaded; the empty arrays do not mean an empty conversation. */
    messagesOmitted: z.literal(true).optional(),
    pendingRequests: readableRequestList(
      PendingRequestViewSchema,
      workspaceSnapshotMaxPendingRequests,
    ),
    pendingRequestWindow: DurableWindowSchema,
    runQueue: z.array(ThreadRunQueueEntryViewSchema).max(workspaceSnapshotMaxRunQueueEntries),
    sequence: SequenceSchema,
    serializedBytes: z.number().int().positive().max(workspaceSnapshotMaxSerializedBytes),
    threadWindow: DurableWindowSchema,
    threads: z.array(ThreadViewSchema).max(workspaceSnapshotMaxThreads),
    workspace: WorkspaceViewSchema,
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
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

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

/**
 * A page of the reader's tasks across every Workspace they belong to: listed,
 * unarchived Threads, most recently updated first, with this reader's read
 * state for each.
 */
export const TaskPageSchema = z.object({
  readStates: z.array(ThreadReadStateSchema).max(threadPageMaxItems),
  tasks: z.array(TaskEntryViewSchema).max(threadPageMaxItems),
  window: DurableWindowSchema,
});
export type TaskPage = z.infer<typeof TaskPageSchema>;

export const WorkspaceCatalogPageSchema = z.object({
  notificationPreferences: z
    .array(WorkspaceNotificationPreferenceSchema)
    .max(workspacePageMaxItems + 1),
  window: DurableWindowSchema,
  workspaces: z.array(WorkspaceViewSchema).max(workspacePageMaxItems),
});
export type WorkspaceCatalogPage = z.infer<typeof WorkspaceCatalogPageSchema>;

export const ThreadMessagePageSchema = z.object({
  messages: z.array(MessageViewSchema).max(messagePageMaxItems),
  threadId: ThreadIdSchema,
  window: ThreadMessageWindowSchema,
});
export type ThreadMessagePage = z.infer<typeof ThreadMessagePageSchema>;

export const ThreadEventPageSchema = z.object({
  readState: ThreadReadStateSchema,
  thread: ThreadViewSchema,
  events: z.array(AgentEventViewSchema).max(turnPageMaxItems),
  threadId: ThreadIdSchema,
  window: ThreadMessageWindowSchema,
});
export type ThreadEventPage = z.infer<typeof ThreadEventPageSchema>;

const ProtocolErrorViewSchema = z.object(ProtocolErrorSchema.shape);

export const HostToClientMessageSchema = z.discriminatedUnion("type", [
  ComputerViewChangedSchema,
  ComputerViewRemovedSchema,
  z.object({
    type: z.literal("host.read-states"),
    workspaceId: WorkspaceIdSchema,
    states: z.array(ThreadReadStateSchema).max(100),
  }),
  z.object({
    type: z.literal("host.read-markers"),
    workspaceId: WorkspaceIdSchema,
    markers: z.array(z.object({ threadId: ThreadIdSchema, readSequence: SequenceSchema })).max(100),
  }),
  z.object({
    type: z.literal("host.notification-preferences"),
    preferences: z.array(WorkspaceNotificationPreferenceSchema).max(100),
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.snapshot"),
    snapshot: WorkspaceSnapshotSchema,
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.events"),
    events: z.array(AgentEventViewSchema).min(1).max(2_000),
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
    workspaceId: WorkspaceIdSchema,
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.synchronized"),
    sequence: SequenceSchema,
    workspaceId: WorkspaceIdSchema,
  }),
  z.object({
    ...clientMessageBase,
    type: z.literal("host.triggers-changed"),
    workspaceId: WorkspaceIdSchema,
  }),
  ThreadPlaceChangedSchema,
  BrowserTabsChangedSchema,
  ...PlaceActivityNoticeViewSchema.options,
  // A Workspace's browser sessions changed — one opened, or one moved between
  // starting, ready, closing and its terminal state. It names nothing: every
  // client rereads the list rather than waiting out the bootstrap poll.
  z.object({
    ...clientMessageBase,
    type: z.literal("host.browser-sessions-changed"),
    workspaceId: WorkspaceIdSchema,
  }),
  // What changed about browsers this socket's person can see: the page each
  // shows and whether an agent is acting in it. A client patches its sessions
  // in place; nothing is reread. Only changed sessions are named.
  z.object({
    ...clientMessageBase,
    sessions: z.array(BrowserPresenceSchema).min(1).max(100),
    type: z.literal("host.browser-presence"),
    workspaceId: WorkspaceIdSchema,
  }),
  // These conversations gained a browser page in their durable usage record:
  // a Run used a new session or tab, or a person opened one there. A client
  // rereads usage only for the ones it shows.
  z.object({
    ...clientMessageBase,
    threadIds: z.array(ThreadIdSchema).min(1).max(100),
    type: z.literal("host.browser-usage-changed"),
    workspaceId: WorkspaceIdSchema,
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
  // A pending Request opened, changed or ended somewhere on this Host. It names
  // nothing: every client rereads `requests.list`, which is where it is asked
  // whom each Request waits on, including in Workspaces it is not subscribed to.
  z.object({
    ...clientMessageBase,
    type: z.literal("host.requests-changed"),
  }),
  // A listed Thread was created or changed what a task list shows of it — its
  // title, status, last reply or failure — somewhere on this Host, or this
  // reader placed a task. It names nothing: every client rereads
  // `tasks.list`, which is where membership decides what each reader sees.
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
  // Host has already checked their membership, mute and read position. Nothing
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
    workspaceId: WorkspaceIdSchema,
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
