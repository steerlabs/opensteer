import { discover } from "@opensteer/agent-tools/discover";
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
import { commandSubject } from "../../packages/database/src/resource-access.js";
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
  const scope: RunToolScope = {
    aud: "opensteer-run-tools",
    bindingGeneration: 1,
    environmentId: createId("environment"),
    requestedBy: createId("user"),
    runId: createId("run"),
    runnerBootId: "eval",
    runnerId: createId("runner"),
    threadId: testCase.tasks.find((entry) => entry.self)?.task.id ?? createId("thread"),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    iss: "opensteer-host",
    jti: randomUUID(),
  };
  const agentToken = randomUUID();
  const connectionId = randomUUID();
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
    status: "idle",
    title: "Eval",
    updatedAt: new Date().toISOString(),
  });
  // Automation tools expand and validate in their production handler before the
  // fixture replaces the backend.
  const triggers = new TriggerToolHandlers(
    { manage: async () => unavailable() },
    { triggerOrigins: async () => new Map() },
    {
      door: (_caller, registry) => ({
        registry,
        scope: async () => ({ scope: null, grant: null, mode: "full-access" }),
        // As the real door admits an agent: it names the subject it admitted, which every later
        // admission of the command reads again.
        admit: async (caller) => ({
          answer: "now",
          face: 0,
          execution: { subject: commandSubject(caller.key) } as never,
        }),
        secretDigestKey: Buffer.alloc(32, 0x33),
      }),
    },
  );
  const handlers: AgentToolHandlers = {
    discover: async () => unavailable(),
    opensteer_ai_account_list: async () => unavailable(),
    opensteer_commands: async () => unavailable(),
    opensteer_command: async () => unavailable(),
    opensteer_state: async () => unavailable(),
    computer_list: async () => unavailable(),
    computer_use: async () => unavailable(),
    computer_apps: async () => unavailable(),
    computer_access_request: async () => unavailable(),
    opensteer_plugin_list: async () => unavailable(),
    opensteer_plugin_install: async () => unavailable(),
    opensteer_plugin_catalog: async () => unavailable(),
    plugin_resources: async () => unavailable(),
    plugin_skills: async () => unavailable(),
    opensteer_plugin_resource_update: async () => unavailable(),
    plugin_search: async () => unavailable(),
    plugin_describe: async () => unavailable(),
    plugin_call: async () => unavailable(),
    plugin_execute: async () => unavailable(),
    plugin_resume: async () => unavailable(),
    opensteer_plugin_export: async () => unavailable(),
    opensteer_plugin_activate: async () => unavailable(),
    plugin_account_request: async () => unavailable(),
    opensteer_plugin_remove: async () => unavailable(),
    local_server_add: async () => unavailable(),
    local_server_list: async () => unavailable(),
    local_server_remove: async () => unavailable(),
    browser_use: async () => unavailable(),
    browser_connect: async () => unavailable(),
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
    app_access_request: async () => unavailable(),
  };
  const agent = new OpensteerMcpService({
    publicUrl: url,
    handlers,
    callers: {
      authenticate: async (token: string) => {
        if (token !== agentToken) throw refused("unauthorized", "Invalid eval credential");
        const common = {
          userId: scope.requestedBy,
          accessMode: thread.accessMode,
        };
        if (testCase.caller === "connection") {
          const grant = { scope: "everything" } as const;
          const grantRevision = 1;
          return {
            ...common,
            kind: "connection" as const,
            key: `connection:${connectionId}`,
            connectionId,
            grant,
            grantRevision,
            agentConnection: {
              agentConnectionId: connectionId,
              grant,
              grantRevision,
              // A connection as it consents today: direct work included (B5).
              consentVersion: 2,
              accessMode: common.accessMode,
              bridgeSenders: null,
            },
          };
        }
        return {
          ...common,
          kind: "run" as const,
          key: `run:${scope.runId}`,
          thread,
          claims: scope,
        };
      },
    },
    store: {
      requests: { get: async () => null },
      readTask: async (_reader, id) => ({ ...thread, id }),
      threadOrigins: async () => new Map(),
    },
  });
  const tabs = new TabFixture(testCase.browser ?? BrowserFixtureSchema.parse({}), scope.threadId);
  const appServers = await startAppServers(testCase.appServers, calls);
  const mocks = withFixtureUrls(testCase.mocks, appServers.urls, workspace) as EvalCase["mocks"];
  const sessions: { server: Server; transport: StreamableHTTPServerTransport }[] = [];
  const clients: Client[] = [];
  const activeCalls = new Map<string, number>();
  const mockOffsets = new Map<string, number>();
  const automationWrites = new Map<string, Record<string, unknown>>();
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
      const offered = new Set(tools.map(({ name }) => name));
      const instructions = client.getInstructions() ?? "";
      endpoints.set(name, { client, tools, instructions });
      // MCP calls and Browser Harness opensteer.callTool both arrive here, as in production.
      const dispatch = async (
        name: string,
        args: Record<string, unknown>,
        index: number,
      ): Promise<CallToolResult> => {
        const original = await client.callTool({ name, arguments: args });
        const definition =
          name === "discover" ? discover : agentTools.find((tool) => tool.name === name);
        const valid =
          !!definition &&
          offered.has(name) &&
          (original.isError !== true ||
            (isRecord(original.structuredContent) &&
              isRecord(original.structuredContent.error) &&
              original.structuredContent.error.message === validated));
        calls[index] = { at: calls[index]?.at ?? Date.now(), tool: name, args, valid };
        if (!valid) return original as CallToolResult;
        const fixture = Object.hasOwn(mocks, name)
          ? mocks[name]
          : tabFixtureTools.has(name)
            ? undefined
            : taskFixtureResult(testCase, name, args, scope.threadId);
        // Nothing configured for this tool: its empty answer, or an unavailable refusal when its
        // output has no place for one. The call was valid; only the case's answer is missing.
        let result =
          fixture !== undefined || tabFixtureTools.has(name)
            ? fixture
            : definition!.output.safeParse(defaultResult(name)).success
              ? defaultResult(name)
              : { $error: unconfigured, $code: "unavailable" };
        // A Home that changed answers with the change: `$after` reads `changed` once an earlier
        // accepted call in this sample matched `call` (tool and partial arguments), else
        // `before`, so a model that checks its own work sees what the Home would show. It may
        // stand for a whole mock or for one `$byArgs` entry's result.
        const changed = (value: unknown): unknown => {
          if (!isRecord(value) || !isRecord(value.$after)) return value;
          const after = value.$after;
          const call = isRecord(after.call) ? after.call : {};
          const done = calls
            .slice(0, index)
            .some(
              (previous) =>
                previous?.valid === true &&
                previous.tool === call.tool &&
                partialMatch(previous.args, isRecord(call.args) ? call.args : {}),
            );
          return done ? after.changed : after.before;
        };
        result = changed(result);
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
              : { $error: "Case mock response sequence exhausted" };
        }
        if (isRecord(result) && Array.isArray(result.$byArgs)) {
          const entry = result.$byArgs.find(
            (candidate) => isRecord(candidate) && partialMatch(args, candidate.args),
          );
          result = isRecord(entry)
            ? changed(entry.result)
            : { $error: "No case mock matches these arguments" };
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
        }
        if (name === "opensteer_automation_read" && isRecord(result)) {
          if (isRecord(result.automation) && typeof result.automation.id === "string") {
            const automationId = result.automation.id;
            // A write answers with the automation alone; the read keeps its own fields.
            result = {
              ...result,
              automation: { ...result.automation, ...automationWrites.get(automationId) },
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
            // A list entry keeps its summary fields (source, task, latest occurrence).
            automations: result.automations.map((automation) =>
              isRecord(automation) && typeof automation.id === "string"
                ? { ...automation, ...automationWrites.get(automation.id) }
                : automation,
            ),
          };
        const output = definition.output.safeParse(result);
        if (!output.success) {
          const message = `${testCase.id}: invalid mock output for ${name}: ${output.error.message}`;
          calls[index] = {
            at: calls[index]?.at ?? Date.now(),
            tool: name,
            args,
            valid: false,
            result: { error: message },
          };
          return agentToolFailureResult({ code: "invalid_mock_output", message });
        }
        result = output.data;
        calls[index] = { at: calls[index]?.at ?? Date.now(), tool: name, args, valid, result };
        if (name === "plugin_describe" || !isRecord(result)) {
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

function taskFixtureResult(
  testCase: EvalCase,
  name: string,
  args: Record<string, unknown>,
  selfId: string,
): unknown {
  if (!testCase.tasks.length) return undefined;
  const offset = typeof args.cursor === "string" ? Number(args.cursor) : 0;
  const page = <T>(items: T[], limit: number) => ({
    items: items.slice(offset, offset + limit),
    hasMore: offset + limit < items.length,
    nextCursor: offset + limit < items.length ? String(offset + limit) : null,
  });
  if (name === "opensteer_task_list") {
    const since = typeof args.changedSince === "string" ? Date.parse(args.changedSince) : null;
    const query = typeof args.query === "string" ? args.query.toLowerCase() : null;
    const tasks = testCase.tasks
      .flatMap(({ task, items }) => {
        if (args.parentTaskId && task.parentTaskId !== args.parentTaskId) return [];
        if (typeof args.done === "boolean" && Boolean(task.doneAt) !== args.done) return [];
        if (
          typeof args.hasPendingRequests === "boolean" &&
          task.pendingRequests > 0 !== args.hasPendingRequests
        )
          return [];
        if (
          query &&
          !task.title?.toLowerCase().includes(query) &&
          !items.some(
            (item) =>
              item.type === "message" &&
              item.status === "published" &&
              item.text?.toLowerCase().includes(query),
          )
        )
          return [];
        const messages = items
          .filter(
            (item) =>
              item.type === "message" &&
              item.status === "published" &&
              (since === null || Date.parse(item.createdAt) > since),
          )
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const settledQuestions = items.filter(
          (item) =>
            item.type === "request.resolved" &&
            (item.status === "fulfilled" || item.status === "declined") &&
            (since === null || Date.parse(item.createdAt) > since),
        );
        const doneChanged =
          since !== null &&
          task.doneAt !== null &&
          Date.parse(task.doneAt) > since &&
          task.doneBy !== "quiet";
        if (since !== null && !messages.length && !settledQuestions.length && !doneChanged)
          return [];
        const questionsAnswered = settledQuestions.filter(
          (item) => item.status === "fulfilled",
        ).length;
        const questionsDismissed = settledQuestions.filter(
          (item) => item.status === "declined",
        ).length;
        const newestEventAt =
          since !== null
            ? Math.max(
                ...messages.map((item) => Date.parse(item.createdAt)),
                ...settledQuestions.map((item) => Date.parse(item.createdAt)),
                ...(doneChanged && task.doneAt ? [Date.parse(task.doneAt)] : []),
              )
            : Date.parse(task.updatedAt);
        return [
          {
            sortAt: newestEventAt,
            entry: {
              id: task.id,
              link: task.link,
              title: task.title,
              status: task.status,
              doneAt: task.doneAt,
              doneBy: task.doneBy ?? null,
              lastVisitedAt: task.lastVisitedAt ?? null,
              parentTaskId: task.parentTaskId,
              pendingRequests: task.pendingRequests,
              delegationId: null,
              taskStatus: null,
              updatedAt: task.updatedAt,
              ...(since !== null && messages.length
                ? {
                    newMessages: messages.length,
                    firstNewAt: messages.at(-1)!.createdAt,
                  }
                : {}),
              ...(since !== null && questionsAnswered > 0 ? { questionsAnswered } : {}),
              ...(since !== null && questionsDismissed > 0 ? { questionsDismissed } : {}),
            },
          },
        ];
      })
      .sort((a, b) => b.sortAt - a.sortAt)
      .map(({ entry }) => entry);
    const result = page(tasks, typeof args.limit === "number" ? args.limit : 25);
    return { tasks: result.items, hasMore: result.hasMore, nextCursor: result.nextCursor };
  }
  if (name === "opensteer_task_read") {
    const history = testCase.tasks.find(({ task }) => task.id === (args.taskId ?? selfId));
    if (!history) return undefined;
    const isQuery = typeof args.query === "string";
    const items = history.items
      .filter(
        (item) =>
          (isQuery
            ? item.type === "message" &&
              item.status === "published" &&
              item.text?.toLowerCase().includes((args.query as string).toLowerCase())
            : args.view === "activity" ||
              (item.type === "message" && item.status === "published") ||
              (item.type === "request.resolved" &&
                (item.status === "fulfilled" || item.status === "declined"))) &&
          (!args.itemId || args.itemId === item.itemId),
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const result = page(items, typeof args.limit === "number" ? args.limit : 20);
    return { task: history.task, recentRuns: [], recentPlaces: [], ...result };
  }
  return undefined;
}

const unconfigured =
  "No matching fixture is configured for this operation. No resource was created.";

function defaultResult(name: string): unknown {
  switch (name) {
    case "discover":
      return { items: [], nextCursor: null };
    case "plugin_search":
      return { items: [], namespaces: [], remaining: 0, next: null };
    case "computer_apps":
      return { computers: [], phones: [] };
    case "opensteer_task_list":
      return { tasks: [], hasMore: false, nextCursor: null };
    case "opensteer_request_list":
      return {
        requests: [],
        window: { byteCount: 0, hasMore: false, itemCount: 0, nextCursor: null, totalItems: 0 },
      };
    case "browser_profile_list":
      return { profiles: [], sites: [] };
    case "opensteer_automation_list":
      return { automations: [] };
    default:
      return { status: "unavailable", message: unconfigured };
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
