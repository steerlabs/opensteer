import { AgentMediaContentSchema } from "@opensteer/agent-tools/outputs";
import { z } from "zod";
import { formatIssues } from "@opensteer/shared/validationIssues";
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
  agentToolAnnotations,
  connectionInstructions,
  type AgentTool,
} from "@opensteer/agent-tools";
import { OpensteerError, AssignmentIdSchema, ThreadIdSchema, type Thread } from "@opensteer/core";
import type { OpensteerStore, AgentOperationReceipts } from "@opensteer/database";
import { advertisedJsonSchema } from "@opensteer/shared/advertisedJsonSchema";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { mcpToolCallId } from "../integrations/mcp-call-id.js";
import { mcpResourceMetadataPath } from "./connections/connection-oauth.js";
import { AgentCallerResolver, type AgentCaller } from "./agent-caller.js";
import { toolAccess } from "./tool-access.js";
import { fingerprint } from "./operations.js";
import type { AgentToolHandlers, ToolCall } from "./handlers/index.js";

const maximumSessions = 256;
const sessionIdleLifetimeMs = 30 * 60 * 1_000;
interface McpSession {
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
  #sessionsBeingCreated = 0;
  readonly options: {
    readonly callers: Pick<AgentCallerResolver, "authenticate">;
    readonly handlers: AgentToolHandlers;
    readonly receipts: Pick<AgentOperationReceipts, "execute">;
    readonly store: Pick<
      OpensteerStore,
      "getThreadForOwner" | "findMainWorkspaceForOwner" | "getAssignmentForOwner"
    >;
    readonly publicUrl: URL;
  };
  constructor(options: {
    readonly callers: Pick<AgentCallerResolver, "authenticate">;
    readonly handlers: AgentToolHandlers;
    readonly receipts: Pick<AgentOperationReceipts, "execute">;
    readonly store: Pick<
      OpensteerStore,
      "getThreadForOwner" | "findMainWorkspaceForOwner" | "getAssignmentForOwner"
    >;
    readonly publicUrl: URL;
  }) {
    this.options = options;
    this.#runtimeOrigin = options.publicUrl;
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
      authorization = await this.options.callers.authenticate(token);
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
      extra: { disconnected: disconnected.signal },
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
      if (this.#sessions.size + this.#sessionsBeingCreated >= maximumSessions) {
        sendJsonRpcError(response, 503, "The Host has reached its MCP session limit");
        return;
      }
      this.#sessionsBeingCreated += 1;
      try {
        session = await this.#createSession({ ...authorization, origin });
        createdSession = true;
      } catch (error) {
        this.#sessionsBeingCreated -= 1;
        sendJsonRpcError(response, 500, safeMessage(error, safeMessageOptions));
        return;
      }
    }

    try {
      await session.transport.handleRequest(request, response, body);
    } catch (error) {
      if (createdSession) {
        const initializedId = session.transport.sessionId;
        if (initializedId) this.#sessions.delete(initializedId);
        await session.server.close().catch(() => undefined);
      }
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, safeMessage(error, safeMessageOptions));
      }
    } finally {
      if (createdSession) this.#sessionsBeingCreated -= 1;
    }
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(({ server }) => server.close()));
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
    input: AgentCaller & { readonly origin: URL; readonly sessionId: string },
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
    const session = await this.#createSession(input);
    try {
      await session.transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, safeMessage(error, safeMessageOptions));
      }
    } finally {
      await session.server.close().catch(() => undefined);
    }
  }

  /**
   * A session the Host holds, or with `sessionId` a one-request session that
   * serves an id it no longer holds.
   */
  async #createSession(
    input: AgentCaller & { readonly origin: URL; readonly sessionId?: string },
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
      origin: input.origin.origin,
      key: input.key,
      kind: input.kind,
      lastSeenAt: Date.now(),
      server,
      transport,
    };
    transport.onclose = () => {
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
    for (const tool of agentTools.filter((spec) =>
      spec.callers.some((kind) => kind === caller.kind),
    )) {
      const annotations = agentToolAnnotations(tool);
      const registration = {
        annotations,
        description: tool.description,
        title: tool.title,
        inputSchema: tool.input as z.ZodObject,
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
          const result = await this.callTool(token, tool.name, args, {
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
          const media = Array.isArray(result.content)
            ? result.content.flatMap((item: unknown) => {
                const parsed = AgentMediaContentSchema.safeParse(item);
                return parsed.success ? [parsed.data] : [];
              })
            : [];
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }, ...media],
            structuredContent: result,
            ...(result.isError === true ? { isError: true } : {}),
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  error instanceof z.ZodError
                    ? `invalid_arguments: ${formatIssues(error.issues)}`
                    : safeMessage(error, safeMessageOptions),
              },
            ],
            isError: true,
          };
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
    identity: { readonly operationKey: string; readonly signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const found = agentTools.find((spec) => spec.name === name);
    if (!found) throw new OpensteerError({ code: "not_found", message: "Unknown Opensteer tool" });
    const tool = found;
    const input = tool.input.parse(value);
    let caller = await this.options.callers.authenticate(bearer);
    let key =
      "operationKey" in input && typeof input.operationKey === "string"
        ? input.operationKey
        : identity.operationKey;
    const check = async () => {
      if (!tool.callers.some((kind) => kind === caller.kind))
        throw new OpensteerError({
          code: "forbidden",
          message: "This tool is unavailable to this caller",
        });
      toolAccess[tool.access](caller, await this.#targets(caller, tool, input));
      const authorize = this.options.handlers[tool.name].authorize as
        ((call: ToolCall<typeof tool.name>) => Promise<void>) | undefined;
      await authorize?.({
        caller,
        input,
        operationKey: key,
        ...(identity.signal ? { signal: identity.signal } : {}),
      });
    };
    if (
      caller.kind === "program" &&
      caller.program.kind === "watch" &&
      (tool.name === "thread_delegate" || tool.name === "thread_message") &&
      "observationId" in input &&
      input.observationId &&
      !("operationKey" in input && input.operationKey)
    )
      key = `observation:${input.observationId}`;
    const invoke = async (recover = false) => {
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
      const handler = (
        recover ? this.options.handlers[tool.name].recover : this.options.handlers[tool.name]
      ) as (call: ToolCall<typeof tool.name>) => Promise<unknown>;
      return tool.output.parse(await handler(call)) as Record<string, unknown>;
    };
    if (tool.access === "read") {
      await check();
      return invoke();
    }
    const result = await this.options.receipts.execute({
      callerKey: caller.key,
      operationKey: key,
      tool: tool.name,
      fingerprint: fingerprint(input),
      check: async () => {
        await check();
      },
      invoke: () => invoke(),
      ...(this.options.handlers[tool.name].recover ? { recover: () => invoke(true) } : {}),
    });
    return tool.output.parse(result) as Record<string, unknown>;
  }
  async #targets(caller: AgentCaller, tool: AgentTool, input: object): Promise<Thread[]> {
    const ids: Thread["id"][] = [];
    const record = input as Record<string, unknown>;
    const add = async (value: unknown) => {
      if (value === "home") {
        const home = await this.options.store.findMainWorkspaceForOwner(caller.userId);
        if (!home?.homeThreadId)
          throw new OpensteerError({ code: "forbidden", message: "Chat is unavailable" });
        ids.push(home.homeThreadId);
      } else {
        const id = ThreadIdSchema.safeParse(value);
        if (id.success) ids.push(id.data);
      }
    };
    await add(record.threadId);
    await add(record.anchorThreadId);
    if (
      tool.name === "person_show" &&
      record.target &&
      typeof record.target === "object" &&
      "threadId" in record.target
    )
      await add(record.target.threadId);
    if (tool.name === "assignment_cancel") {
      const assignment = await this.options.store.getAssignmentForOwner({
        assignmentId: AssignmentIdSchema.parse(record.assignmentId),
        ownerId: caller.userId,
      });
      if (!assignment)
        throw new OpensteerError({ code: "forbidden", message: "Assignment is unavailable" });
      ids.push(assignment.workerThreadId);
    }
    return Promise.all(
      [...new Set(ids)].map(async (id) => {
        const thread = await this.options.store.getThreadForOwner(id, caller.userId);
        if (!thread)
          throw new OpensteerError({ code: "forbidden", message: "Thread is unavailable" });
        return thread;
      }),
    );
  }
  async #sweep(now = Date.now()): Promise<void> {
    const expired = [...this.#sessions.entries()].filter(
      ([, session]) => now - session.lastSeenAt > sessionIdleLifetimeMs,
    );
    for (const [id] of expired) this.#sessions.delete(id);
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
