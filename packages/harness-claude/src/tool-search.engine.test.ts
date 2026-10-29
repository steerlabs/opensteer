import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { toolsForCapabilityProfile } from "@opensteer/agent-tools";
import { integrationGatewayToolNames } from "@opensteer/integration-core";
import { describe, expect, it } from "vitest";
import { resolveClaudeExecutable } from "./executable.js";

function installedClaude(): string {
  const executable = resolveClaudeExecutable(process.env.OPENSTEER_CLAUDE_EXECUTABLE ?? "claude");
  if (!executable)
    throw new Error(
      "Install Claude Code from https://code.claude.com/docs/en/setup, then restart Opensteer.",
    );
  return executable;
}

// Real CLI, model, HTTP discovery and tool execution; only Host operations are
// fixtures. The first-request comparison includes cache reads and writes.
describe("Claude deferred Opensteer tools", () => {
  it("discovers tools fresh, resumed and in a subagent with smaller initial input", async () => {
    const directory = join(
      process.env.OPENSTEER_TOOL_SEARCH_EVIDENCE_DIR ?? tmpdir(),
      `opensteer-tool-search-${randomUUID()}`,
    );
    await mkdir(directory, { recursive: true });
    const calls: { name: string; at: number }[] = [];
    const discovery: { server: string; requested: number; ready: number | undefined }[] = [];
    const resources = new Set<Server>();
    let slow = false;
    const serve = async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const name = request.url === "/integrations" ? "opensteer_integrations" : "opensteer";
      const server = new Server({ name, version: "1" }, { capabilities: { tools: {} } });
      resources.add(server);
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        const entry = {
          server: name,
          requested: Date.now(),
          ready: undefined as number | undefined,
        };
        discovery.push(entry);
        if (slow) await delay(25_000);
        entry.ready = Date.now();
        return {
          tools:
            name === "opensteer"
              ? toolsForCapabilityProfile("main").map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: toJsonSchemaCompat(tool.inputSchema, {
                    strictUnions: true,
                    pipeStrategy: "input",
                  }),
                }))
              : integrationGatewayToolNames.map((tool) => ({
                  name: tool,
                  description: `Fixture ${tool}`,
                  inputSchema: {
                    type: "object" as const,
                    properties: { query: { type: "string" } },
                  },
                })),
        };
      });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push({ name: `${name}:${request.params.name}`, at: Date.now() });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ proof: "fixture-executed", name: request.params.name }),
            },
          ],
        };
      });
      const transport = new StreamableHTTPServerTransport({});
      response.on("close", () => {
        void server.close();
        resources.delete(server);
      });
      try {
        await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
        await transport.handleRequest(request, response);
      } catch (error) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const http = createServer((request, response) => {
      void serve(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const traces: Record<string, { at: number; message: SDKMessage }[]> = {};
    const options = (alwaysLoad: boolean): Options => ({
      cwd: directory,
      pathToClaudeCodeExecutable: installedClaude(),
      model: "sonnet",
      env: { ...process.env, ENABLE_TOOL_SEARCH: "true" },
      settingSources: [],
      strictMcpConfig: true,
      tools: ["ToolSearch", "Agent"],
      allowedTools: ["ToolSearch", "Agent", "mcp__opensteer__*", "mcp__opensteer_integrations__*"],
      permissionMode: "default",
      maxTurns: 12,
      persistSession: true,
      managedSettings: {
        disableAllHooks: true,
        disableBundledSkills: true,
        disableClaudeAiConnectors: true,
        disableRemoteControl: true,
        disableWorkflows: true,
      },
      systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true },
      mcpServers: {
        opensteer: { type: "http", url: `${origin}/tools`, alwaysLoad },
        opensteer_integrations: { type: "http", url: `${origin}/integrations`, alwaysLoad },
      },
      canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
    });
    const run = async (label: string, prompt: string, config: Options) => {
      const trace: (typeof traces)[string] = [];
      traces[label] = trace;
      const handle = query({ prompt, options: config });
      try {
        for await (const message of handle) trace.push({ at: Date.now(), message });
      } finally {
        handle.close();
        await writeFile(join(directory, `${label}.json`), JSON.stringify(trace, null, 2));
      }
      const result = trace.findLast(({ message }) => message.type === "result")?.message;
      expect(result?.type === "result" && result.subtype === "success", label).toBe(true);
      return trace;
    };
    const firstInput = (trace: (typeof traces)[string]) => {
      const message = trace.find(({ message }) => message.type === "assistant")?.message;
      if (message?.type !== "assistant") throw new Error("No assistant usage");
      const usage = message.message.usage;
      return (
        usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
      );
    };
    const prompt =
      "Use ToolSearch if needed to find and call Opensteer's thread_list tool and integration_search tool (query calendar). Do both now, then reply with their proof values. Do not delegate.";
    try {
      const baseline = await run("always-load", prompt, options(true));
      const baselineCalls = calls.splice(0);
      expect(baselineCalls.map(({ name }) => name)).toContain("opensteer:thread_list");
      slow = true;
      const fresh = await run("deferred-fresh", prompt, options(false));
      slow = false;
      expect(calls.map(({ name }) => name)).toContain("opensteer:thread_list");
      expect(calls.map(({ name }) => name)).toContain("opensteer_integrations:integration_search");
      const init = fresh.find(
        ({ message }) => message.type === "system" && message.subtype === "init",
      )?.message;
      if (init?.type !== "system" || init.subtype !== "init") throw new Error("No session init");
      expect(init.tools).toContain("ToolSearch");
      expect(init.tools).toContain("mcp__opensteer__thread_list");
      expect(init.tools).toContain("mcp__opensteer_integrations__integration_search");
      const resumed = await run(
        "deferred-resumed",
        "Find and call Opensteer's thread_read tool for threadId home, and integration_describe. Use ToolSearch to load their schemas. Reply with their proof values.",
        { ...options(false), resume: init.session_id },
      );
      expect(calls.map(({ name }) => name)).toContain("opensteer:thread_read");
      expect(calls.map(({ name }) => name)).toContain(
        "opensteer_integrations:integration_describe",
      );
      await run(
        "deferred-subagent",
        "Start one foreground Agent subagent. Instruct it to use ToolSearch to find and call Opensteer's thread_list tool, then return its proof. Do not call thread_list yourself.",
        options(false),
      );
      const subagentTrace = traces["deferred-subagent"] ?? [];
      expect(
        subagentTrace.some(
          ({ message }) =>
            message.type === "assistant" &&
            message.parent_tool_use_id !== null &&
            message.message.content.some(
              (part) => part.type === "tool_use" && part.name === "mcp__opensteer__thread_list",
            ),
        ),
      ).toBe(true);
      const tokens = {
        alwaysLoad: firstInput(baseline),
        deferred: firstInput(fresh),
        resumed: firstInput(resumed),
      };
      expect(tokens.deferred).toBeLessThan(tokens.alwaysLoad);
      await writeFile(
        join(directory, "result.json"),
        JSON.stringify(
          {
            sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            tokens,
            calls,
            discovery,
            executable: installedClaude(),
            model: "sonnet",
            artifactDirectory: directory,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ directory, tokens }));
    } finally {
      await Promise.allSettled([...resources].map((server) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
