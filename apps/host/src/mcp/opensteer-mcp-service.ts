import { IntegrationCallOutputSchema } from "@opensteer/agent-tools/outputs";
import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isInitializeRequest,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  agentTools,
  toolsFor,
  agentToolAnnotations,
  connectionInstructions,
  agentToolFailureResult,
  agentToolRecordResult,
  type AgentTool,
} from "@opensteer/agent-tools";
import { OpensteerError, RequestIdSchema, ThreadIdSchema, type Thread } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { advertisedJsonSchema } from "@opensteer/shared/advertisedJsonSchema";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { requestPendingGuidance } from "@opensteer/shared/requestGuidance";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { mcpToolCallId } from "../integrations/mcp-call-id.js";
import { agentToolFailure, internalToolFailureCode } from "./agent-tool-failure.js";
import { mcpResourceMetadataPath } from "./connections/connection-oauth.js";
import { AgentCallerResolver, type AgentCaller } from "./agent-caller.js";
import { toolAccess } from "./tool-access.js";
import { toolOperationKey } from "./operations.js";
import type { RealtimeHub } from "@opensteer/orchestration";
import type { AgentToolHandlers, ToolCall } from "./handlers/index.js";

const maximumSessions = 256;
const sessionIdleLifetimeMs = 30 * 60 * 1_000;
interface McpSession {
  readonly responses: Set<ServerResponse>;
  readonly token: string;
  readonly origin: string;
  readonly key: string;
  readonly kind: AgentCaller["kind"];
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}
export class OpensteerMcpService {
  readonly #runtimeOrigin: URL;
  readonly #sessions = new Map<string, McpSession>();
  readonly #activeSessions = new Set<McpSession>();
  readonly #reservations = new Map<string, number>();
  readonly #detachObserve: (() => void) | undefined;
  readonly options: {
    readonly callers: Pick<AgentCallerResolver, "authenticate">;
    readonly handlers: AgentToolHandlers;
    readonly realtime?: Pick<RealtimeHub, "observe">;
    readonly store: Pick<OpensteerStore, "getThreadForOwner" | "findMainWorkspaceForOwner"> & {
      readonly requests: Pick<OpensteerStore["requests"], "get">;
    };
    readonly publicUrl: URL;
    /** A failure the caller was told only that something went wrong. */
    readonly onToolError?: (error: unknown, tool: string) => void;
  };
  constructor(options: {
    readonly callers: Pick<AgentCallerResolver, "authenticate">;
    readonly handlers: AgentToolHandlers;
    readonly realtime?: Pick<RealtimeHub, "observe">;
    readonly store: Pick<OpensteerStore, "getThreadForOwner" | "findMainWorkspaceForOwner"> & {
      readonly requests: Pick<OpensteerStore["requests"], "get">;
    };
    readonly publicUrl: URL;
    readonly onToolError?: (error: unknown, tool: string) => void;
  }) {
    this.options = options;
    this.#runtimeOrigin = options.publicUrl;
    this.#detachObserve = options.realtime?.observe((change) => {
      if (change.type.startsWith("host.")) void this.#revalidateConnections();
    });
  }
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
    const disconnected = new AbortController();
    const onClose = () => disconnected.abort(new Error("MCP client disconnected"));
    response.once("close", onClose);
    // The SDK hands this to each tool call as its `authInfo`.
    (request as IncomingMessage & { auth?: AuthInfo }).auth = {
      clientId: authorization.key,
      scopes: [],
      token,
      extra: {
        disconnected: disconnected.signal,
        caller: authorization,
      },
    };
    const sessionId = singleHeader(request.headers["mcp-session-id"]);
    let session: McpSession;
    let createdSession = false;

    if (sessionId) {
      const existing = this.#sessions.get(sessionId);
      if (
        !existing ||
        existing.key !== authorization.key ||
        existing.kind !== authorization.kind ||
        existing.origin !== origin.origin
      ) {
        await this.#serveDetached(request, response, body, {
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
      } catch (error) {
        this.#release(authorization.key);
        sendJsonRpcError(response, 500, safeMessage(error, safeMessageOptions));
        return;
      }
    }

    session.responses.add(response);
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
      session.responses.delete(response);
      if (createdSession) this.#release(authorization.key);
    }
  }

  async close(): Promise<void> {
    this.#detachObserve?.();
    const sessions = [...this.#activeSessions];
    this.#activeSessions.clear();
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
    session.responses.add(response);
    try {
      await session.transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, safeMessage(error, safeMessageOptions));
      }
    } finally {
      session.responses.delete(response);
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
    const transport = new StreamableHTTPServerTransport(
      input.sessionId
        ? {
            allowedHosts: [input.origin.host],
            allowedOrigins: [input.origin.origin],
            enableDnsRebindingProtection: true,
            enableJsonResponse: true,
          }
        : {
            allowedHosts: [input.origin.host],
            allowedOrigins: [input.origin.origin],
            enableDnsRebindingProtection: true,
            enableJsonResponse: true,
            onsessionclosed: (closedId) => {
              this.#sessions.delete(closedId);
            },
            onsessioninitialized: (initializedId) => {
              this.#sessions.set(initializedId, session);
            },
            sessionIdGenerator: randomUUID,
          },
    );
    const server = await this.createServer(input, input.sessionId);
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
      token: input.token,
      origin: input.origin.origin,
      key: input.key,
      kind: input.kind,
      lastSeenAt: Date.now(),
      server,
      transport,
    };
    this.#activeSessions.add(session);
    transport.onclose = () => {
      this.#activeSessions.delete(session);
      const id = transport.sessionId;
      if (id) this.#sessions.delete(id);
    };
    return session;
  }

  createServer(caller: AgentCaller, detachedSessionId?: string): McpServer {
    const server = new McpServer(
      { name: "opensteer", version: "1.0.0" },
      {
        maxToolInputElements: 10_000,
        ...(caller.kind === "connection" ? { instructions: connectionInstructions } : {}),
      },
    );
    const advertisedTools: Tool[] = [];
    for (const tool of toolsFor(caller)) {
      const annotations = agentToolAnnotations(tool);
      const registration = {
        annotations,
        description: tool.description,
        title: tool.title,
        // callTool validates every call against the tool's own schema, so a
        // refusal names its field; the SDK only hands the arguments through.
        inputSchema: z.looseObject({}),
      };
      advertisedTools.push({
        name: tool.name,
        ...registration,
        inputSchema: advertisedJsonSchema(
          ("advertisedInputSchema" in tool ? tool.advertisedInputSchema : undefined) ??
            toJsonSchemaCompat(tool.input, { strictUnions: true, pipeStrategy: "input" }),
        ) as Tool["inputSchema"],
        execution: { taskSupport: "forbidden" },
      });
      server.registerTool(tool.name, registration, async (args, extra) => {
        try {
          const token = extra.authInfo?.token;
          if (!token) throw new Error("MCP authorization is missing");
          const resolvedCaller = extra.authInfo?.extra?.caller as AgentCaller | undefined;
          const result = await this.callTool(token, tool.name, args, {
            ...(resolvedCaller ? { caller: resolvedCaller } : {}),
            operationKey: mcpToolCallId(
              caller.key,
              detachedSessionId ?? extra.sessionId,
              extra.requestId,
              tool.name,
            ),
            signal:
              extra.authInfo?.extra?.disconnected instanceof AbortSignal
                ? AbortSignal.any([extra.signal, extra.authInfo.extra.disconnected])
                : extra.signal,
          });
          // A text result is the whole answer, sent once as written.
          // Each result goes out once, in the shape a model reads best: text as
          // written, a provider's content (text, images, its error) as it came,
          // and a record as JSON with its structured copy.
          if (typeof result === "string")
            return { content: [{ type: "text" as const, text: result }] };
          if (tool.output === IntegrationCallOutputSchema)
            return IntegrationCallOutputSchema.parse(result);
          const currentCaller = resolvedCaller ?? caller;
          let pendingRequest = false;
          if (
            currentCaller.kind === "run" &&
            result.status === "pending" &&
            typeof result.requestId === "string"
          ) {
            const id = RequestIdSchema.safeParse(result.requestId);
            const request = id.success ? await this.options.store.requests.get(id.data) : null;
            pendingRequest =
              request?.mode === "durable" &&
              request.status === "pending" &&
              request.originatingRunId === currentCaller.claims.runId;
          }
          return agentToolRecordResult(result, pendingRequest ? requestPendingGuidance : undefined);
        } catch (error) {
          const failure = agentToolFailure(error, tool.access);
          if (failure.code === internalToolFailureCode && !extra.signal.aborted)
            this.options.onToolError?.(error, tool.name);
          return agentToolFailureResult(failure);
        }
      });
    }
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: advertisedTools,
    }));
    return server;
  }
  async callTool(
    bearer: string,
    name: string,
    value: unknown,
    identity: {
      readonly operationKey: string;
      readonly signal?: AbortSignal;
      readonly caller?: AgentCaller;
    },
  ): Promise<Record<string, unknown> | string> {
    const found = agentTools.find((spec) => spec.name === name);
    if (!found) throw new OpensteerError({ code: "not_found", message: "Unknown Opensteer tool" });
    const tool = found;
    const input = tool.input.parse(value);
    let caller = identity.caller ?? (await this.options.callers.authenticate(bearer));
    const key = toolOperationKey(caller, input, identity.operationKey);
    const check = async () => {
      toolAccess[tool.access](caller, await this.#targets(caller, tool, input));
      if (!toolsFor(caller).some((spec) => spec.name === tool.name))
        throw new OpensteerError({
          code: "forbidden",
          message: "This tool is unavailable to this caller",
        });
      const authorize = this.options.handlers[tool.name].authorize as
        ((call: ToolCall<typeof tool.name>) => Promise<void>) | undefined;
      await authorize?.({
        caller,
        input,
        operationKey: key,
        ...(identity.signal ? { signal: identity.signal } : {}),
      });
    };
    const invoke = async () => {
      const call: ToolCall<typeof tool.name> = {
        checkLive: async () => {
          caller = await this.options.callers.authenticate(bearer);
          await check();
        },
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
      const output = tool.output.safeParse(await handler(call));
      // A result outside the contract is the Host's fault, never the caller's arguments.
      // Field paths only: a value could be anything the tool returned.
      if (!output.success)
        throw new Error(
          `Opensteer produced an invalid result for this tool at ${[
            ...new Set(output.error.issues.map(({ path }) => path.join(".") || "(result)")),
          ].join(", ")}`,
        );
      return output.data as Record<string, unknown> | string;
    };
    await check();
    return invoke();
  }

  async #targets(caller: AgentCaller, tool: AgentTool, input: object): Promise<Thread[]> {
    const ids: Thread["id"][] = [];
    const record = input as Record<string, unknown>;
    const add = async (value: unknown) => {
      if (value === "home") {
        const home = await this.options.store.findMainWorkspaceForOwner(caller.userId);
        if (!home?.homeThreadId)
          throw new OpensteerError({ code: "conflict", message: "Chat has not been started yet" });
        ids.push(home.homeThreadId);
      } else {
        const id = ThreadIdSchema.safeParse(value);
        if (id.success) ids.push(id.data);
      }
    };
    for (const field of tool.targetFields ?? []) await add(record[field]);
    const targets = this.options.handlers[tool.name].targets as
      ((call: ToolCall<typeof tool.name>) => Promise<readonly string[]>) | undefined;
    if (targets)
      for (const value of await targets({ caller, input } as ToolCall<typeof tool.name>))
        await add(value);
    return Promise.all(
      [...new Set(ids)].map(async (id) => {
        const thread = await this.options.store.getThreadForOwner(id, caller.userId);
        if (!thread)
          throw new OpensteerError({ code: "forbidden", message: "Thread is unavailable" });
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
  async #revalidateConnections() {
    await Promise.allSettled(
      [...this.#activeSessions]
        .filter((s) => s.kind === "connection")
        .map(async (session) => {
          try {
            await this.options.callers.authenticate(session.token);
          } catch {
            this.#activeSessions.delete(session);
            for (const [id, held] of this.#sessions)
              if (held === session) this.#sessions.delete(id);
            for (const response of session.responses) response.destroy();
            await session.server.close();
          }
        }),
    );
  }
  async #sweep(now = Date.now()): Promise<void> {
    const expired = [...this.#sessions.entries()].filter(
      ([, session]) => now - session.lastSeenAt > sessionIdleLifetimeMs,
    );
    for (const [id, session] of expired) {
      this.#sessions.delete(id);
      this.#activeSessions.delete(session);
    }
    await Promise.allSettled(expired.map(([, session]) => session.server.close()));
  }
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
