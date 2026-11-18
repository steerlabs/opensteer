import {
  opensteer_task_read,
  opensteer_task_list,
  opensteer_task_delegate,
  opensteer_task_update,
  opensteer_task_interrupt,
  opensteer_delegation_cancel,
  computer_access_request,
} from "@opensteer/agent-tools/tools";
import {
  ThreadReadOutputSchema,
  ThreadListOutputSchema,
  TaskSchema,
  ThreadMessageOutputSchema,
  ThreadUpdateOutputSchema,
  ThreadInterruptOutputSchema,
} from "@opensteer/agent-tools/outputs";
import type { AgentTriggerManager } from "./handlers/triggers.js";
import { ThreadService } from "../threads/thread-service.js";
import {
  createId,
  OpensteerError,
  AssignmentIdSchema,
  BrowserProfileIdSchema,
  EnvironmentIdSchema,
  MessageContentSchema,
  MessageIdSchema,
  PersonMessageSchema,
  PersonShowTargetSchema,
  RequestIdSchema,
  RunIdSchema,
  RequestKindSchema,
  RequestViewSchema,
  RequestStatusSchema,
  ThreadIdSchema,
  ThreadInputPolicySchema,
  readableRequestList,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import { TriggerControlInputSchema } from "@opensteer/triggers";
import { z } from "zod";
import { AgentBrowserSessionSummarySchema, BrowserSessionIdSchema } from "@opensteer/protocol";
import { DurableWindowCursorSchema, DurableWindowSchema } from "@opensteer/protocol";
import { agentToolPayloadMaxSerializedBytes } from "@opensteer/protocol";

const AgentDurableWindowSchema = z.strictObject(DurableWindowSchema.shape);
const AgentBrowserSessionSummaryStrictSchema = z.strictObject({
  ...AgentBrowserSessionSummarySchema.shape,
  placement: z.strictObject(AgentBrowserSessionSummarySchema.shape.placement.shape),
});

const requestBase = {
  requestId: z.uuid(),
} as const;
const ProductToolRequestUnionSchema = z.discriminatedUnion("type", [
  opensteer_task_read.input.safeExtend({ ...requestBase, type: z.literal("thread.read") }),
  opensteer_task_list.input.safeExtend({ ...requestBase, type: z.literal("thread.list") }),
  opensteer_task_delegate.input.safeExtend({ ...requestBase, type: z.literal("thread.delegate") }),
  opensteer_delegation_cancel.input.safeExtend({ ...requestBase, type: z.literal("task.cancel") }),
  z.strictObject({
    ...requestBase,
    content: MessageContentSchema,
    delivery: ThreadInputPolicySchema,
    observationId: z.string().trim().min(1).max(255).optional(),
    threadId: ThreadIdSchema,
    type: z.literal("thread.message"),
  }),
  z.strictObject({
    type: z.literal("person.message"),
    requestId: z.uuid(),
    message: PersonMessageSchema,
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("person.show"),
    target: PersonShowTargetSchema,
  }),
  z.strictObject({
    ...requestBase,
    input: opensteer_task_update.input,
    type: z.literal("thread.update"),
  }),
  z.strictObject({
    ...requestBase,
    input: opensteer_task_interrupt.input,
    type: z.literal("thread.interrupt"),
  }),
  z.strictObject({
    ...requestBase,
    before: DurableWindowCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    type: z.literal("request.list"),
  }),
  z.strictObject({
    ...requestBase,
    targetRequestId: RequestIdSchema,
    type: z.literal("request.withdraw"),
  }),
  computer_access_request.input.safeExtend({
    ...requestBase,
    type: z.literal("computer.access.request"),
  }),

  z.strictObject({ ...requestBase, type: z.literal("browser.session.list") }),
  z.strictObject({
    ...requestBase,
    environmentId: EnvironmentIdSchema.optional(),
    fresh: z.literal(true).optional(),
    profileId: BrowserProfileIdSchema.optional(),
    sessionId: BrowserSessionIdSchema.optional(),
    type: z.literal("browser.session.open"),
  }),
  z.strictObject({
    ...requestBase,
    sessionId: BrowserSessionIdSchema,
    type: z.literal("browser.session.close"),
  }),
  z.strictObject({
    ...requestBase,
    input: TriggerControlInputSchema,
    // The Host admits, authorizes, and derives idempotency per originating tool.
    tool: z.enum(["trigger.read", "trigger.write"]),
    type: z.literal("trigger.control"),
  }),
]);
export const ProductToolRequestSchema = ProductToolRequestUnionSchema.refine(
  (request) =>
    request.type !== "browser.session.open" ||
    [request.fresh, request.profileId, request.sessionId].filter(Boolean).length === 1,
  "Choose exactly one of an existing session to attach, a granted browser profile, or a fresh session",
)

  .refine(
    (request) =>
      new TextEncoder().encode(JSON.stringify(request)).byteLength <=
      agentToolPayloadMaxSerializedBytes,
    `Agent control request must not exceed ${agentToolPayloadMaxSerializedBytes} serialized bytes`,
  );

const responseBase = {
  requestId: z.uuid(),
} as const;

const RequestCreationResultSchema = z.strictObject({
  kind: RequestKindSchema,
  replayed: z.boolean(),
  requestId: RequestIdSchema,
  status: RequestStatusSchema,
});

const ProductToolResultUnionSchema = z.discriminatedUnion("type", [
  ThreadReadOutputSchema.safeExtend({
    ...responseBase,
    type: z.literal("thread.read.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: TaskSchema.extend({ delegationId: AssignmentIdSchema, runId: RunIdSchema }),
    type: z.literal("thread.delegate.result"),
  }),
  TaskSchema.safeExtend({ ...responseBase, type: z.literal("task.cancel.result") }),
  ThreadListOutputSchema.safeExtend({ ...responseBase, type: z.literal("thread.list.result") }),
  z.strictObject({
    ...responseBase,
    result: ThreadMessageOutputSchema,
    type: z.literal("thread.message.result"),
  }),
  z.strictObject({
    type: z.literal("person.message.result"),
    requestId: z.uuid(),
    messageId: MessageIdSchema,
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("person.show.result"),
    status: z.enum(["sent-unconfirmed", "no-device-connected", "already-requested"]),
    connectedDevices: z.number().int().nonnegative(),
  }),
  ThreadUpdateOutputSchema.safeExtend({ ...responseBase, type: z.literal("thread.update.result") }),
  ThreadInterruptOutputSchema.safeExtend({
    ...responseBase,
    type: z.literal("thread.interrupt.result"),
  }),
  z.strictObject({
    ...responseBase,
    requests: readableRequestList(RequestViewSchema, 100),
    type: z.literal("request.list.result"),
    window: AgentDurableWindowSchema,
  }),
  z.strictObject({
    ...responseBase,
    request: RequestViewSchema,
    type: z.literal("request.withdraw.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: RequestCreationResultSchema,
    type: z.literal("computer.access.request.result"),
  }),
  z.strictObject({
    ...responseBase,
    session: AgentBrowserSessionSummaryStrictSchema,
    type: z.literal("browser.session.open.result"),
    wasExisting: z.boolean(),
  }),
  z.strictObject({
    ...responseBase,
    sessions: z.array(AgentBrowserSessionSummaryStrictSchema).max(100),
    type: z.literal("browser.session.list.result"),
  }),

  z.strictObject({
    ...responseBase,
    sessionId: BrowserSessionIdSchema.nullable(),
    type: z.literal("browser.session.close.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: z.unknown(),
    type: z.literal("trigger.control.result"),
  }),
]);
const productToolResultMaxSerializedBytes = agentToolPayloadMaxSerializedBytes;
export const ProductToolResultSchema = ProductToolResultUnionSchema.refine(
  (response) =>
    new TextEncoder().encode(JSON.stringify(response)).byteLength <=
    productToolResultMaxSerializedBytes,
  `Product tool result must not exceed ${productToolResultMaxSerializedBytes} serialized bytes`,
);
export type ProductToolResult = z.infer<typeof ProductToolResultSchema>;

import { ProductToolHandlers } from "./handlers/product.js";
import { TriggerToolHandlers } from "./handlers/triggers.js";
import { agentToolHandlers } from "./handlers/index.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { AgentCallerResolver } from "./agent-caller.js";
import type { RunToolTokenService } from "../agents/run-tool-tokens.js";
import type { TriggerControlTokenService } from "../triggers/trigger-control-service.js";
import type { WatchControlTokenService } from "../triggers/watch-capability.js";
type ProductOptions = ConstructorParameters<typeof ProductToolHandlers>[0];
type TestOptions = Partial<ProductOptions> & {
  readonly store: ProductOptions["store"];
  readonly tokens: Pick<
    RunToolTokenService | TriggerControlTokenService | WatchControlTokenService,
    "authenticate"
  >;
  readonly triggers?: AgentTriggerManager;
};
export class ProductToolsTestClient {
  readonly options: TestOptions;
  readonly service: OpensteerMcpService;
  constructor(options: TestOptions, kind: "run" | "trigger" | "watch" = "run") {
    this.options = options;
    const unavailableDefaults = new Proxy(
      {},
      {
        get: (_target, name) =>
          name === "readablePlaces"
            ? async (_ownerId: unknown, references: unknown) => references
            : async () => {
                throw new Error("Unexpected dependency");
              },
      },
    );
    const defaultCommands = {
      withInputAdmission: async <T>(_owner: unknown, _key: unknown, invoke: () => Promise<T>) =>
        invoke(),
    };
    const commands = options.commands?.withInputAdmission
      ? options.commands
      : (new Proxy(options.commands ?? {}, {
          get: (target, key) => {
            if (key === "withInputAdmission") return defaultCommands.withInputAdmission;
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as ProductOptions["commands"]);
    const product = new ProductToolHandlers({
      deploymentId: createId("deployment"),
      threads: new ThreadService({
        store: options.store,
        commands,
        runners: {
          canRunHarness: () => true,
          isAvailable: () => true,
          harnessAccessModes: () => undefined,
          identityForEnvironment: () => undefined,
          attachmentInputFailure: () => null,
        },
        placeContext: unavailableDefaults as never,
        browser: unavailableDefaults as never,
      }),
      realtime: {
        observeScopes: () => () => false,
        observe: () => () => {},
        sendToUsers: () => {},
      },
      browser: unavailableDefaults as never,
      browserSources: unavailableDefaults as never,
      savedLogins: unavailableDefaults as never,
      deviceAccess: unavailableDefaults as never,
      machineFullDiskAccess: unavailableDefaults as never,
      canRunHarness: () => true,
      harnessAccessModes: () => ThreadAccessModeSchema.options,
      isEnvironmentConnected: () => true,
      execution: unavailableDefaults as never,
      ...options,
      commands,
    });
    const unavailable = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error("Unexpected tool");
        },
      },
    );
    const handlers = agentToolHandlers({
      tabs: unavailable as never,
      administration: new Proxy(
        {},
        {
          get: () => {
            throw new Error("Unexpected administration tool");
          },
        },
      ) as never,
      product,
      integrations: unavailable as never,
      apps: unavailable as never,
      triggers: new TriggerToolHandlers(options.triggers ?? (unavailable as AgentTriggerManager)),
      teamRequestForRun: async () => null,
      personalContextForRun: async () => true,
      pluginInstall: async () => {
        throw new Error("Unexpected install");
      },
    });
    this.service = new OpensteerMcpService({
      store: options.store,
      callers: new AgentCallerResolver({
        store: options.store,
        runs:
          kind === "run"
            ? (options.tokens as RunToolTokenService)
            : {
                authenticate: async () => {
                  throw new Error("Not a Run");
                },
              },
        ...(kind === "trigger" ? { triggers: options.tokens as TriggerControlTokenService } : {}),
        ...(kind === "watch" ? { watches: options.tokens as WatchControlTokenService } : {}),
      }),
      handlers,
      publicUrl: new URL("https://host.test"),
    });
  }
  async handle(token: string, value: unknown): Promise<ProductToolResult> {
    const request = ProductToolRequestSchema.parse(value);
    let name: string = request.type.replaceAll(".", "_").replaceAll("-", "_");
    const taskNames: Record<string, string> = {
      "thread.read": "opensteer_task_read",
      "thread.list": "opensteer_task_list",
      "thread.interrupt": "opensteer_task_interrupt",
      "thread.update": "opensteer_task_update",
      "task.cancel": "opensteer_delegation_cancel",
      "person.message": "send_to_person",
      "person.show": "show_to_person",
      "request.withdraw": "opensteer_request_withdraw",
    };
    name = taskNames[request.type] ?? name;
    if (request.type === "thread.delegate") name = "opensteer_task_delegate";
    if (request.type === "thread.message") name = "opensteer_task_send";
    if (request.type === "request.list") name = "opensteer_request_list";
    const { type: _type, requestId, ...rest } = request;
    let input: Record<string, unknown> = rest;
    if (request.type === "thread.update" || request.type === "thread.interrupt")
      input = request.input;
    if (request.type === "request.withdraw") input = { requestId: request.targetRequestId };
    if (request.type === "thread.message") {
      if (request.content.some((p) => p.type !== "text"))
        throw new OpensteerError({
          code: "bad_request",
          message:
            "A message from an agent cannot include a place reference. Forward selected references with opensteer_task_delegate places",
        });
      input = {
        ...rest,
        message: request.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"),
      };
      delete input.content;
    }
    if (request.type === "trigger.control") {
      name = (
        {
          list: "opensteer_automation_list",
          get: "opensteer_automation_read",
          create: "opensteer_automation_create",
          update: "opensteer_automation_update",
          set_status: "opensteer_automation_control",
          set_next_fire: "opensteer_automation_control",
          run: "opensteer_automation_control",
          cancel: "opensteer_automation_control",
        } as const
      )[request.input.operation];
      const { operation, ...fields } = request.input;
      input = { ...fields, action: operation };
      delete input.idempotencyKey;
      if ("source" in fields && fields.source?.kind === "schedule") {
        const schedule = fields.source.schedule;
        input.source = {
          kind: "schedule",
          ...(schedule.kind === "cron"
            ? { cron: schedule.expression, timezone: schedule.timezone }
            : { at: schedule.at }),
          ...(schedule.payload === undefined ? {} : { payload: schedule.payload }),
        };
      }
    }
    if (request.type === "thread.message") {
      input.taskId = input.threadId;
      delete input.threadId;
    }
    if (request.type === "trigger.control") {
      if ("triggerId" in input) {
        input.automationId = input.triggerId;
        delete input.triggerId;
      }
      if ("anchorThreadId" in input) {
        input.taskId = input.anchorThreadId;
        delete input.anchorThreadId;
      }
      if (input.action === "set_status") {
        input.action =
          input.status === "active" ? "resume" : input.status === "paused" ? "pause" : "archive";
        delete input.status;
      } else if (input.action === "set_next_fire") input.action = "reschedule";
      else if (input.action === "run") input.action = "run_now";
      else if (input.action === "cancel") input.action = "cancel_pending";
      else delete input.action;
    }
    if (request.type === "request.list")
      input = { limit: request.limit, ...(request.before ? { cursor: request.before } : {}) };
    if (request.type === "person.show" && "threadId" in request.target)
      input = { target: { taskId: request.target.threadId } };
    const result = await this.service.callTool(token, name, input, { operationKey: requestId });
    if (typeof result === "string") throw new Error(`${name} returned text, not a record`);
    let fields: Record<string, unknown> = result;
    if (
      [
        "thread.delegate",
        "thread.message",
        "computer.access.request",
        "trigger.control",
        "browser.tab.read",
        "browser.tab.write",
      ].includes(request.type)
    )
      fields = { result };
    if (request.type === "browser.session.close") fields = { sessionId: result.sessionId };
    return { ...fields, type: `${request.type}.result`, requestId } as ProductToolResult;
  }
}
export class TriggerToolsTestClient extends ProductToolsTestClient {
  constructor(options: TestOptions) {
    super(options, "trigger");
  }
}
export class WatchToolsTestClient extends ProductToolsTestClient {
  constructor(options: TestOptions) {
    super(options, "watch");
  }
}

export async function readToolRecords(
  store: import("@opensteer/database").OpensteerStore,
  result: {
    readonly taskId?: import("@opensteer/core").ThreadId;
    readonly runId: import("@opensteer/core").RunId | null;
    readonly messageId?: import("@opensteer/core").MessageId;
    readonly delegationId?: import("@opensteer/core").AssignmentId | null;
  },
) {
  const { messageFromRow, runFromRow, threadFromRow, threadInputFromRow } =
    await import("@opensteer/database/test-support/store");
  const assignment = result.delegationId ? await store.getAssignment(result.delegationId) : null;
  const messageId = result.messageId ?? assignment?.initialInputMessageId;
  const messageRow = messageId
    ? await store.database
        .selectFrom("messages")
        .selectAll()
        .where("id", "=", messageId)
        .executeTakeFirst()
    : result.runId
      ? await store.database
          .selectFrom("messages")
          .innerJoin("threadInputs", "threadInputs.messageId", "messages.id")
          .selectAll("messages")
          .where("threadInputs.runId", "=", result.runId)
          .orderBy("messages.sequence", "asc")
          .executeTakeFirst()
      : undefined;
  const threadId = result.taskId ?? messageRow?.threadId;
  if (!threadId) throw new Error("Tool result has no persisted Thread");
  const threadRow = await store.database
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  const runRow = result.runId
    ? await store.database
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", result.runId)
        .executeTakeFirst()
    : undefined;
  const inputRow = messageRow
    ? await store.database
        .selectFrom("threadInputs")
        .selectAll()
        .where("messageId", "=", messageRow.id)
        .executeTakeFirst()
    : undefined;
  return {
    thread: threadFromRow({
      ...threadRow,
      pendingRequests: threadRow.pendingRequestCount,
      providerSessionId: null,
      continuationIdentity: null,
    }),
    run: runRow ? runFromRow(runRow) : null,
    message: messageRow ? messageFromRow(messageRow) : null,
    input: inputRow ? threadInputFromRow(inputRow) : null,
  };
}
