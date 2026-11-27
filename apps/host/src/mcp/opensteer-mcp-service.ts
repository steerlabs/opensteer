import { once } from "node:events";
import { discover } from "@opensteer/agent-tools/discover";
import { presentPluginToolResult } from "../plugins/local-tool-results.js";
import { productToolOutput } from "./tool-output.js";
import { ComputerUseOutputSchema } from "@opensteer/agent-tools/outputs";
import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isInitializeRequest,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  agentTools,
  agentToolFamilies,
  toolsFor,
  agentToolAnnotations,
  connectionInstructionsFor,
  connectionDirectTools,
  connectionTaskCreateInput,
  connectionTaskKind,
  connectionToolDescription,
  connectionToolSchema,
  pluginResumeConnectionOutput,
  agentToolFailureResult,
  agentToolRecordResult,
  withoutUnofferedGuidance,
  requestToolNames,
  type AgentTool,
} from "@opensteer/agent-tools";
import {
  AgentOperationIdSchema,
  OpensteerError,
  ToolBlockedError,
  ThreadIdSchema,
  agentAccessChangeWords,
  agentOperationEndingOf,
  agentOperationEndingWords,
  agentWithheldNext,
  type AgentAccessChange,
  type Thread,
  type UserId,
  requestHoldLimitMs,
  shortRequestHoldMs,
  consentAllowsDirectWork,
} from "@opensteer/core";
import {
  admitExecution,
  connectionAfterChange,
  findAgentOperation,
  grantedDeviceApprovals,
  lineageAllowsPersonalContext,
  reachesTarget,
  type OpensteerStore,
} from "@opensteer/database";
import {
  AgentOperationFailure,
  agentOperationRefusal,
  assertOperationArguments,
  operationArgumentDigest,
  scriptFailedNext,
  storedScriptError,
  unknownOperationNext,
  withAgentOperationReceipt,
} from "../agent-sessions/agent-session-service.js";
import { advertisedToolInputSchema } from "../agents/agent-tools-plan.js";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RequestHold } from "./request-hold.js";
import type { SavedLoginService } from "../browser/saved-logins.js";
import type { PluginExecutions } from "../plugins/plugin-executions.js";
import { mcpToolCallId } from "./call-id.js";
import { agentToolFailure, internalToolFailureCode } from "./agent-tool-failure.js";
import { lentDevice, lentNow } from "./lent-now.js";
import { mcpResourceMetadataPath } from "./connections/connection-oauth.js";
import {
  AgentCallerResolver,
  callerLineage,
  callerReader,
  type AgentCaller,
  type RunCaller,
} from "./agent-caller.js";
import { toolAccess } from "./tool-access.js";
import { toolOperationKey } from "./operations.js";
import { browserConnectCompletedNext } from "./handlers/browser.js";
import { endedScriptOutput } from "./handlers/direct.js";
import type { RealtimeHub } from "@opensteer/orchestration";
import type { AgentToolHandlers, ToolCall } from "./handlers/types.js";

/**
 * The tool a name resolves to for this caller. `discover` exists only for a connected agent;
 * anyone else reads it exactly like a name that never existed.
 */
function toolNamed(name: string, caller?: AgentCaller): AgentTool | undefined {
  if (name === "discover") return caller?.kind === "connection" ? discover : undefined;
  return agentTools.find((spec) => spec.name === name);
}
/**
 * A connected agent learns of a task's pending Requests only from `pendingRequest`, which the
 * origin predicate chose; a task's count of them is never part of what it is told.
 */
function withoutRequestCounts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRequestCounts);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "pendingRequests")
      .map(([key, entry]) => [key, withoutRequestCounts(entry)]),
  );
}
const requestTools = new Set<string>(requestToolNames);
function parseToolInput(tool: AgentTool, caller: AgentCaller, value: unknown) {
  return caller.kind === "connection" && tool.name === "opensteer_task_create"
    ? connectionTaskCreateInput.parse(value)
    : tool.input.parse(value);
}

const maximumSessions = 256;
const sessionIdleLifetimeMs = 30 * 60 * 1_000;
/**
 * How long work a session's call runs, which the change that ended the session's authority (a
 * Disconnect, an expiry, a narrowed grant) is stopping, has to return its own ending. Only that
 * work waits; any other call is ended at once.
 */
const retiringCallGraceMs = 2_000;
/** How long a call ended with its refusal has to write it before its response is cut. */
const retiringRefusalGraceMs = 1_000;

/**
 * One call a session is answering: its own stop, the operation it may run, and, once the
 * session's authority has ended or changed, what happened to it: from then on the call's answer
 * is its receipt, never its content.
 */
interface McpCall {
  readonly stop: AbortController;
  operationKey?: string;
  ended?: Promise<AgentAccessChange>;
}

/**
 * The one rule for a call answered after its session's authority ended or changed: its answer is
 * its receipt, never its content. The receipt is the operation's true status, its taskId and
 * operationId when it has them, and the Home's own words for why the content is not there; no
 * script output, result body, diagnostics or target names. A call with no operation (a read, a
 * wait, discover) gets the Home's words alone.
 */
function receiptAfterAccessChange(
  result: Awaited<ReturnType<OpensteerMcpService["callToolResult"]>>,
  change: AgentAccessChange,
) {
  const words = agentAccessChangeWords[change];
  const receipt = result.structuredContent as Record<string, unknown> | undefined;
  const taskId = ThreadIdSchema.safeParse(receipt?.taskId).data;
  const operationId = AgentOperationIdSchema.safeParse(receipt?.operationId).data;
  const status = receipt?.status;
  if (!taskId || !operationId)
    return agentToolFailureResult({
      code: "access_changed",
      message: words.message,
      next: words.next,
    });
  const identity = { taskId, operationId };
  // The Home's own ending sentences, kept where the work said one of them; nothing else of it.
  const error = z
    .object({ code: z.string(), message: z.string(), next: z.string().nullable() })
    .safeParse(receipt?.error).data;
  const ownEnding =
    error &&
    Object.values(agentOperationEndingWords).some(
      ({ message, next }) => error.message === message && error.next === next,
    )
      ? error
      : undefined;
  switch (status) {
    case "completed":
    case "failed":
      return agentToolRecordResult({
        status,
        ...identity,
        next: agentWithheldNext(status, change),
        ...(status === "failed" ? { isError: true } : {}),
      });
    case "refused":
      return agentToolFailureResult(
        ownEnding
          ? {
              ...ownEnding,
              code: ownEnding.code === "stopped_by_person" ? ownEnding.code : "access_changed",
            }
          : { code: "access_changed", message: words.message, next: "Nothing was sent." },
        undefined,
        { ...identity, status: "refused" },
      );
    case "unknown": {
      const ending =
        typeof receipt?.next === "string" ? agentOperationEndingOf(receipt.next) : null;
      if (ending)
        return agentToolRecordResult({
          status: "unknown",
          ...identity,
          next: unknownOperationNext(ending),
        });
      return agentToolFailureResult(
        ownEnding
          ? {
              ...ownEnding,
              code: ownEnding.code === "stopped_by_person" ? ownEnding.code : "access_changed",
            }
          : {
              code: "access_changed",
              message: words.message,
              next: "Part of it may have happened. Check the current state before doing anything else.",
            },
        undefined,
        { ...identity, status: "unknown" },
      );
    }
    default:
      // Still waiting for the person: its Request stands only while the connection does.
      return agentToolRecordResult({
        status: typeof status === "string" ? status : "pending",
        ...identity,
        next:
          change === "changed"
            ? `${words.message} Call again with this operationId; it now answers under the changed access.`
            : `${words.message} Its Request no longer stands.`,
      });
  }
}
const maximumTimerMs = 2_147_483_647;
interface McpSession {
  readonly responses: Set<ServerResponse>;
  /** Whose Home, and the connected agent whose lineage this session is under, if any. */
  readonly owner: UserId;
  readonly connectionId: string | null;
  /** The authority its tool list was built for; a change closes the session. */
  readonly authority: string;
  /** When the connection's credential expires, in epoch milliseconds. */
  readonly expiresAt: number | null;
  readonly token: string;
  readonly origin: string;
  readonly key: string;
  readonly kind: AgentCaller["kind"];
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  readonly streams: boolean;
  lastSeenAt: number;
}
export class OpensteerMcpService {
  readonly #runtimeOrigin: URL;
  readonly #sessions = new Map<string, McpSession>();
  readonly #activeSessions = new Set<McpSession>();
  /** Sessions whose authority ended, closing once the calls they were answering have answered. */
  readonly #retiring = new Set<McpSession>();
  /** The call each open response answers (`McpCall`). */
  readonly #calls = new WeakMap<ServerResponse, McpCall>();
  readonly #reservations = new Map<string, number>();
  readonly #detachObserve: (() => void) | undefined;
  readonly options: {
    readonly callers: Pick<AgentCallerResolver, "authenticate">;
    readonly handlers: Partial<AgentToolHandlers>;
    readonly requestHold?: Pick<RequestHold, "admit" | "wait">;
    readonly pluginExecutions?: Pick<PluginExecutions, "hold"> &
      Partial<Pick<PluginExecutions, "replayOperation">>;
    readonly longRequestHold?: (caller: RunCaller) => Promise<boolean>;
    readonly realtime?: Pick<RealtimeHub, "observe">;
    readonly store: Pick<OpensteerStore, "readTask" | "threadOrigins"> & {
      readonly requests: Pick<OpensteerStore["requests"], "get">;
      readonly database?: OpensteerStore["database"];
    };
    readonly publicUrl: URL;
    readonly connectionPasswords?: boolean | (() => boolean);
    readonly savedLogins?: Pick<SavedLoginService, "replaySessionCredential">;
    /** A failure the caller was told only that something went wrong. */
    readonly onToolError?: (error: unknown, tool: string) => void;
  };
  constructor(options: {
    readonly callers: Pick<AgentCallerResolver, "authenticate">;
    readonly handlers: Partial<AgentToolHandlers>;
    readonly requestHold?: Pick<RequestHold, "admit" | "wait">;
    readonly pluginExecutions?: Pick<PluginExecutions, "hold"> &
      Partial<Pick<PluginExecutions, "replayOperation">>;
    readonly longRequestHold?: (caller: RunCaller) => Promise<boolean>;
    readonly realtime?: Pick<RealtimeHub, "observe">;
    readonly store: Pick<OpensteerStore, "readTask" | "threadOrigins"> & {
      readonly requests: Pick<OpensteerStore["requests"], "get">;
      readonly database?: OpensteerStore["database"];
    };
    readonly publicUrl: URL;
    readonly connectionPasswords?: boolean | (() => boolean);
    readonly savedLogins?: Pick<SavedLoginService, "replaySessionCredential">;
    readonly onToolError?: (error: unknown, tool: string) => void;
  }) {
    this.options = options;
    this.#runtimeOrigin = options.publicUrl;
    this.#detachObserve = options.realtime?.observe((change) => {
      if (change.type.startsWith("host.")) void this.#revalidateConnections();
    });
    // Idle sessions close on time, not only when the next request arrives.
    this.#sweepTimer = setInterval(() => void this.#sweep(), sessionIdleLifetimeMs / 6);
    this.#sweepTimer.unref();
  }
  readonly #sweepTimer: ReturnType<typeof setInterval>;
  /**
   * `connectionOrigin` is the approved connection route this request arrived
   * on, which the connection routes validated; only connected agents use it,
   * and Runs and programs stay on the runtime origin.
   */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
    token: string,
    connectionOrigin?: string,
  ): Promise<void> {
    const origin = connectionOrigin ? new URL(connectionOrigin) : this.#runtimeOrigin;
    try {
      assertRequestOrigin(request, origin);
    } catch (error) {
      sendJsonRpcError(response, 403, safeMessage(error, safeMessageOptions));
      return;
    }
    // Before anything waits: a close missed here would leave this response open forever.
    const disconnected = new AbortController();
    response.once("close", () => disconnected.abort(new Error("MCP client disconnected")));
    const call: McpCall = { stop: disconnected };
    this.#calls.set(response, call);
    const ended = responseEnded(response);
    let authorization: AgentCaller;
    try {
      authorization =
        ((request as IncomingMessage & { auth?: AuthInfo }).auth?.extra?.caller as
          AgentCaller | undefined) ?? (await this.options.callers.authenticate(token));
    } catch {
      response.setHeader(
        "www-authenticate",
        connectionOrigin
          ? `Bearer resource_metadata="${origin.origin}${mcpResourceMetadataPath}"`
          : 'Bearer realm="opensteer-agent-tools"',
      );
      sendJsonRpcError(response, 401, "Agent tools authorization is invalid or expired");
      return;
    }
    if ((authorization.kind === "connection") !== (connectionOrigin !== undefined)) {
      sendJsonRpcError(response, 403, "MCP request Host is not allowed");
      return;
    }
    await this.#sweep();
    if (disconnected.signal.aborted) return;
    // The SDK hands this to each tool call as its `authInfo`.
    (request as IncomingMessage & { auth?: AuthInfo }).auth = {
      clientId: authorization.key,
      scopes: [],
      token,
      extra: {
        disconnected: disconnected.signal,
        call,
        caller: authorization,
      },
    };
    const sessionId = singleHeader(request.headers["mcp-session-id"]);
    let session: McpSession;
    let createdSession = false;

    if (sessionId) {
      let existing = this.#sessions.get(sessionId);
      // A session's tools were listed for one authority; a changed grant or mode retires it.
      if (existing && existing.authority !== sessionAuthority(authorization)) {
        await this.#closeSession(existing, "changed");
        existing = undefined;
      }
      if (
        !existing ||
        existing.key !== authorization.key ||
        existing.kind !== authorization.kind ||
        existing.origin !== origin.origin
      ) {
        await this.#serveDetached(request, response, body, ended, {
          ...authorization,
          origin,
          token,
          sessionId,
        });
        return;
      }
      existing.lastSeenAt = Date.now();
      session = existing;
    } else {
      if (request.method !== "POST" || !isInitializeRequest(body)) {
        sendJsonRpcError(response, 400, "A valid MCP initialization request is required");
        return;
      }
      if (!this.#reserve(authorization)) {
        sendJsonRpcError(response, 503, "The Host has reached its MCP session limit");
        return;
      }
      try {
        session = await this.#createSession({ ...authorization, origin, token });
        createdSession = true;
        // An update or revoke that committed while this session registered must not leave it
        // advertising authority that already changed.
        const current = await this.options.callers.authenticate(token).catch(() => null);
        if (!current || sessionAuthority(current) !== session.authority) {
          this.#release(authorization.key);
          await this.#closeSession(session, current ? "changed" : undefined);
          sendJsonRpcError(response, 401, "Agent tools authorization is invalid or expired");
          return;
        }
      } catch (error) {
        this.#release(authorization.key);
        sendJsonRpcError(response, 500, safeMessage(error, safeMessageOptions));
        return;
      }
    }

    void responseLifetime(session, response, ended);
    try {
      await session.transport.handleRequest(request, response, body);
    } catch (error) {
      if (createdSession) {
        const initializedId = session.transport.sessionId;
        if (initializedId) this.#sessions.delete(initializedId);
        this.#activeSessions.delete(session);
        await session.server.close().catch(() => undefined);
      }
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, safeMessage(error, safeMessageOptions));
      }
    } finally {
      if (createdSession) this.#release(authorization.key);
    }
  }

  async close(): Promise<void> {
    this.#detachObserve?.();
    clearInterval(this.#sweepTimer);
    const sessions = [...this.#activeSessions, ...this.#retiring];
    this.#activeSessions.clear();
    this.#retiring.clear();
    this.#sessions.clear();
    await Promise.allSettled(
      sessions.map(async (session) => {
        for (const response of session.responses) response.destroy();
        await session.server.close();
      }),
    );
  }

  /**
   * Serves one request on a session this Host does not hold for its token: one
   * from before a Host restart, one swept while its Run waited, or one an
   * earlier Run opened in an engine kept running for its Thread's next Run.
   * Engines keep the session they were given rather than initialize again. The
   * request's token is the whole authority, as for any session, and its tool
   * calls are named by its own Run; the session the Host holds for another is
   * neither read nor closed.
   */
  async #serveDetached(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
    ended: Promise<void>,
    input: AgentCaller & {
      readonly token: string;
      readonly origin: URL;
      readonly sessionId: string;
    },
  ): Promise<void> {
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST") {
      // There is no server-to-client stream to resume; a POST carries replies.
      response.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    if (!this.#reserve(input)) {
      sendJsonRpcError(response, 503, "The Host has reached its MCP session limit");
      return;
    }
    let session: McpSession | undefined;
    try {
      session = await this.#createSession(input);
    } finally {
      this.#release(input.key);
    }
    const completed = responseLifetime(session, response, ended);
    try {
      await session.transport.handleRequest(request, response, body);
      // A stream outlives handleRequest, and this session closes with its one response.
      if (session.streams) await completed;
    } catch (error) {
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, safeMessage(error, safeMessageOptions));
      }
    } finally {
      this.#activeSessions.delete(session);
      await session.server.close().catch(() => undefined);
    }
  }

  /**
   * A session the Host holds, or with `sessionId` a one-request session that
   * serves an id it no longer holds.
   */
  async #createSession(
    input: AgentCaller & {
      readonly token: string;
      readonly origin: URL;
      readonly sessionId?: string;
    },
  ): Promise<McpSession> {
    let session!: McpSession;
    const longRequestHold =
      input.kind === "run" && (await this.options.longRequestHold?.(input)) === true;
    const enableJsonResponse = !longRequestHold;
    const transport = new StreamableHTTPServerTransport(
      input.sessionId
        ? {
            allowedHosts: [input.origin.host],
            allowedOrigins: [input.origin.origin],
            enableDnsRebindingProtection: true,
            enableJsonResponse,
          }
        : {
            allowedHosts: [input.origin.host],
            allowedOrigins: [input.origin.origin],
            enableDnsRebindingProtection: true,
            enableJsonResponse,
            onsessionclosed: (closedId) => {
              this.#sessions.delete(closedId);
            },
            onsessioninitialized: (initializedId) => {
              this.#sessions.set(initializedId, session);
            },
            sessionIdGenerator: randomUUID,
          },
    );
    const server = await this.createServer(input, input.sessionId, longRequestHold);
    try {
      // SDK 1.30's Node transport declares optional callbacks more narrowly
      // than its own Transport interface under exactOptionalPropertyTypes.
      await server.connect(transport as unknown as Transport);
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }
    session = {
      responses: new Set(),
      owner: input.userId,
      connectionId: callerLineage(input)?.agentConnectionId ?? null,
      authority: sessionAuthority(input),
      expiresAt: input.kind === "connection" ? (input.expiresAt ?? null) : null,
      token: input.token,
      origin: input.origin.origin,
      key: input.key,
      kind: input.kind,
      lastSeenAt: Date.now(),
      server,
      streams: longRequestHold,
      transport,
    };
    this.#activeSessions.add(session);
    // A held stream never outlives the credential that opened it: a near expiry closes it on
    // time, a distant one is caught by the periodic sweep.
    const untilExpiry =
      input.kind === "connection" && input.expiresAt !== undefined
        ? Math.max(0, input.expiresAt - Date.now())
        : undefined;
    const expiry =
      untilExpiry !== undefined && untilExpiry <= maximumTimerMs
        ? setTimeout(() => void this.#closeSession(session, "expired"), untilExpiry)
        : undefined;
    expiry?.unref();
    transport.onclose = () => {
      clearTimeout(expiry);
      this.#activeSessions.delete(session);
      const id = transport.sessionId;
      if (id) this.#sessions.delete(id);
    };
    return session;
  }

  async createServer(
    caller: AgentCaller,
    detachedSessionId?: string,
    longRequestHold = false,
  ): Promise<McpServer> {
    const offered = await this.#toolsFor(caller);
    const server = new McpServer(
      { name: "opensteer", version: "1.0.0" },
      {
        maxToolInputElements: 10_000,
        ...(caller.kind === "connection"
          ? { instructions: connectionInstructionsFor(caller.grant, offered) }
          : {}),
      },
    );
    const advertisedTools: Tool[] = [];
    for (const tool of offered) {
      const annotations = agentToolAnnotations(tool);
      const registration = {
        annotations,
        description:
          caller.kind === "connection"
            ? connectionToolDescription(tool, caller.grant)
            : tool.description,
        title: tool.title,
        // callTool validates every call against the tool's own schema, so a
        // refusal names its field; the SDK only hands the arguments through.
        inputSchema: z.looseObject({}),
      };
      advertisedTools.push(
        caller.kind === "connection"
          ? {
              name: tool.name,
              description: registration.description,
              ...(annotations.readOnlyHint ? { annotations: { readOnlyHint: true } } : {}),
              inputSchema: advertisedToolInputSchema({
                input: tool.input,
                advertisedInputSchema: connectionToolSchema(tool, caller.grant),
              }) as Tool["inputSchema"],
            }
          : {
              name: tool.name,
              ...registration,
              inputSchema: advertisedToolInputSchema(tool) as Tool["inputSchema"],
              execution: { taskSupport: "forbidden" },
            },
      );
      server.registerTool(tool.name, registration, async (args, extra) => {
        const disconnected = extra.authInfo?.extra?.disconnected;
        const call = extra.authInfo?.extra?.call as McpCall | undefined;
        const operationKey = mcpToolCallId(
          caller.key,
          detachedSessionId ?? extra.sessionId,
          extra.requestId,
          tool.name,
        );
        const result = await this.callToolResult(extra.authInfo?.token ?? "", tool.name, args, {
          operationKey,
          ...(call ? { keyed: (key: string) => (call.operationKey = key) } : {}),
          signal:
            disconnected instanceof AbortSignal
              ? AbortSignal.any([extra.signal, disconnected])
              : extra.signal,
          longRequestHold,
          ...(extra.authInfo?.extra?.caller
            ? { caller: extra.authInfo.extra.caller as AgentCaller }
            : {}),
        });
        // The one place a result is written: once the session's authority has ended, only an
        // ending goes out (a stopped operation's unknown, or a refusal), never a result. A
        // result that completed in the meantime stays true in its operation's record.
        return call?.ended ? receiptAfterAccessChange(result, await call.ended) : result;
      });
    }
    // A grant may imply no tools at all; the list is still served, empty.
    if (!advertisedTools.length) server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: advertisedTools,
    }));
    return server;
  }
  /** The Run relay's input check; it has no connected caller, so `discover` is unknown here. */
  validateToolInput(name: string, value: unknown): unknown {
    const tool = toolNamed(name);
    if (!tool) throw unknownTool();
    return tool.input.parse(value);
  }

  async callToolResult(
    bearer: string,
    name: string,
    args: unknown,
    identity: {
      readonly operationKey: string;
      readonly signal?: AbortSignal;
      readonly caller?: AgentCaller;
      readonly longRequestHold?: boolean;
      /** Told the key of the operation this call runs, once it is known. */
      readonly keyed?: (key: string) => void;
    },
  ) {
    let tool = toolNamed(name);
    const present =
      name === "plugin_call" || name === "plugin_resume"
        ? presentPluginToolResult
        : agentToolRecordResult;
    const admittedAt = Date.now();
    const signal = identity.signal ?? new AbortController().signal;
    let failureCaller: AgentCaller | undefined;
    try {
      const token = bearer;
      if (!token) throw new Error("MCP authorization is missing");
      const currentCaller = identity.caller ?? (await this.options.callers.authenticate(token));
      failureCaller = currentCaller;
      tool = toolNamed(name, currentCaller);
      const pluginHold =
        currentCaller.kind === "run" &&
        ["plugin_call", "plugin_execute", "plugin_resume"].includes(name) &&
        this.options.pluginExecutions
          ? {
              caller: currentCaller,
              service: this.options.pluginExecutions,
              steersAtAdmission: (await this.options.requestHold?.admit(currentCaller)) ?? 0,
            }
          : null;
      const hold =
        currentCaller.kind === "run" && requestTools.has(name) && this.options.requestHold
          ? {
              caller: currentCaller,
              service: this.options.requestHold,
              steersAtAdmission: await this.options.requestHold.admit(currentCaller),
            }
          : null;
      const answered = await abortableToolResult(
        this.callTool(token, name, args, {
          caller: currentCaller,
          operationKey: identity.operationKey,
          signal,
          ...(identity.keyed ? { keyed: identity.keyed } : {}),
        }),
        signal,
      );
      // What Opensteer wrote for its own agents never names a tool this connection lacks.
      const result =
        currentCaller.kind === "connection" && typeof answered !== "string"
          ? withoutUnofferedGuidance(
              answered,
              new Set((await this.#toolsFor(currentCaller)).map(({ name }) => name)),
            )
          : answered;
      // A text result is the whole answer, sent once as written.
      // Each result goes out once, in the shape a model reads best: text as
      // written, a provider's content (text, images, its error) as it came,
      // and a record as JSON with its structured copy.
      if (typeof result === "string") return { content: [{ type: "text" as const, text: result }] };
      if (tool?.output === ComputerUseOutputSchema) {
        const script = ComputerUseOutputSchema.parse(result);
        const { status, taskId, operationId, next, ending } = script.structuredContent ?? {};
        if (
          currentCaller.kind !== "connection" ||
          typeof status !== "string" ||
          typeof taskId !== "string" ||
          typeof operationId !== "string"
        )
          return script;
        const receipt = {
          status,
          taskId,
          operationId,
          ...(typeof next === "string" ? { next } : {}),
          ...(typeof ending === "string" ? { ending } : {}),
        };
        return {
          ...script,
          content: [
            ...script.content,
            { type: "text" as const, text: `Receipt: ${JSON.stringify(receipt)}` },
          ],
        };
      }
      if (pluginHold && result.status === "pending" && typeof result.executionId === "string") {
        const held = await pluginHold.service.hold({
          caller: pluginHold.caller,
          record: result,
          admittedAt,
          steersAtAdmission: pluginHold.steersAtAdmission,
          signal,
          limitMs:
            (identity.longRequestHold ?? (await this.options.longRequestHold?.(pluginHold.caller)))
              ? requestHoldLimitMs
              : shortRequestHoldMs,
        });
        return present(held);
      }
      if (hold && typeof result.requestId === "string") {
        const held = await hold.service.wait({
          caller: hold.caller,
          result,
          tool: name,
          admittedAt,
          steersAtAdmission: hold.steersAtAdmission,
          signal,
          limitMs:
            (identity.longRequestHold ?? (await this.options.longRequestHold?.(hold.caller)))
              ? requestHoldLimitMs
              : shortRequestHoldMs,
        });
        if (held) return present(held.record);
      }
      const presented = present(result);
      return name === "discover" && "error" in result
        ? { ...presented, isError: true as const }
        : presented;
    } catch (error) {
      const parsed =
        error instanceof OpensteerError && error.message === unknownToolMessage
          ? undefined
          : tool?.input.safeParse(args);
      const access =
        parsed?.success && tool && "readsOnly" in tool && tool.readsOnly?.(parsed.data as never)
          ? "read"
          : (tool?.access ?? "write");
      const failure = agentToolFailure(
        error instanceof AgentOperationFailure ? error.cause : error,
        access,
        // Only a device's own refusal names a Device; nothing is read for any other failure.
        failureCaller && namesDevice(error instanceof AgentOperationFailure ? error.cause : error)
          ? await this.#visibleDevices(failureCaller)
          : () => false,
        // Under a connection's grant: the connection, or a Run in its lineage (AD11).
        failureCaller ? callerLineage(failureCaller) !== null : false,
      );
      if (failure.code === internalToolFailureCode && !signal.aborted)
        this.options.onToolError?.(error, name);
      const connection =
        failureCaller?.kind === "connection"
          ? {
              tools: new Set((await this.#toolsFor(failureCaller)).map(({ name }) => name)),
              notFoundMessage: connectionNotFoundMessage(name, failure.message),
            }
          : undefined;
      return agentToolFailureResult(
        failure,
        connection,
        error instanceof AgentOperationFailure || error instanceof ToolBlockedError
          ? error.receipt
          : undefined,
      );
    }
  }

  async callTool(
    bearer: string,
    name: string,
    value: unknown,
    identity: {
      readonly operationKey: string;
      readonly signal?: AbortSignal;
      readonly caller?: AgentCaller;
      /**
       * How the Home re-resolves a caller it holds no bearer for (a messaging bridge): the same
       * live re-check a signed-in caller gets before its effect.
       */
      readonly resolveCaller?: () => Promise<AgentCaller>;
      /** Told the key of the operation this call runs, once it is known. */
      readonly keyed?: (key: string) => void;
    },
  ): Promise<Record<string, unknown> | string> {
    if (!toolNamed(name) && name !== "discover") throw unknownTool();
    const authenticate = () =>
      identity.resolveCaller ? identity.resolveCaller() : this.options.callers.authenticate(bearer);
    let caller = identity.caller ?? (await authenticate());
    const found = toolNamed(name, caller);
    if (!found) throw unknownTool();
    const tool = found;
    if (caller.kind === "connection") await this.assertToolOffered(caller, name);
    const input = parseToolInput(tool, caller, value);
    if (!this.options.handlers[tool.name])
      throw new OpensteerError({
        code: "not_found",
        message: "This tool is unavailable on this Host",
      });
    let key = toolOperationKey(caller, input, identity.operationKey);
    identity.keyed?.(key);
    const database = this.options.store.database;
    let resume: Awaited<ReturnType<typeof findAgentOperation>>;
    const operationId = "operationId" in input ? input.operationId : undefined;
    identity.signal?.throwIfAborted();
    if (operationId && caller.kind !== "connection")
      throw new OpensteerError({
        code: "bad_request",
        message: "operationId is for connected agents only.",
      });
    if (operationId && (!connectionDirectTools.has(name) || !database))
      throw new OpensteerError({ code: "not_found", message: "Operation is unavailable." });
    if (caller.kind === "connection" && connectionDirectTools.has(name) && database) {
      let row = await findAgentOperation(database, {
        userId: caller.userId,
        agentConnectionId: caller.connectionId,
        identity: operationId ? { id: operationId } : { key },
      });
      if (operationId && !row)
        throw new OpensteerError({ code: "not_found", message: "Operation is unavailable." });
      // A replay is a call: nothing of its row is returned unless the connection may still reach
      // its target under the grant it holds now. Outside it, any replay (by operationId or by
      // operationKey alone) reads exactly as an unknown operation and never reuses the key to run
      // a new effect.
      if (row && !(await this.#reachable(caller, row)))
        throw new OpensteerError({ code: "not_found", message: "Operation is unavailable." });
      if (row) {
        const taskId =
          "taskId" in input ? ThreadIdSchema.optional().parse(input.taskId) : undefined;
        assertOperationArguments(row, operationArgumentDigest(name, input), taskId);
        key = row.operationKey;
        identity.keyed?.(key);
        resume = row;
        const base = {
          taskId: row.taskId,
          operationId: row.id,
          ...(row.ending ? { ending: row.ending } : {}),
        };
        if (row.state === "refused")
          throw new AgentOperationFailure(agentOperationRefusal(row.decision, row.ending), {
            ...base,
            status: "refused",
          });
        if (row.state === "unknown" || row.state === "failed" || row.state === "completed") {
          const connection = caller;
          await withAgentOperationReceipt(database, row, row.taskId, () =>
            this.assertToolOffered(connection, name),
          );
          const status = row.state;
          if (
            (status === "failed" || status === "unknown") &&
            tool.output === ComputerUseOutputSchema
          ) {
            const error = storedScriptError(row);
            if (error) {
              const grant = row.target.grant;
              return endedScriptOutput(
                {
                  ...base,
                  status,
                  ...(grant.kind === "browser-profile" ? { profileId: grant.profileId } : {}),
                  next: status === "unknown" ? unknownOperationNext(row.ending) : scriptFailedNext,
                },
                error,
              );
            }
          }
          const request =
            status === "completed" && name === "ask_person" && row.requestId
              ? await this.options.store.requests.get(row.requestId)
              : null;
          const answer =
            request?.status === "fulfilled" && request.response?.kind === "form"
              ? request.response.answers.question_1?.[0]
              : undefined;
          const plugin =
            status === "completed" &&
            (name === "plugin_call" || name === "plugin_execute" || name === "plugin_resume")
              ? await withAgentOperationReceipt(database, row, row.taskId, async () =>
                  this.options.pluginExecutions?.replayOperation?.(
                    connection,
                    row,
                    identity.signal,
                  ),
                )
              : undefined;
          const credential =
            status === "completed" &&
            (name === "saved_login_request" || name === "card_request") &&
            row.sessionStatus === "active"
              ? await withAgentOperationReceipt(database, row, row.taskId, async () =>
                  this.options.savedLogins?.replaySessionCredential(row.id),
                )
              : undefined;
          const receipt = {
            ...plugin,
            ...credential,
            taskId: base.taskId,
            ...(name === "plugin_resume" && plugin?.status === "pending"
              ? {}
              : { operationId: base.operationId }),
            ...(row.ending ? { ending: row.ending } : {}),
            status: plugin?.status ?? status,
            ...(answer !== undefined ? { answer } : {}),
            ...(status === "completed"
              ? {
                  summary: row.resultSummary,
                  ...(name === "browser_connect" ? { next: browserConnectCompletedNext } : {}),
                }
              : {
                  next:
                    status !== "unknown"
                      ? "It failed. Check the current state."
                      : name === "computer_use" && row.effect === "read" && !row.ending
                        ? "Opensteer lost the result of this read, which could not send input to the device."
                        : unknownOperationNext(row.ending),
                }),
          };
          if (tool.output === ComputerUseOutputSchema)
            return {
              content: [
                {
                  type: "text",
                  text: "next" in receipt ? receipt.next : "This script already ran.",
                },
              ],
              structuredContent: receipt,
            };
          return receipt;
        }
      }
    }
    const check = async () => {
      identity.signal?.throwIfAborted();
      if (caller.kind === "connection") {
        await this.assertToolOffered(caller, name);
        await this.#assertConnectionTaskKind(caller, name, input);
      }
      const access = "readsOnly" in tool && tool.readsOnly?.(input as never) ? "read" : tool.access;
      const queue =
        caller.kind === "connection" &&
        tool.name === "opensteer_task_send" &&
        "delivery" in input &&
        input.delivery === "queue";
      const targets = await this.#targets(caller, tool, input, access !== "read" || queue);
      toolAccess[queue ? "read" : access](caller, targets);
      if (
        caller.kind !== "connection" &&
        !(await this.#toolsFor(caller)).some((spec) => spec.name === tool.name)
      )
        throw unavailableTool(caller, tool.name);
      const authorize = this.options.handlers[tool.name]?.authorize as
        ((call: ToolCall<typeof tool.name>) => Promise<void>) | undefined;
      await authorize?.({
        caller,
        input,
        operationKey: key,
        ...(identity.signal ? { signal: identity.signal } : {}),
      });
    };
    const invoke = async () => {
      const liveCaller = async () => {
        identity.signal?.throwIfAborted();
        caller = await authenticate();
        await check();
        return caller;
      };
      const call: ToolCall<typeof tool.name> = {
        checkLive: async () => {
          await liveCaller();
        },
        ...(tool.name === "discover" ? { liveCaller } : {}),
        caller,
        input,
        operationKey: key,
        ...(identity.signal ? { signal: identity.signal } : {}),
      };
      // A registry key fixes both schemas and the handler. Parsing above supplies
      // the corresponding member of the input union to the exhaustive map.
      const handler = this.options.handlers[tool.name] as (
        call: ToolCall<typeof tool.name>,
      ) => Promise<unknown>;
      identity.signal?.throwIfAborted();
      const handled = await handler(call);
      const raw = handled;
      identity.signal?.throwIfAborted();
      const outputSchema =
        caller.kind === "connection" && name === "plugin_resume"
          ? pluginResumeConnectionOutput
          : tool.output;
      const output = outputSchema.safeParse(
        /^(opensteer_(task|delegation|subagent|request|automation|app)_|person_)/.test(tool.name)
          ? productToolOutput(raw)
          : raw,
      );
      // A result outside the contract is the Host's fault, never the caller's arguments.
      // Field paths only: a value could be anything the tool returned.
      if (!output.success)
        throw new Error(
          `Opensteer produced an invalid result for this tool at ${[
            ...new Set(output.error.issues.map(({ path }) => path.join(".") || "(result)")),
          ].join(", ")}`,
        );
      return (
        caller.kind === "connection" && name.startsWith("opensteer_task_")
          ? withoutRequestCounts(output.data)
          : output.data
      ) as Record<string, unknown> | string;
    };
    const perform = async () => {
      await check();
      return invoke();
    };
    return resume && database
      ? withAgentOperationReceipt(database, resume, resume.taskId, perform)
      : perform();
  }

  /** Refuses a tool this caller's current authority does not offer. */
  /**
   * Before an earlier result of this call is returned again: the same checks the call itself
   * passed (tool offered, task targets, the tool's own target authorization), under the caller's
   * authority now.
   */
  async authorizeReplay(caller: AgentCaller, name: string, value: unknown): Promise<void> {
    const found = toolNamed(name, caller);
    if (!found) throw unknownTool();
    const tool = found;
    if (caller.kind === "connection") await this.assertToolOffered(caller, name);
    const input = parseToolInput(tool, caller, value);
    if (caller.kind === "connection") await this.#assertConnectionTaskKind(caller, name, input);
    const access = "readsOnly" in tool && tool.readsOnly?.(input as never) ? "read" : tool.access;
    const queue =
      caller.kind === "connection" &&
      tool.name === "opensteer_task_send" &&
      "delivery" in input &&
      input.delivery === "queue";
    const targets = await this.#targets(caller, tool, input, access !== "read" || queue);
    toolAccess[queue ? "read" : access](caller, targets);
    if (caller.kind !== "connection") await this.assertToolOffered(caller, name);
    const authorize = this.options.handlers[tool.name]?.authorize as
      ((call: ToolCall<typeof tool.name>) => Promise<void>) | undefined;
    await authorize?.({
      caller,
      input,
      operationKey: toolOperationKey(caller, input, `replay:${name}`),
    });
  }
  async assertToolOffered(caller: AgentCaller, name: string): Promise<void> {
    if (!toolNamed(name, caller)) throw unknownTool();
    if (!(await this.#toolsFor(caller)).some((spec) => spec.name === name))
      throw caller.kind === "connection" ? unknownTool() : unavailableTool(caller, name);
  }
  /**
   * The person's Devices a failure may name to this caller: of what its connection lineage is lent
   * now. Without the Home's database to read the rule, a selected grant learns of none.
   */
  async #visibleDevices(caller: AgentCaller): Promise<(deviceId: string) => boolean> {
    const database = this.options.store.database;
    if (database)
      return lentDevice(
        await lentNow(caller, (owner, grant) => grantedDeviceApprovals(database, owner, grant)),
      );
    return callerLineage(caller)?.grant.scope === "selected" ? () => false : () => true;
  }

  async #toolsFor(caller: AgentCaller) {
    const offered = toolsFor({
      ...caller,
      // The same grant-derived set a lineage Run's dispatch plan carries.
      ...(callerLineage(caller) ? { grant: callerLineage(caller)!.grant } : {}),
      personalContext:
        caller.kind === "connection" ||
        lineageAllowsPersonalContext(caller.agentConnection ?? null),
    });
    const passwords = this.options.connectionPasswords;
    if (caller.kind !== "connection") return offered;
    // Direct work only for a connection whose consent covers it: the same predicate its calls
    // are refused by (B5). A connection with no row read reads as consenting to none.
    const direct = consentAllowsDirectWork(caller.agentConnection?.consentVersion ?? 0);
    const passwordsOff = typeof passwords === "function" ? !passwords() : passwords === false;
    return offered.filter(
      ({ name }) =>
        (direct || !connectionDirectTools.has(name)) &&
        !(passwordsOff && (name === "saved_login_request" || name === "card_request")),
    );
  }
  async #assertConnectionTaskKind(
    caller: Extract<AgentCaller, { kind: "connection" }>,
    tool: string,
    input: object,
  ): Promise<void> {
    const kind = connectionTaskKind(tool);
    const database = this.options.store.database;
    if (!database || !kind || !("taskId" in input) || typeof input.taskId !== "string") return;
    const id = ThreadIdSchema.parse(input.taskId);
    const task = await database
      .selectFrom("threads")
      .select(["worker", "originConnectionId"])
      .where("id", "=", id)
      .where("createdBy", "=", caller.userId)
      .where("removedAt", "is", null)
      .$if(caller.grant.scope === "selected", (query) =>
        query.where("originConnectionId", "=", caller.connectionId),
      )
      .executeTakeFirst();
    if (
      kind === "direct" &&
      task?.originConnectionId === caller.connectionId &&
      task.worker !== "external"
    )
      throw new OpensteerError({
        code: "conflict",
        message:
          "That taskId belongs to a task run by one of the person's agents. Pass a direct-work taskId returned by a direct tool, or omit taskId to start or continue direct work.",
      });
    if (kind === "person-agent" && task?.worker === "external") {
      if (task.originConnectionId !== caller.connectionId)
        throw new OpensteerError({ code: "forbidden", message: "Task is unavailable" });
      throw new OpensteerError({
        code: "conflict",
        message:
          "That taskId is for work you do directly. Pass a taskId for work run by one of the person's agents, such as one returned by opensteer_task_create.",
      });
    }
  }
  /**
   * The tasks a call names, read as its caller reads them. For a change (`write`), a task the
   * caller's lineage may not change (with Everything, another connected agent's) reads as one that
   * does not exist, before its state or its mode is looked at: every write tool refuses it the
   * same way, in the words a missing task gets.
   */
  async #targets(
    caller: AgentCaller,
    tool: AgentTool,
    input: object,
    write: boolean,
  ): Promise<Thread[]> {
    const ids: Thread["id"][] = [];
    const record = input as Record<string, unknown>;
    const add = async (value: unknown) => {
      const id = ThreadIdSchema.safeParse(value);
      if (id.success) ids.push(id.data);
    };
    for (const field of tool.targetFields ?? []) await add(record[field]);
    const targets = this.options.handlers[tool.name]?.targets as
      ((call: ToolCall<typeof tool.name>) => Promise<readonly string[]>) | undefined;
    if (targets)
      for (const value of await targets({ caller, input } as ToolCall<typeof tool.name>))
        await add(value);
    const lineage = callerLineage(caller);
    const selected = lineage?.grant.scope === "selected" ? lineage.agentConnectionId : undefined;
    const writableBy =
      write && lineage && selected === undefined ? lineage.agentConnectionId : undefined;
    return Promise.all(
      [...new Set(ids)].map(async (id) => {
        // A task its caller may not read (a memory pass's lineage, one without personal context)
        // is refused here as a task that does not exist is, in the same words.
        const thread = await this.options.store.readTask(callerReader(caller), id, caller.userId, {
          ...(selected === undefined ? {} : { lineageConnectionId: selected }),
          ...(writableBy === undefined ? {} : { writableBy }),
        });
        // One refusal; agentToolFailure says it as not_found to every caller under a grant.
        if (!thread)
          throw new OpensteerError({ code: "forbidden", message: "Task is unavailable" });
        return thread;
      }),
    );
  }
  #reserve(caller: AgentCaller): boolean {
    const reserved = [...this.#reservations.values()].reduce((sum, count) => sum + count, 0);
    const count = this.#activeSessions.size + reserved;
    const own =
      [...this.#activeSessions].filter((s) => s.key === caller.key).length +
      (this.#reservations.get(caller.key) ?? 0);
    if (
      count >= maximumSessions ||
      (caller.kind === "connection" && (own >= 8 || count >= maximumSessions - 32))
    )
      return false;
    this.#reservations.set(caller.key, (this.#reservations.get(caller.key) ?? 0) + 1);
    return true;
  }
  #release(key: string) {
    const reservation = this.#reservations.get(key);
    if (reservation === 1) this.#reservations.delete(key);
    else if (reservation) this.#reservations.set(key, reservation - 1);
  }
  /**
   * A connected agent's sessions, and those of work in its lineage, end when its authority ends or
   * changes; a new session lists the tools its grant now implies.
   */
  async #revalidateConnections() {
    await Promise.allSettled(
      [...this.#activeSessions]
        .filter((s) => s.kind === "connection" || s.authority !== "")
        .map(async (session) => {
          const current = await this.options.callers.authenticate(session.token).catch(() => null);
          if (current && sessionAuthority(current) === session.authority) return;
          // Still authenticated: its grant or mode moved, either way. Otherwise, as it stands.
          await this.#closeSession(session, current ? "changed" : undefined);
        }),
    );
  }
  /** Closes every session held by a connection or by work in its lineage. */
  async closeLineage(connectionId: string, minimumGrantRevision?: number): Promise<void> {
    await Promise.allSettled(
      [...this.#activeSessions]
        .filter(({ authority }) => {
          const [id, revision] = authority.split(":");
          return (
            id === connectionId &&
            (minimumGrantRevision === undefined || Number(revision) < minimumGrantRevision)
          );
        })
        .map((session) =>
          this.#closeSession(session, minimumGrantRevision !== undefined ? "changed" : undefined),
        ),
    );
  }
  /**
   * A session whose authority ended takes nothing new at once (its credential no longer
   * authenticates, and it is no longer found), and from then on writes only an ending on the calls
   * it is answering (`McpCall.ended`). Streams carry no call's answer and end now.
   */
  async #closeSession(session: McpSession, change?: AgentAccessChange) {
    this.#activeSessions.delete(session);
    for (const [id, held] of this.#sessions) if (held === session) this.#sessions.delete(id);
    this.#retiring.add(session);
    // What happened, as the caller knows it, or as the connection now stands.
    const known = change ? Promise.resolve(change) : this.#changeOf(session);
    for (const response of session.responses) {
      const call = this.#calls.get(response);
      if (call) call.ended ??= known;
      if (response.req?.method !== "POST") response.destroy();
    }
    void this.#retire(session, known).catch(() => undefined);
  }
  /** Whether a connection may still reach a stored operation's target, under its grant now. */
  async #reachable(
    caller: Extract<AgentCaller, { kind: "connection" }>,
    row: { readonly target: { readonly grant: import("@opensteer/core").AgentGrantTarget } },
  ): Promise<boolean> {
    const grantTarget = row.target.grant;
    if (grantTarget.kind === "device") return true;
    const database = this.options.store.database;
    if (!database) return false;
    const execution = await admitExecution(database, {
      ownerUserId: caller.userId,
      subject: { kind: "connection", agentConnectionId: caller.connectionId },
      ...(grantTarget.kind === "browser-profile" ? { grantTarget } : {}),
    }).catch(() => null);
    if (execution === null) return false;
    if (grantTarget.kind === "browser-profile") return true;
    return reachesTarget(database, execution, grantTarget);
  }
  /** What happened to a session's access, read from its connection's standing. */
  async #changeOf(session: McpSession): Promise<AgentAccessChange> {
    const database = this.options.store.database;
    if (!session.connectionId || !database) return "ended";
    const after = await connectionAfterChange(database, session.owner, session.connectionId).catch(
      () => null,
    );
    return after === "live"
      ? "changed"
      : after === "revoked"
        ? "disconnected"
        : after === "expired"
          ? "expired"
          : "ended";
  }
  /**
   * A call that runs an operation the change is stopping (handed off, here) returns that work's
   * own ending within a short grace; every other call (a read, a wait, a request not yet an
   * operation) is ended with the refusal at once; what still does not answer is cut.
   */
  async #retire(session: McpSession, known: Promise<AgentAccessChange>) {
    const change = await known;
    const ended = new OpensteerError({
      code: "forbidden",
      reason: "authority-changed",
      message: agentAccessChangeWords[change].message,
    });
    const answered = async (responses: readonly ServerResponse[], ms: number) => {
      const open = responses.map((response) =>
        response.writableFinished || response.destroyed ? undefined : once(response, "close"),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(open),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    };
    const end = (responses: readonly ServerResponse[]) => {
      for (const response of responses) this.#calls.get(response)?.stop.abort(ended);
    };
    const calls = [...session.responses];
    const keys = calls.flatMap((response) => this.#calls.get(response)?.operationKey ?? []);
    const stopping = new Set(
      keys.length && this.options.store.database
        ? (
            await this.options.store.database
              .selectFrom("agentOperations")
              .select("operationKey")
              .where("operationKey", "in", keys)
              .where("state", "=", "handed-off")
              .execute()
          ).map(({ operationKey }) => operationKey)
        : [],
    );
    const work = calls.filter((response) =>
      stopping.has(this.#calls.get(response)?.operationKey ?? ""),
    );
    end(calls.filter((response) => !work.includes(response)));
    if (work.length) await answered(work, retiringCallGraceMs);
    if (!this.#retiring.has(session)) return;
    end([...session.responses]);
    if (session.responses.size) await answered([...session.responses], retiringRefusalGraceMs);
    if (!this.#retiring.delete(session)) return;
    for (const response of session.responses) response.destroy();
    await session.server.close();
  }
  async #sweep(now = Date.now()): Promise<void> {
    const expired = [...this.#sessions.entries()].filter(
      ([, session]) =>
        (session.expiresAt !== null && session.expiresAt <= now) ||
        (session.responses.size === 0 && now - session.lastSeenAt > sessionIdleLifetimeMs),
    );
    // A session whose credential expired ends as any ended session does: its calls read why.
    for (const [, session] of expired)
      void this.#closeSession(
        session,
        session.expiresAt !== null && session.expiresAt <= now ? "expired" : "ended",
      );
  }
}

const unknownToolMessage = "Unknown Opensteer tool";

function unknownTool() {
  return new OpensteerError({ code: "not_found", message: unknownToolMessage });
}

function connectionNotFoundMessage(tool: string, message: string): string {
  if (message === unknownToolMessage) return "That item is unavailable.";
  if (message === "Operation is unavailable.") return message;
  if (tool.startsWith("opensteer_automation_")) return "Automation not found";
  if (/^opensteer_(task|subagent|delegation)_/u.test(tool)) return "Task is unavailable";
  if (tool === "browser_use" || tool === "browser_connect")
    return "This browser target is unavailable or not shared with this connected agent.";
  return "That item is unavailable.";
}

/**
 * Why a tool is not offered. A connected agent cannot ask for more access itself: the person
 * widens its grant under Connected agents, and the refusal says so.
 */
function unavailableTool(caller: AgentCaller, name: string): OpensteerError {
  const family = agentToolFamilies[name as keyof typeof agentToolFamilies];
  if (caller.kind === "connection" && family === "widen")
    return new OpensteerError({
      code: "forbidden",
      message:
        "A connected agent cannot ask for more access. The person widens what this agent may use under Connected agents.",
      next: "Continue with what is shared with you, or tell the person what you need.",
    });
  return new OpensteerError({
    code: "forbidden",
    message: "This tool is unavailable to this caller",
  });
}

function sessionAuthority(caller: AgentCaller): string {
  const lineage = callerLineage(caller);
  return lineage ? `${lineage.agentConnectionId}:${lineage.revision}:${caller.accessMode}` : "";
}

function responseEnded(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const ended = () => {
      response.off("finish", ended);
      response.off("close", ended);
      resolve();
    };
    response.once("finish", ended);
    response.once("close", ended);
  });
}

async function responseLifetime(
  session: McpSession,
  response: ServerResponse,
  ended: Promise<void>,
): Promise<void> {
  session.responses.add(response);
  await ended;
  session.responses.delete(response);
  session.lastSeenAt = Date.now();
}

function assertRequestOrigin(request: IncomingMessage, allowed: URL): void {
  if (singleHeader(request.headers.host) !== allowed.host) {
    throw new Error("MCP request Host is not allowed");
  }
  const origin = singleHeader(request.headers.origin);
  if (origin && origin !== allowed.origin) {
    throw new Error("MCP request Origin is not allowed");
  }
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string" || value === undefined) return value;
  return value.length === 1 ? value[0] : undefined;
}

function sendJsonRpcError(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: { code: -32_000, message }, id: null, jsonrpc: "2.0" }));
}

const safeMessageOptions = { fallback: "Opensteer tool request failed" } as const;

async function abortableToolResult<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw signal.reason;
  }
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** A device's own refusal (its switch, offline, asleep, stopped), which may name the Device. */
function namesDevice(error: unknown): boolean {
  return (
    error instanceof OpensteerError &&
    (error.reason === "device-access-off" ||
      error.reason === "device-offline" ||
      error.reason === "device-asleep" ||
      error.reason === "device-stopped")
  );
}
