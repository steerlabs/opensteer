import * as acpV1 from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { OpensteerError } from "@opensteer/core";
import { Deferred } from "@opensteer/harness";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { SupervisedProcess } from "@opensteer/harness";
import type {
  AcpClientCapabilities,
  AcpClientInfo,
  AcpInspectionSnapshot,
  AcpPermissionRequest,
  AcpProtocolVersion,
  AcpResumePolicy,
  AcpSessionConfigOption,
  AcpSessionSnapshot,
  AcpToolCall,
} from "./types.js";

export interface AcpProtocolHandlers {
  readonly elicitation: (request: AcpElicitationRequest, signal: AbortSignal) => Promise<unknown>;
  readonly permission: (
    request: AcpPermissionRequest,
    signal: AbortSignal,
  ) => Promise<string | null>;
  readonly readTextFile: (
    path: string,
    line?: number | null,
    limit?: number | null,
  ) => Promise<string>;
  readonly update: (sessionId: string, update: unknown) => void;
}

export interface AcpElicitationRequest {
  readonly message: string;
  readonly mode: string;
  readonly requestedSchema?: unknown;
  readonly sessionId?: string;
  readonly toolCallId?: string;
}

export interface AcpMcpServer {
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  readonly name: string;
  readonly type: "http";
  readonly url: string;
}

export interface AcpSessionEnvironment {
  readonly additionalDirectories: readonly string[];
  readonly cwd: string;
  readonly mcpServers: readonly AcpMcpServer[];
}

export interface AcpPromptResult {
  readonly stopReason: string;
  readonly usage?: {
    readonly cachedInputTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens?: number;
  };
}

export type AcpPromptBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface AcpProtocolClient {
  readonly version: AcpProtocolVersion;
  close(error?: unknown): void;
  initialize(options: {
    readonly capabilities: AcpClientCapabilities;
    readonly deadlineMs: number;
    readonly info: AcpClientInfo;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
  }): Promise<AcpInspectionSnapshot>;
  authenticate(methodId: string, signal: AbortSignal): Promise<void>;
  newSession(environment: AcpSessionEnvironment, signal: AbortSignal): Promise<AcpSessionSnapshot>;
  resumeSession(
    reference: string,
    environment: AcpSessionEnvironment,
    policy: AcpResumePolicy,
    signal: AbortSignal,
  ): Promise<AcpSessionSnapshot>;
  setMode(sessionId: string, modeId: string, signal: AbortSignal): Promise<void>;
  setModel(
    sessionId: string,
    modelId: string,
    metadata: Readonly<Record<string, unknown>> | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  setConfigOption(
    sessionId: string,
    option: {
      readonly id: string;
      readonly type: "boolean" | "select";
      readonly value: boolean | string;
    },
    signal: AbortSignal,
  ): Promise<readonly AcpSessionConfigOption[]>;
  prompt(
    sessionId: string,
    blocks: readonly AcpPromptBlock[],
    signal: AbortSignal,
  ): Promise<AcpPromptResult>;
  cancel(sessionId: string, metadata?: Readonly<Record<string, unknown>>): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}

const SetModelResponseSchema = z.looseObject({});
const SessionConfigSelectEntrySchema = z.looseObject({
  description: z.string().nullish(),
  name: z.string(),
  value: z.string(),
});
const SessionConfigOptionSchema = z.looseObject({
  category: z.string().nullish(),
  configId: z.string().optional(),
  currentValue: z.union([z.boolean(), z.string()]),
  id: z.string().optional(),
  name: z.string(),
  options: z
    .array(
      z.union([
        SessionConfigSelectEntrySchema,
        z.looseObject({
          options: z.array(SessionConfigSelectEntrySchema),
        }),
      ]),
    )
    .optional(),
  type: z.enum(["boolean", "select"]),
});

export function createAcpProtocolClient(options: {
  readonly handlers: AcpProtocolHandlers;
  readonly process: SupervisedProcess;
  readonly stdout?: AsyncIterable<Buffer>;
  readonly version: AcpProtocolVersion;
}): AcpProtocolClient {
  return options.version === 1
    ? createV1Client(options.process, options.handlers, options.stdout)
    : createV2Client(options.process, options.handlers, options.stdout);
}

function createV1Client(
  process: SupervisedProcess,
  handlers: AcpProtocolHandlers,
  stdout: AsyncIterable<Buffer> = process.stdout,
): AcpProtocolClient {
  const app = acpV1
    .client({ name: "Opensteer" })
    .onNotification(acpV1.methods.client.session.update, ({ params }) => {
      handlers.update(params.sessionId, params.update);
    })
    .onRequest(acpV1.methods.client.session.requestPermission, async ({ params, signal }) => {
      const optionId = await handlers.permission(permissionRequestV1(params), signal);
      return {
        outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId },
      };
    })
    .onRequest(acpV1.methods.client.fs.readTextFile, async ({ params }) => ({
      content: await handlers.readTextFile(params.path, params.line, params.limit),
    }))
    .onRequest(acpV1.methods.client.fs.writeTextFile, () => {
      throw new OpensteerError({ code: "forbidden", message: "ACP file writes are disabled" });
    })
    .onRequest(acpV1.methods.client.elicitation.create, async ({ params, signal }) => {
      const result = await handlers.elicitation(elicitationRequest(params), signal);
      if (result === null) return { action: "cancel" };
      if (!isRecord(result)) return { action: "decline" };
      const content = Object.fromEntries(
        Object.entries(result).filter(
          (entry): entry is [string, string | number | boolean | string[]] =>
            isElicitationValue(entry[1]),
        ),
      );
      return { action: "accept", content };
    });
  const connection = app.connect(
    acpV1.ndJsonStream(
      Writable.toWeb(process.child.stdin),
      Readable.toWeb(Readable.from(stdout)) as ReadableStream<Uint8Array>,
    ),
  );
  const agent = connection.agent;
  return {
    version: 1,
    close: (error) => connection.close(error),
    initialize: async (options) => {
      const response = (await withTimeout(
        agent.request(
          acpV1.methods.agent.initialize,
          {
            protocolVersion: 1,
            clientCapabilities: v1Capabilities(options.capabilities),
            clientInfo: options.info,
            ...(options.metadata ? { _meta: { ...options.metadata } } : {}),
          },
          { cancellationSignal: options.signal },
        ),
        options.deadlineMs,
        {
          signal: options.signal,
          timeoutError: () =>
            new OpensteerError({ code: "timeout", message: "ACP initialize timed out" }),
        },
      )) as acpV1.InitializeResponse;
      return {
        agentCapabilities: objectOrEmpty(response.agentCapabilities),
        ...(response.agentInfo ? { agentInfo: response.agentInfo } : {}),
        authMethods: (response.authMethods ?? []).map((method) => ({
          id: method.id,
          name: method.name,
        })),
        metadata: objectOrEmpty(response._meta),
        protocolVersion: response.protocolVersion,
      };
    },
    authenticate: async (methodId, signal) => {
      await agent.request(
        acpV1.methods.agent.authenticate,
        { methodId },
        { cancellationSignal: signal },
      );
    },
    newSession: async (environment, signal) =>
      v1Snapshot(
        await agent.request(acpV1.methods.agent.session.new, v1Environment(environment), {
          cancellationSignal: signal,
        }),
      ),
    resumeSession: async (reference, environment, policy, signal) => {
      if (policy.method === "load") {
        const response = await agent.request(
          acpV1.methods.agent.session.load,
          { ...v1Environment(environment), sessionId: reference },
          { cancellationSignal: signal },
        );
        return v1Snapshot({ sessionId: reference, ...response });
      }
      const response = await agent.request(
        acpV1.methods.agent.session.resume,
        { ...v1Environment(environment), sessionId: reference },
        { cancellationSignal: signal },
      );
      return v1Snapshot({ sessionId: reference, ...response });
    },
    setMode: async (sessionId, modeId, signal) => {
      await agent.request(
        acpV1.methods.agent.session.setMode,
        { sessionId, modeId },
        { cancellationSignal: signal },
      );
    },
    setModel: async (sessionId, modelId, metadata, signal) => {
      const response = await agent.request<unknown, unknown>(
        "session/set_model",
        { sessionId, modelId, ...(metadata ? { _meta: { ...metadata } } : {}) },
        { cancellationSignal: signal },
      );
      SetModelResponseSchema.parse(response);
    },
    setConfigOption: async (sessionId, option, signal) => {
      const response = await agent.request(
        acpV1.methods.agent.session.setConfigOption,
        option.type === "boolean"
          ? { configId: option.id, sessionId, type: "boolean", value: Boolean(option.value) }
          : { configId: option.id, sessionId, value: String(option.value) },
        { cancellationSignal: signal },
      );
      return sessionOptions(response.configOptions);
    },
    prompt: async (sessionId, blocks, signal) => {
      const response = await agent.request(
        acpV1.methods.agent.session.prompt,
        { sessionId, prompt: blocks.map(v1Block) },
        { cancellationSignal: signal },
      );
      return {
        stopReason: response.stopReason,
        ...(response.usage ? { usage: promptUsage(response.usage) } : {}),
      };
    },
    cancel: (sessionId, metadata) =>
      agent.notify(acpV1.methods.agent.session.cancel, {
        sessionId,
        ...(metadata ? { _meta: { ...metadata } } : {}),
      }),
    closeSession: async (sessionId) => {
      await agent.request(acpV1.methods.agent.session.close, { sessionId });
    },
  };
}

function createV2Client(
  process: SupervisedProcess,
  handlers: AcpProtocolHandlers,
  stdout: AsyncIterable<Buffer> = process.stdout,
): AcpProtocolClient {
  const idle = new Map<string, { readonly done: Deferred<string>; running: boolean }>();
  const app = acpV2
    .client({ name: "Opensteer" })
    .onNotification(acpV2.methods.client.session.update, ({ params }) => {
      handlers.update(params.sessionId, params.update);
      const state = v2State(params.update);
      const turn = idle.get(params.sessionId);
      if (!turn || !state) return;
      if (state.state === "running" || state.state === "requires_action") turn.running = true;
      if (state.state === "idle" && turn.running) turn.done.resolve(state.stopReason ?? "end_turn");
    })
    .onRequest(acpV2.methods.client.session.requestPermission, async ({ params, signal }) => {
      const optionId = await handlers.permission(permissionRequestV2(params), signal);
      return {
        outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId },
      };
    })
    .onRequest(acpV2.methods.client.elicitation.create, async ({ params, signal }) => {
      const result = await handlers.elicitation(elicitationRequest(params), signal);
      return result === null || !isRecord(result)
        ? { action: "cancel" }
        : { action: "accept", content: result };
    });
  const connection = app.connect(
    acpV2.ndJsonStream(
      Writable.toWeb(process.child.stdin),
      Readable.toWeb(Readable.from(stdout)) as ReadableStream<Uint8Array>,
    ),
  );
  const agent = connection.agent;
  return {
    version: 2,
    close: (error) => connection.close(error),
    initialize: async (options) => {
      const response = (await withTimeout(
        agent.request(
          acpV2.methods.agent.initialize,
          {
            protocolVersion: 2,
            info: options.info,
            capabilities: options.capabilities.elicitation ? { elicitation: { form: {} } } : {},
            ...(options.metadata ? { _meta: { ...options.metadata } } : {}),
          },
          { cancellationSignal: options.signal },
        ),
        options.deadlineMs,
        {
          signal: options.signal,
          timeoutError: () =>
            new OpensteerError({ code: "timeout", message: "ACP initialize timed out" }),
        },
      )) as acpV2.InitializeResponse;
      return {
        agentCapabilities: objectOrEmpty(response.capabilities),
        agentInfo: response.info,
        authMethods: (response.authMethods ?? []).map((method) => ({
          id: method.methodId,
          name: method.name,
        })),
        metadata: objectOrEmpty(response._meta),
        protocolVersion: response.protocolVersion,
      };
    },
    authenticate: async (methodId, signal) => {
      await agent.request(
        acpV2.methods.agent.auth.login,
        { methodId },
        { cancellationSignal: signal },
      );
    },
    newSession: async (environment, signal) => {
      const response = await agent.request(
        acpV2.methods.agent.session.new,
        v2Environment(environment),
        { cancellationSignal: signal },
      );
      return v2Snapshot(response.sessionId, response);
    },
    resumeSession: async (reference, environment, policy, signal) => {
      const response = await agent.request(
        acpV2.methods.agent.session.resume,
        {
          ...v2Environment(environment),
          sessionId: reference,
          ...(policy.method === "load" ? { replayFrom: { type: "start" as const } } : {}),
        },
        { cancellationSignal: signal },
      );
      return v2Snapshot(reference, response);
    },
    setMode: async (sessionId, modeId, signal) => {
      await agent.request(
        acpV2.methods.agent.session.setConfigOption,
        { configId: "mode", sessionId, type: "id", value: modeId },
        { cancellationSignal: signal },
      );
    },
    setModel: async (sessionId, modelId, _metadata, signal) => {
      await agent.request(
        acpV2.methods.agent.session.setConfigOption,
        { configId: "model", sessionId, type: "id", value: modelId },
        { cancellationSignal: signal },
      );
    },
    setConfigOption: async (sessionId, option, signal) => {
      const response = await agent.request(
        acpV2.methods.agent.session.setConfigOption,
        option.type === "boolean"
          ? { configId: option.id, sessionId, type: "boolean", value: Boolean(option.value) }
          : { configId: option.id, sessionId, type: "id", value: String(option.value) },
        { cancellationSignal: signal },
      );
      return sessionOptions(response.configOptions);
    },
    prompt: async (sessionId, blocks, signal) => {
      if (idle.has(sessionId))
        throw new OpensteerError({
          code: "conflict",
          message: "ACP session already has an active prompt",
        });
      const turn = { done: new Deferred<string>(), running: false };
      idle.set(sessionId, turn);
      try {
        const request = agent.request(
          acpV2.methods.agent.session.prompt,
          { sessionId, prompt: blocks.map(v2Block) },
          { cancellationSignal: signal },
        );
        const [, stopReason] = await Promise.all([request, turn.done.promise]);
        return { stopReason };
      } finally {
        idle.delete(sessionId);
      }
    },
    cancel: (sessionId, metadata) =>
      agent.notify(acpV2.methods.agent.session.cancel, {
        sessionId,
        ...(metadata ? { _meta: { ...metadata } } : {}),
      }),
    closeSession: async (sessionId) => {
      await agent.request(acpV2.methods.agent.session.close, { sessionId });
    },
  };
}

function v1Capabilities(capabilities: AcpClientCapabilities): acpV1.ClientCapabilities {
  return {
    ...(capabilities.fileSystem === "read-only"
      ? { fs: { readTextFile: true, writeTextFile: false } }
      : {}),
    terminal: false,
    session: { configOptions: { boolean: {} } },
    ...(capabilities.elicitation ? { elicitation: { form: {} } } : {}),
  };
}

function v1Environment(environment: AcpSessionEnvironment): acpV1.NewSessionRequest {
  return {
    cwd: environment.cwd,
    additionalDirectories: [...environment.additionalDirectories],
    mcpServers: environment.mcpServers.map((server) => ({
      ...server,
      headers: [...server.headers],
    })),
  };
}

function v2Environment(environment: AcpSessionEnvironment): acpV2.NewSessionRequest {
  return {
    cwd: environment.cwd,
    additionalDirectories: [...environment.additionalDirectories],
    mcpServers: environment.mcpServers.map((server) => ({
      ...server,
      headers: [...server.headers],
    })),
  };
}

function v1Block(block: AcpPromptBlock): acpV1.ContentBlock {
  return block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", data: block.data, mimeType: block.mimeType };
}

function v2Block(block: AcpPromptBlock): acpV2.ContentBlock {
  return block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", data: block.data, mimeType: block.mimeType };
}

function v1Snapshot(response: acpV1.NewSessionResponse): AcpSessionSnapshot {
  return {
    configOptions: sessionOptions(response.configOptions ?? []),
    metadata: objectOrEmpty(response._meta),
    ...(response.modes
      ? {
          modes: {
            currentModeId: response.modes.currentModeId,
            availableModes: response.modes.availableModes.map(({ id, name }) => ({ id, name })),
          },
        }
      : {}),
    sessionId: response.sessionId,
  };
}

function v2Snapshot(
  sessionId: string,
  response: acpV2.NewSessionResponse | acpV2.ResumeSessionResponse,
): AcpSessionSnapshot {
  return {
    configOptions: sessionOptions(response.configOptions ?? []),
    metadata: objectOrEmpty(response._meta),
    sessionId,
  };
}

function sessionOptions(
  options: readonly (acpV1.SessionConfigOption | acpV2.SessionConfigOption)[],
): readonly AcpSessionConfigOption[] {
  return options.flatMap((rawOption): AcpSessionConfigOption[] => {
    const parsed = SessionConfigOptionSchema.safeParse(rawOption);
    if (!parsed.success) return [];
    const option = parsed.data;
    const id = option.configId ?? option.id;
    if (!id) return [];
    if (option.type === "boolean") {
      return [
        {
          ...(option.category ? { category: option.category } : {}),
          currentValue: option.currentValue,
          id,
          name: option.name,
          type: "boolean",
        },
      ];
    }
    if (option.type !== "select") return [];
    const entries = (option.options ?? []).flatMap((entry) => {
      if (isRecord(entry) && Array.isArray(entry.options)) {
        return entry.options.flatMap((nested) => {
          const nestedResult = SessionConfigSelectEntrySchema.safeParse(nested);
          return nestedResult.success ? [nestedResult.data] : [];
        });
      }
      const entryResult = SessionConfigSelectEntrySchema.safeParse(entry);
      return entryResult.success ? [entryResult.data] : [];
    });
    return [
      {
        ...(option.category ? { category: option.category } : {}),
        currentValue: option.currentValue,
        id,
        name: option.name,
        options: entries.map((entry) => ({
          ...(entry.description ? { description: entry.description } : {}),
          label: entry.name,
          value: entry.value,
        })),
        type: "select",
      },
    ];
  });
}

function permissionOptions(
  options: readonly (acpV1.PermissionOption | acpV2.PermissionOption)[],
): AcpPermissionRequest["options"] {
  return options.map((option) => ({
    id: option.optionId,
    kind: option.kind,
    label: option.name,
  }));
}

function permissionRequestV1(request: acpV1.RequestPermissionRequest): AcpPermissionRequest {
  return {
    options: permissionOptions(request.options),
    sessionId: request.sessionId,
    toolCall: toolCall(request.toolCall),
  };
}

function permissionRequestV2(request: acpV2.RequestPermissionRequest): AcpPermissionRequest {
  const subject = request.subject;
  const call =
    isRecord(subject) && subject.type === "tool_call" && isRecord(subject.toolCall)
      ? toolCall(subject.toolCall)
      : commandPermissionToolCall(subject, request.title);
  return { options: permissionOptions(request.options), toolCall: call };
}

function commandPermissionToolCall(subject: unknown, title: string): AcpToolCall {
  if (!isRecord(subject) || subject.type !== "command" || typeof subject.command !== "string") {
    return { id: "permission", title };
  }
  return {
    id: typeof subject.toolCallId === "string" ? subject.toolCallId : `command:${subject.command}`,
    kind: "execute",
    name: subject.command,
    title,
  };
}

function toolCall(call: unknown): AcpToolCall {
  if (!isRecord(call) || typeof call.toolCallId !== "string") {
    return { id: "unknown-tool-call" };
  }
  return {
    id: call.toolCallId,
    ...(Array.isArray(call.content) ? { content: call.content } : {}),
    ...(typeof call.kind === "string" ? { kind: call.kind } : {}),
    ...(Array.isArray(call.locations) ? { locations: call.locations } : {}),
    ...(typeof call.name === "string" ? { name: call.name } : {}),
    ...(call.rawInput !== undefined ? { rawInput: call.rawInput } : {}),
    ...(call.rawOutput !== undefined ? { rawOutput: call.rawOutput } : {}),
    ...(typeof call.status === "string" ? { status: call.status } : {}),
    ...(typeof call.title === "string" ? { title: call.title } : {}),
  };
}

function elicitationRequest(
  request: acpV1.CreateElicitationRequest | acpV2.CreateElicitationRequest,
): AcpElicitationRequest {
  const sessionId =
    "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : undefined;
  const toolCallId =
    "toolCallId" in request && typeof request.toolCallId === "string"
      ? request.toolCallId
      : undefined;
  return {
    message: request.message,
    mode: request.mode,
    ...(request.mode === "form" ? { requestedSchema: request.requestedSchema } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

function promptUsage(usage: acpV1.Usage): NonNullable<AcpPromptResult["usage"]> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedReadTokens === null || usage.cachedReadTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedReadTokens }),
    ...(usage.cachedWriteTokens === null || usage.cachedWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cachedWriteTokens }),
    ...(usage.thoughtTokens === null || usage.thoughtTokens === undefined
      ? {}
      : { reasoningTokens: usage.thoughtTokens }),
  };
}

function v2State(
  update: acpV2.SessionUpdate,
): { readonly state: string; readonly stopReason?: string } | undefined {
  if (update.sessionUpdate !== "state_update" || typeof update.state !== "string") return undefined;
  return {
    state: update.state,
    ...(update.state === "idle" && typeof update.stopReason === "string"
      ? { stopReason: update.stopReason }
      : {}),
  };
}

function objectOrEmpty(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isElicitationValue(value: unknown): value is string | number | boolean | string[] {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

export function acpReadTextFileHandler(roots: readonly string[]) {
  return async (path: string, line?: number | null, limit?: number | null): Promise<string> => {
    if (!isAbsolute(path))
      throw new OpensteerError({
        code: "bad_request",
        message: "ACP file reads require an absolute path",
      });
    const resolved = await realpath(path);
    const allowed = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
    if (!allowed.some((root) => contained(root, resolved))) {
      throw new OpensteerError({
        code: "forbidden",
        message: "ACP file read is outside the session roots",
      });
    }
    const bytes = await readFile(resolved);
    if (bytes.includes(0))
      throw new OpensteerError({
        code: "bad_request",
        message: "ACP cannot read binary files as text",
      });
    const text = bytes.toString("utf8");
    if (line === null || line === undefined) return text;
    const start = Math.max(0, line - 1);
    return text
      .split(/(?<=\n)/u)
      .slice(start, limit === null || limit === undefined ? undefined : start + Math.max(0, limit))
      .join("");
  };
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
