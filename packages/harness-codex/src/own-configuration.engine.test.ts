import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createId,
  ModelSelectionSchema,
  OpensteerError,
  requestOptionDeclines,
  type ThreadAccessMode,
} from "@opensteer/core";
import { type HarnessEvent, type HarnessSessionContext } from "@opensteer/harness";
import { afterEach, expect, it } from "vitest";
import { CodexHarnessDriver, codexOthersHomeDirectory, packagedCodexExecutable } from "./index.js";

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
      const answered =
        !command || JSON.stringify(parsed.input ?? []).includes("function_call_output");
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
  readonly authFile?: false;
  readonly credentialStore?: "auto" | "file" | "keyring";
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
  if (input.authFile !== false) {
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-local-stub", auth_mode: "apikey" }),
    );
  }
  await writeFile(
    join(codexHome, "config.toml"),
    [
      ...(input.credentialStore
        ? [`cli_auth_credentials_store = ${JSON.stringify(input.credentialStore)}`]
        : []),
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
    launch: {
      arguments: [],
      executable: process.env.OPENSTEER_CODEX_EXECUTABLE || packagedCodexExecutable(),
    },
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
          // Decline using the same helper the product uses: Codex 0.162.0
          // offers "allow-once" and "cancel" on command approvals, not "reject".
          const presentation = event.data.request.presentation;
          const options = presentation.kind === "choice" ? presentation.options : [];
          const decline = options.find(requestOptionDeclines);
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
  const othersHome = codexOthersHomeDirectory({ privateStateRoot: state }, codexHome);
  return {
    codexHome,
    commandRan: await exists(join(project, "ran.txt")),
    events,
    hookRan: await exists(hookRan),
    notifyRan: await exists(notifyRan),
    othersHome,
    othersAuthStat: await lstat(join(othersHome, "auth.json")).catch(() => undefined),
    othersAuthRealPath: await realpath(join(othersHome, "auth.json")).catch(() => undefined),
    othersConfig: await readFile(join(othersHome, "config.toml"), "utf8").catch(() => undefined),
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

it("runs a connected agent's or a chat's Supervised task from an Opensteer-owned home without the person's configuration", async () => {
  const run = await codexRun({ accessMode: "approval-required", own: false });
  expect(run.startFailure).toBeUndefined();
  expect(run.events.find((event) => event.type === "run.failed")).toBeUndefined();
  // The Opensteer home shares auth.json by symbolic link (never a copy) and
  // carries only reach-the-model settings.
  expect(run.othersAuthStat?.isSymbolicLink()).toBe(true);
  expect(run.othersAuthRealPath).toBe(await realpath(join(run.codexHome, "auth.json")));
  expect(run.othersConfig).toContain('cli_auth_credentials_store = "file"');
  expect(run.othersConfig).toContain("[model_providers.stub]");
  expect(run.othersConfig).not.toContain("notify");
  expect(run.othersConfig).not.toContain("PERSON-DEVELOPER-MARKER");
  expect(run.othersConfig).not.toContain("PERSON-AGENT-MARKER");
  expect(run.othersConfig).not.toContain("trust_level");
  // (A) The mode holds: neither the person's nor the project's command rule applies.
  // Declining with what Codex 0.162.0 offers ("cancel") stops the command and interrupts cleanly.
  const opened = run.events.filter((event) => event.type === "request.opened");
  expect(opened).toHaveLength(1);
  expect(run.commandRan).toBe(false);
  expect(run.events.some((event) => event.type === "run.interrupted")).toBe(true);
  // (B) Nothing of the person's runs: neither notify nor hooks.
  expect(run.notifyRan).toBe(false);
  expect(run.hookRan).toBe(false);
  // (C) None of their instructions, custom agent, or project instructions reach the model.
  const sent = run.requests.join("\n");
  for (const marker of [
    "PERSON-DEVELOPER-MARKER",
    "PERSON-AGENT-MARKER",
    "PERSON-GLOBAL-AGENTS-MARKER",
    "PROJECT-AGENTS-MARKER",
    "PROJECT-DEVELOPER-MARKER",
  ])
    expect(sent).not.toContain(marker);
}, 240_000);

it("refuses others' tasks before starting Codex when the login is in the keyring or auth.json is absent", async () => {
  const keyring = await codexRun({
    accessMode: "approval-required",
    credentialStore: "keyring",
    own: false,
  });
  expect(keyring.startFailure).toBeInstanceOf(OpensteerError);
  expect((keyring.startFailure as OpensteerError).code).toBe("forbidden");
  expect((keyring.startFailure as OpensteerError).message).toContain(
    'cli_auth_credentials_store = "file"',
  );
  expect(keyring.requests).toHaveLength(0);

  const missingAuth = await codexRun({
    accessMode: "approval-required",
    authFile: false,
    own: false,
  });
  expect(missingAuth.startFailure).toBeInstanceOf(OpensteerError);
  expect((missingAuth.startFailure as OpensteerError).code).toBe("forbidden");
  expect((missingAuth.startFailure as OpensteerError).message).toContain("auth.json");
  expect(missingAuth.requests).toHaveLength(0);
}, 120_000);

it("runs Codex background text from the Opensteer-owned home without notify or person instructions, and refuses keyring logins", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-codex-bg-")));
  cleanups.push(() => rm(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 }));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const state = join(root, "state");
  const notifyRan = join(root, "notify-ran");
  await mkdir(codexHome, { recursive: true });
  await mkdir(state, { recursive: true });
  const api = await startStubApi("");
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-local-stub", auth_mode: "apikey" }),
  );
  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model_provider = "stub"',
      `notify = ["touch", "${notifyRan}"]`,
      'developer_instructions = "PERSON-DEVELOPER-MARKER"',
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
    ].join("\n"),
  );
  await writeFile(join(codexHome, "AGENTS.md"), "PERSON-GLOBAL-AGENTS-MARKER");
  const driver = new CodexHarnessDriver({
    launch: {
      arguments: [],
      executable: process.env.OPENSTEER_CODEX_EXECUTABLE || packagedCodexExecutable(),
    },
  });
  const instanceId = createId("harnessInstance");
  const adapter = await driver.create({ config: {}, instanceId, sourceId: "openai" });
  cleanups.push(() => adapter.close());
  const result = await adapter.generateText!({
    context: {
      environment: {
        CODEX_HOME: codexHome,
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        STUB_API_KEY: "local-stub",
        TMPDIR: state,
      },
      providerState: {
        continuationKey: root,
        kind: "ambient",
        privateStateRoot: state,
        providerHomeDirectory: undefined,
        store: { directory: codexHome, id: "own-configuration" },
      },
      scratchDirectory: state,
      wrapProcessLaunch: (launch) => launch,
    },
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.4",
      options: {},
      providerId: "openai",
    }),
    prompt: "Name this task.",
    signal: AbortSignal.timeout(120_000),
  });
  expect(result).toEqual({ ok: true, text: "done" });
  expect(await exists(notifyRan)).toBe(false);
  const sent = api.requests.join("\n");
  for (const marker of [
    "PERSON-DEVELOPER-MARKER",
    "PERSON-AGENT-MARKER",
    "PERSON-GLOBAL-AGENTS-MARKER",
  ])
    expect(sent).not.toContain(marker);

  // Keyring store refuses without spawning or reaching the API.
  const beforeCount = api.requests.length;
  await writeFile(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  const refused = await adapter.generateText!({
    context: {
      environment: {
        CODEX_HOME: codexHome,
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        STUB_API_KEY: "local-stub",
        TMPDIR: state,
      },
      providerState: {
        continuationKey: root,
        kind: "ambient",
        privateStateRoot: state,
        providerHomeDirectory: undefined,
        store: { directory: codexHome, id: "own-configuration" },
      },
      scratchDirectory: state,
      wrapProcessLaunch: (launch) => launch,
    },
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.4",
      options: {},
      providerId: "openai",
    }),
    prompt: "Name this task.",
    signal: AbortSignal.timeout(30_000),
  });
  expect(refused).toEqual({ ok: false, failure: "unavailable" });
  expect(api.requests).toHaveLength(beforeCount);
}, 180_000);
