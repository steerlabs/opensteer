import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, ModelSelectionSchema, type ThreadAccessMode } from "@opensteer/core";
import { type HarnessEvent, type HarnessSessionContext } from "@opensteer/harness";
import { afterEach, expect, it } from "vitest";
import { packagedPiExecutable } from "./executable.js";
import { PiHarnessDriver } from "./pi-driver.js";

/**
 * The shipped Pi, started by the driver in a temporary home and project against
 * a local stand-in for an OpenAI-compatible endpoint: nothing reads or writes
 * the computer's own Pi configuration, and nothing leaves it.
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

/**
 * One of each kind of the person's own Pi configuration Pi loads: a shell
 * command prefix in their settings and in the project's, `SYSTEM.md`,
 * `APPEND_SYSTEM.md` and `AGENTS.md` of theirs and the project's, a prompt
 * template; and their sign-in (`models.json`, `auth.json`), which stays.
 */
async function piRun(input: {
  readonly accessMode: ThreadAccessMode;
  readonly commands: readonly string[];
  readonly decisions: readonly ("allow-once" | "reject")[];
  readonly own: boolean;
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-pi-own-")));
  cleanups.push(() => rm(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 }));
  const home = join(root, "home");
  const agentDirectory = join(home, ".pi", "agent");
  const project = join(root, "agent-home");
  const state = join(root, "state");
  const userPrefixRan = join(root, "user-prefix-ran");
  const projectPrefixRan = join(root, "project-prefix-ran");
  await mkdir(join(agentDirectory, "prompts"), { recursive: true });
  await mkdir(join(project, ".pi"), { recursive: true });
  await mkdir(state, { recursive: true });
  let body = "";
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    request.on("end", () => {
      if (!request.url?.includes("chat/completions")) {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      body += text;
      const step = text.split('"role":"tool"').length - 1;
      const nextCommand = input.commands[step];
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) =>
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta, finish_reason: finish, index: 0 }],
            id: `stub_${step}`,
            object: "chat.completion.chunk",
            usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
      if (nextCommand) {
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                function: { arguments: JSON.stringify({ command: nextCommand }), name: "bash" },
                id: `call_${step + 1}`,
                index: 0,
                type: "function",
              },
            ],
          },
          null,
        );
        chunk({}, "tool_calls");
      } else {
        chunk({ content: "done", role: "assistant" }, null);
        chunk({}, "stop");
      }
      response.end("data: [DONE]\n\n");
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
  await writeFile(
    join(agentDirectory, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          api: "openai-completions",
          apiKey: "local-stub",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [{ id: "stub-model", name: "stub-model" }],
        },
      },
    }),
  );
  await writeFile(join(agentDirectory, "auth.json"), "{}");
  await writeFile(
    join(agentDirectory, "settings.json"),
    JSON.stringify({ shellCommandPrefix: `touch "${userPrefixRan}";` }),
  );
  await writeFile(join(agentDirectory, "SYSTEM.md"), "PERSON-SYSTEM-MD-MARKER");
  await writeFile(join(agentDirectory, "APPEND_SYSTEM.md"), "PERSON-APPEND-MARKER");
  await writeFile(join(agentDirectory, "AGENTS.md"), "PERSON-AGENTS-MARKER");
  await writeFile(join(agentDirectory, "prompts", "person-prompt.md"), "PERSON-PROMPT-MARKER");
  await writeFile(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ shellCommandPrefix: `touch "${projectPrefixRan}";` }),
  );
  await writeFile(join(project, ".pi", "SYSTEM.md"), "PROJECT-SYSTEM-MD-MARKER");
  await writeFile(join(project, "AGENTS.md"), "PROJECT-AGENTS-MARKER");

  const driver = new PiHarnessDriver({
    connectMcpServer: async () => ({
      callTool: async () => ({ content: [], isError: false }),
      close: async () => undefined,
      listTools: async () => [],
    }),
    executable: packagedPiExecutable(),
    nodeExecutable: process.execPath,
  });
  const instanceId = createId("harnessInstance");
  const adapter = await driver.create({ config: {}, instanceId, sourceId: "openai" });
  cleanups.push(() => adapter.close());
  const threadId = createId("thread");
  const threadStateDirectory = join(state, "threads", threadId);
  await mkdir(threadStateDirectory, { recursive: true });
  const environment = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    TMPDIR: state,
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
    instructions: "OPENSTEER-INSTRUCTIONS-MARKER",
    machineAccessNotice: "No other computers are reachable.",
    modelSelection: ModelSelectionSchema.parse({
      modelId: "stub-model",
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
      store: { directory: agentDirectory, id: "own-configuration" },
    },
    signal: AbortSignal.timeout(120_000),
    skills: { skills: [] },
    threadId,
    threadStateDirectory,
    workspacePath: project,
    wrapProcessLaunch: (launch) => launch,
    writableRoots: [project],
  };

  const session = await adapter.startSession(context);
  const events: HarnessEvent[] = [];
  let requestIndex = 0;
  const observing = (async () => {
    for await (const event of session.events) {
      events.push(event);
      if (event.type === "request.opened") {
        const decision = input.decisions[requestIndex] ?? "allow-once";
        requestIndex += 1;
        await session.resolveRequest(event.data.request.id, {
          kind: "choice",
          optionId: decision,
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
      environment: {},
      inputs: [
        {
          author: { displayName: "Person", kind: "human", principalId: "person" },
          content: [{ text: "Do it.", type: "text" }],
          createdAt: new Date().toISOString(),
          kind: "input",
          messageId: createId("message"),
        },
      ],
      reports: { messages: [], omittedCount: 0, throughSequence: null },
      requestedBy: createId("user"),
      runId: createId("run"),
      signal: AbortSignal.timeout(120_000),
    });
  } finally {
    await session.stop();
    await observing;
  }
  const requests = events.flatMap((event) =>
    event.type === "request.opened" ? [JSON.stringify(event.data.request)] : [],
  );
  return {
    blockedRan: await exists(join(project, "blocked.txt")),
    body,
    commandRan: await exists(join(project, "ran.txt")),
    events,
    projectPrefixRan: await exists(projectPrefixRan),
    requests,
    userPrefixRan: await exists(userPrefixRan),
  };
}

it("starts a task a connected agent or a chat started with none of the person's Pi configuration and enforces Supervised", async () => {
  const run = await piRun({
    accessMode: "approval-required",
    commands: ["touch blocked.txt", "touch ran.txt"],
    decisions: ["reject", "allow-once"],
    own: false,
  });
  expect(run.events.find((event) => event.type === "run.failed")).toBeUndefined();
  // (A) Supervised holds through the driver's extension: both bash commands ask;
  // rejecting the first stops it and allowing the second lets it run.
  expect(run.requests).toHaveLength(2);
  expect(run.requests[0]).toContain("blocked.txt");
  expect(run.requests[1]).toContain("ran.txt");
  expect(run.blockedRan).toBe(false);
  expect(run.commandRan).toBe(true);
  // (B) No shell prefix of theirs or the project's wrapped it.
  expect(run.userPrefixRan).toBe(false);
  expect(run.projectPrefixRan).toBe(false);
  // (C) None of their instructions: Pi's own prompt and Opensteer's instructions only.
  for (const marker of [
    "PERSON-SYSTEM-MD-MARKER",
    "PERSON-APPEND-MARKER",
    "PERSON-AGENTS-MARKER",
    "PERSON-PROMPT-MARKER",
    "PROJECT-SYSTEM-MD-MARKER",
    "PROJECT-AGENTS-MARKER",
  ])
    expect(run.body).not.toContain(marker);
  expect(run.body).toContain("You are an expert coding assistant operating inside pi");
  expect(run.body).toContain("OPENSTEER-INSTRUCTIONS-MARKER");
}, 120_000);

it("still reads the person's own configuration in their own task, as Pi did before", async () => {
  const run = await piRun({
    accessMode: "approval-required",
    commands: ["touch ran.txt"],
    decisions: ["allow-once"],
    own: true,
  });
  expect(run.events.find((event) => event.type === "run.failed")).toBeUndefined();
  expect(run.requests).toHaveLength(1);
  expect(run.commandRan).toBe(true);
  // Non-vacuous control: the person's shellCommandPrefix and SYSTEM.md are loaded
  // in their own task; the project's .pi/settings.json stays off under --no-approve.
  expect(run.userPrefixRan).toBe(true);
  expect(run.projectPrefixRan).toBe(false);
  expect(run.body).toContain("PERSON-SYSTEM-MD-MARKER");
}, 120_000);

it("refuses others' tasks and background text before spawning Pi when models.json contains a ! credential command", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-pi-bang-")));
  cleanups.push(() => rm(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 }));
  const home = join(root, "home");
  const agentDirectory = join(home, ".pi", "agent");
  const project = join(root, "agent-home");
  const state = join(root, "state");
  const bangRan = join(root, "bang-command-ran");
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(state, { recursive: true });

  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (!request.url?.includes("chat/completions")) {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            { delta: { content: "done", role: "assistant" }, finish_reason: null, index: 0 },
          ],
          id: "stub_0",
          object: "chat.completion.chunk",
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          id: "stub_0",
          object: "chat.completion.chunk",
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
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

  await writeFile(
    join(agentDirectory, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          api: "openai-completions",
          apiKey: `!sh -c 'touch "${bangRan}" && printf local-stub'`,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [{ id: "stub-model", name: "stub-model" }],
        },
      },
    }),
  );
  await writeFile(join(agentDirectory, "auth.json"), "{}");

  const driver = new PiHarnessDriver({
    connectMcpServer: async () => ({
      callTool: async () => ({ content: [], isError: false }),
      close: async () => undefined,
      listTools: async () => [],
    }),
    executable: packagedPiExecutable(),
    nodeExecutable: process.execPath,
  });
  const instanceId = createId("harnessInstance");
  const adapter = await driver.create({ config: {}, instanceId, sourceId: "openai" });
  cleanups.push(() => adapter.close());
  const makeContext = async (own: boolean): Promise<HarnessSessionContext> => {
    const threadId = createId("thread");
    const threadStateDirectory = join(state, "threads", threadId);
    await mkdir(threadStateDirectory, { recursive: true });
    return {
      accessMode: "approval-required",
      agentTools: {
        instructions: "",
        skills: [],
        token: "local-stub",
        tools: [],
        toolsRevision: "own-configuration",
        url: "http://127.0.0.1:9/internal/v1/mcp",
      },
      commandEnvironment: {},
      environment: {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        TMPDIR: state,
      },
      environmentId: createId("environment"),
      harnessInstanceId: instanceId,
      history: [],
      historyWindow: { byteCount: 2, hasEarlier: false, itemCount: 0 },
      instructions: "OPENSTEER-INSTRUCTIONS-MARKER",
      machineAccessNotice: "No other computers are reachable.",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "stub-model",
        options: {},
        providerId: "openai",
      }),
      personalContext: true,
      personLineage: own,
      platformGuide: "",
      providerState: {
        continuationKey: root,
        kind: "ambient",
        privateStateRoot: state,
        providerHomeDirectory: undefined,
        store: { directory: agentDirectory, id: "own-configuration" },
      },
      signal: AbortSignal.timeout(120_000),
      skills: { skills: [] },
      threadId,
      threadStateDirectory,
      workspacePath: project,
      wrapProcessLaunch: (launch) => launch,
      writableRoots: [project],
    };
  };

  // Others' task: refused before Pi starts; the ! command never runs.
  const othersContext = await makeContext(false);
  await expect(adapter.startSession(othersContext)).rejects.toMatchObject({
    code: "forbidden",
    message:
      'Your Pi configuration runs a local shell command to fetch a credential (a "!" value in models.json or auth.json), which Opensteer does not run for tasks a connected agent or chat started.',
  });
  expect(
    await adapter.generateText!({
      context: { ...othersContext, scratchDirectory: othersContext.threadStateDirectory },
      modelSelection: othersContext.modelSelection,
      prompt: "Name it",
      signal: AbortSignal.timeout(30_000),
    }),
  ).toEqual({ ok: false, failure: "unavailable" });
  expect(await exists(bangRan)).toBe(false);

  // Non-vacuous control: the person's own task DOES run the ! command on real Pi.
  const ownContext = await makeContext(true);
  const session = await adapter.startSession(ownContext);
  const events: HarnessEvent[] = [];
  const observing = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  try {
    await session.execute({
      context: {
        assignment: null,
        startedAt: "2026-11-23T00:00:00.000Z",
        threadState: { previousAssignment: null, previousRun: null },
      },
      environment: {},
      inputs: [
        {
          author: { displayName: "Person", kind: "human", principalId: "person" },
          content: [{ text: "Say done.", type: "text" }],
          createdAt: new Date().toISOString(),
          kind: "input",
          messageId: createId("message"),
        },
      ],
      reports: { messages: [], omittedCount: 0, throughSequence: null },
      requestedBy: createId("user"),
      runId: createId("run"),
      signal: AbortSignal.timeout(120_000),
    });
  } finally {
    await session.stop();
    await observing;
  }
  expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
  expect(await exists(bangRan)).toBe(true);
}, 120_000);
