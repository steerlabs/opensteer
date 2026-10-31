import { advertisedJsonSchema } from "@opensteer/shared/advertisedJsonSchema";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { BrowserTabReadInputSchema, BrowserTabWriteInputSchema } from "@opensteer/protocol";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  legacyBrowserSignInTool,
  legacyBrowserProfileSaveTool,
  previousReleaseToolsForCapabilityProfile,
  toolsForEnvironmentContract,
  type AgentToolName,
} from "@opensteer/agent-tools";
import {
  OpensteerError,
  ThreadWriteInputSchema,
  type AgentCapabilityProfileId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { programAllowsTool } from "../triggers/program-authority.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  type Tool,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  AgentControlService,
  AgentControlTokenService,
  AgentControlRunScope,
} from "./agent-control-service.js";
import type {
  TriggerControlService,
  TriggerControlTokenService,
} from "../triggers/trigger-control-service.js";
import type { AgentControlResponse } from "@opensteer/protocol";
import {
  requiredTriggerToolField,
  triggerSourceFromInput,
  TriggerReadInputSchema,
  TriggerWriteInputSchema,
  TriggerProgramSchema,
  type TriggerControlInput,
  type TriggerWriteInput,
} from "@opensteer/triggers";
import { z } from "zod";
import { mcpToolCallId } from "../integrations/mcp-call-id.js";
import type { WatchControlTokenService } from "../triggers/watch-capability.js";
import type { WatchControlService } from "../triggers/watch-control-service.js";

const maximumSessions = 256;
const sessionIdleLifetimeMs = 30 * 60 * 1_000;

/**
 * An MCP session belongs to what it acts for, never to the token that opened
 * it: a refreshed token keeps using the same session, and every request is
 * authorized by the token it carries.
 */
interface McpSession extends ToolAuthorization {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}

interface ToolAuthorization {
  readonly anchor?: { readonly threadId: ThreadId; readonly ownerId: UserId };
  readonly control: AgentToolControl;
  readonly profileId: AgentCapabilityProfileId;
  /** The Run a run-scoped token names; its Runner decides the session's tool inventory. */
  readonly run?: AgentControlRunScope;
  readonly scope: "run" | "trigger" | "watch";
  readonly subjectId: string;
  readonly toolContractVersion: 1 | 2 | 3 | null;
}

interface AgentToolControl {
  handle(token: string, input: unknown): Promise<AgentControlResponse>;
}

function toolInputSchema(
  definition: { readonly inputSchema: z.ZodType; readonly name: string },
  version: 1 | 2 | 3 | null,
): z.ZodObject {
  const inputSchema = definition.inputSchema as z.ZodObject;
  if (version !== 1) return inputSchema;
  if (definition.name === "thread_message") {
    return inputSchema.extend({ delivery: z.enum(["queue", "trigger"]) });
  }
  if (definition.name === "trigger_write") {
    return inputSchema.extend({
      program: TriggerProgramSchema.omit({ toolContractVersion: true }).optional(),
    });
  }
  return inputSchema;
}

function toolDescription(name: string, current: string, version: 1 | 2 | 3 | null): string {
  if (version !== 1) return current;
  if (name === "thread_message") {
    return "Send a message to a Thread. delivery queue records passive context; delivery trigger queues actionable work.";
  }
  if (name === "trigger_write") {
    return "Create or change a Trigger using the version 1 program input contract. Nested programs contain language and source and do not accept toolContractVersion.";
  }
  return current;
}

export class AgentToolsMcpService {
  readonly #agentControl: Pick<AgentControlService, "handle">;
  readonly #allowedHost: string;
  readonly #allowedOrigin: string;
  readonly #sessions = new Map<string, McpSession>();
  readonly #tokens: AgentControlTokenService;
  readonly #runnerCapabilities:
    ((scope: AgentControlRunScope) => Promise<readonly string[]>) | undefined;
  readonly #store: Pick<OpensteerStore, "getThreadForOwner">;
  readonly #triggerControl: Pick<TriggerControlService, "handle"> | undefined;
  readonly #triggerTokens: TriggerControlTokenService | undefined;
  readonly #watchControl: Pick<WatchControlService, "handle"> | undefined;
  readonly #watchTokens: WatchControlTokenService | undefined;
  #sessionsBeingCreated = 0;

  constructor(options: {
    readonly agentControl: Pick<AgentControlService, "handle">;
    readonly publicUrl: URL;
    /**
     * What a Run's Runner advertised, which decides the tools its engine
     * accepts. Without it every Run gets the current inventory.
     */
    readonly runnerCapabilities?: (scope: AgentControlRunScope) => Promise<readonly string[]>;
    readonly store: Pick<OpensteerStore, "getThreadForOwner">;
    readonly tokens: AgentControlTokenService;
    readonly triggerControl?: Pick<TriggerControlService, "handle">;
    readonly triggerTokens?: TriggerControlTokenService;
    readonly watchControl?: Pick<WatchControlService, "handle">;
    readonly watchTokens?: WatchControlTokenService;
  }) {
    this.#agentControl = options.agentControl;
    this.#allowedHost = options.publicUrl.host;
    this.#allowedOrigin = options.publicUrl.origin;
    this.#tokens = options.tokens;
    this.#runnerCapabilities = options.runnerCapabilities;
    this.#store = options.store;
    this.#triggerControl = options.triggerControl;
    this.#triggerTokens = options.triggerTokens;
    this.#watchControl = options.watchControl;
    this.#watchTokens = options.watchTokens;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
    token: string,
  ): Promise<void> {
    try {
      this.#assertRequestOrigin(request);
    } catch (error) {
      sendJsonRpcError(response, 403, safeMessage(error, safeMessageOptions));
      return;
    }
    let authorization: ToolAuthorization;
    try {
      authorization = await this.#authenticate(token);
    } catch {
      response.setHeader("www-authenticate", 'Bearer realm="opensteer-agent-tools"');
      sendJsonRpcError(response, 401, "Agent tools authorization is invalid or expired");
      return;
    }
    await this.#sweep();
    // The SDK hands this to each tool call as its `authInfo`.
    (request as IncomingMessage & { auth?: AuthInfo }).auth = {
      clientId: authorization.subjectId,
      scopes: [],
      token,
    };
    const sessionId = singleHeader(request.headers["mcp-session-id"]);
    let session: McpSession;
    let createdSession = false;

    if (sessionId) {
      const existing = this.#sessions.get(sessionId);
      if (
        !existing ||
        existing.scope !== authorization.scope ||
        existing.subjectId !== authorization.subjectId ||
        existing.profileId !== authorization.profileId ||
        existing.toolContractVersion !== authorization.toolContractVersion
      ) {
        await this.#serveDetached(request, response, body, { ...authorization, sessionId });
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
        session = await this.#createSession(authorization);
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
    input: ToolAuthorization & { readonly sessionId: string },
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
    input: ToolAuthorization & { readonly sessionId?: string },
  ): Promise<McpSession> {
    let session!: McpSession;
    const transport = new StreamableHTTPServerTransport(
      input.sessionId
        ? {
            allowedHosts: [this.#allowedHost],
            allowedOrigins: [this.#allowedOrigin],
            enableDnsRebindingProtection: true,
            enableJsonResponse: true,
          }
        : {
            allowedHosts: [this.#allowedHost],
            allowedOrigins: [this.#allowedOrigin],
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
    const server = await this.createServer(input);
    try {
      // SDK 1.30's Node transport declares optional callbacks more narrowly
      // than its own Transport interface under exactOptionalPropertyTypes.
      await server.connect(transport as unknown as Transport);
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }
    session = {
      control: input.control,
      lastSeenAt: Date.now(),
      profileId: input.profileId,
      scope: input.scope,
      subjectId: input.subjectId,
      toolContractVersion: input.toolContractVersion,
      server,
      transport,
    };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) this.#sessions.delete(id);
    };
    return session;
  }

  async createServer(
    input: ToolAuthorization & { readonly sessionId?: string },
  ): Promise<McpServer> {
    const anchor = input.anchor
      ? await this.#store.getThreadForOwner(input.anchor.threadId, input.anchor.ownerId)
      : null;
    if (input.scope !== "run" && !anchor) throw new Error("Program anchor Thread is unavailable");
    // The largest catalog array has 63 place records; this leaves substantial
    // headroom while bounding work before Zod validates the request.
    const server = new McpServer(
      { name: "opensteer", version: "1.0.0" },
      { maxToolInputElements: 10_000 },
    );
    // A Run's engine accepts exactly the tools its Runner's release knows, read
    // once per session: it keeps that inventory while its Runner reconnects, and
    // a forgotten session asks again. A session without a Run gets today's.
    const capabilities =
      input.scope === "run" && input.run && this.#runnerCapabilities
        ? await this.#runnerCapabilities(input.run)
        : null;
    const lacks = (capability: string) =>
      capabilities !== null && !capabilities.includes(capability);
    const legacyEnvironment =
      input.scope === "run" ? lacks("environment-list-v1") : input.toolContractVersion !== 3;
    const definitions = [
      ...toolsForEnvironmentContract(input.profileId, legacyEnvironment),
      ...(lacks("browser-profile-create-v1")
        ? previousReleaseToolsForCapabilityProfile(input.profileId)
        : []),
    ].filter(
      (definition) =>
        (definition.name !== "thread_write" || !lacks("task-done-v1")) &&
        (definition.name !== "person_notify" ||
          (input.scope === "run" && capabilities?.includes("person-notify-v1") === true)),
    );
    const advertisedTools: Tool[] = [];
    for (const definition of definitions) {
      if (
        input.scope !== "run" &&
        anchor &&
        (!("id" in definition) ||
          !programAllowsTool(input.scope, anchor.capabilityProfileId, definition.id))
      )
        continue;
      const inputSchema = toolInputSchema(definition, input.toolContractVersion);
      const registration = {
        annotations: definition.annotations,
        description: toolDescription(
          definition.name,
          definition.description,
          input.toolContractVersion,
        ),
        inputSchema,
        title: definition.annotations.title,
      };
      advertisedTools.push({
        ...registration,
        name: definition.name,
        inputSchema: advertisedJsonSchema(
          (input.toolContractVersion !== 1 && "advertisedInputSchema" in definition
            ? definition.advertisedInputSchema
            : undefined) ??
            toJsonSchemaCompat(inputSchema, { strictUnions: true, pipeStrategy: "input" }),
        ) as Tool["inputSchema"],
        execution: { taskSupport: "forbidden" },
      });
      server.registerTool(definition.name, registration, async (args, extra) => {
        const requestId = mcpToolCallId(
          input.subjectId,
          input.sessionId ?? extra.sessionId,
          extra.requestId,
          definition.name,
        );
        try {
          let parsedInput = inputSchema.parse(args) as Record<string, unknown>;
          if (
            input.toolContractVersion === 1 &&
            definition.name === "trigger_write" &&
            parsedInput.program &&
            typeof parsedInput.program === "object"
          ) {
            parsedInput = {
              ...parsedInput,
              program: { ...parsedInput.program, toolContractVersion: 1 },
            };
          }
          const token = extra.authInfo?.token;
          if (!token) throw new Error("Agent tools authorization is missing");
          const result = await this.#callTool({
            control: input.control,
            input: parsedInput,
            name: definition.name,
            legacyEnvironment,
            requestId,
            token,
          });
          return {
            content: [{ text: JSON.stringify(result), type: "text" as const }],
            structuredContent: result,
          };
        } catch (error) {
          return {
            content: [{ text: safeMessage(error, safeMessageOptions), type: "text" as const }],
            isError: true,
          };
        }
      });
    }
    // Keep the SDK's full Zod call validation; only its public list handler differs.
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: advertisedTools,
    }));
    return server;
  }

  async #callTool(call: {
    readonly control: AgentToolControl;
    readonly legacyEnvironment: boolean;
    readonly input: Record<string, unknown>;
    readonly name:
      | AgentToolName
      | typeof legacyBrowserSignInTool.name
      | typeof legacyBrowserProfileSaveTool.name;
    readonly requestId: string;
    readonly token: string;
  }): Promise<Record<string, unknown>> {
    const { control, input, requestId, token } = call;
    switch (call.name) {
      case "environment_list": {
        const response = await control.handle(token, {
          ...input,
          requestId,
          type: "environment.list",
        });
        if (response.type !== "environment.list.result") throw unexpectedToolResponse();
        const { type: _type, requestId: _requestId, ...result } = response;
        return result;
      }
      case "workspace_list": {
        if (!call.legacyEnvironment) {
          const response = await control.handle(token, {
            ...input,
            requestId,
            type: "workspace.list",
          });
          if (response.type !== "workspace.list.result") throw unexpectedToolResponse();
          return { workspaces: response.workspaces, window: response.window };
        }
        const response = await control.handle(token, {
          maxWorkspaces: input.limit,
          requestId,
          type: "workspace.inspect",
          ...(input.before ? { workspaceBefore: input.before } : {}),
          ...(input.harnessCursor ? { harnessCursor: input.harnessCursor } : {}),
          ...(input.modelPage ? { modelPage: input.modelPage } : {}),
        });
        if (response.type !== "workspace.inspect.result") throw unexpectedToolResponse();
        return {
          delegationDefault: response.delegationDefault,
          environments: response.environments,
          environmentsTruncated: response.environmentsTruncated,
          harnesses: response.harnesses,
          harnessesTruncated: response.harnessesTruncated,
          ...(response.harnessesNextCursor
            ? { harnessesNextCursor: response.harnessesNextCursor }
            : {}),
          window: response.workspaceWindow,
          workspaces: response.workspaces,
        };
      }
      case "workspace_create": {
        const response = await control.handle(token, {
          ...(input.icon ? { icon: input.icon } : {}),
          ...(input.color ? { color: input.color } : {}),
          name: input.name,
          requestId,
          ...(input.backing === "local-directory"
            ? {
                storage: {
                  backing: "local-directory" as const,
                  ...(input.environmentId ? { environmentId: input.environmentId } : {}),
                },
              }
            : input.backing === "portablefs"
              ? { storage: { backing: "portablefs" as const } }
              : {}),
          type: "workspace.create",
        });
        if (response.type !== "workspace.create.result") throw unexpectedToolResponse();
        return { workspace: response.workspace };
      }
      case "workspace_mount": {
        const response = await control.handle(token, {
          requestId,
          type: "workspace.mount",
          workspaceId: input.workspaceId,
        });
        if (response.type !== "workspace.mount.result") throw unexpectedToolResponse();
        return { path: response.path, workspaceId: response.workspaceId };
      }
      case "thread_read": {
        const response = await control.handle(token, {
          ...(input.query ? { query: input.query } : {}),
          ...(input.aroundMessageId ? { aroundMessageId: input.aroundMessageId } : {}),
          ...(input.assignmentBefore ? { assignmentBefore: input.assignmentBefore } : {}),
          ...(input.before ? { before: input.before } : {}),
          maxMessages: input.maxMessages,
          requestId,
          threadId: input.threadId,
          type: "thread.read",
        });
        if (response.type !== "thread.read.result") throw unexpectedToolResponse();
        return {
          assignments: response.assignments,
          assignmentWindow: response.assignmentWindow,
          messages: response.messages,
          thread: response.thread,
          window: response.window,
        };
      }
      case "thread_list": {
        const response = await control.handle(token, {
          ...(input.before ? { before: input.before } : {}),
          limit: input.limit,
          ...(input.query ? { query: input.query } : {}),
          requestId,
          type: "thread.list",
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        });
        if (response.type !== "thread.list.result") throw unexpectedToolResponse();
        return { threads: response.threads, window: response.window };
      }
      case "thread_delegate": {
        const response = await control.handle(token, {
          ...(input.environmentId ? { environmentId: input.environmentId } : {}),
          ...(input.harnessInstanceId ? { harnessInstanceId: input.harnessInstanceId } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.observationId ? { observationId: input.observationId } : {}),
          requestId,
          task: input.task,
          ...(input.places ? { places: input.places } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.icon ? { icon: input.icon } : {}),
          type: "thread.delegate",
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
        });
        if (response.type !== "thread.delegate.result") throw unexpectedToolResponse();
        return response.result;
      }
      case "assignment_cancel": {
        const response = await control.handle(token, {
          assignmentId: input.assignmentId,
          requestId,
          type: "assignment.cancel",
        });
        if (response.type !== "assignment.cancel.result") throw unexpectedToolResponse();
        return { assignment: response.assignment };
      }
      case "thread_write": {
        const response = await control.handle(token, {
          input: ThreadWriteInputSchema.parse(input),
          requestId,
          type: "thread.write",
        });
        if (response.type !== "thread.write.result") throw unexpectedToolResponse();
        return { thread: response.thread, doneWhenRunEnds: response.doneWhenRunEnds };
      }
      case "person_notify": {
        const response = await control.handle(token, {
          type: "person.notify",
          requestId,
          message: input.message,
        });
        if (response.type !== "person.notify.result") throw unexpectedToolResponse();
        return { messageId: response.messageId };
      }
      case "thread_message": {
        const response = await control.handle(token, {
          content: [{ text: input.message, type: "text" }],
          ...(input.delivery ? { delivery: input.delivery } : {}),
          ...(input.observationId ? { observationId: input.observationId } : {}),
          requestId,
          threadId: input.threadId,
          type: "thread.message",
        });
        if (response.type !== "thread.message.result") throw unexpectedToolResponse();
        return response.result;
      }
      case "request_list": {
        const response = await control.handle(token, {
          ...(input.before ? { before: input.before } : {}),
          limit: input.limit,
          requestId,
          type: "request.list",
        });
        if (response.type !== "request.list.result") throw unexpectedToolResponse();
        return { requests: response.requests, window: response.window };
      }
      case "request_withdraw": {
        const response = await control.handle(token, {
          requestId,
          targetRequestId: input.requestId,
          type: "request.withdraw",
        });
        if (response.type !== "request.withdraw.result") throw unexpectedToolResponse();
        return { request: response.request };
      }
      case "browser_profile_create": {
        const response = await control.handle(token, {
          name: input.name,
          requestId,
          type: "browser.profile.create",
        });
        if (response.type !== "browser.profile.create.result") throw unexpectedToolResponse();
        return { profile: response.profile };
      }
      case "browser_profile_list": {
        const response = await control.handle(token, {
          requestId,
          type: "browser.profile.list",
          ...(input.site ? { site: input.site } : {}),
        });
        if (response.type !== "browser.profile.list.result") throw unexpectedToolResponse();
        return { profiles: response.profiles, ...(response.site ? { site: response.site } : {}) };
      }
      case "browser_sign_in":
      case "sign_in": {
        const response = await control.handle(token, {
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          site: input.site,
          reason: input.reason,
          requestId,
          type: "sign-in",
        });
        if (response.type !== "sign-in.result") throw unexpectedToolResponse();
        return response.result;
      }
      case "machine_full_disk_access_request": {
        const response = await control.handle(token, {
          computer: input.computer,
          reason: input.reason,
          requestId,
          type: "machine.full-disk-access.request",
        });
        if (response.type !== "machine.full-disk-access.request.result")
          throw unexpectedToolResponse();
        return response.result;
      }
      case "browser_access_request": {
        const response = await control.handle(token, {
          reason: input.reason,
          requestId,
          suggestion: input.suggestion,
          type: "browser.access.request",
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        });
        if (response.type !== "browser.access.request.result") throw unexpectedToolResponse();
        return response.result;
      }
      case "browser_profile_save": {
        const response = await control.handle(token, {
          reason: input.reason,
          requestId,
          sessionId: input.sessionId,
          ...(input.suggestedName ? { suggestedName: input.suggestedName } : {}),
          type: "browser.profile.save",
        });
        if (response.type !== "browser.profile.save.result") throw unexpectedToolResponse();
        return response.result;
      }
      case "browser_tab_read": {
        const response = await control.handle(token, {
          requestId,
          input: BrowserTabReadInputSchema.parse(input),
          type: "browser.tab.read",
        });
        if (response.type !== "browser.tab.read.result") throw unexpectedToolResponse();
        return response.result;
      }
      case "browser_tab_write": {
        const response = await control.handle(token, {
          requestId,
          input: BrowserTabWriteInputSchema.parse(input),
          type: "browser.tab.write",
        });
        if (response.type !== "browser.tab.write.result") throw unexpectedToolResponse();
        return response.result;
      }
      case "browser_session_list": {
        const response = await control.handle(token, {
          requestId,
          type: "browser.session.list",
        });
        if (response.type !== "browser.session.list.result") throw unexpectedToolResponse();
        return { sessions: response.sessions };
      }
      case "browser_session_open": {
        const response = await control.handle(token, {
          ...(input.environmentId ? { environmentId: input.environmentId } : {}),
          ...(input.fresh ? { fresh: input.fresh } : {}),
          ...(input.profileId ? { profileId: input.profileId } : {}),
          requestId,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          type: "browser.session.open",
        });
        if (response.type !== "browser.session.open.result") throw unexpectedToolResponse();
        return { session: response.session, wasExisting: response.wasExisting };
      }
      case "browser_session_close": {
        const response = await control.handle(token, {
          requestId,
          sessionId: input.sessionId,
          type: "browser.session.close",
        });
        if (response.type !== "browser.session.close.result") throw unexpectedToolResponse();
        return { closed: response.sessionId !== null, sessionId: response.sessionId };
      }
      case "trigger_read": {
        const read = TriggerReadInputSchema.parse(input);
        const context = { action: read.action, tool: "trigger_read" } as const;
        return this.#callTriggerControl({
          control,
          input:
            read.action === "list"
              ? {
                  limit: read.limit,
                  operation: "list",
                  ...(read.workspaceId === undefined ? {} : { workspaceId: read.workspaceId }),
                }
              : {
                  occurrenceLimit: read.occurrenceLimit,
                  operation: "get",
                  triggerId: requiredTriggerToolField(read.triggerId, "triggerId", context),
                },
          requestId,
          token,
          tool: "trigger.read",
        });
      }
      case "trigger_write": {
        const write = TriggerWriteInputSchema.parse(input);
        return this.#callTriggerControl({
          control,
          input: triggerWriteOperation(write, requestId),
          requestId,
          token,
          tool: "trigger.write",
        });
      }
    }
  }

  async #callTriggerControl(call: {
    readonly control: AgentToolControl;
    readonly input: TriggerControlInput;
    readonly requestId: string;
    readonly token: string;
    readonly tool: "trigger.read" | "trigger.write";
  }): Promise<Record<string, unknown>> {
    const response = await call.control.handle(call.token, {
      input: call.input,
      requestId: call.requestId,
      tool: call.tool,
      type: "trigger.control",
    });
    if (response.type !== "trigger.control.result") throw unexpectedToolResponse();
    return asStructuredResult(response.result);
  }

  async #authenticate(token: string): Promise<ToolAuthorization> {
    try {
      const claims = await this.#tokens.authenticate(token);
      return {
        control: this.#agentControl,
        profileId: claims.capabilityProfileId,
        run: claims,
        scope: "run",
        subjectId: claims.runId,
        toolContractVersion: null,
      };
    } catch (runError) {
      if (this.#triggerControl && this.#triggerTokens) {
        try {
          const claims = await this.#triggerTokens.authenticate(token);
          return {
            anchor: { threadId: claims.threadId, ownerId: claims.requestedBy },
            control: this.#triggerControl,
            profileId: "trigger",
            scope: "trigger",
            subjectId: claims.occurrenceId,
            toolContractVersion: claims.toolContractVersion,
          };
        } catch {
          // A separate audience keeps a watch token unusable by occurrence paths.
        }
      }
      if (!this.#watchControl || !this.#watchTokens) throw runError;
      const claims = await this.#watchTokens.authenticate(token);
      return {
        anchor: { threadId: claims.anchorThreadId, ownerId: claims.createdBy },
        control: this.#watchControl,
        profileId: "trigger",
        scope: "watch",
        subjectId: claims.activationId,
        toolContractVersion: claims.toolContractVersion,
      };
    }
  }

  async #sweep(now = Date.now()): Promise<void> {
    const expired = [...this.#sessions.entries()].filter(
      ([, session]) => now - session.lastSeenAt > sessionIdleLifetimeMs,
    );
    for (const [id] of expired) this.#sessions.delete(id);
    await Promise.allSettled(expired.map(([, session]) => session.server.close()));
  }

  #assertRequestOrigin(request: IncomingMessage): void {
    if (singleHeader(request.headers.host) !== this.#allowedHost) {
      throw new Error("MCP request Host is not allowed");
    }
    const origin = singleHeader(request.headers.origin);
    if (origin && origin !== this.#allowedOrigin) {
      throw new Error("MCP request Origin is not allowed");
    }
  }
}

/**
 * trigger_write is a flat, union-free tool shape, so each action is expanded
 * here field by field into the internal control operation it stands for.
 */
function triggerWriteOperation(write: TriggerWriteInput, requestId: string): TriggerControlInput {
  const context = { action: write.action, tool: "trigger_write" } as const;
  // The flat input is the union of every action's fields; a field the chosen
  // action would silently drop is refused so the caller learns it had no effect.
  const accepted: Readonly<Record<TriggerWriteInput["action"], readonly string[]>> = {
    cancel: ["occurrenceId", "triggerId"],
    create: ["anchorThreadId", "name", "program", "source"],
    run: ["payload", "triggerId"],
    set_next_fire: ["nextFireAt", "triggerId"],
    set_status: ["status", "triggerId"],
    update: ["expectedRevisionId", "name", "program", "source", "triggerId"],
  };
  const stray = Object.entries(write)
    .filter(
      ([field, value]) =>
        field !== "action" && value !== undefined && !accepted[write.action].includes(field),
    )
    .map(([field]) => field);
  if (stray.length > 0) {
    throw new OpensteerError({
      code: "bad_request",
      message: `trigger_write action "${write.action}" does not accept ${stray.join(", ")}`,
    });
  }
  switch (write.action) {
    case "create":
      return {
        anchorThreadId: requiredTriggerToolField(write.anchorThreadId, "anchorThreadId", context),
        // The model never chooses the key: the control service rewrites this
        // into a key scoped to the authority the call arrived with.
        idempotencyKey: requestId,
        name: requiredTriggerToolField(write.name, "name", context),
        operation: "create",
        program: requiredTriggerToolField(write.program, "program", context),
        source: triggerSourceFromInput(requiredTriggerToolField(write.source, "source", context)),
      };
    case "update":
      return {
        expectedRevisionId: requiredTriggerToolField(
          write.expectedRevisionId,
          "expectedRevisionId",
          context,
        ),
        ...(write.name === undefined ? {} : { name: write.name }),
        operation: "update",
        ...(write.program === undefined ? {} : { program: write.program }),
        ...(write.source === undefined ? {} : { source: triggerSourceFromInput(write.source) }),
        triggerId: requiredTriggerToolField(write.triggerId, "triggerId", context),
      };
    case "set_status":
      return {
        operation: "set_status",
        status: requiredTriggerToolField(write.status, "status", context),
        triggerId: requiredTriggerToolField(write.triggerId, "triggerId", context),
      };
    case "set_next_fire":
      return {
        operation: "set_next_fire",
        nextFireAt: requiredTriggerToolField(write.nextFireAt, "nextFireAt", context),
        triggerId: requiredTriggerToolField(write.triggerId, "triggerId", context),
      };
    case "run":
      return {
        operation: "run",
        ...(write.payload === undefined ? {} : { payload: write.payload }),
        triggerId: requiredTriggerToolField(write.triggerId, "triggerId", context),
      };
    case "cancel":
      return {
        ...(write.occurrenceId === undefined ? {} : { occurrenceId: write.occurrenceId }),
        operation: "cancel",
        triggerId: requiredTriggerToolField(write.triggerId, "triggerId", context),
      };
  }
}

function asStructuredResult(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
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

function unexpectedToolResponse(): Error {
  return new Error("Opensteer returned an unexpected tool response");
}

const safeMessageOptions = { fallback: "Opensteer tool request failed" } as const;
