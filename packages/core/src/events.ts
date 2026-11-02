import { PlaceIdentitySchema, PlaceIdentityViewSchema } from "./places.js";
import { z } from "zod";
import {
  DelegationIdSchema,
  EnvironmentIdSchema,
  EventIdSchema,
  ExecutionNodeIdSchema,
  MessageIdSchema,
  UserIdSchema,
  RunIdSchema,
  SequenceSchema,
  RequestIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";
import {
  AssignmentSummarySchema,
  IsoDateTimeSchema,
  MessageContentSchema,
  MessageAuthorSchema,
  MessageAuthorViewSchema,
  MessageSchema,
  MessageViewSchema,
  RunFailureViewSchema,
  RunFailureSchema,
  RunStatusSchema,
  RunUsageSchema,
  RunUsageViewSchema,
  ProviderContinuationIdentitySchema,
  ProviderContinuationIdentityViewSchema,
  ThreadAccessModeSchema,
  ThreadRunQueueEntrySchema,
  ThreadRunQueueEntryViewSchema,
  ThreadInputSchema,
  ThreadInputViewSchema,
  ThreadSchema,
  ThreadStatusSchema,
  ThreadViewSchema,
} from "./models.js";
import {
  PendingRequestSchema,
  PendingRequestViewSchema,
  RequestCancellationReasonSchema,
  ResolvedRequestEventSchema,
  ResolvedRequestEventViewSchema,
} from "./requests.js";
import { ThreadTitleSchema } from "./thread-title.js";
import { WorkspaceIconNameSchema } from "./workspace-icons.js";
import { ToolOutputSchema, ToolOutputViewSchema } from "./tool-output.js";

export const ToolIdentitySchema = z.strictObject({
  name: z.string().min(1).max(255),
  namespace: z.string().min(1).max(255),
});
export type ToolIdentity = z.infer<typeof ToolIdentitySchema>;
const ToolIdentityViewSchema = z.object(ToolIdentitySchema.shape);

/**
 * What an integration gateway call addressed, as the Host resolved the call's
 * toolRef when it recorded the call. An engine only ever holds the opaque
 * reference; this is how a transcript names the integration, the operation
 * and, for Computer use, the app and the Mac it runs on, or the phone. The
 * Host writes it, so a Runner's event never carries it.
 */
export const IntegrationCallSubjectSchema = z.strictObject({
  /** The account the grant acts as, in the words search shows: "Work", "Slack on Alex's Mac". */
  account: z.string().min(1).max(240),
  /** Computer use only: the approved app and the Mac it runs on. */
  computerApp: z
    .strictObject({
      app: z.string().min(1).max(240),
      bundleId: z.string().min(1).max(255),
      computer: z.string().min(1).max(240),
      /** Stable identity for grouping calls when two Macs share a display name. */
      runnerId: RunnerIdSchema,
    })
    .nullable(),
  effect: z.enum(["read", "write"]),
  /**
   * An Android phone call only: the phone, which is the whole target because
   * a phone's connection names no app. Absent for every other call.
   */
  phone: z
    .strictObject({
      computer: z.string().min(1).max(240),
      runnerId: RunnerIdSchema,
    })
    .optional(),
  /** The integration's title: "Gmail", "Computer use". */
  integration: z.string().min(1).max(240),
  operation: z.strictObject({
    name: z.string().min(1).max(255),
    title: z.string().min(1).max(255),
  }),
});
export type IntegrationCallSubject = z.infer<typeof IntegrationCallSubjectSchema>;
const IntegrationCallSubjectViewSchema = z.object({
  ...IntegrationCallSubjectSchema.shape,
  computerApp: z.object(IntegrationCallSubjectSchema.shape.computerApp.unwrap().shape).nullable(),
  operation: z.object(IntegrationCallSubjectSchema.shape.operation.shape),
  phone: z.object(IntegrationCallSubjectSchema.shape.phone.unwrap().shape).optional(),
});

export const delegationTaskPreviewMaxBytes = 2 * 1_024;
export const delegationResultPreviewMaxBytes = 8 * 1_024;

function boundedUtf8Text(maximumBytes: number) {
  return z
    .string()
    .max(maximumBytes)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes`,
    );
}

export const DelegationOutcomeSchema = z.enum(["completed", "failed", "interrupted"]);
export type DelegationOutcome = z.infer<typeof DelegationOutcomeSchema>;

export const DelegationDeliverySchema = z.discriminatedUnion("status", [
  z.strictObject({ resultMessageId: MessageIdSchema, status: z.literal("delivered") }),
  z.strictObject({
    reason: z.string().trim().min(1).max(500),
    status: z.literal("undeliverable"),
  }),
]);
export type DelegationDelivery = z.infer<typeof DelegationDeliverySchema>;
const DelegationDeliveryViewSchema = z.discriminatedUnion("status", [
  z.object(DelegationDeliverySchema.options[0].shape),
  z.object(DelegationDeliverySchema.options[1].shape),
]);

const toolStartedRunnerData = z.object({
  arguments: z.unknown(),
  callId: z.string().min(1),
  /** The subagent that called the tool; absent for the Run's own agent. */
  nodeId: ExecutionNodeIdSchema.optional(),
  tool: ToolIdentitySchema,
});

export const executionNodePromptMaxBytes = 8 * 1_024;
export const executionNodeResultMaxBytes = 16 * 1_024;
const executionNodeTitle = z.string().trim().min(1).max(240);
const executionNodeModel = z.string().min(1).max(255);
const executionNodeRef = z.string().min(1).max(255);

/** A subagent the engine started, or a background task such as a shell it left running. */
export const ExecutionNodeKindSchema = z.enum(["subagent", "task"]);
export type ExecutionNodeKind = z.infer<typeof ExecutionNodeKindSchema>;

/** How a subagent ended: by finishing, by failing, or by being stopped with its Run. */
export const ExecutionNodeOutcomeSchema = z.enum(["completed", "failed", "interrupted"]);
export type ExecutionNodeOutcome = z.infer<typeof ExecutionNodeOutcomeSchema>;

const placeSiteSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.origin !== "null" && url.origin === value;
    } catch {
      return false;
    }
  }, "Site must be an origin");

const eventDataSchemas = {
  "place.entered": z.strictObject({
    place: PlaceIdentitySchema,
    title: z.string().max(256),
    site: placeSiteSchema.nullable(),
  }),
  "assignment.created": z.strictObject({ assignment: AssignmentSummarySchema }),
  "assignment.updated": z.strictObject({ assignment: AssignmentSummarySchema }),
  "request.cancelled": z.strictObject({
    reason: RequestCancellationReasonSchema,
    requestId: RequestIdSchema,
  }),
  "request.opened": z.strictObject({ request: PendingRequestSchema }),
  "request.updated": z.strictObject({ request: PendingRequestSchema }),
  "request.resolved": z.strictObject({ request: ResolvedRequestEventSchema }),
  "assistant.message": z.object({
    content: MessageContentSchema,
    messageId: MessageIdSchema,
  }),
  "delegation.settled": z.strictObject({
    childRunId: RunIdSchema,
    childThread: z.strictObject({
      id: ThreadIdSchema,
      title: z.string().trim().min(1).max(240),
      workspaceId: WorkspaceIdSchema,
    }),
    delegationId: DelegationIdSchema,
    delivery: DelegationDeliverySchema,
    failure: RunFailureSchema.nullable(),
    outcome: DelegationOutcomeSchema,
    resultPreview: boundedUtf8Text(delegationResultPreviewMaxBytes).nullable(),
    taskPreview: boundedUtf8Text(delegationTaskPreviewMaxBytes),
  }),
  "message.created": z.object({
    input: ThreadInputSchema.nullable(),
    message: MessageSchema,
    addressedToUserId: UserIdSchema.optional(),
  }),
  "message.injected": z.object({
    messageId: MessageIdSchema,
  }),
  /**
   * A queued Message joined the conversation where a Run took it, after
   * everything the Thread said while it waited, rather than where it was sent.
   */
  "message.placed": z.object({
    message: MessageSchema,
  }),
  "reasoning.completed": z.object({
    blockId: z.string().min(1).max(255),
    text: z.string().max(300_000),
  }),
  "run.queued": z.object({
    run: ThreadRunQueueEntrySchema,
  }),
  "thread.created": z.object({
    thread: ThreadSchema,
    home: z.literal(true).optional(),
  }),
  "thread.execution-updated": z.object({ thread: ThreadSchema }),
  /**
   * A conversation gave an unlisted Thread work of its own, so it is now one
   * of its person's tasks. It carries the whole Thread because a client that
   * listed only tasks has never held it.
   */
  "thread.listed": z.object({ thread: ThreadSchema }),
  "thread-input.updated": z.object({ input: ThreadInputSchema }),
  "thread.input-queue-updated": z.strictObject({ paused: z.boolean() }),
  /**
   * A Thread's absolute list state at this sequence. `title` is its title then;
   * the Host includes it on every state change it writes, and a title change is
   * written as one of these so readers that predate titles changing still parse
   * it. Absent on events written before titles could change. `icon` is its
   * symbol then, carried the same way; absent before symbols existed. `doneAt`
   * is when it was marked Done, or null while open; absent before Done existed.
   */
  "thread.state-changed": z.strictObject({
    status: ThreadStatusSchema,
    inputQueuePaused: z.boolean(),
    pendingRequests: z.number().int().nonnegative(),
    title: ThreadTitleSchema.optional(),
    icon: WorkspaceIconNameSchema.nullable().optional(),
    doneAt: IsoDateTimeSchema.nullable().optional(),
  }),
  "thread.continuation-established": z.strictObject({
    continuationIdentity: ProviderContinuationIdentitySchema,
  }),
  "thread.access-mode-updated": z.strictObject({
    accessMode: ThreadAccessModeSchema,
  }),
  /**
   * `replyMessageId` is the Run's reply: the last message its agent wrote that
   * says something, which every engine ends a successful turn with. The Host records it when
   * it commits the Runner's event, and it is what the person who asked is
   * shown, what a channel sends and what an Assignment returns.
   */
  "run.completed": z.object({
    startedAt: z.iso.datetime(),
    personWaiting: z.boolean(),
    startedBy: MessageAuthorSchema,
    replyMessageId: MessageIdSchema.nullable(),
    status: z.literal("completed"),
  }),
  "run.failed": RunFailureSchema.extend({
    startedAt: z.iso.datetime(),
    personWaiting: z.boolean(),
    startedBy: MessageAuthorSchema,
  }),
  "run.interrupted": z.object({
    startedAt: z.iso.datetime(),
    personWaiting: z.boolean(),
    startedBy: MessageAuthorSchema,
    cause: z.enum(["lease-lost"]).optional(),
    status: z.literal("interrupted"),
  }),
  /**
   * A steering restart or execution recovery continues the same Run and
   * native conversation: attempt `attempt` takes over. Written by the Host.
   */
  "run.restarted": z.object({
    startedAt: z.iso.datetime(),
    personWaiting: z.boolean(),
    startedBy: MessageAuthorSchema,
    attempt: z.number().int().min(2),
    /**
     * What the attempts it replaced consumed, as their engines stated it. The
     * next attempt's own `run.usage` adds to it; absent when none stated any.
     */
    priorUsage: RunUsageSchema.optional(),
    reason: z.enum(["steer", "recovery"]),
  }),
  "run.started": z.object({
    startedAt: z.iso.datetime(),
    personWaiting: z.boolean(),
    startedBy: MessageAuthorSchema,
    status: z.literal("running"),
  }),
  "run.status": z.object({
    startedAt: z.iso.datetime(),
    personWaiting: z.boolean(),
    startedBy: MessageAuthorSchema,
    status: RunStatusSchema,
  }),
  /**
   * What this Run consumed, stated once by the engine that ran it and always
   * before the Run's terminal event. It is this Run's own share, never a
   * session running total, and it is absent entirely from engines whose
   * protocol does not report per-turn usage.
   */
  "run.usage": RunUsageSchema,
  /**
   * The engine finished a turn while work it started in the background is
   * still running (`background`), or began another turn in the same Run
   * (`turn`): a wake-up when that work finished, or a message steered in.
   * On `background`, `replyMessageId` is the reply that turn ended with, read
   * the way a completed Run's is and written by the Host.
   */
  "run.phase": z.strictObject({
    startedAt: z.iso.datetime(),
    personWaiting: z.boolean(),
    startedBy: MessageAuthorSchema,
    phase: z.enum(["turn", "background"]),
    replyMessageId: MessageIdSchema.nullable().optional(),
  }),
  "tool.completed": z.object({
    callId: z.string().min(1),
    isError: z.boolean(),
    nodeId: ExecutionNodeIdSchema.optional(),
    output: ToolOutputSchema,
  }),
  "tool.started": toolStartedRunnerData.extend({
    integration: IntegrationCallSubjectSchema.optional(),
  }),
  /**
   * A subagent the Run's engine started: one invocation, under the Run's
   * current attempt and authority. Its tools and questions name it; its own
   * text is not a message of the Thread, and what it returned arrives with
   * `node.completed`. A resumed child session is a new node with the same
   * `sessionRef`.
   */
  "node.started": z.strictObject({
    /** A subagent, or a background task such as a shell left running. */
    kind: ExecutionNodeKindSchema,
    model: executionNodeModel.nullable(),
    nativeRef: executionNodeRef,
    nodeId: ExecutionNodeIdSchema,
    /** The tool call of the agent that started it, when the engine names one. */
    originCallId: z.string().min(1).max(255).nullable(),
    parentNodeId: ExecutionNodeIdSchema.nullable(),
    prompt: boundedUtf8Text(executionNodePromptMaxBytes).nullable(),
    sessionRef: executionNodeRef.nullable(),
    title: executionNodeTitle,
  }),
  /** What the engine said about a subagent after it was first seen. */
  "node.updated": z.strictObject({
    model: executionNodeModel.optional(),
    nodeId: ExecutionNodeIdSchema,
    /** The call that started it, when the engine names it only after the node was seen. */
    originCallId: z.string().min(1).max(255).optional(),
    prompt: boundedUtf8Text(executionNodePromptMaxBytes).optional(),
    title: executionNodeTitle.optional(),
  }),
  "node.completed": z.strictObject({
    nodeId: ExecutionNodeIdSchema,
    result: boundedUtf8Text(executionNodeResultMaxBytes).nullable(),
    status: ExecutionNodeOutcomeSchema,
    /** The subagent's own share, which the Run's usage already includes. */
    usage: RunUsageSchema.nullable(),
  }),
} as const;

/**
 * The event data a Runner reports. It is the durable shape less what only the
 * Host knows: an integration call's subject is resolved and written by the
 * Host when it commits the event, and a Runner's copy of it is dropped; which
 * message was a turn's or a completed Run's reply is read from the messages
 * the Host holds.
 */
// Place entries are exclusively Host-authored.
const { "place.entered": _hostPlaceEntered, ...runnerWritableEventDataSchemas } = eventDataSchemas;
const runnerEventDataSchemas = {
  ...runnerWritableEventDataSchemas,
  "run.completed": eventDataSchemas["run.completed"].omit({
    replyMessageId: true,
    startedAt: true,
    personWaiting: true,
    startedBy: true,
  }),
  "run.phase": eventDataSchemas["run.phase"].omit({
    replyMessageId: true,
    startedAt: true,
    personWaiting: true,
    startedBy: true,
  }),
  "run.started": eventDataSchemas["run.started"].omit({
    startedAt: true,
    personWaiting: true,
    startedBy: true,
  }),
  "run.status": eventDataSchemas["run.status"].omit({
    startedAt: true,
    personWaiting: true,
    startedBy: true,
  }),
  "run.restarted": eventDataSchemas["run.restarted"].omit({
    startedAt: true,
    personWaiting: true,
    startedBy: true,
  }),
  "run.failed": eventDataSchemas["run.failed"].omit({
    startedAt: true,
    personWaiting: true,
    startedBy: true,
  }),
  "run.interrupted": eventDataSchemas["run.interrupted"].omit({
    startedAt: true,
    personWaiting: true,
    startedBy: true,
  }),
  "tool.started": toolStartedRunnerData,
} as const;

const eventDataViewSchemas = {
  "place.entered": z.object({
    ...eventDataSchemas["place.entered"].shape,
    place: PlaceIdentityViewSchema,
  }),
  "assignment.created": z.object({ assignment: AssignmentSummarySchema }),
  "assignment.updated": z.object({ assignment: AssignmentSummarySchema }),
  "request.cancelled": z.object(eventDataSchemas["request.cancelled"].shape),
  "request.opened": z.object({ request: PendingRequestViewSchema }),
  "request.updated": z.object({ request: PendingRequestViewSchema }),
  "request.resolved": z.object({ request: ResolvedRequestEventViewSchema }),
  "assistant.message": eventDataSchemas["assistant.message"],
  "delegation.settled": z.object({
    ...eventDataSchemas["delegation.settled"].shape,
    childThread: z.object(eventDataSchemas["delegation.settled"].shape.childThread.shape),
    delivery: DelegationDeliveryViewSchema,
    failure: RunFailureViewSchema.nullable(),
  }),
  "message.created": z.object({
    input: ThreadInputViewSchema.nullable(),
    message: MessageViewSchema,
    addressedToUserId: UserIdSchema.optional(),
  }),
  "message.injected": eventDataSchemas["message.injected"],
  "message.placed": z.object({ message: MessageViewSchema }),
  "reasoning.completed": eventDataSchemas["reasoning.completed"],
  "run.queued": z.object({ run: ThreadRunQueueEntryViewSchema }),
  "thread.created": z.object({ thread: ThreadViewSchema, home: z.literal(true).optional() }),
  "thread.execution-updated": z.object({ thread: ThreadViewSchema }),
  "thread.listed": z.object({ thread: ThreadViewSchema }),
  "thread-input.updated": z.object({ input: ThreadInputViewSchema }),
  "thread.input-queue-updated": z.object(eventDataSchemas["thread.input-queue-updated"].shape),
  "thread.state-changed": z.object(eventDataSchemas["thread.state-changed"].shape),
  "thread.continuation-established": z.object({
    continuationIdentity: ProviderContinuationIdentityViewSchema,
  }),
  "thread.access-mode-updated": z.object(eventDataSchemas["thread.access-mode-updated"].shape),
  "run.completed": eventDataSchemas["run.completed"].extend({
    startedAt: z.iso.datetime().optional(),
    personWaiting: z.boolean().optional(),
    startedBy: MessageAuthorViewSchema.optional(),
  }),
  "run.failed": RunFailureViewSchema.extend({
    startedAt: z.iso.datetime().optional(),
    personWaiting: z.boolean().optional(),
    startedBy: MessageAuthorViewSchema.optional(),
  }),
  "run.interrupted": eventDataSchemas["run.interrupted"].extend({
    startedAt: z.iso.datetime().optional(),
    personWaiting: z.boolean().optional(),
    startedBy: MessageAuthorViewSchema.optional(),
  }),
  "run.restarted": z.object({
    ...eventDataSchemas["run.restarted"].shape,
    startedAt: z.iso.datetime().optional(),
    personWaiting: z.boolean().optional(),
    startedBy: MessageAuthorViewSchema.optional(),
    priorUsage: RunUsageViewSchema.optional(),
  }),
  "run.started": eventDataSchemas["run.started"].extend({
    startedAt: z.iso.datetime().optional(),
    personWaiting: z.boolean().optional(),
    startedBy: MessageAuthorViewSchema.optional(),
  }),
  "run.status": eventDataSchemas["run.status"].extend({
    startedAt: z.iso.datetime().optional(),
    personWaiting: z.boolean().optional(),
    startedBy: MessageAuthorViewSchema.optional(),
  }),
  "run.usage": RunUsageViewSchema,
  "run.phase": z.object({
    ...eventDataSchemas["run.phase"].shape,
    startedAt: z.iso.datetime().optional(),
    personWaiting: z.boolean().optional(),
    startedBy: MessageAuthorViewSchema.optional(),
  }),
  "node.started": z.object(eventDataSchemas["node.started"].shape),
  "node.updated": z.object(eventDataSchemas["node.updated"].shape),
  "node.completed": z.object({
    ...eventDataSchemas["node.completed"].shape,
    usage: RunUsageViewSchema.nullable(),
  }),
  "tool.completed": z.object({
    ...eventDataSchemas["tool.completed"].shape,
    output: ToolOutputViewSchema,
  }),
  "tool.started": z.object({
    ...eventDataSchemas["tool.started"].shape,
    integration: IntegrationCallSubjectViewSchema.optional(),
    tool: ToolIdentityViewSchema,
  }),
} as const;

export type AgentEventType = keyof typeof eventDataSchemas;

function makeEventVariant<T extends AgentEventType>(type: T) {
  return z.object({
    createdAt: IsoDateTimeSchema,
    data: eventDataSchemas[type],
    environmentId: EnvironmentIdSchema,
    eventId: EventIdSchema,
    runId: RunIdSchema.nullable(),
    sequence: SequenceSchema,
    threadId: ThreadIdSchema,
    type: z.literal(type),
    workspaceId: WorkspaceIdSchema,
  });
}

function makeEventViewVariant<T extends AgentEventType>(type: T) {
  return z.object({
    createdAt: IsoDateTimeSchema,
    data: eventDataViewSchemas[type],
    environmentId: EnvironmentIdSchema,
    eventId: EventIdSchema,
    runId: RunIdSchema.nullable(),
    sequence: SequenceSchema,
    threadId: ThreadIdSchema,
    type: z.literal(type),
    workspaceId: WorkspaceIdSchema,
  });
}

export const agentEventMaxSerializedBytes = 512 * 1_024;

export const AgentEventSchema = z
  .discriminatedUnion("type", [
    makeEventVariant("assignment.created"),
    makeEventVariant("assignment.updated"),
    makeEventVariant("request.cancelled"),
    makeEventVariant("request.opened"),
    makeEventVariant("request.updated"),
    makeEventVariant("request.resolved"),
    makeEventVariant("assistant.message"),
    makeEventVariant("delegation.settled"),
    makeEventVariant("message.created"),
    makeEventVariant("message.injected"),
    makeEventVariant("message.placed"),
    makeEventVariant("reasoning.completed"),
    makeEventVariant("run.queued"),
    makeEventVariant("run.completed"),
    makeEventVariant("run.failed"),
    makeEventVariant("run.interrupted"),
    makeEventVariant("run.restarted"),
    makeEventVariant("run.started"),
    makeEventVariant("run.status"),
    makeEventVariant("run.usage"),
    makeEventVariant("run.phase"),
    makeEventVariant("node.started"),
    makeEventVariant("node.updated"),
    makeEventVariant("node.completed"),
    makeEventVariant("tool.completed"),
    makeEventVariant("tool.started"),
    makeEventVariant("thread.created"),
    makeEventVariant("thread.execution-updated"),
    makeEventVariant("thread.listed"),
    makeEventVariant("thread-input.updated"),
    makeEventVariant("thread.input-queue-updated"),
    makeEventVariant("thread.state-changed"),
    makeEventVariant("thread.continuation-established"),
    makeEventVariant("thread.access-mode-updated"),
    makeEventVariant("place.entered").extend({ runId: RunIdSchema }),
  ])
  .refine(
    (event) =>
      new TextEncoder().encode(JSON.stringify(event)).byteLength <= agentEventMaxSerializedBytes,
    `Agent event must not exceed ${agentEventMaxSerializedBytes} serialized bytes`,
  );

export const AgentEventViewSchema = z
  .discriminatedUnion("type", [
    makeEventViewVariant("assignment.created"),
    makeEventViewVariant("assignment.updated"),
    makeEventViewVariant("request.cancelled"),
    makeEventViewVariant("request.opened"),
    makeEventViewVariant("request.updated"),
    makeEventViewVariant("request.resolved"),
    makeEventViewVariant("assistant.message"),
    makeEventViewVariant("delegation.settled"),
    makeEventViewVariant("message.created"),
    makeEventViewVariant("message.injected"),
    makeEventViewVariant("message.placed"),
    makeEventViewVariant("reasoning.completed"),
    makeEventViewVariant("run.queued"),
    makeEventViewVariant("run.completed"),
    makeEventViewVariant("run.failed"),
    makeEventViewVariant("run.interrupted"),
    makeEventViewVariant("run.restarted"),
    makeEventViewVariant("run.started"),
    makeEventViewVariant("run.status"),
    makeEventViewVariant("run.usage"),
    makeEventViewVariant("run.phase"),
    makeEventViewVariant("node.started"),
    makeEventViewVariant("node.updated"),
    makeEventViewVariant("node.completed"),
    makeEventViewVariant("tool.completed"),
    makeEventViewVariant("tool.started"),
    makeEventViewVariant("thread.created"),
    makeEventViewVariant("thread.execution-updated"),
    makeEventViewVariant("thread.listed"),
    makeEventViewVariant("thread-input.updated"),
    makeEventViewVariant("thread.input-queue-updated"),
    makeEventViewVariant("thread.state-changed"),
    makeEventViewVariant("thread.continuation-established"),
    makeEventViewVariant("thread.access-mode-updated"),
    makeEventViewVariant("place.entered").extend({ runId: RunIdSchema }),
  ])
  .refine(
    (event) =>
      new TextEncoder().encode(JSON.stringify(event)).byteLength <= agentEventMaxSerializedBytes,
    `Agent event must not exceed ${agentEventMaxSerializedBytes} serialized bytes`,
  );

export type AgentEventView = z.infer<typeof AgentEventViewSchema>;

export type AgentEvent = z.infer<typeof AgentEventSchema>;

export type EventData<T extends AgentEventType> = z.infer<(typeof eventDataSchemas)[T]>;

export type RunnerEventData<T extends keyof typeof runnerEventDataSchemas> = z.infer<
  (typeof runnerEventDataSchemas)[T]
>;

export { eventDataSchemas, runnerEventDataSchemas };
