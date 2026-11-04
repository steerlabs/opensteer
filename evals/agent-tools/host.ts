import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { z } from "zod";
import { isRecord } from "@opensteer/shared/isRecord";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createId, ThreadSchema } from "@opensteer/core";
import { agentTools } from "@opensteer/agent-tools";
import { OpensteerMcpService } from "../../apps/host/src/mcp/opensteer-mcp-service.js";
import type { AgentToolHandlers } from "../../apps/host/src/mcp/handlers/index.js";
import { RunToolTokenService } from "../../apps/host/src/agents/run-tool-tokens.js";
import { SignedTokenService } from "../../apps/host/src/identity/host-keys.js";

import { caseReach, type EvalCase } from "./cases.js";
import type { RecordedCall } from "./grader.js";

// These are test doubles, never a real Host store, grant, credential or integration.
// Every tool call first traverses the production MCP service's Zod boundary.
const validated = "EVAL_VALIDATED_NO_SIDE_EFFECT";
function unavailable(): never {
  throw new Error(validated);
}
const bodySchema = z.looseObject({
  method: z.string().optional(),
  params: z.unknown().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
});

export async function startFakeHost(testCase: EvalCase) {
  const calls: RecordedCall[] = [];
  const secret = randomUUID();
  const scope = {
    bindingGeneration: 1,
    membershipGeneration: 1,
    environmentId: createId("environment"),
    requestedBy: createId("user"),
    runId: createId("run"),
    runnerBootId: "eval",
    runnerId: createId("runner"),
    threadId: createId("thread"),
    workspaceId: createId("workspace"),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    iss: "opensteer-host" as const,
    jti: randomUUID(),
  };
  const signed = new SignedTokenService(generateKeyPairSync("ed25519"), {
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
  });
  const authorizer = { assertActiveGrant: async () => {} };
  const agentTokens = new RunToolTokenService({ tokens: signed, authorizer });
  const agentToken = agentTokens.issue(scope);
  const http = createServer();
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No eval listener");
  const url = new URL(`http://127.0.0.1:${address.port}`);
  const thread = ThreadSchema.parse({
    ...scope,
    id: scope.threadId,
    accessMode: "full-access",
    continuationIdentity: null,
    createdAt: new Date().toISOString(),
    createdBy: scope.requestedBy,
    harnessInstanceId: createId("harnessInstance"),
    inheritsMain: caseReach(testCase) === "user",
    lineageRootThreadId: scope.threadId,
    inputQueuePaused: false,
    listed: true,
    modelSelection: { modelId: "eval", providerId: "eval", options: {} },
    parentThreadId: null,
    pendingRequests: 0,
    role: testCase.role,
    status: "idle",
    title: "Eval",
    updatedAt: new Date().toISOString(),
  });
  const handlers: AgentToolHandlers = {
    project_write: async () => unavailable(),
    settings_read: async () => unavailable(),
    settings_write: async () => unavailable(),
    computer_list: async () => unavailable(),
    computer_write: async () => unavailable(),
    integration_manage: async () => unavailable(),
    channel_manage: async () => unavailable(),
    plugin_manage: async () => unavailable(),
    browser_profile_write: async () => unavailable(),
    app_publish: async () => unavailable(),
    app_list: async () => unavailable(),
    app_fetch: async () => unavailable(),
    plugin_install: async () => unavailable(),
    environment_list: async () => unavailable(),
    project_list: async () => unavailable(),
    project_create: async () => unavailable(),
    thread_read: async () => unavailable(),
    thread_list: async () => unavailable(),
    thread_delegate: async () => unavailable(),
    thread_message: async () => unavailable(),
    thread_write: async () => unavailable(),
    thread_wait: async () => unavailable(),
    thread_configure: async () => unavailable(),
    thread_queue: async () => unavailable(),
    assignment_cancel: async () => unavailable(),
    person_message: async () => unavailable(),
    person_show: async () => unavailable(),
    request_list: async () => unavailable(),
    request_withdraw: async () => unavailable(),
    browser_profile_create: async () => unavailable(),
    browser_profile_list: async () => unavailable(),
    sign_in: async () => unavailable(),
    browser_access_request: async () => unavailable(),
    machine_full_disk_access_request: async () => unavailable(),
    browser_tab_read: async () => unavailable(),
    browser_tab_write: async () => unavailable(),
    browser_session_list: async () => unavailable(),
    browser_session_open: async () => unavailable(),
    browser_session_close: async () => unavailable(),
    trigger_read: async () => unavailable(),
    trigger_write: async () => unavailable(),
    integration_search: async () => unavailable(),
    integration_describe: async () => unavailable(),
    integration_call: async () => unavailable(),
    computer: async () => unavailable(),
    integration_request: async () => unavailable(),
    integration_propose: async () => unavailable(),
  };
  const agent = new OpensteerMcpService({
    publicUrl: url,
    handlers,
    callers: {
      authenticate: async (token: string) => {
        const claims = await agentTokens.authenticate(token);
        const common = {
          userId: scope.requestedBy,
          accessMode: thread.accessMode,
          reach:
            caseReach(testCase) === "user"
              ? { kind: "user" as const }
              : caseReach(testCase) === "lineage"
                ? { kind: "lineage" as const, lineageRootThreadId: thread.id }
                : { kind: "workspace" as const, workspaceId: thread.workspaceId },
        };
        if (testCase.caller === "connection")
          return {
            ...common,
            kind: "connection" as const,
            key: "connection:eval",
            connectionId: "eval",
          };
        return {
          ...common,
          kind: "run" as const,
          key: `run:${scope.runId}`,
          thread,
          claims,
        };
      },
    },
    store: {
      getThreadForOwner: async (id) => ({ ...thread, id }),
      findMainWorkspaceForOwner: async () => undefined,
    },
  });
  const sessions: { server: Server; transport: StreamableHTTPServerTransport }[] = [];
  const clients: Client[] = [];
  const activeCalls = new Map<string, number>();
  const mockOffsets = new Map<string, number>();
  const endpoints = new Map<
    string,
    {
      client: Client;
      tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
      instructions: string;
    }
  >();
  const routes = new Map<
    string,
    (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>
  >();
  routes.set("/production/agent", (req, res, body) =>
    agent.handle(
      req,
      res,
      body,
      agentToken,
      testCase.caller === "connection" ? url.origin : undefined,
    ),
  );
  http.on("request", (req, res) => {
    void (async () => {
      const route = routes.get(new URL(req.url ?? "/", url).pathname);
      if (!route || req.headers.authorization !== `Bearer ${secret}`) {
        res.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > 8 * 1024 * 1024) throw new Error("Eval request too large");
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      await route(req, res, raw ? bodySchema.parse(JSON.parse(raw)) : undefined);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  async function close() {
    const closed = await Promise.allSettled([
      ...clients.map((client) => client.close()),
      ...sessions.map(({ server }) => server.close()),
      agent.close(),
    ]);
    await closeHttpServerNow(http);
    const failures = closed.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Fake Host cleanup failed",
      );
  }
  try {
    for (const name of ["agent"]) {
      const client = new Client({ name: "opensteer-eval", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`/production/${name}`, url), {
          requestInit: { headers: { Authorization: `Bearer ${secret}` } },
        }) as unknown as Transport,
      );
      const { tools } = await client.listTools();
      const instructions = client.getInstructions() ?? "";
      endpoints.set(name, { client, tools, instructions });
      routes.set(`/${name}`, async (req, res, body) => {
        let session = sessions.find(
          ({ transport }) => transport.sessionId === req.headers["mcp-session-id"],
        );
        if (!session) {
          const server = new Server(
            { name: "opensteer", version: "1.0.0" },
            { capabilities: { tools: {} }, instructions },
          );
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: true,
          });
          server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
          server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const args = request.params.arguments ?? {};
            const name = request.params.name;
            const index = activeCalls.get(`${extra.sessionId}:${String(extra.requestId)}`);
            if (index === undefined) throw new Error("MCP call was not recorded at ingress");
            const original = await client.callTool({ name, arguments: args });
            const definition = agentTools
              .filter((tool) => tool.callers.some((kind) => kind === testCase.caller))
              .find((tool) => tool.name === name);
            const valid = !!definition && definition.input.safeParse(args).success;
            calls[index] = { tool: name, args, valid };
            if (!valid) return original;
            let result = Object.hasOwn(testCase.mocks, name)
              ? testCase.mocks[name]
              : defaultResult(name);
            if (
              result !== null &&
              typeof result === "object" &&
              !Array.isArray(result) &&
              "$responses" in result &&
              Array.isArray(result.$responses)
            ) {
              const offset = mockOffsets.get(name) ?? 0;
              mockOffsets.set(name, offset + 1);
              result =
                offset < result.$responses.length
                  ? result.$responses[offset]
                  : { status: "unavailable", message: "Case mock response sequence exhausted" };
            }
            if (isRecord(result) && typeof result.$error === "string") {
              return {
                isError: true,
                content: [{ type: "text", text: result.$error }],
              };
            }
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              ...(name !== "integration_describe" && isRecord(result)
                ? { structuredContent: result }
                : {}),
            };
          });
          await server.connect(transport as unknown as Transport);
          session = { server, transport };
          sessions.push(session);
        }
        const parsedBody = body === undefined ? {} : bodySchema.parse(body);
        let callKey: string | undefined;
        if (parsedBody.method === "tools/call") {
          const params = z
            .looseObject({ name: z.string(), arguments: z.unknown().optional() })
            .safeParse(parsedBody.params);
          callKey = `${session.transport.sessionId}:${String(parsedBody.id)}`;
          activeCalls.set(callKey, calls.length);
          calls.push({
            tool: params.success ? params.data.name : "<invalid-name>",
            args: params.success
              ? Object.hasOwn(params.data, "arguments")
                ? params.data.arguments
                : {}
              : parsedBody.params,
            valid: false,
          });
        }
        try {
          await session.transport.handleRequest(req, res, body);
        } finally {
          if (callKey) activeCalls.delete(callKey);
        }
      });
    }
    return { calls, scope, secret, url, endpoints, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function defaultResult(name: string): unknown {
  switch (name) {
    case "integration_search":
      return { operations: [], integrations: [], catalog: [], total: 0 };
    case "project_list":
      return { projects: [], window: { hasMore: false } };
    case "thread_list":
      return { threads: [], nextCursor: null };
    case "request_list":
      return { requests: [] };
    case "browser_profile_list":
      return { profiles: [] };
    case "browser_session_list":
      return { sessions: [] };
    case "trigger_read":
      return { triggers: [] };
    default:
      return {
        status: "unavailable",
        message: "No matching fixture is configured for this operation. No resource was created.",
      };
  }
}
