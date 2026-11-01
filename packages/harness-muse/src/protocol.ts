import { Connection, MspError, ProtocolError, type DuplexTransport } from "@muse-code/sdk";
import type { HarnessProcessLaunchWrapper, SupervisedProcess } from "@opensteer/harness";
import { spawnSupervised } from "@opensteer/harness";
import { z } from "zod";
import type {
  ApprovalDecideResult,
  ApprovalRequestParams,
  InitializeResult,
  Item,
  ModelListResult,
  SessionResumeResult,
  SessionSetApprovalModeResult,
  SessionStartResult,
  SubscriptionUsage,
  TurnCompletedParams,
  TurnStartResult,
  TurnSteerResult,
  UserInputRequestParams,
} from "./generated/msp.js";

export type {
  ApprovalChoice,
  ApprovalRequestParams,
  Item,
  ModelCatalogEntry,
  ModelListResult,
  SessionMcpServerConfig,
  SubscriptionUsage,
  TokenUsage,
  TurnCompletedParams,
  TurnInputPart,
  UserInputQuestion,
  UserInputRequestParams,
  WorkflowChild,
} from "./generated/msp.js";

const nonEmptyString = z.string().min(1);
const nonnegativeInteger = z.number().int().nonnegative();

export const MuseInitializeResultSchema = z.looseObject({
  grantedCapabilities: z.array(z.string()),
  museHome: z.string(),
  schema: z.looseObject({ version: z.number().int() }),
  serverInfo: z.looseObject({ name: z.string(), version: z.string() }),
});

export const MuseModelListResultSchema = z.looseObject({
  models: z.array(
    z.looseObject({
      contextLimit: z.number().int().positive().nullable(),
      defaultReasoningEffort: z.string().optional(),
      description: z.string().nullable(),
      displayLabel: z.string(),
      isActive: z.boolean(),
      isDefault: z.boolean(),
      modelId: nonEmptyString,
      outputLimit: z.number().int().positive().nullable(),
      providerId: z.string(),
      reasoningEffortVariants: z
        .array(z.looseObject({ description: z.string().optional(), tier: z.string() }))
        .optional(),
      variants: z.union([z.array(z.string()), z.literal("unknown")]).optional(),
    }),
  ),
  profileId: z.string().nullable(),
  providerId: z.string(),
  source: z.string(),
});

const museSessionSchema = z.looseObject({
  activeTurnId: z.string().nullable(),
  modelId: z.string().nullable().optional(),
  sessionId: nonEmptyString,
  status: z.string(),
  workspaceRoot: z.string().optional(),
});

export const MuseSessionStartResultSchema = z.looseObject({
  session: museSessionSchema,
  viewCursor: z.string(),
});

export const MuseSessionResumeResultSchema = z.looseObject({
  history: z.looseObject({}),
  pendingRequests: z.array(z.unknown()),
  session: museSessionSchema,
  viewCursor: z.string(),
});

export const MuseTurnStartResultSchema = z.looseObject({
  commandId: nonEmptyString,
  disposition: z.string(),
  startedNewTurn: z.boolean(),
  status: z.string(),
  turnId: nonEmptyString,
});

export const MuseTurnSteerResultSchema = z.looseObject({
  commandId: nonEmptyString,
  status: z.string(),
  turnId: nonEmptyString,
});

export const MuseSetApprovalModeResultSchema = z.looseObject({
  applyOutcome: z.string(),
  commandId: nonEmptyString,
  effectiveMode: z.looseObject({ mode: z.string() }),
  status: z.string(),
});

export const MuseApprovalDecideResultSchema = z.looseObject({
  approvalId: nonEmptyString,
  commandId: nonEmptyString,
  status: z.string(),
  terminal: z.boolean(),
});

export const MuseItemSchema = z.looseObject({
  args: z.string().optional(),
  callId: z.string().optional(),
  childSessionId: z.string().optional(),
  children: z
    .array(
      z.looseObject({
        attempt: z.number().int().positive(),
        childId: nonEmptyString,
        durationMs: z.number().finite().optional(),
        failureKind: z.string().optional(),
        failureReason: z.string().optional(),
        label: z.string().optional(),
        resultRef: z.string().optional(),
        status: z.string(),
        terminal: z.string().optional(),
      }),
    )
    .optional(),
  commandText: z.string().optional(),
  controlStatus: z.string().optional(),
  entryId: z.string().optional(),
  exitCode: z.number().int().optional(),
  failureReason: z.string().optional(),
  fallbackText: z.string().optional(),
  finalSummary: z.string().optional(),
  itemId: nonEmptyString,
  kind: nonEmptyString,
  objective: z.string().optional(),
  result: z.looseObject({ summary: z.string(), text: z.string().optional() }).optional(),
  revision: z.number().int().positive(),
  role: z.string().optional(),
  status: nonEmptyString,
  subagentId: z.string().optional(),
  summary: z.array(z.string()).optional(),
  text: z.string().optional(),
  tool: z.string().optional(),
  turnId: z.string().nullable().optional(),
  visibleOutput: z.string().optional(),
});

export const MuseItemEventSchema = z.looseObject({ item: MuseItemSchema });
export const MuseItemDeltaSchema = z.looseObject({
  delta: z.string(),
  field: z.string().optional(),
  itemId: nonEmptyString,
  sessionId: nonEmptyString,
});

const museTokenUsageSchema = z.looseObject({
  cacheReadTokens: nonnegativeInteger.optional(),
  cacheWriteTokens: nonnegativeInteger.optional(),
  cachedTokens: nonnegativeInteger,
  inputTokens: nonnegativeInteger,
  outputTokens: nonnegativeInteger,
  reasoningTokens: nonnegativeInteger,
});

export const MuseSessionTokenUsageSchema = z.looseObject({
  promptTokens: nonnegativeInteger,
  sessionId: nonEmptyString,
  totalTokens: nonnegativeInteger,
  turnId: nonEmptyString,
  usage: museTokenUsageSchema,
});

export const MuseTurnCompletedSchema = z.looseObject({
  error: z
    .looseObject({
      kind: z.string(),
      message: z.string(),
      quota: z.looseObject({ resetsAtMs: z.number().finite() }).optional(),
      retryable: z.boolean(),
    })
    .optional(),
  reason: z.string().optional(),
  sessionId: nonEmptyString,
  terminal: z.string(),
  turnId: nonEmptyString,
  usage: museTokenUsageSchema.optional(),
});

export const MuseApprovalRequestSchema = z.looseObject({
  approvalId: nonEmptyString,
  availableChoices: z.array(
    z.looseObject({
      acceptsFeedback: z.boolean().optional(),
      choiceId: nonEmptyString,
      decision: nonEmptyString,
      label: z.string(),
      scope: z.string(),
    }),
  ),
  currentRequirementId: z.looseObject({
    approvalId: nonEmptyString,
    sourceIndex: z.number().int().nonnegative(),
  }),
  itemId: nonEmptyString,
  rawArgs: z.string(),
  sessionId: nonEmptyString,
  subagentOrigin: z
    .looseObject({
      childRunId: nonEmptyString,
      childSessionId: nonEmptyString,
      subagentId: nonEmptyString,
    })
    .optional(),
  subject: z.looseObject({
    access: z.string().optional(),
    command: z.string().optional(),
    host: z.string().optional(),
    kind: z.string(),
    path: z.string().optional(),
    target: z.string().optional(),
  }),
  toolCallId: nonEmptyString,
  toolName: nonEmptyString,
  turnId: nonEmptyString,
});

export const MuseUserInputRequestSchema = z.looseObject({
  itemId: nonEmptyString,
  questions: z.array(
    z.looseObject({
      header: z.string(),
      id: nonEmptyString,
      options: z.array(
        z.looseObject({ description: z.string().optional(), label: nonEmptyString }),
      ),
      question: z.string(),
      selection: z.looseObject({
        maxSelections: z.number().int().positive().optional(),
        minSelections: z.number().int().nonnegative().optional(),
        mode: z.enum(["single", "multiple"]),
      }),
    }),
  ),
  sessionId: nonEmptyString,
  toolCallId: nonEmptyString,
  toolName: nonEmptyString,
  turnId: nonEmptyString,
  userInputId: nonEmptyString,
});

export const MuseSubscriptionUsageSchema = z.looseObject({
  observedAtMs: z.number().positive().finite(),
  tier: z.string(),
  weekly: z.looseObject({
    resetsAtMs: z.number().positive().finite(),
    usedPercent: z.number().nonnegative().finite(),
  }),
  window: z.looseObject({
    resetsAtMs: z.number().positive().finite(),
    usedPercent: z.number().nonnegative().finite(),
    windowDurationMins: z.number().positive().finite(),
  }),
});

export const MuseUsageReadResultSchema = z.looseObject({
  usage: MuseSubscriptionUsageSchema.optional(),
});

export interface MuseHostOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly requestedCapabilities?: readonly string[];
  readonly signal?: AbortSignal;
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onProtocolError: (error: ProtocolError) => void;
  readonly onServerRequest: (method: string, params: unknown) => Promise<Record<string, unknown>>;
  readonly startupTimeoutMs: number;
  readonly wrapProcessLaunch: HarnessProcessLaunchWrapper;
}

/** A supervised Muse host using the SDK's unpatched transport-only connection. */
export class MuseHost {
  readonly connection: Connection;
  readonly exited: SupervisedProcess["exited"];
  readonly initializeResult: InitializeResult;
  readonly #process: SupervisedProcess;
  #closePromise: Promise<void> | undefined;

  private constructor(
    process: SupervisedProcess,
    connection: Connection,
    initializeResult: InitializeResult,
  ) {
    this.#process = process;
    this.connection = connection;
    this.initializeResult = initializeResult;
    this.exited = process.exited;
  }

  static async open(options: MuseHostOptions): Promise<MuseHost> {
    const launch = options.wrapProcessLaunch({
      args: options.args,
      cwd: options.cwd,
      environment: options.environment,
      executable: options.executable,
    });
    const process = spawnSupervised({
      ...launch,
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    process.child.stdin.on("error", () => undefined);
    void drain(process.stderr);
    const transport = supervisedTransport(process);
    const connection = new Connection(transport);
    connection.onNotification((notification) =>
      options.onNotification(notification.method, notification.params),
    );
    connection.onServerRequest((request) =>
      options.onServerRequest(request.method, request.params),
    );
    connection.onProtocolError(options.onProtocolError);
    try {
      const raw = await deadline(
        connection.request("initialize", {
          capabilities: {
            requestedCapabilities: [...(options.requestedCapabilities ?? ["sessionMcp"])],
          },
          clientInfo: { name: "opensteer", title: "Opensteer", version: "0.0.0" },
        }),
        options.startupTimeoutMs,
        "Muse Code initialization timed out",
      );
      const initializeResult = MuseInitializeResultSchema.parse(raw) as unknown as InitializeResult;
      if (initializeResult.schema.version !== 1) {
        throw new ProtocolError("Muse Code returned an unsupported MSP schema version");
      }
      connection.notify("initialized");
      await connection.flush();
      return new MuseHost(process, connection, initializeResult);
    } catch (error) {
      await connection.close().catch(() => undefined);
      await process.terminate(0).catch(() => undefined);
      throw error;
    }
  }

  mintCommandId(): string {
    return this.connection.mintCommandId();
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.connection.request(method, params);
  }

  async command(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const commandId = this.mintCommandId();
    return this.connection.request(method, { ...params, commandId });
  }

  async startTurn(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const commandId = this.mintCommandId();
    return this.connection.command("turn/start", params, {
      commandId,
      maxAttempts: 3,
      retryDelay: async () => undefined,
    });
  }

  close(): Promise<void> {
    this.#closePromise ??= this.connection
      .close()
      .catch(() => undefined)
      .then(() => this.#process.terminate(0).catch(() => undefined));
    return this.#closePromise;
  }
}

function supervisedTransport(process: SupervisedProcess): DuplexTransport {
  return {
    incoming: decodeUtf8(process.stdout),
    write: async (chunk) => {
      if (process.child.stdin.destroyed) throw new ProtocolError("Muse Code stdin is closed");
      await new Promise<void>((resolve, reject) => {
        process.child.stdin.write(chunk, "utf8", (error) => (error ? reject(error) : resolve()));
      });
    },
    close: async (flushed) => {
      await deadline(flushed ?? Promise.resolve(), 10_000, "Muse Code output did not flush").catch(
        () => undefined,
      );
      if (!process.child.stdin.destroyed && !process.child.stdin.writableEnded) {
        await new Promise<void>((resolve) => {
          process.child.stdin.end(() => resolve());
        }).catch(() => undefined);
      }
      await deadline(process.exited, 10_000, "Muse Code did not exit").catch(async () => {
        await process.terminate(0);
      });
    },
  };
}

async function* decodeUtf8(output: AsyncIterable<Buffer>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const chunk of output) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const trailing = decoder.decode();
  if (trailing) yield trailing;
}

async function drain(output: AsyncIterable<Buffer>): Promise<void> {
  for await (const _chunk of output) {
    // Muse stderr can contain authentication material and is never retained.
  }
}

async function deadline<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseMuseModelList(value: unknown): ModelListResult {
  return MuseModelListResultSchema.parse(value) as unknown as ModelListResult;
}

export function parseMuseSessionStart(value: unknown): SessionStartResult {
  return MuseSessionStartResultSchema.parse(value) as unknown as SessionStartResult;
}

export function parseMuseSessionResume(value: unknown): SessionResumeResult {
  return MuseSessionResumeResultSchema.parse(value) as unknown as SessionResumeResult;
}

export function parseMuseTurnStart(value: unknown): TurnStartResult {
  return MuseTurnStartResultSchema.parse(value) as TurnStartResult;
}

export function parseMuseTurnSteer(value: unknown): TurnSteerResult {
  return MuseTurnSteerResultSchema.parse(value) as TurnSteerResult;
}

export function parseMuseSetApprovalMode(value: unknown): SessionSetApprovalModeResult {
  return MuseSetApprovalModeResultSchema.parse(value) as unknown as SessionSetApprovalModeResult;
}

export function parseMuseApprovalDecide(value: unknown): ApprovalDecideResult {
  return MuseApprovalDecideResultSchema.parse(value) as ApprovalDecideResult;
}

export function parseMuseItem(value: unknown): Item {
  return MuseItemSchema.parse(value) as unknown as Item;
}

export function parseMuseTurnCompleted(value: unknown): TurnCompletedParams {
  return MuseTurnCompletedSchema.parse(value) as unknown as TurnCompletedParams;
}

export function parseMuseApprovalRequest(value: unknown): ApprovalRequestParams {
  return MuseApprovalRequestSchema.parse(value) as unknown as ApprovalRequestParams;
}

export function parseMuseUserInputRequest(value: unknown): UserInputRequestParams {
  return MuseUserInputRequestSchema.parse(value) as unknown as UserInputRequestParams;
}

export function parseMuseSubscriptionUsage(value: unknown): SubscriptionUsage {
  return MuseSubscriptionUsageSchema.parse(value) as SubscriptionUsage;
}

export function isMuseMspError(error: unknown): error is MspError {
  return error instanceof MspError;
}
