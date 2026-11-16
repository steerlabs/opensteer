import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isRecord } from "@opensteer/shared/isRecord";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createId, refused, ThreadSchema } from "@opensteer/core";
import { agentToolFailureResult, agentToolRecordResult, agentTools } from "@opensteer/agent-tools";
import { OpensteerMcpService } from "../../apps/host/src/mcp/opensteer-mcp-service.js";
import type { AgentToolHandlers } from "../../apps/host/src/mcp/handlers/types.js";
import { TriggerToolHandlers } from "../../apps/host/src/mcp/handlers/triggers.js";
import type { RunToolScope } from "../../apps/host/src/agents/run-tool-tokens.js";

import { type EvalCase } from "./cases.js";
import { partialMatch, gradeToolBoundary, type Check, type RecordedCall } from "./grader.js";
import { TabFixture, tabFixtureTools } from "./tab-fixture.js";
import { BrowserFixtureSchema } from "./cases.js";

// These are test doubles, never a real Host store, grant, credential or integration.
// Every tool call traverses the production MCP service's input and access checks
// before this sentinel allows a fixture to replace the backend.
const validated = "EVAL_VALIDATED_NO_SIDE_EFFECT";
function unavailable(): never {
  throw refused("conflict", validated);
}
const bodySchema = z.looseObject({
  method: z.string().optional(),
  params: z.unknown().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
});

export async function startFakeHost(testCase: EvalCase, workspace?: string) {
  const calls: RecordedCall[] = [];
  const boundaryChecks: Check[] = [];
  const secret = randomUUID();
  const scope = {
    bindingGeneration: 1,
    environmentId: createId("environment"),
    requestedBy: createId("user"),
    runId: createId("run"),
    runnerBootId: "eval",
    runnerId: createId("runner"),
    threadId: createId("thread"),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    iss: "opensteer-host" as const,
    jti: randomUUID(),
  };
  const agentToken = randomUUID();
  const http = createServer();
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No eval listener");
  const url = new URL(`http://127.0.0.1:${address.port}`);
  const thread = ThreadSchema.parse({
    ...scope,
    id: scope.threadId,
    accessMode: testCase.accessMode,
    continuationIdentity: null,
    createdAt: new Date().toISOString(),
    createdBy: scope.requestedBy,
    harnessInstanceId: createId("harnessInstance"),
    lineageRootThreadId: scope.threadId,
    inputQueuePaused: false,
    listed: true,
    modelSelection: { modelId: "eval", providerId: "eval", options: {} },
    parentThreadId: null,
    pendingRequests: 0,
    purpose: testCase.purpose,
    teamOrigin: testCase.teamBound
      ? { teamId: createId("deployment"), channelId: createId("teamChannel"), threadRootId: "1" }
      : null,
    status: "idle",
    title: "Eval",
    updatedAt: new Date().toISOString(),
  });
  // Automation tools expand and validate in their production handler before the
  // fixture replaces the backend.
  const triggers = new TriggerToolHandlers({ manage: async () => unavailable() });
  const handlers: AgentToolHandlers = {
    opensteer_ai_account_list: async () => unavailable(),
    opensteer_ai_account_update: async () => unavailable(),
    opensteer_defaults_read: async () => unavailable(),
    opensteer_defaults_update: async () => unavailable(),
    computer_list: async () => unavailable(),
    computer_update: async () => unavailable(),
    computer_remove: async () => unavailable(),
    computer_use: async () => unavailable(),
    computer_access_request: async () => unavailable(),
    integration_list: async () => unavailable(),
    integration_remove: async () => unavailable(),
    opensteer_messaging_bridge_list: async () => unavailable(),
    opensteer_messaging_bridge_update: async () => unavailable(),
    opensteer_messaging_bridge_remove: async () => unavailable(),
    opensteer_plugin_list: async () => unavailable(),
    opensteer_plugin_install: async () => unavailable(),
    opensteer_plugin_update: async () => unavailable(),
    opensteer_plugin_remove: async () => unavailable(),
    browser_profile_update: async () => unavailable(),
    browser_profile_remove: async () => unavailable(),
    app_publish: async () => unavailable(),
    app_list: async () => unavailable(),
    app_start: async () => unavailable(),
    app_stop: async () => unavailable(),
    app_delete: async () => unavailable(),
    tab_list: async () => unavailable(),
    tab_open: async () => unavailable(),
    tab_close: async () => unavailable(),
    tab_organize: async () => unavailable(),
    tab_group_update: async () => unavailable(),
    opensteer_task_list: async () => unavailable(),
    opensteer_task_read: async () => unavailable(),
    opensteer_task_create: async () => unavailable(),
    opensteer_task_delegate: async () => unavailable(),
    opensteer_task_send: async () => unavailable(),
    opensteer_task_wait: async () => unavailable(),
    opensteer_task_interrupt: async () => unavailable(),
    opensteer_task_resume: async () => unavailable(),
    opensteer_task_queue: async () => unavailable(),
    opensteer_task_update: async () => unavailable(),
    opensteer_task_configure: async () => unavailable(),
    opensteer_delegation_status: async () => unavailable(),
    opensteer_delegation_wait: async () => unavailable(),
    opensteer_delegation_cancel: async () => unavailable(),
    opensteer_subagent_read: async () => unavailable(),
    opensteer_subagent_stop: async () => unavailable(),
    ask_person: async () => unavailable(),
    send_to_person: async () => unavailable(),
    show_to_person: async () => unavailable(),
    opensteer_request_list: async () => unavailable(),
    opensteer_request_read: async () => unavailable(),
    opensteer_request_answer: async () => unavailable(),
    opensteer_request_withdraw: async () => unavailable(),
    browser_profile_list: async () => unavailable(),
    saved_login_request: async () => unavailable(),
    chrome_cookies_request: async () => unavailable(),
    card_request: async () => unavailable(),
    browser_profile_request: async () => unavailable(),
    opensteer_automation_list: (call) => triggers.read(call),
    opensteer_automation_read: (call) => triggers.read(call),
    opensteer_automation_create: (call) => triggers.write(call),
    opensteer_automation_update: (call) => triggers.write(call),
    opensteer_automation_control: (call) => triggers.write(call),
    integration_search: async () => unavailable(),
    integration_describe: async () => unavailable(),
    integration_call: async () => unavailable(),
    integration_request: async () => unavailable(),
    app_access_request: async () => unavailable(),
    custom_integration_request: async () => unavailable(),
    opensteer_team_read: async () => unavailable(),
    opensteer_team_file_download: async () => unavailable(),
    opensteer_team_search: async () => unavailable(),
    opensteer_team_post: async () => unavailable(),
    opensteer_knowledge_topic_list: async () => unavailable(),
    opensteer_knowledge_search: async () => unavailable(),
    opensteer_knowledge_read: async () => unavailable(),
    opensteer_knowledge_save: async () => unavailable(),
    opensteer_knowledge_remove: async () => unavailable(),
  };
  const agent = new OpensteerMcpService({
    teamsAvailable: async () => testCase.teamBound || testCase.knowledge,
    publicUrl: url,
    handlers,
    callers: {
      authenticate: async (token: string) => {
        if (token !== agentToken) throw refused("unauthorized", "Invalid eval credential");
        const claims = scope as unknown as RunToolScope;
        const common = {
          userId: scope.requestedBy,
          accessMode: thread.accessMode,
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
      requests: { get: async () => null },
      getThreadForOwner: async (id) => ({ ...thread, id }),
    },
  });
  const tabs = new TabFixture(testCase.browser ?? BrowserFixtureSchema.parse({}), scope.threadId);
  const appServers = await startAppServers(testCase.appServers, calls);
  const mocks = withFixtureUrls(testCase.mocks, appServers.urls, workspace) as EvalCase["mocks"];
  const sessions: { server: Server; transport: StreamableHTTPServerTransport }[] = [];
  const clients: Client[] = [];
  const activeCalls = new Map<string, number>();
  const mockOffsets = new Map<string, number>();
  const automationWrites = new Map<string, unknown>();
  const automationSources = new Map<string, unknown>();
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
  // Chained samples close each stage's Host, then sample cleanup closes the last one again.
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return (closing ??= closeOnce());
  }
  async function closeOnce() {
    const closed = await Promise.allSettled([
      ...clients.map((client) => client.close()),
      ...sessions.map(({ server }) => server.close()),
      agent.close(),
      appServers.close(),
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
      // MCP calls and Browser Harness opensteer.callTool both arrive here, as in production.
      const dispatch = async (
        name: string,
        args: Record<string, unknown>,
        index: number,
      ): Promise<CallToolResult> => {
        const original = await client.callTool({ name, arguments: args });
        const definition = agentTools
          .filter((tool) => tool.callers.some((kind) => kind === testCase.caller))
          .find((tool) => tool.name === name);
        const valid =
          !!definition &&
          definition.input.safeParse(args).success &&
          (original.isError !== true ||
            (isRecord(original.structuredContent) &&
              isRecord(original.structuredContent.error) &&
              original.structuredContent.error.message === validated));
        calls[index] = { at: calls[index]?.at ?? Date.now(), tool: name, args, valid };
        if (!valid) return original as CallToolResult;
        let result = Object.hasOwn(mocks, name)
          ? mocks[name]
          : tabFixtureTools.has(name)
            ? undefined
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
        if (isRecord(result) && Array.isArray(result.$byArgs)) {
          const entry = result.$byArgs.find(
            (candidate) => isRecord(candidate) && partialMatch(args, candidate.args),
          );
          result = isRecord(entry)
            ? entry.result
            : { status: "unavailable", message: "No case mock matches these arguments" };
        }
        if (isRecord(result) && typeof result.$error === "string") {
          calls[index] = {
            at: calls[index]?.at ?? Date.now(),
            tool: name,
            args,
            valid,
            result,
          };
          return agentToolFailureResult({
            code: typeof result.$code === "string" ? result.$code : "invalid_input",
            message: result.$error,
            next: typeof result.$next === "string" ? result.$next : null,
          });
        }
        if (result === undefined) {
          const answered = tabs.call(name, args);
          calls[index] = {
            at: calls[index]?.at ?? Date.now(),
            tool: name,
            args,
            valid,
            result: "result" in answered ? answered.result : answered,
          };
          return "result" in answered
            ? agentToolRecordResult(answered.result)
            : agentToolFailureResult(answered.error);
        }
        // Keep successful automation changes readable; fixed fixture timestamps otherwise
        // contradict the real Run clock and provoke spurious repair attempts.
        if (
          automationWriteTools.has(name) &&
          isRecord(result) &&
          isRecord(result.automation) &&
          typeof result.automation.id === "string"
        ) {
          const automationId = result.automation.id;
          let automation = result.automation;
          if (
            name === "opensteer_automation_create" &&
            isRecord(args.source) &&
            typeof args.source.at === "string"
          )
            automation = { ...automation, nextFireAt: new Date(args.source.at).toISOString() };
          result = { ...result, automation };
          automationWrites.set(automationId, automation);
          if (
            name === "opensteer_automation_update" &&
            isRecord(args.source) &&
            args.source.kind === "schedule" &&
            typeof args.source.cron === "string"
          )
            automationSources.set(automationId, {
              kind: "schedule",
              schedule: {
                kind: "cron",
                expression: args.source.cron,
                timezone: args.source.timezone,
              },
            });
        }
        if (name === "opensteer_automation_read" && isRecord(result)) {
          if (isRecord(result.automation) && typeof result.automation.id === "string") {
            const automationId = result.automation.id;
            result = {
              ...result,
              automation: automationWrites.get(automationId) ?? result.automation,
              ...(isRecord(result.revision) && automationSources.has(automationId)
                ? {
                    revision: {
                      ...result.revision,
                      source: automationSources.get(automationId),
                    },
                  }
                : {}),
            };
          }
        }
        if (
          name === "opensteer_automation_list" &&
          isRecord(result) &&
          Array.isArray(result.automations)
        )
          result = {
            ...result,
            automations: result.automations.map((automation) =>
              isRecord(automation) && typeof automation.id === "string"
                ? (automationWrites.get(automation.id) ?? automation)
                : automation,
            ),
          };
        calls[index] = { at: calls[index]?.at ?? Date.now(), tool: name, args, valid, result };
        if (name === "integration_describe" || !isRecord(result)) {
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        return agentToolRecordResult(result);
      };
      routes.set("/harness/tools", async (_req, res, body) => {
        const request = z.looseObject({ name: z.string(), input: z.unknown() }).parse(body);
        const args = isRecord(request.input) ? request.input : {};
        if (workspace)
          boundaryChecks.push(
            ...(await gradeToolBoundary(
              testCase.expect,
              calls,
              { tool: request.name, args },
              workspace,
            )),
          );
        const index = calls.push({ at: Date.now(), tool: request.name, args, valid: false }) - 1;
        const result = await dispatch(request.name, args, index);
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(harnessToolValue(result)));
      });
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
            const index = activeCalls.get(`${extra.sessionId}:${String(extra.requestId)}`);
            if (index === undefined) throw new Error("MCP call was not recorded at ingress");
            return dispatch(request.params.name, request.params.arguments ?? {}, index);
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
          if (workspace && params.success)
            boundaryChecks.push(
              ...(await gradeToolBoundary(
                testCase.expect,
                calls,
                { tool: params.data.name, args: params.data.arguments ?? {} },
                workspace,
              )),
            );
          activeCalls.set(callKey, calls.length);
          calls.push({
            at: Date.now(),
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
    return { calls, boundaryChecks, scope, secret, url, endpoints, tabs, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const automationWriteTools = new Set([
  "opensteer_automation_create",
  "opensteer_automation_update",
  "opensteer_automation_control",
]);

function defaultResult(name: string): unknown {
  switch (name) {
    case "integration_search":
      return { operations: [], integrations: [], catalog: [], total: 0 };
    case "opensteer_task_list":
      return { tasks: [], hasMore: false, nextCursor: null };
    case "opensteer_request_list":
      return { requests: [] };
    case "browser_profile_list":
      return { profiles: [], sites: [] };
    case "opensteer_automation_list":
      return { automations: [] };
    default:
      return {
        status: "unavailable",
        message: "No matching fixture is configured for this operation. No resource was created.",
      };
  }
}

/** What `opensteer.callTool` resolves to: the tool's output, or `{error}` exactly as MCP sends it. */
function harnessToolValue(result: CallToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content.find((block) => block.type === "text")?.text ?? "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return result.isError
      ? { error: { code: "internal_error", message: text, next: null } }
      : { text };
  }
}

/**
 * Real loopback listeners for server-app fixtures, so an agent's curl or fetch to a
 * localUrl actually happens and is graded as `harness:http`.
 */
async function startAppServers(
  servers: EvalCase["appServers"],
  calls: RecordedCall[],
): Promise<{ urls: Map<string, string>; close: () => Promise<void> }> {
  const listeners = await Promise.all(
    Object.entries(servers).map(async ([app, routes]) => {
      const server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://app").pathname;
        const route = `${req.method ?? "GET"} ${path}`;
        calls.push({
          at: Date.now(),
          tool: "harness:http",
          args: { app, method: req.method ?? "GET", path },
          valid: true,
        });
        req.resume();
        const answer = Object.hasOwn(routes, route) ? routes[route] : undefined;
        const status =
          isRecord(answer) && typeof answer.$status === "number"
            ? answer.$status
            : answer === undefined
              ? 404
              : 200;
        const body =
          answer === undefined
            ? { error: `No route ${route}` }
            : isRecord(answer) && "$body" in answer
              ? answer.$body
              : answer;
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No app fixture listener");
      return { app, server, url: `http://127.0.0.1:${address.port}` };
    }),
  );
  return {
    urls: new Map(listeners.map(({ app, url }) => [app, url])),
    close: async () => {
      await Promise.all(listeners.map(({ server }) => closeHttpServerNow(server)));
    },
  };
}

/** Mocks may name a live fixture: {{appServer:<name>}} for its URL, {{agentHome}} for the workspace. */
function withFixtureUrls(
  value: unknown,
  urls: ReadonlyMap<string, string>,
  agentHome: string | undefined,
): unknown {
  if (typeof value === "string")
    return value
      .replace(/\{\{appServer:([a-z0-9-]+)\}\}/gu, (_, app: string) => {
        const url = urls.get(app);
        if (!url) throw new Error(`No app server fixture named ${app}`);
        return url;
      })
      .replace(/\{\{agentHome\}\}/gu, () => agentHome ?? "/eval/agent-home");
  if (Array.isArray(value)) return value.map((item) => withFixtureUrls(item, urls, agentHome));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withFixtureUrls(item, urls, agentHome)]),
    );
  return value;
}
