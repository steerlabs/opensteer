import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type McpServerStatus, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createId, ModelSelectionSchema, type ThreadAccessMode } from "@opensteer/core";
import { type HarnessEvent, type HarnessSessionContext } from "@opensteer/harness";
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

interface ToolCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

interface StubApi {
  readonly url: string;
  /** Every main-model request body, as sent. */
  readonly requests: string[];
}

/**
 * Answers the main model with the script's tool calls, one per turn (the
 * number of tool results already in the conversation picks the next), then
 * "done". Background helper requests, which carry no Bash tool, get "done".
 */
async function startStubApi(script: readonly ToolCall[]): Promise<StubApi> {
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
      const step = JSON.stringify(parsed.messages).split('"tool_result"').length - 1;
      const next = main ? script[step] : undefined;
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
      if (next) {
        send("content_block_start", {
          content_block: { id: `toolu_${calls}`, input: {}, name: next.name, type: "tool_use" },
          index: 0,
          type: "content_block_start",
        });
        send("content_block_delta", {
          delta: { partial_json: JSON.stringify(next.input), type: "input_json_delta" },
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
  cleanups.push(
    () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No stub address");
  return { requests, url: `http://127.0.0.1:${address.port}` };
}

/**
 * A person's own Claude Code setup, one of each kind of thing Claude Code
 * loads: user settings with allow rules, a default mode, an environment
 * setting, auto-memory and an enabled user plugin; a user hook; user memory
 * (`~/.claude/CLAUDE.md`); a user agent, command, output style and skill; user
 * MCP servers beside one named like Opensteer's; and a project with its own
 * `.claude/settings.json`, `.claude/settings.local.json`, `CLAUDE.md`,
 * `CLAUDE.local.md`, `.claude/rules/`, and `.mcp.json`.
 */
async function personalSetup(allow: readonly string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-claude-own-")));
  // Claude Code may still be writing its session files as its process exits.
  cleanups.push(() => rm(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 }));
  const home = join(root, "home");
  const config = join(home, ".claude");
  const project = join(root, "agent-home");
  const autoMemory = join(root, "auto-memory");
  const encodedProject = project.replace(/[^A-Za-z0-9]/gu, "-");
  const defaultAutoMemory = join(config, "projects", encodedProject, "memory");
  const marketplaceDir = join(config, "plugins", "marketplaces", "local");
  const pluginDir = join(marketplaceDir, "plugins", "person-plugin");
  const hookMarker = join(root, "person-hook-ran");
  const projectHookMarker = join(root, "project-hook-ran");
  for (const directory of [
    join(config, "skills", "person-skill"),
    join(config, "agents"),
    join(config, "commands"),
    join(config, "output-styles"),
    join(marketplaceDir, ".claude-plugin"),
    join(pluginDir, ".claude-plugin"),
    autoMemory,
    defaultAutoMemory,
    join(project, ".claude", "rules"),
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      autoMemoryDirectory: autoMemory,
      autoMemoryEnabled: true,
      enabledPlugins: { "person-plugin@local": true },
      env: { OPENSTEER_PERSON_SETTING: "person-setting-applied" },
      hooks: {
        PreToolUse: [
          {
            hooks: [{ command: `touch "${hookMarker}"`, type: "command" }],
            matcher: ".*",
          },
        ],
      },
      permissions: { allow, defaultMode: "bypassPermissions" },
    }),
  );
  await writeFile(join(autoMemory, "MEMORY.md"), "Person auto-memory marker 6a1e.\n");
  await writeFile(join(defaultAutoMemory, "MEMORY.md"), "Person auto-memory marker 6a1e.\n");
  await writeFile(
    join(marketplaceDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "local",
      owner: { name: "Person" },
      plugins: [
        {
          description: "A plugin of the person's own.",
          name: "person-plugin",
          source: "./plugins/person-plugin",
          version: "1.0.0",
        },
      ],
    }),
  );
  await writeFile(
    join(config, "plugins", "known_marketplaces.json"),
    JSON.stringify({
      local: {
        installLocation: marketplaceDir,
        lastUpdated: "2026-01-01T00:00:00.000Z",
        source: { path: marketplaceDir, source: "directory" },
      },
    }),
  );
  await writeFile(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      description: "A plugin of the person's own.",
      name: "person-plugin",
      version: "1.0.0",
    }),
  );
  await writeFile(
    join(config, "plugins", "installed_plugins.json"),
    JSON.stringify({
      plugins: {
        "person-plugin@local": [
          {
            installedAt: "2026-01-01T00:00:00.000Z",
            installPath: pluginDir,
            lastUpdated: "2026-01-01T00:00:00.000Z",
            scope: "user",
            version: "1.0.0",
          },
        ],
      },
      version: 2,
    }),
  );
  await writeFile(join(config, "CLAUDE.md"), "Person user CLAUDE.md marker 41c8.");
  await writeFile(
    join(config, "skills", "person-skill", "SKILL.md"),
    "---\nname: person-skill\ndescription: A skill of the person's own.\n---\nBody.\n",
  );
  await writeFile(
    join(config, "agents", "person-agent.md"),
    "---\nname: person-agent\ndescription: An agent of the person's own.\n---\nAgent body marker 9d02.\n",
  );
  await writeFile(
    join(config, "commands", "person-command.md"),
    "A command of the person's own.\n",
  );
  await writeFile(
    join(config, "output-styles", "person-style.md"),
    "---\nname: person-style\ndescription: The person's own style.\n---\nStyle marker 5b7e.\n",
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
  await writeFile(
    join(project, ".claude", "settings.json"),
    JSON.stringify({
      env: { OPENSTEER_PROJECT_SETTING: "project-setting-applied" },
      hooks: {
        PreToolUse: [
          {
            hooks: [{ command: `touch "${projectHookMarker}"`, type: "command" }],
            matcher: ".*",
          },
        ],
      },
      permissions: { allow },
    }),
  );
  await writeFile(
    join(project, ".claude", "settings.local.json"),
    JSON.stringify({
      env: { OPENSTEER_LOCAL_SETTING: "local-setting-applied" },
    }),
  );
  await writeFile(join(project, "CLAUDE.md"), "Project CLAUDE.md marker 7f3a.");
  await writeFile(join(project, "CLAUDE.local.md"), "Project CLAUDE.local.md marker 8c4d.");
  await writeFile(
    join(project, ".claude", "rules", "project-rule.md"),
    "Project rule marker 3e9b.\n",
  );
  await writeFile(
    join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: { "project-server": { args: ["-e", ""], command: process.execPath } },
    }),
  );
  return { config, home, hookMarker, project, projectHookMarker, root };
}

async function runOnce(input: {
  readonly accessMode: ThreadAccessMode;
  readonly allow: readonly string[];
  readonly personalContext: boolean;
  readonly personLineage?: boolean;
  readonly script: (setup: Awaited<ReturnType<typeof personalSetup>>) => readonly ToolCall[];
}) {
  const setup = await personalSetup(input.allow);
  const api = await startStubApi(input.script(setup));
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
    config: { maxTurns: 6 },
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
    modelSelection: ModelSelectionSchema.parse({
      modelId: "sonnet",
      options: {},
      providerId: "anthropic",
    }),
    personalContext: input.personalContext,
    personLineage: input.personLineage ?? input.personalContext,
    platformGuide: "",
    providerState: {
      continuationKey: setup.root,
      kind: "ambient",
      privateStateRoot: state,
      providerHomeDirectory: undefined,
      store: { directory: join(state, "store"), id: "own-configuration" },
    },
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
          content: [{ text: "Do the work.", type: "text" }],
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
  const requests = events.flatMap((event) =>
    event.type === "request.opened" ? [JSON.stringify(event.data.request)] : [],
  );
  return { api, events, init, requests, servers, setup };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const read = (path: string) => readFile(path, "utf8").catch(() => undefined);

it("runs a person's own Supervised task with their engine's own rules, adding no guard", async () => {
  const { api, events, init, requests, servers, setup } = await runOnce({
    accessMode: "approval-required",
    allow: ["Bash(git status)"],
    personalContext: true,
    script: (s) => [
      { input: { command: "git status", description: "First, by a rule" }, name: "Bash" },
      {
        input: {
          command: `printf "%s|%s|%s" "$OPENSTEER_PERSON_SETTING" "$OPENSTEER_PROJECT_SETTING" "$OPENSTEER_LOCAL_SETTING" > "${join(s.project, "marker.txt")}"`,
          description: "Second, with no rule",
        },
        name: "Bash",
      },
    ],
  });
  expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
  // The task's mode, not the person's default mode.
  expect(init?.permissionMode).toBe("default");
  // `git status` ran without asking, by the person's own rule; the other
  // command asked, as Supervised does in their terminal.
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("Second, with no rule");
  expect(requests[0]).not.toContain("First, by a rule");
  // Their user, project and local settings reached the command; both hooks ran.
  expect(await read(join(setup.project, "marker.txt"))).toBe(
    "person-setting-applied|project-setting-applied|local-setting-applied",
  );
  expect(await exists(setup.hookMarker)).toBe(true);
  expect(await exists(setup.projectHookMarker)).toBe(true);
  // Their memory, auto-memory, the project's CLAUDE.md/CLAUDE.local.md/rules,
  // and Agent home's AGENTS.md reached the model.
  const sent = api.requests.join("\n");
  expect(sent).toContain("Person user CLAUDE.md marker 41c8.");
  expect(sent).toContain("Person auto-memory marker 6a1e.");
  expect(sent).toContain("Project CLAUDE.md marker 7f3a.");
  expect(sent).toContain("Project CLAUDE.local.md marker 8c4d.");
  expect(sent).toContain("Project rule marker 3e9b.");
  expect(sent).toContain("Agent home AGENTS.md marker 2c9d.");
  // Claude Code's own web tools, the person's skill, agent, command, plugin and
  // MCP servers, and Opensteer's server replacing the one of theirs bearing its name.
  expect(init?.tools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch", "Bash"]));
  expect(init?.slash_commands).toEqual(expect.arrayContaining(["person-skill", "person-command"]));
  expect(init?.agents).toContain("person-agent");
  expect(init?.plugins.some(({ name }) => name === "person-plugin")).toBe(true);
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

it("edits in the task's folder without asking in Auto-accept edits and asks outside it", async () => {
  const { events, init, requests, setup } = await runOnce({
    accessMode: "auto-accept-edits",
    allow: [],
    personalContext: true,
    script: (s) => [
      { input: { content: "in", file_path: join(s.project, "inside.txt") }, name: "Write" },
      { input: { content: "out", file_path: join(s.root, "outside.txt") }, name: "Write" },
    ],
  });
  expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
  expect(init?.permissionMode).toBe("acceptEdits");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("outside.txt");
  expect(await read(join(setup.project, "inside.txt"))).toBe("in");
  // The person allowed it once.
  expect(await read(join(setup.root, "outside.txt"))).toBe("out");
}, 240_000);

it("runs a task a connected agent or a chat started with none of the person's configuration", async () => {
  const { api, events, init, requests, servers, setup } = await runOnce({
    accessMode: "approval-required",
    // Every change allowed in the person's and project's settings, and a bypass default.
    allow: ["Bash(*)", "Bash", "Edit", "Write"],
    // Connected agent with `everything` or a person-only chat: personalContext is true,
    // personLineage is false — engine configuration must still be stripped.
    personalContext: true,
    personLineage: false,
    script: (s) => [
      { input: { content: "x", file_path: join(s.project, "written.txt") }, name: "Write" },
      {
        input: {
          command: `printf "%s|%s|%s" "$OPENSTEER_PERSON_SETTING" "$OPENSTEER_PROJECT_SETTING" "$OPENSTEER_LOCAL_SETTING" > "${join(s.project, "marker.txt")}"`,
          description: "Run shell in stripped mode",
        },
        name: "Bash",
      },
    ],
  });
  expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
  // (A) The mode holds: neither user nor project allow rules nor defaultMode apply,
  // and Bash is gated through claudeShellApprovalHook as well as Write.
  expect(init?.permissionMode).toBe("default");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toContain("written.txt");
  expect(requests[1]).toContain("Run shell in stripped mode");
  expect(await read(join(setup.project, "written.txt"))).toBe("x");
  // (B) Nothing of the person's runs: no user/project hook, no MCP server of theirs or
  // the project's, and the Bash command ran with none of their user/project/local env settings.
  expect(await exists(setup.hookMarker)).toBe(false);
  expect(await exists(setup.projectHookMarker)).toBe(false);
  expect(servers?.map(({ name }) => name)).toEqual(["opensteer"]);
  expect(await read(join(setup.project, "marker.txt"))).toBe("||");
  // (C) None of their instructions, auto-memory, rules, agent, command, skill, style or plugin.
  const sent = api.requests.join("\n");
  expect(sent).not.toContain("Person user CLAUDE.md marker 41c8.");
  expect(sent).not.toContain("Person auto-memory marker 6a1e.");
  expect(sent).not.toContain("Project CLAUDE.md marker 7f3a.");
  expect(sent).not.toContain("Project CLAUDE.local.md marker 8c4d.");
  expect(sent).not.toContain("Project rule marker 3e9b.");
  expect(sent).not.toContain("Agent body marker 9d02.");
  expect(sent).not.toContain("Style marker 5b7e.");
  expect(init?.agents ?? []).not.toContain("person-agent");
  expect(init?.slash_commands).not.toContain("person-command");
  expect(init?.slash_commands).not.toContain("person-skill");
  expect(init?.output_style).not.toBe("person-style");
  // Only Claude Code's own built-in plugins, none of the person's.
  expect(init?.plugins.filter(({ path }) => path !== "builtin")).toEqual([]);
  expect(init?.tools).not.toContain("WebSearch");
  expect(init?.tools).not.toContain("WebFetch");
}, 240_000);
