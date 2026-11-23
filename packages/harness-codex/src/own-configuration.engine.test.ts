import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, ModelSelectionSchema, type ThreadAccessMode } from "@opensteer/core";
import {
  nativeUserHarnessRuntimeBoundary,
  type HarnessEvent,
  type HarnessSessionContext,
} from "@opensteer/harness";
import { afterEach, expect, it } from "vitest";
import { CodexHarnessDriver, packagedCodexExecutable } from "./index.js";

/**
 * The shipped Codex, started by the driver in a temporary `CODEX_HOME` and
 * project against a local stand-in for the Responses API: nothing reads or
 * writes the computer's own Codex configuration, and nothing leaves it.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Answers the first request with one shell command, then "done". */
async function startStubApi(command: string) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      // Opensteer's own MCP server, with no tools: Codex must connect to it.
      if (request.url?.startsWith("/mcp")) {
        const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
        if (message.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                capabilities: { tools: {} },
                protocolVersion: "2025-06-18",
                serverInfo: { name: "opensteer", version: "1.0.0" },
              }
            : message.method === "tools/list"
              ? { tools: [] }
              : message.method === "resources/list"
                ? { resources: [] }
                : message.method === "resources/templates/list"
                  ? { resourceTemplates: [] }
                  : {};
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: message.id, jsonrpc: "2.0", result }));
        return;
      }
      if (!request.url?.includes("/responses")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      requests.push(body);
      const parsed = JSON.parse(body) as {
        input?: unknown[];
        tools?: { name?: string; type?: string }[];
      };
      const answered = JSON.stringify(parsed.input ?? []).includes("function_call_output");
      const names = new Set((parsed.tools ?? []).map((tool) => tool.name));
      const call = names.has("shell_command")
        ? { arguments: { command }, name: "shell_command" }
        : names.has("exec_command")
          ? { arguments: { cmd: command }, name: "exec_command" }
          : { arguments: { command: ["bash", "-lc", command] }, name: "shell" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (data: Record<string, unknown>) =>
        response.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
      send({ response: { id: "resp_1" }, type: "response.created" });
      send({
        item: answered
          ? {
              content: [{ text: "done", type: "output_text" }],
              id: "msg_1",
              role: "assistant",
              type: "message",
            }
          : {
              arguments: JSON.stringify(call.arguments),
              call_id: "call_1",
              id: "fc_1",
              name: call.name,
              type: "function_call",
            },
        output_index: 0,
        type: "response.output_item.done",
      });
      send({
        response: {
          id: "resp_1",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
        type: "response.completed",
      });
      response.end();
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  cleanups.push(() => new Promise((resolveClose) => server.close(() => resolveClose())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No stub address");
  return {
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    url: `http://127.0.0.1:${address.port}/v1`,
  };
}

/**
 * One of each kind of the person's own Codex configuration Codex loads: a
 * command rule allowing `touch`, a `notify` command, a hook, developer
 * instructions, a personality, a custom agent, an `AGENTS.md` of theirs; and
 * a trusted project with its own `AGENTS.md`, `.codex/config.toml` and rule.
 */
async function codexRun(input: {
  readonly accessMode: ThreadAccessMode;
  readonly own: boolean;
  readonly rules?: false;
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-codex-own-")));
  cleanups.push(() => rm(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 }));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const project = join(root, "agent-home");
  const notifyRan = join(root, "notify-ran");
  const hookRan = join(root, "hook-ran");
  await mkdir(join(codexHome, "rules"), { recursive: true });
  await mkdir(join(project, ".codex", "rules"), { recursive: true });
  const api = await startStubApi("touch ran.txt");
  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model_provider = "stub"',
      `notify = ["touch", "${notifyRan}"]`,
      'developer_instructions = "PERSON-DEVELOPER-MARKER"',
      'personality = "friendly"',
      "",
      "[model_providers.stub]",
      'name = "stub"',
      `base_url = "${api.url}"`,
      'wire_api = "responses"',
      'env_key = "STUB_API_KEY"',
      "",
      "[agents.person-agent]",
      'description = "PERSON-AGENT-MARKER"',
      "",
      `[projects."${project}"]`,
      'trust_level = "trusted"',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(codexHome, "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: `touch "${hookRan}"`, type: "command" }] }],
        UserPromptSubmit: [{ hooks: [{ command: `touch "${hookRan}"`, type: "command" }] }],
      },
    }),
  );
  await writeFile(join(codexHome, "AGENTS.md"), "PERSON-GLOBAL-AGENTS-MARKER");
  if (input.rules !== false)
    await writeFile(
      join(codexHome, "rules", "person.rules"),
      'prefix_rule(pattern=["touch"], decision="allow")\n',
    );
  await writeFile(join(project, "AGENTS.md"), "PROJECT-AGENTS-MARKER");
  await writeFile(
    join(project, ".codex", "config.toml"),
    'developer_instructions = "PROJECT-DEVELOPER-MARKER"\n',
  );
  if (input.rules !== false)
    await writeFile(
      join(project, ".codex", "rules", "project.rules"),
      'prefix_rule(pattern=["touch"], decision="allow")\n',
    );
  const state = join(root, "state");
  const threadStateDirectory = join(state, "threads", "thread");
  await mkdir(threadStateDirectory, { recursive: true });
  const environment = {
    CODEX_HOME: codexHome,
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    STUB_API_KEY: "local-stub",
    TMPDIR: state,
  };
  const driver = new CodexHarnessDriver({
    launch: { arguments: [], executable: packagedCodexExecutable() },
  });
  const instanceId = createId("harnessInstance");
  const adapter = await driver.create({ config: {}, instanceId, sourceId: "openai" });
  cleanups.push(() => adapter.close());
  const context: HarnessSessionContext = {
    accessMode: input.accessMode,
    agentTools: {
      instructions: "",
      skills: [],
      token: "local-stub",
      tools: [],
      toolsRevision: "own-configuration",
      url: api.mcpUrl,
    },
    commandEnvironment: {},
    environment,
    environmentId: createId("environment"),
    harnessInstanceId: instanceId,
    history: [],
    historyWindow: { byteCount: 2, hasEarlier: false, itemCount: 0 },
    instructions: undefined,
    machineAccessNotice: "No other computers are reachable.",
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.4",
      options: {},
      providerId: "openai",
    }),
    personalContext: true,
    personLineage: input.own,
    platformGuide: "",
    providerState: {
      continuationKey: root,
      kind: "ambient",
      privateStateRoot: state,
      providerHomeDirectory: undefined,
      store: { directory: codexHome, id: "own-configuration" },
    },
    runtimeBoundary: nativeUserHarnessRuntimeBoundary,
    signal: AbortSignal.timeout(180_000),
    skills: { skills: [] },
    threadId: createId("thread"),
    threadStateDirectory,
    workspacePath: project,
    wrapProcessLaunch: (launch) => launch,
    writableRoots: [project],
  };
  const events: HarnessEvent[] = [];
  let startFailure: unknown;
  const session = await adapter.startSession(context).catch((error: unknown) => {
    startFailure = error;
    return undefined;
  });
  if (session) {
    const observing = (async () => {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === "request.opened") {
          // Decline with what Codex offers: a command it asks about has no
          // "Reject" of its own, only "Cancel", which ends the turn.
          const presentation = event.data.request.presentation;
          const options = presentation.kind === "choice" ? presentation.options : [];
          const decline =
            options.find((option) => option.hint === "reject-once") ??
            options.find((option) => option.hint === "cancel");
          if (!decline) throw new Error("Codex offered no way to decline");
          await session.resolveRequest(event.data.request.id, {
            kind: "choice",
            optionId: decline.id,
          });
        }
      }
    })();
    try {
      await session.execute({
        context: {
          assignment: null,
          startedAt: "2026-11-23T00:00:00.000Z",
          threadState: { previousAssignment: null, previousRun: null },
        },
        environment,
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
  }
  return {
    commandRan: await exists(join(project, "ran.txt")),
    events,
    hookRan: await exists(hookRan),
    notifyRan: await exists(notifyRan),
    requests: api.requests,
    startFailure,
  };
}

it("runs the person's own Supervised task with their own Codex configuration", async () => {
  const run = await codexRun({ accessMode: "approval-required", own: true });
  expect(run.startFailure).toBeUndefined();
  expect(run.events.find((event) => event.type === "run.failed")).toBeUndefined();
  // Their command rule allows `touch`: it ran without asking, as in their terminal.
  expect(run.events.filter((event) => event.type === "request.opened")).toHaveLength(0);
  expect(run.commandRan).toBe(true);
  // Their notify command ran; their instructions, agent and the project's reached the model.
  expect(run.notifyRan).toBe(true);
  const sent = run.requests.join("\n");
  for (const marker of [
    "PERSON-AGENT-MARKER",
    "PERSON-GLOBAL-AGENTS-MARKER",
    "PROJECT-AGENTS-MARKER",
    "PROJECT-DEVELOPER-MARKER",
  ])
    expect(sent).toContain(marker);
}, 240_000);

/**
 * Why Codex refuses a task a connected agent or a chat started
 * (`assertEngineMayRun`): even started with Opensteer's stripped
 * configuration, Codex 0.162.0 still applies the person's command rules and
 * `notify`, and reads their `~/.codex/AGENTS.md`, custom agents and the
 * project's developer instructions. When this stops being true, Codex can be
 * shown and added to the engines that run such tasks.
 */
it("still reads the person's Codex configuration when started stripped", async () => {
  const run = await codexRun({ accessMode: "approval-required", own: false });
  expect(run.startFailure).toBeUndefined();
  // (A) Their rule ran the command in Supervised without asking.
  expect(run.events.filter((event) => event.type === "request.opened")).toHaveLength(0);
  expect(run.commandRan).toBe(true);
  // (B) Their notify command ran; their hook did not (Codex's hooks feature is off).
  expect(run.notifyRan).toBe(true);
  expect(run.hookRan).toBe(false);
  // (C) Their AGENTS.md, custom agent and the project's developer instructions reached the model.
  const sent = run.requests.join("\n");
  for (const marker of [
    "PERSON-AGENT-MARKER",
    "PERSON-GLOBAL-AGENTS-MARKER",
    "PROJECT-DEVELOPER-MARKER",
  ])
    expect(sent).toContain(marker);
  // Without their rules the same command asks: the rule is what let it through.
  const withoutRules = await codexRun({
    accessMode: "approval-required",
    own: false,
    rules: false,
  });
  expect(withoutRules.events.filter((event) => event.type === "request.opened")).toHaveLength(1);
  expect(withoutRules.commandRan).toBe(false);
  // The project's AGENTS.md and the person's own developer instructions do not.
  expect(sent).not.toContain("PROJECT-AGENTS-MARKER");
  expect(sent).not.toContain("PERSON-DEVELOPER-MARKER");
}, 240_000);
