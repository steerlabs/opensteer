import {
  thread_read,
  thread_list,
  delegate_task,
  thread_update,
  thread_interrupt,
  task_cancel,
} from "@opensteer/agent-tools/tools";
import {
  BrowserProfileListOutputSchema,
  ThreadReadOutputSchema,
  ThreadListOutputSchema,
  TaskSchema,
  OrchestratorCapabilitiesSchema,
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
  BrowserAccessSuggestionSchema,
  BrowserProfileIdSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
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
import { AgentBrowserSignInResultSchema } from "@opensteer/protocol";
import {
  AgentBrowserSessionSummarySchema,
  BrowserSessionIdSchema,
  BrowserTabReadInputSchema,
  BrowserTabReadResultSchema,
  BrowserTabWriteInputSchema,
  BrowserTabWriteResultSchema,
} from "@opensteer/protocol";
import { DurableWindowCursorSchema, DurableWindowSchema } from "@opensteer/protocol";
import { agentToolPayloadMaxSerializedBytes } from "@opensteer/protocol";
import { MachineAliasSchema } from "@opensteer/protocol";

const AgentDurableWindowSchema = z.strictObject(DurableWindowSchema.shape);
const AgentBrowserSessionSummaryStrictSchema = z.strictObject({
  ...AgentBrowserSessionSummarySchema.shape,
  placement: z.strictObject(AgentBrowserSessionSummarySchema.shape.placement.shape),
});

const requestBase = {
  requestId: z.uuid(),
} as const;
const EnvironmentListInputSchema = z
  .strictObject({
    query: z
      .string()
      .trim()
      .max(256)
      .transform((query) => query || undefined)
      .optional(),
    harnessInstanceId: HarnessInstanceIdSchema.optional(),
    cursor: z.string().min(1).max(2_048).optional(),
    environmentCursor: EnvironmentIdSchema.optional(),
    harnessCursor: HarnessInstanceIdSchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.cursor && !input.harnessInstanceId)
      context.addIssue({ code: "custom", message: "cursor requires harnessInstanceId" });
    if (input.harnessInstanceId && (input.environmentCursor || input.harnessCursor))
      context.addIssue({
        code: "custom",
        message: "Focus cannot be combined with directory cursors",
      });
  });

const ProductToolRequestUnionSchema = z.discriminatedUnion("type", [
  EnvironmentListInputSchema.safeExtend({
    ...requestBase,
    type: z.literal("environment.list"),
  }),
  thread_read.input.safeExtend({ ...requestBase, type: z.literal("thread.read") }),
  thread_list.input.safeExtend({ ...requestBase, type: z.literal("thread.list") }),
  delegate_task.input.safeExtend({ ...requestBase, type: z.literal("thread.delegate") }),
  task_cancel.input.safeExtend({ ...requestBase, type: z.literal("task.cancel") }),
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
    input: thread_update.input,
    type: z.literal("thread.update"),
  }),
  z.strictObject({
    ...requestBase,
    input: thread_interrupt.input,
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
  z.strictObject({
    ...requestBase,
    type: z.literal("browser.profile.list"),
  }),
  z.strictObject({
    ...requestBase,
    reason: z.string().trim().min(1).max(500),
    sessionId: BrowserSessionIdSchema.optional(),
    site: z.string().trim().min(1).max(2_048),
    type: z.literal("sign-in"),
  }),
  z.strictObject({
    ...requestBase,
    reason: z.string().trim().min(1).max(500),
    suggestion: BrowserAccessSuggestionSchema,
    type: z.literal("browser.profile.request"),
  }),
  /**
   * The computer is named by the alias the Run's machine-access note listed,
   * which is the only name the agent ever sees for it; the Host resolves the
   * alias against the same reachable set the note was rendered from.
   */
  z.strictObject({
    ...requestBase,
    computer: MachineAliasSchema,
    reason: z.string().trim().min(1).max(500),
    type: z.literal("machine.full-disk-access.request"),
  }),
  z.strictObject({
    ...requestBase,
    input: BrowserTabReadInputSchema,
    type: z.literal("browser.tab.read"),
  }),
  z.strictObject({
    ...requestBase,
    input: BrowserTabWriteInputSchema,
    type: z.literal("browser.tab.write"),
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
  OrchestratorCapabilitiesSchema.extend({
    ...responseBase,
    type: z.literal("environment.list.result"),
  }),
  ThreadReadOutputSchema.safeExtend({ ...responseBase, type: z.literal("thread.read.result") }),
  z.strictObject({
    ...responseBase,
    result: TaskSchema.extend({ assignmentId: AssignmentIdSchema, runId: RunIdSchema }),
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
    profiles: BrowserProfileListOutputSchema.shape.profiles,
    type: z.literal("browser.profile.list.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: AgentBrowserSignInResultSchema,
    type: z.literal("sign-in.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: RequestCreationResultSchema.extend({ kind: z.literal("browser.access") }),
    type: z.literal("browser.profile.request.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: RequestCreationResultSchema.extend({ kind: z.literal("machine.full-disk-access") }),
    type: z.literal("machine.full-disk-access.request.result"),
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
    result: BrowserTabReadResultSchema,
    type: z.literal("browser.tab.read.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: BrowserTabWriteResultSchema,
    type: z.literal("browser.tab.write.result"),
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
        folders: { admit: async (folder) => folder },
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
      realtime: { observe: () => () => {}, sendToUsers: () => {} },
      browser: unavailableDefaults as never,
      browserSources: unavailableDefaults as never,
      machineFullDiskAccess: unavailableDefaults as never,
      canRunHarness: () => true,
      harnessAccessModes: () => ThreadAccessModeSchema.options,
      isEnvironmentConnected: () => true,
      onEvent: () => {},
      folders: unavailableDefaults as never,
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
    if (request.type === "thread.delegate") name = "delegate_task";
    if (request.type === "thread.message") name = "thread_send";
    if (request.type === "request.list") name = "pending_request";
    if (request.type === "environment.list") name = "orchestrator_capabilities";
    const { type: _type, requestId, ...rest } = request;
    let input: Record<string, unknown> = rest;
    if (request.type === "thread.update" || request.type === "thread.interrupt")
      input = request.input;
    if (request.type === "browser.tab.read" || request.type === "browser.tab.write")
      input = request.input;
    if (request.type === "request.withdraw") input = { requestId: request.targetRequestId };
    if (request.type === "thread.message") {
      if (request.content.some((p) => p.type !== "text"))
        throw new OpensteerError({
          code: "bad_request",
          message:
            "A message from an agent cannot include a place reference. Forward selected references with delegate_task places",
        });
      input = {
        ...rest,
        message: request.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"),
      };
      delete input.content;
    }
    if (request.type === "trigger.control") {
      name = request.tool.replaceAll(".", "_");
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
    const result = await this.service.callTool(token, name, input, { operationKey: requestId });
    if (typeof result === "string") throw new Error(`${name} returned text, not a record`);
    let fields: Record<string, unknown> = result;
    if (
      [
        "thread.delegate",
        "thread.message",
        "sign-in",
        "browser.profile.request",
        "machine.full-disk-access.request",
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
    readonly threadId?: import("@opensteer/core").ThreadId;
    readonly runId: import("@opensteer/core").RunId | null;
    readonly messageId?: import("@opensteer/core").MessageId;
    readonly assignmentId?: import("@opensteer/core").AssignmentId | null;
  },
) {
  const { messageFromRow, runFromRow, threadFromRow, threadInputFromRow } =
    await import("@opensteer/database/test-support/store");
  const assignment = result.assignmentId ? await store.getAssignment(result.assignmentId) : null;
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
  const threadId = result.threadId ?? messageRow?.threadId;
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
