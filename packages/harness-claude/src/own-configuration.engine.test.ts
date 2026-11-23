import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type McpServerStatus, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createId, ModelSelectionSchema, type ThreadAccessMode } from "@opensteer/core";
import {
  nativeUserHarnessRuntimeBoundary,
  type HarnessEvent,
  type HarnessSessionContext,
} from "@opensteer/harness";
import { afterEach, expect, it } from "vitest";
import { ClaudeHarnessDriver } from "./claude-driver.js";

/**
 * Claude Code itself, started by the driver in a temporary home and project
 * against a local stand-in for the Messages API: nothing reads or writes the
 * computer's own Claude configuration, and nothing leaves the computer.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The Claude Code build the Agent SDK ships for this platform. */
async function bundledClaudeExecutable(): Promise<string> {
  const sdk = await realpath(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")));
  const executable = join(
    dirname(dirname(sdk)),
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  await readFile(executable).catch(() => {
    throw new Error(`The Agent SDK ships no Claude Code at ${executable}`);
  });
  return executable;
}

interface StubApi {
  readonly url: string;
  /** Every main-model request body, as sent. */
  readonly requests: string[];
}

/**
 * Answers the main model's first request with one Bash call, and everything
 * after with "done". Requests without the Bash tool (background helpers) get
 * "done" too.
 */
async function startStubApi(command: string): Promise<StubApi> {
  const requests: string[] = [];
  let calls = 0;
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      if (request.url?.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"input_tokens":10}');
        return;
      }
      if (!request.url?.startsWith("/v1/messages")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const parsed = JSON.parse(body) as {
        model: string;
        messages: unknown[];
        tools?: { name?: string }[];
      };
      const main = (parsed.tools ?? []).some((tool) => tool.name === "Bash");
      if (main) requests.push(body);
      const answered = JSON.stringify(parsed.messages).includes("tool_result");
      calls += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) =>
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
        message: {
          content: [],
          id: `msg_${calls}`,
          model: parsed.model,
          role: "assistant",
          stop_reason: null,
          type: "message",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        type: "message_start",
      });
      if (main && !answered) {
        send("content_block_start", {
          content_block: { id: `toolu_${calls}`, input: {}, name: "Bash", type: "tool_use" },
          index: 0,
          type: "content_block_start",
        });
        send("content_block_delta", {
          delta: {
            partial_json: JSON.stringify({ command, description: "Write the marker" }),
            type: "input_json_delta",
          },
          index: 0,
          type: "content_block_delta",
        });
        send("content_block_stop", { index: 0, type: "content_block_stop" });
        send("message_delta", {
          delta: { stop_reason: "tool_use" },
          type: "message_delta",
          usage: { output_tokens: 5 },
        });
      } else {
        send("content_block_start", {
          content_block: { text: "", type: "text" },
          index: 0,
          type: "content_block_start",
        });
        send("content_block_delta", {
          delta: { text: "done", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        });
        send("content_block_stop", { index: 0, type: "content_block_stop" });
        send("message_delta", {
          delta: { stop_reason: "end_turn" },
          type: "message_delta",
          usage: { output_tokens: 1 },
        });
      }
      send("message_stop", { type: "message_stop" });
      response.end();
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  cleanups.push(() => new Promise((resolveClose) => server.close(() => resolveClose())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No stub address");
  return { requests, url: `http://127.0.0.1:${address.port}` };
}

/**
 * A person's own Claude Code setup: user settings that would loosen any mode
 * (every command allowed, permission prompts skipped), a user-level setting
 * the commands can see, a user skill, and an MCP server of their own beside
 * one named like Opensteer's; and a project with its own CLAUDE.md.
 */
async function personalSetup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-claude-own-")));
  // Claude Code may still be writing its session files as its process exits.
  cleanups.push(() => rm(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 }));
  const home = join(root, "home");
  const config = join(home, ".claude");
  const project = join(root, "agent-home");
  await mkdir(join(config, "skills", "person-skill"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      env: { OPENSTEER_PERSON_SETTING: "person-setting-applied" },
      permissions: {
        allow: ["Bash(*)", "Bash", "Edit", "Write"],
        defaultMode: "bypassPermissions",
      },
    }),
  );
  await writeFile(
    join(config, "skills", "person-skill", "SKILL.md"),
    "---\nname: person-skill\ndescription: A skill of the person's own.\n---\nBody.\n",
  );
  const servers = {
    mcpServers: {
      opensteer: { type: "http", url: "http://127.0.0.1:9/person-connection" },
      "person-server": { command: process.execPath, args: ["-e", ""], type: "stdio" },
    },
  };
  // Claude Code keeps user MCP servers in `.claude.json`, beside the config directory.
  await writeFile(join(config, ".claude.json"), JSON.stringify(servers));
  await writeFile(join(home, ".claude.json"), JSON.stringify(servers));
  await writeFile(join(project, "CLAUDE.md"), "Project CLAUDE.md marker 7f3a.");
  return { config, home, marker: join(project, "marker.txt"), project, root };
}

async function runOnce(input: {
  readonly accessMode: ThreadAccessMode;
  readonly personalContext: boolean;
}) {
  const setup = await personalSetup();
  const api = await startStubApi(`printf "%s" "$OPENSTEER_PERSON_SETTING" > marker.txt`);
  const executable = await bundledClaudeExecutable();
  let init: Extract<SDKMessage, { type: "system"; subtype: "init" }> | undefined;
  let servers: McpServerStatus[] | undefined;
  const driver = new ClaudeHarnessDriver({
    executable,
    sdk: {
      query: (parameters) => {
        const handle = query(parameters);
        return {
          async *[Symbol.asyncIterator]() {
            for await (const message of handle) {
              if (message.type === "system" && message.subtype === "init") {
                init = message;
                servers = await handle.mcpServerStatus();
              }
              yield message;
            }
          },
          close: () => handle.close(),
          interrupt: () => handle.interrupt(),
          stopTask: (taskId) => handle.stopTask(taskId),
        };
      },
    },
  });
  const instanceId = createId("harnessInstance");
  const adapter = await driver.create({
    config: { maxTurns: 4 },
    instanceId,
    sourceId: "anthropic",
  });
  cleanups.push(() => adapter.close());
  const threadId = createId("thread");
  const state = join(setup.root, "state");
  const threadStateDirectory = join(state, "threads", threadId);
  await mkdir(threadStateDirectory, { recursive: true });
  const environment = {
    ANTHROPIC_API_KEY: "sk-ant-local-stub",
    ANTHROPIC_BASE_URL: api.url,
    CLAUDE_CONFIG_DIR: setup.config,
    HOME: setup.home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: join(setup.root, "state"),
  };
  const context: HarnessSessionContext = {
    accessMode: input.accessMode,
    agentTools: {
      instructions: "",
      skills: [],
      token: "local-stub",
      tools: [],
      toolsRevision: "own-configuration",
      url: "http://127.0.0.1:9/internal/v1/mcp",
    },
    commandEnvironment: {},
    environment,
    environmentId: createId("environment"),
    harnessInstanceId: instanceId,
    history: [],
    historyWindow: { byteCount: 2, hasEarlier: false, itemCount: 0 },
    instructions: "Instructions from Agent home AGENTS.md marker 2c9d.",
    machineAccessNotice: "No other computers are reachable.",
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "sonnet",
      options: {},
      providerId: "anthropic",
    }),
    personalContext: input.personalContext,
    platformGuide: "",
    providerState: {
      continuationKey: setup.root,
      kind: "ambient",
      privateStateRoot: state,
      providerHomeDirectory: undefined,
      store: { directory: join(state, "store"), id: "own-configuration" },
    },
    runtimeBoundary: nativeUserHarnessRuntimeBoundary,
    signal: AbortSignal.timeout(180_000),
    skills: { skills: [] },
    threadId,
    threadStateDirectory,
    workspacePath: setup.project,
    wrapProcessLaunch: (launch) => launch,
    writableRoots: [setup.project],
  };
  const session = await adapter.startSession(context);
  const events: HarnessEvent[] = [];
  const observing = (async () => {
    for await (const event of session.events) {
      events.push(event);
      if (event.type === "request.opened") {
        await session.resolveRequest(event.data.request.id, {
          kind: "choice",
          optionId: "allow-once",
        });
      }
    }
  })();
  try {
    await session.execute({
      context: {
        assignment: null,
        startedAt: "2026-11-22T00:00:00.000Z",
        threadState: { previousAssignment: null, previousRun: null },
      },
      environment: {},
      inputs: [
        {
          author: { displayName: "Person", kind: "human", principalId: "person" },
          content: [{ text: "Write the marker.", type: "text" }],
          createdAt: new Date().toISOString(),
          kind: "input",
          messageId: createId("message"),
        },
      ],
      reports: { messages: [], omittedCount: 0, throughSequence: null },
      requestedBy: createId("user"),
      runId: createId("run"),
      signal: AbortSignal.timeout(180_000),
    });
  } finally {
    await session.stop();
    await observing;
  }
  const marker = await readFile(setup.marker, "utf8").catch(() => undefined);
  return { api, events, init, marker, servers, setup };
}

it("runs a personal task with Claude Code's own configuration and the task's mode", async () => {
  const { api, events, init, marker, servers } = await runOnce({
    accessMode: "approval-required",
    personalContext: true,
  });
  expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
  // The person's every-command allow rule and bypass default did not decide:
  // Supervised asked before the command, and the person allowed it once.
  expect(init?.permissionMode).toBe("default");
  expect(events.filter((event) => event.type === "request.opened")).toHaveLength(1);
  // The command ran with the user-level setting in its environment.
  expect(marker).toBe("person-setting-applied");
  // The project's own CLAUDE.md reached the model, and Agent home's AGENTS.md beside it.
  expect(api.requests.join("\n")).toContain("Project CLAUDE.md marker 7f3a.");
  expect(api.requests.join("\n")).toContain("Agent home AGENTS.md marker 2c9d.");
  // Claude Code's own web tools, the person's skill and MCP server, and Opensteer's
  // server replacing the one of theirs that bears its name.
  expect(init?.tools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch", "Bash"]));
  expect(init?.slash_commands).toContain("person-skill");
  expect(servers?.map(({ name, source }) => ({ name, source }))).toEqual(
    expect.arrayContaining([
      { name: "opensteer", source: "dynamic" },
      { name: "person-server", source: "user" },
    ]),
  );
  expect(servers?.find(({ name }) => name === "opensteer")?.config).toMatchObject({
    url: "http://127.0.0.1:9/internal/v1/mcp",
  });
}, 240_000);

it("runs a task without personal context with none of the person's configuration", async () => {
  const { api, events, init, marker, servers } = await runOnce({
    accessMode: "approval-required",
    personalContext: false,
  });
  expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
  expect(init?.permissionMode).toBe("default");
  expect(events.filter((event) => event.type === "request.opened")).toHaveLength(1);
  // No user settings: the command ran, but without the person's setting.
  expect(marker).toBe("");
  expect(api.requests.join("\n")).not.toContain("Project CLAUDE.md marker 7f3a.");
  expect(init?.tools).not.toContain("WebSearch");
  expect(init?.tools).not.toContain("WebFetch");
  expect(init?.slash_commands).not.toContain("person-skill");
  expect(servers?.map(({ name }) => name)).toEqual(["opensteer"]);
}, 240_000);
