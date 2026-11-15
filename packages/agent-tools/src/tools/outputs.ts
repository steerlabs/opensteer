import { TabIdSchema } from "@opensteer/core";
import { AppSchema, AppListItemSchema } from "@opensteer/core";
import {
  AgentBrowserSessionSummarySchema,
  ChromeCookiesResultSchema,
  SavedLoginResultSchema,
  UseCardResultSchema,
} from "@opensteer/protocol";
import { z } from "zod";
import {
  AppIdSchema,
  AssignmentIdSchema,
  AssignmentStatusSchema,
  BrowserProfileIdSchema,
  DelegationModelChoiceSchema,
  ExecutionNodeViewSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  MessageIdSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  ModelSelectionSchema,
  PlaceContentPartSchema,
  PlaceIdentitySchema,
  ProviderSessionIdSchema,
  RequestIdSchema,
  RequestKindSchema,
  RequestStatusSchema,
  RequestPresentationSchema,
  RequestAnswererViewSchema,
  MessageAuthorViewSchema,
  TriggerIdSchema,
  RunSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  TimeZoneSchema,
  PersonNameSchema,
  TriggerOccurrenceIdSchema,
  ThreadSchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import {
  TriggerProgramEventSchema,
  TriggerViewSchema,
  TriggerRevisionViewSchema,
  TriggerOccurrenceViewSchema,
  TriggerSummaryViewSchema,
  TriggerWatchActivationViewSchema,
} from "@opensteer/triggers";
import { AgentLinkSchema } from "./agent-links.js";
export { AgentLinkSchema } from "./agent-links.js";

const AiAccountModelOptionSchema = z.union([
  z.object({
    id: z.string().min(1).max(100),
    values: z.array(z.string().max(255)).min(1).max(32),
    default: z.string().max(255).optional(),
  }),
  z.object({
    id: z.string().min(1).max(100),
    values: z.tuple([z.literal(false), z.literal(true)]),
    default: z.boolean().optional(),
  }),
]);
export const AiAccountModelSchema = z.object({
  modelId: ModelIdSchema,
  providerId: ModelProviderIdSchema,
  displayName: z.string().min(1).max(120).optional(),
  options: z.array(AiAccountModelOptionSchema).min(1).max(16).optional(),
});
export type AiAccountModel = z.infer<typeof AiAccountModelSchema>;
export const AiAccountStatusSchema = z.enum([
  "disabled",
  "disconnected",
  "unreported",
  "ready",
  "authentication-required",
  "preparing",
  "unavailable",
  "error",
]);
export type AiAccountStatus = z.infer<typeof AiAccountStatusSchema>;
const AiAccountModelLimitsSchema = z.object({
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
});
const AiAccountSchema = z.object({
  aiAccountId: HarnessInstanceIdSchema,
  computerId: RunnerIdSchema,
  name: z.string().min(1).max(120),
  engine: HarnessIdSchema,
  enabled: z.boolean(),
  isDefault: z.boolean(),
  status: AiAccountStatusSchema,
  detail: z.string().min(1).max(500).optional(),
  lightModel: DelegationModelChoiceSchema.optional(),
  models: z.array(AiAccountModelSchema).max(8),
  modelsOmitted: z.number().int().nonnegative(),
  modelLimits: z.record(z.string(), AiAccountModelLimitsSchema).optional(),
});
const AiAccountModelChoiceSchema = z.object({
  modelId: ModelIdSchema,
  providerId: ModelProviderIdSchema,
  options: ModelSelectionSchema.shape.options,
});
export const AiAccountListOutputSchema = z.object({
  accounts: z
    .array(AiAccountSchema)
    .max(64)
    .refine((rows) => rows.reduce((count, row) => count + row.models.length, 0) <= 40),
  nextCursor: z.string().min(1).max(2_048).optional(),
  delegationDefault: z
    .object({ aiAccountId: HarnessInstanceIdSchema, model: AiAccountModelChoiceSchema })
    .optional(),
  accessCeiling: ThreadAccessModeSchema,
  limits: z.object({
    maxDepth: z.number().int().nullable(),
    remainingDepth: z.number().int().nonnegative().nullable(),
    maxTasks: z.number().int().nullable(),
    remainingTasks: z.number().int().nonnegative().nullable(),
    maxAutonomousRuns: z.number().int(),
    remainingAutonomousRuns: z.number().int().nonnegative().nullable(),
    maxWaitMs: z.number().int(),
    taskDeadlineAt: z.string().nullable(),
  }),
});
export type AiAccountListOutput = z.infer<typeof AiAccountListOutputSchema>;
export const DefaultsOutputSchema = z.object({
  accessMode: ThreadAccessModeSchema,
  selection: z
    .object({ aiAccountId: HarnessInstanceIdSchema, model: AiAccountModelChoiceSchema })
    .nullable(),
  timeZone: TimeZoneSchema.nullable(),
});
export const DefaultsReadOutputSchema = DefaultsOutputSchema.extend({
  /** Null until the person sets one in Settings → Account. */
  ownerName: PersonNameSchema.nullable(),
});
export const DefaultsUpdateOutputSchema = DefaultsOutputSchema.partial().extend({
  ok: z.literal(true),
});

export const WindowSchema = z.object({
  byteCount: z.number(),
  hasMore: z.boolean(),
  itemCount: z.number(),
  nextCursor: z.string().nullable(),
  totalItems: z.number(),
  taskId: ThreadIdSchema.optional(),
});
const task = ThreadSchema.shape;
const PageSchema = { hasMore: z.boolean(), nextCursor: z.string().nullable() };

export const ThreadDetailSchema = z.object({
  link: AgentLinkSchema.optional(),
  id: task.id,
  title: task.title,
  status: task.status,
  purpose: task.purpose,
  teamOrigin: task.teamOrigin,
  aiAccountId: task.harnessInstanceId,
  modelSelection: task.modelSelection,
  accessMode: task.accessMode,
  parentTaskId: task.parentThreadId,
  pendingRequests: task.pendingRequests,
  inputQueuePaused: task.inputQueuePaused,
  doneAt: task.doneAt,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});
export const ThreadSummarySchema = z.object({
  link: AgentLinkSchema.optional(),
  delegationId: AssignmentIdSchema.nullable(),
  doneAt: task.doneAt.optional(),
  id: ThreadIdSchema,
  parentTaskId: task.parentThreadId,
  pendingRequests: task.pendingRequests,
  status: task.status,
  taskStatus: AssignmentStatusSchema.nullable(),
  title: z.string().nullable(),
  updatedAt: task.updatedAt,
});
export const ThreadListOutputSchema = z.object({
  tasks: z.array(ThreadSummarySchema).max(50),
  ...PageSchema,
});
export const TaskSchema = z.object({
  link: AgentLinkSchema.optional(),
  delegationId: AssignmentIdSchema.nullable(),
  taskId: ThreadIdSchema,
  runId: RunSchema.shape.id.nullable(),
  runStatus: RunSchema.shape.status.nullable(),
  status: AssignmentStatusSchema,
  title: z.string(),
  objective: z.string().nullable(),
  result: z.string().nullable(),
  pendingRequests: task.pendingRequests,
  parentTaskId: ThreadIdSchema.nullable(),
  createdAt: task.createdAt,
  finishedAt: z.string().nullable(),
});
export const ThreadMessageOutputSchema = z.object({
  link: AgentLinkSchema.optional(),
  delegationId: AssignmentIdSchema.nullable(),
  disposition: z.enum(["cancelled", "pending", "steering", "run-queued"]),
  messageId: MessageIdSchema,
  runId: RunSchema.shape.id.nullable(),
});
export const ThreadInterruptOutputSchema = z.object({
  link: AgentLinkSchema.optional(),
  interruptedRunId: RunSchema.shape.id.nullable(),
});
export const ThreadUpdateOutputSchema = z.object({
  link: AgentLinkSchema.optional(),
  title: task.title,
  doneAt: task.doneAt,
  doneWhenRunEnds: z.boolean(),
});
export const LegacyAppPublishOutputSchema = z.object({
  appId: AppIdSchema,
  version: z.number().int(),
  message: z.string(),
});
export const LegacyAppListOutputSchema = z.object({
  apps: z.array(
    z.object({
      id: AppIdSchema,
      title: z.string(),
      kind: z.enum(["html", "server"]),
      folder: z.string().optional().describe("Server app folder: an absolute path in Agent home."),
      start: z.string().optional(),
      taskId: ThreadIdSchema,
      latestVersion: z.number(),
      updatedAt: z.string(),
    }),
  ),
});
export const AppFetchOutputSchema = z.object({
  status: z.number(),
  contentType: z.union([z.string(), z.array(z.string())]).optional(),
  body: z.string(),
  truncated: z.boolean(),
});
export const PluginInstallOutputSchema = z.object({
  pluginId: z.string().nullable(),
  issues: z
    .array(
      z.object({
        message: z.string().optional(),
        component: z.enum(["manifest", "mcp", "skill"]).optional(),
        entry: z.string().nullable().optional(),
        severity: z.string().optional(),
        code: z.string().optional(),
      }),
    )
    .optional(),
  specialist: z.boolean().optional(),
  registration: z
    .object({ id: z.string(), status: z.string(), plugin: z.string() })
    .nullable()
    .optional(),
});
export const PersonMessageOutputSchema = z.object({
  messageId: MessageIdSchema,
  link: AgentLinkSchema.optional(),
});
export const PersonShowOutputSchema = z.object({
  status: z.enum(["sent-unconfirmed", "no-device-connected", "already-requested"]),
  connectedDevices: z.number().int().nonnegative(),
});
const [
  humanAuthor,
  agentAuthor,
  triggerAuthor,
  watchAuthor,
  platformAuthor,
  connectionAuthor,
  memberAuthor,
] = MessageAuthorViewSchema.options;
/** Authors as tools present them: an agent names its task, an automation or watch its automation. */
const ToolMessageAuthorSchema = z.discriminatedUnion("kind", [
  humanAuthor,
  agentAuthor.omit({ threadId: true }).extend({ taskId: ThreadIdSchema }),
  triggerAuthor.omit({ triggerId: true }).extend({ automationId: TriggerIdSchema }),
  watchAuthor.omit({ triggerId: true }).extend({ automationId: TriggerIdSchema }),
  platformAuthor,
  connectionAuthor,
  memberAuthor,
]);
const [deviceAnswerer, agentAnswerer] = RequestAnswererViewSchema.options;
const ToolRequestAnswererSchema = z.union([
  deviceAnswerer,
  agentAnswerer.omit({ threadId: true }).extend({ taskId: ThreadIdSchema }),
]);
type ToolMessageAuthor = z.infer<typeof ToolMessageAuthorSchema>;
export function toolMessageAuthor(
  author: z.infer<typeof MessageAuthorViewSchema>,
): ToolMessageAuthor {
  if (author.kind === "agent") {
    const { threadId, ...rest } = author;
    return { ...rest, taskId: threadId };
  }
  if (author.kind === "trigger" || author.kind === "watch") {
    const { triggerId, ...rest } = author;
    return { ...rest, automationId: triggerId };
  }
  return author;
}
export function toolRequestAnswerer(
  answerer: z.infer<typeof RequestAnswererViewSchema>,
): z.infer<typeof ToolRequestAnswererSchema> {
  if (!("kind" in answerer)) return answerer;
  const { threadId, ...rest } = answerer;
  return { ...rest, taskId: threadId };
}
export const RequestOutputSchema = z.object({
  link: AgentLinkSchema.optional(),
  id: RequestIdSchema,
  kind: RequestKindSchema,
  status: RequestStatusSchema,
  reason: z.string().nullable().optional(),
  originatingTaskId: ThreadIdSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  title: z.string().optional(),
  revision: z.string().optional(),
  presentation: RequestPresentationSchema.optional(),
  settlementProvenance: ToolRequestAnswererSchema.nullable().optional(),
});
export const RequestListOutputSchema = z.object({
  requests: z.array(RequestOutputSchema),
  window: WindowSchema,
});
export const RequestWithdrawOutputSchema = z.object({ request: RequestOutputSchema });
export const RequestCreationOutputSchema = z.object({
  link: AgentLinkSchema.optional(),
  kind: RequestKindSchema,
  replayed: z.boolean(),
  requestId: RequestIdSchema,
  status: RequestStatusSchema,
});
export const BrowserProfileOutputSchema = z.object({
  id: BrowserProfileIdSchema,
  name: z.string(),
  home: z
    .object({ computerId: RunnerIdSchema, name: z.string(), reachable: z.boolean() })
    .nullable(),
});
export const BrowserProfileListOutputSchema = z.object({
  profiles: z.array(BrowserProfileOutputSchema),
  sites: z.array(z.object({ site: z.string() })),
});
/** A held or pending Request's result also carries what the Host says about it. */
const heldGuidance = { guidance: z.string().optional() };
const [copied, chromePending, chromeDeclined, chromeUnavailable] =
  ChromeCookiesResultSchema.options;
export const CopyChromeCookiesOutputSchema = z.discriminatedUnion("status", [
  copied.extend(heldGuidance),
  chromePending.extend({ ...heldGuidance, link: AgentLinkSchema.optional() }),
  chromeDeclined.extend({ ...heldGuidance, link: AgentLinkSchema.optional() }),
  chromeUnavailable.extend(heldGuidance),
]);
const [ready, savedPending, savedDeclined, savedUnavailable] = SavedLoginResultSchema.options;
export const UseSavedLoginOutputSchema = z.discriminatedUnion("status", [
  ready.extend(heldGuidance),
  savedPending.extend({ ...heldGuidance, link: AgentLinkSchema.optional() }),
  savedDeclined.extend({ ...heldGuidance, link: AgentLinkSchema.optional() }),
  savedUnavailable.extend(heldGuidance),
]);
export const BrowserSessionSchema = AgentBrowserSessionSummarySchema;
export const BrowserSessionListOutputSchema = z.object({ sessions: z.array(BrowserSessionSchema) });
export const BrowserSessionOpenOutputSchema = z.object({
  session: BrowserSessionSchema,
  wasExisting: z.boolean(),
});
export const BrowserSessionCloseOutputSchema = z.object({
  closed: z.boolean(),
  sessionId: z.string().nullable(),
});
export const BrowserTabReadOutputSchema = z.object({
  totalMatches: z.number().optional(),
  groups: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      color: z.string(),
      collapsed: z.boolean(),
      createdBy: z.string(),
      tabCount: z.number(),
    }),
  ),
  tabs: z.array(
    z.object({
      tabId: z.string(),
      title: z.string(),
      matchedFields: z.array(z.string()).optional(),
      site: z.string(),
      state: z.string(),
      sessionId: z.string().nullable(),
      profileId: BrowserProfileIdSchema.nullable(),
      groupId: z.string().nullable(),
      position: z.number().optional(),
      usedByThisTask: z.boolean(),
      usedByOtherTask: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const BrowserTabWriteOutputSchema = z.object({
  action: z.string(),
  groupId: z.string().optional(),
  closed: z.array(z.string()).optional(),
  failed: z.array(z.object({ tabId: z.string(), message: z.string() })).optional(),
  restored: z.array(z.object({ tabId: z.string(), sessionId: z.string() })).optional(),
});
export const SafeTriggerSchema = TriggerViewSchema.omit({
  webhookRouteKey: true,
  anchorThreadId: true,
  createdByThreadId: true,
}).extend({
  link: AgentLinkSchema.optional(),
  taskId: ThreadIdSchema,
  createdByTaskId: ThreadIdSchema.nullable(),
});
const AutomationRevisionSchema = TriggerRevisionViewSchema.omit({
  triggerId: true,
  createdByThreadId: true,
}).extend({ automationId: TriggerViewSchema.shape.id, createdByTaskId: ThreadIdSchema.nullable() });
const AutomationOccurrenceSchema = TriggerOccurrenceViewSchema.omit({
  triggerId: true,
  environmentId: true,
  event: true,
}).extend({
  event: z.object(TriggerProgramEventSchema.omit({ trigger: true }).shape).extend({
    automation: z
      .object(TriggerProgramEventSchema.shape.trigger.omit({ anchorThreadId: true }).shape)
      .extend({ taskId: ThreadIdSchema }),
  }),
  automationId: TriggerViewSchema.shape.id,
});
const AutomationWatchSchema = TriggerWatchActivationViewSchema.omit({
  triggerId: true,
  environmentId: true,
  anchorThreadId: true,
}).extend({
  taskId: ThreadIdSchema,
  automationId: TriggerViewSchema.shape.id,
});
export const AutomationSummarySchema = TriggerSummaryViewSchema.omit({
  webhookRouteKey: true,
  anchorThreadId: true,
  anchorThreadTitle: true,
  createdByThreadId: true,
}).extend({
  taskId: ThreadIdSchema,
  taskTitle: z.string(),
  link: AgentLinkSchema.optional(),
  createdByTaskId: ThreadIdSchema.nullable(),
});
export const TriggerOutputSchema = z.object({
  automation: SafeTriggerSchema.optional(),
  revision: AutomationRevisionSchema.optional(),
  automations: z.array(AutomationSummarySchema).optional(),
  occurrences: z.array(AutomationOccurrenceSchema).optional(),
  occurrence: AutomationOccurrenceSchema.optional(),
  watch: AutomationWatchSchema.nullable().optional(),
  canceledOccurrenceIds: z.array(TriggerOccurrenceIdSchema).optional(),
  activation: AutomationWatchSchema.nullable().optional(),
  taskTitle: z.string().optional(),
  createdByTaskTitle: z.string().nullable().optional(),
  downstreamRuns: z
    .array(
      z.object({
        occurrenceId: TriggerOccurrenceIdSchema,
        run: z
          .object(
            RunSchema.omit({
              environmentId: true,
              harnessInstanceId: true,
              assignmentId: true,
              threadId: true,
              replyTarget: true,
            }).shape,
          )
          .extend({
            link: AgentLinkSchema.optional(),
            taskId: ThreadIdSchema,
            aiAccountId: HarnessInstanceIdSchema,
            delegationId: AssignmentIdSchema.nullable(),
          }),
        taskTitle: z.string(),
      }),
    )
    .max(100)
    .optional(),
  downstreamRunsTruncated: z.boolean().optional(),
  replayed: z.boolean().optional(),
});

export const TriggerWriteOutputSchema = TriggerOutputSchema.extend({
  webhook: z.object({ url: z.url(), secret: z.string().min(1) }).optional(),
});

export { AgentMediaContentSchema, IntegrationCallOutputSchema } from "./integration-outputs.js";

/** A timeline entry. `itemId` is a message ID, or an activity event's sequence. */
export const ThreadItemSchema = z.object({
  link: AgentLinkSchema.optional(),
  itemId: z.string(),
  type: z.string(),
  status: z.string(),
  runId: RunSchema.shape.id.nullable(),
  author: ToolMessageAuthorSchema.optional(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  nextTextOffset: z.number().int().nonnegative().nullable(),
  places: z.array(PlaceContentPartSchema).max(64).optional(),
  createdAt: z.string(),
});
export type ThreadItem = z.infer<typeof ThreadItemSchema>;

export const ThreadWaitOutputSchema = z.object({
  status: z.enum(["running", "settled", "offline", "timed_out"]),
  pendingRequest: z
    .object({ id: z.string(), kind: z.string(), link: AgentLinkSchema.optional() })
    .optional(),
  run: z
    .object({
      id: RunSchema.shape.id,
      status: RunSchema.shape.status,
      link: AgentLinkSchema.optional(),
    })
    .optional(),
  items: z.array(ThreadItemSchema).max(100),
  hasMore: z.boolean(),
  task: TaskSchema.optional(),
});
export const ThreadConfigureOutputSchema = z.object({
  link: AgentLinkSchema.optional(),
  taskId: ThreadIdSchema,
  aiAccountId: HarnessInstanceIdSchema,
  modelSelection: z.object({
    modelId: ModelIdSchema,
    providerId: ModelProviderIdSchema,
    options: ModelSelectionSchema.shape.options,
  }),
  providerSessionId: ProviderSessionIdSchema.nullable(),
});
export const ThreadQueueOutputSchema = z.object({
  link: AgentLinkSchema.optional(),
  paused: z.boolean(),
  items: z
    .array(
      z.object({
        link: AgentLinkSchema.optional(),
        messageId: MessageIdSchema,
        author: ToolMessageAuthorSchema,
        preview: z.string().max(500),
        truncated: z.boolean(),
        canCancel: z.boolean(),
        canMove: z.boolean(),
        canSteer: z.boolean(),
      }),
    )
    .max(100),
});

export const SubagentCancelOutputSchema = z.object({
  subagentId: ExecutionNodeViewSchema.shape.id,
  status: z.literal("stopping"),
});

export const LegacyThreadReadOutputSchema = z
  .object({
    subagent: ExecutionNodeViewSchema.optional(),
    task: ThreadDetailSchema,
    recentRuns: z
      .array(
        z.object({
          link: AgentLinkSchema.optional(),
          runId: RunSchema.shape.id,
          status: RunSchema.shape.status,
          delegationId: AssignmentIdSchema.nullable(),
          modelId: ModelIdSchema,
          createdAt: z.string(),
          startedAt: z.string().nullable(),
          completedAt: z.string().nullable(),
        }),
      )
      .max(50),
    recentPlaces: z
      .array(
        z.object({
          runId: RunSchema.shape.id,
          place: PlaceIdentitySchema,
          title: z.string(),
          site: z.string().nullable(),
        }),
      )
      .max(10),
    items: z.array(ThreadItemSchema).max(100),
    ...PageSchema,
  })
  .refine(
    (result) => new TextEncoder().encode(JSON.stringify(result)).byteLength <= 432 * 1024,
    "Task history exceeds the agent output byte limit",
  );

const [cardReady, cardPending, cardResolved, cardUnavailable] = UseCardResultSchema.options;
export const UseCardOutputSchema = z.discriminatedUnion("status", [
  cardReady,
  cardPending.extend({ link: AgentLinkSchema.optional() }),
  cardResolved,
  cardUnavailable,
]);
export type UseCardOutput = z.infer<typeof UseCardOutputSchema>;

export const AppPublishOutputSchema = z.object({
  appId: AppIdSchema,
  version: z.number().int().positive(),
});
export const AppListOutputSchema = z.object({ apps: z.array(AppListItemSchema).max(500) });
export const AppLifecycleOutputSchema = z.object({ app: z.object(AppSchema.shape) });
export const AppDeleteOutputSchema = z.object({ appId: AppIdSchema, deleted: z.literal(true) });

export const ThreadReadOutputSchema = z
  .object({
    ...LegacyThreadReadOutputSchema.shape,
    recentPlaces: z
      .array(
        z.object({
          runId: RunSchema.shape.id,
          tabId: TabIdSchema,
          title: z.string().max(1024),
          site: z.string().nullable(),
        }),
      )
      .max(10),
  })
  .refine(
    (result) => new TextEncoder().encode(JSON.stringify(result)).byteLength <= 432 * 1024,
    "Task history exceeds the agent output byte limit",
  );
