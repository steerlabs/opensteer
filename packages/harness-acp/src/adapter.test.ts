import {
  ModelSelectionSchema,
  OpensteerError,
  createId,
  type HarnessInstanceId,
} from "@opensteer/core";
import {
  nativeUserHarnessRuntimeBoundary,
  spawnSupervised,
  type HarnessEvent,
  type HarnessRunInput,
  type HarnessSessionContext,
  type SupervisedProcess,
} from "@opensteer/harness";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpHarnessAdapter,
  acpReadTextFileHandler,
  createAcpProtocolClient,
  normalizeAcpUpdate,
} from "./index.js";
import type {
  AcpHarnessOptions,
  AcpPermissionRequest,
  AcpProtocolClient,
  AcpProtocolHandlers,
} from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ACP lifecycle", () => {
  it("stops reported background children before terminal completion", async () => {
    const fixture = await setup("background");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("start child"));
    await session.stop();
    await observed.done;
    const types = observed.events.map((event) => event.type);
    expect(types).toContain("node.started");
    expect(types.indexOf("node.completed")).toBeLessThan(types.indexOf("run.completed"));
    await fixture.adapter.close();
  });

  it("suppresses load replay and publishes only the live prompt", async () => {
    const fixture = await setup("replay");
    const session = await fixture.adapter.resumeSession("native-session", fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("continue"));
    await session.stop();
    await observed.done;
    const messages = observed.events.flatMap((event) =>
      event.type === "assistant.message"
        ? event.data.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    );
    expect(messages).toEqual(["live answer"]);
    expect(observed.events.map((event) => event.type)).toContain("run.completed");
    await fixture.adapter.close();
  });

  it("lets the prompt RPC outcome overrule a streamed answer", async () => {
    const fixture = await setup("prompt-error");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("fail after streaming"));
    await session.stop();
    await observed.done;
    expect(observed.events.map((event) => event.type)).toContain("run.failed");
    expect(observed.events.map((event) => event.type)).not.toContain("run.completed");
    await fixture.adapter.close();
  });

  it("publishes observed usage once before successful completion", async () => {
    const fixture = await setup("usage-success");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("succeed"));
    await expectTerminal(observed.events, "run.completed");
    expectUsageBeforeTerminal(observed.events, "run.completed");
    await session.stop();
    await observed.done;
    await fixture.adapter.close();
  });

  it("publishes observed usage once before a rejected prompt fails", async () => {
    const fixture = await setup("usage-prompt-error");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("fail"));
    await expectTerminal(observed.events, "run.failed");
    expectUsageBeforeTerminal(observed.events, "run.failed");
    await session.stop();
    await observed.done;
    await fixture.adapter.close();
  });

  it("publishes a held partial reply and usage before a rejected prompt fails", async () => {
    const fixture = await setup("held-prompt-error");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("fail after partial reply"));
    await expectTerminal(observed.events, "run.failed");
    expectAssistantBeforeTerminal(observed.events, "partial reply", "run.failed");
    expectUsageBeforeTerminal(observed.events, "run.failed");
    await session.stop();
    await observed.done;
    await fixture.adapter.close();
  });

  it("publishes observed usage once before a held assistant reply is interpreted as failed", async () => {
    const fixture = await setup("usage-held-assistant-error");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("fail after end_turn"));
    await expectTerminal(observed.events, "run.failed");
    expectUsageBeforeTerminal(observed.events, "run.failed");
    await session.stop();
    await observed.done;
    await fixture.adapter.close();
  });

  it("publishes held assistant chunks in order after the bounded stderr deadline", async () => {
    const fixture = await setup("held-assistant-deadline");
    const session = await fixture.adapter.startSession(fixture.context);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const observed = observe(session.events);
    const execution = session.execute(fixture.turn("finish without stderr"));
    await fixture.heldAssistantReached;
    await vi.advanceTimersByTimeAsync(500);
    await execution;
    vi.useRealTimers();
    await expectTerminal(observed.events, "run.completed");
    expect(
      observed.events
        .flatMap((event) => (event.type === "assistant.delta" ? [event.data.text] : []))
        .join(""),
    ).toBe("The error is fixed.");
    await session.stop();
    await observed.done;
    await fixture.adapter.close();
  });

  it("publishes observed usage once before an unexpected process exit fails", async () => {
    const fixture = await setup("usage-process-exit");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("lose process"));
    await expectTerminal(observed.events, "run.failed");
    expectUsageBeforeTerminal(observed.events, "run.failed");
    await observed.done.catch(() => undefined);
    await session.stop();
    await fixture.adapter.close();
  });

  it("publishes observed usage once before cancel-and-kill interruption", async () => {
    const fixture = await setup("usage-interruption");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    const controller = new AbortController();
    const execution = session.execute(fixture.turn("stop", controller.signal));
    await vi.waitFor(() => {
      expect(observed.events.some((event) => event.type === "run.started")).toBe(true);
    });
    controller.abort(new Error("person stopped the Run"));
    await execution;
    await expectTerminal(observed.events, "run.interrupted");
    expectUsageBeforeTerminal(observed.events, "run.interrupted");
    await session.stop();
    await observed.done;
    await fixture.adapter.close();
  });

  it("publishes a held partial reply and usage before cancel-and-kill interruption", async () => {
    const fixture = await setup("held-interruption");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    const controller = new AbortController();
    const execution = session.execute(fixture.turn("stop after partial reply", controller.signal));
    await fixture.heldAssistantReached;
    controller.abort(new Error("person stopped the Run"));
    await execution;
    await expectTerminal(observed.events, "run.interrupted");
    expectAssistantBeforeTerminal(observed.events, "partial reply", "run.interrupted");
    expectUsageBeforeTerminal(observed.events, "run.interrupted");
    await session.stop();
    await observed.done;
    await fixture.adapter.close();
  });

  it("accepts only a permission choice the agent actually offered", async () => {
    const fixture = await setup("permission");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    const execution = session.execute(fixture.turn("needs approval"));
    await vi.waitFor(() => {
      expect(observed.events.some((event) => event.type === "request.opened")).toBe(true);
    });
    const opened = observed.events.find((event) => event.type === "request.opened");
    if (!opened || opened.type !== "request.opened") throw new Error("request did not open");
    await expect(
      session.resolveRequest(opened.data.request.id, { kind: "choice", optionId: "invented" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await session.resolveRequest(opened.data.request.id, { kind: "choice", optionId: "allow" });
    await execution;
    expect(fixture.selectedPermissions).toEqual(["allow"]);
    await session.stop();
    await observed.done;
    await fixture.adapter.close();
  });
});

describe("ACP boundaries", () => {
  it("puts a deadline on initialize", async () => {
    const directory = await temporaryDirectory();
    const process = spawnSupervised({
      args: ["-e", "process.stdin.resume()"],
      cwd: directory,
      environment: { PATH: globalThis.process.env.PATH ?? "" },
      executable: globalThis.process.execPath,
    });
    const client = createAcpProtocolClient({
      handlers: {
        elicitation: async () => null,
        permission: async () => null,
        readTextFile: async () => "",
        update: () => undefined,
      },
      process,
      version: 1,
    });
    await expect(
      client.initialize({
        capabilities: { elicitation: false, fileSystem: "none", terminal: false },
        deadlineMs: 20,
        info: { name: "opensteer_test", version: "0.0.0" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    client.close();
    await process.terminate(0);
    await process.exited;
  });

  it("normalizes standard content and tool updates", () => {
    expect(
      normalizeAcpUpdate({
        content: { text: "hello", type: "text" },
        sessionUpdate: "agent_message_chunk",
      }),
    ).toEqual([{ kind: "assistant", text: "hello" }]);
    expect(
      normalizeAcpUpdate({
        rawInput: { command: "pwd" },
        sessionUpdate: "tool_call",
        status: "pending",
        title: "Shell",
        toolCallId: "call-1",
      }),
    ).toEqual([
      {
        kind: "tool",
        toolCall: {
          id: "call-1",
          rawInput: { command: "pwd" },
          status: "pending",
          title: "Shell",
        },
      },
    ]);
  });

  it("allows bounded workspace reads and refuses paths outside it", async () => {
    const root = await temporaryDirectory();
    const sibling = await temporaryDirectory();
    const file = join(root, "notes.txt");
    const outside = join(sibling, "secret.txt");
    await writeFile(file, "one\ntwo\nthree\n");
    await writeFile(outside, "nope\n");
    const read = acpReadTextFileHandler([root]);
    await expect(read(file, 2, 1)).resolves.toBe("two\n");
    await expect(read(outside)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses invalid UTF-8 as a binary file read", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "binary.dat");
    await writeFile(file, Buffer.from([0xc3, 0x28]));

    await expect(acpReadTextFileHandler([root])(file)).rejects.toMatchObject({
      code: "bad_request",
      message: "ACP cannot read binary files as text",
    });
  });
});

type Scenario =
  | "background"
  | "held-interruption"
  | "held-prompt-error"
  | "held-assistant-deadline"
  | "permission"
  | "prompt-error"
  | "replay"
  | "usage-interruption"
  | "usage-process-exit"
  | "usage-prompt-error"
  | "usage-held-assistant-error"
  | "usage-success";

async function setup(scenario: Scenario) {
  const directory = await temporaryDirectory();
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const instanceId = createId("harnessInstance") as HarnessInstanceId;
  const selectedPermissions: string[] = [];
  let notifyHeldAssistantReached: () => void = () => undefined;
  const heldAssistantReached = new Promise<void>((resolve) => {
    notifyHeldAssistantReached = resolve;
  });
  const options: AcpHarnessOptions = {
    capabilities: {
      approvals: true,
      attachments: true,
      interruption: true,
      mcpImageContent: true,
      resume: true,
      steering: false,
      toolCalls: true,
      userInput: true,
    },
    engineLabel: "Test ACP",
    hooks: {
      classifyError: (error) =>
        error instanceof OpensteerError
          ? error
          : new OpensteerError({
              code: "harness_error",
              message: error instanceof Error ? error.message : "ACP failed",
            }),
      ...(scenario === "usage-held-assistant-error"
        ? {
            holdAssistant: {
              deadlineMs: 500,
              maxCharacters: 2_048,
              settle: () => ({
                discardAssistant: true,
                error: new OpensteerError({
                  code: "harness_error",
                  message: "native end_turn failed",
                }),
                status: "failed" as const,
              }),
            },
          }
        : scenario === "held-assistant-deadline"
          ? {
              holdAssistant: {
                deadlineMs: 500,
                maxCharacters: 2_048,
                settle: () => {
                  notifyHeldAssistantReached();
                  return { status: "pending" as const };
                },
              },
            }
          : scenario === "held-interruption" || scenario === "held-prompt-error"
            ? {
                holdAssistant: {
                  deadlineMs: 0,
                  maxCharacters: 2_048,
                  settle: () => ({ status: "succeeded" as const }),
                },
              }
            : {}),
      permissionChoices: (request: AcpPermissionRequest) =>
        request.options.map((option) => ({
          hint: option.id === "allow" ? "allow-once" : "reject-once",
          label: option.label,
          optionId: option.id,
        })),
      normalizeUpdate: (update) =>
        scenario === "background" &&
        typeof update === "object" &&
        update !== null &&
        "sessionUpdate" in update &&
        update.sessionUpdate === "child-started"
          ? [{ key: "child", kind: "subagent", state: "started" }]
          : undefined,
    },
    launch: ({ context }) => ({
      args: ["-e", "process.stdin.resume()"],
      cwd: context.workspacePath,
      environment: context.environment,
      executable: process.execPath,
    }),
    maxEventBytes: 1_000_000,
    maxEventItems: 1_000,
    policy: {
      accessModeIds: {
        "approval-required": "auto",
        "auto-accept-edits": "auto",
        auto: "auto",
        "full-access": "full",
      },
      cancel: { behavior: "cancel-and-kill", metadata: { outcome: "cancelled" } },
      clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
      clientInfo: { name: "opensteer_test", version: "0.0.0" },
      eagerAuthentication: false,
      initializeDeadlineMs: 100,
      model: { type: "set-model" },
      protocolVersion: 1,
      resume: { method: "load", suppressReplay: true },
    },
  };
  let handlers: AcpProtocolHandlers | undefined;
  const createClient = (input: {
    readonly handlers: AcpProtocolHandlers;
    readonly process: SupervisedProcess;
  }): AcpProtocolClient => {
    handlers = input.handlers;
    return fakeClient(
      scenario,
      input.handlers,
      (choice) => selectedPermissions.push(choice),
      input.process,
      notifyHeldAssistantReached,
    );
  };
  const adapter = new AcpHarnessAdapter(instanceId, options, {
    createClient: createClient as typeof import("./protocol.js").createAcpProtocolClient,
  });
  const environment = { PATH: process.env.PATH ?? "" };
  const context: HarnessSessionContext = {
    accessMode: "full-access",
    agentTools: { capabilityProfileId: "main", token: "agent-token", url: "https://host/mcp" },
    environment,
    environmentId: createId("environment"),
    harnessInstanceId: instanceId,
    history: [],
    historyWindow: { byteCount: 0, hasEarlier: false, itemCount: 0 },
    instructions: undefined,
    integrationTools: { token: "integration-token", url: "https://host/integrations" },
    machineAccessNotice: "No other computers are reachable.",
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "model",
      options: {},
      providerId: "test",
    }),
    platformGuide: "Opensteer guide.",
    providerState: {
      continuationKey: "test-store",
      kind: "ambient",
      providerHomeDirectory: undefined,
      privateStateRoot: directory,
      store: { directory, id: "test-store" },
    },
    runtimeBoundary: nativeUserHarnessRuntimeBoundary,
    signal: new AbortController().signal,
    skills: undefined,
    threadId: createId("thread"),
    threadStateDirectory: join(directory, "thread-state"),
    workspaceId: createId("workspace"),
    workspacePath,
    wrapProcessLaunch: (launch) => launch,
    writableRoots: [workspacePath],
  };
  expect(handlers).toBeUndefined();
  return {
    adapter,
    context,
    heldAssistantReached,
    selectedPermissions,
    turn(text: string, signal = new AbortController().signal): HarnessRunInput {
      return {
        context: {
          assignment: null,
          requesterTimeZone: null,
          threadState: { previousAssignment: null, previousRun: null },
        },
        environment,
        inputs: [
          {
            author: {
              displayName: "Person",
              kind: "human",
              principalId: "person:test",
              userId: createId("user"),
            },
            content: [{ text, type: "text" }],
            createdAt: new Date().toISOString(),
            kind: "input",
            messageId: createId("message"),
          },
        ],
        reports: { messages: [], omittedCount: 0, throughSequence: null },
        requestedBy: createId("user"),
        runId: createId("run"),
        signal,
      };
    },
  };
}

function fakeClient(
  scenario: Scenario,
  handlers: AcpProtocolHandlers,
  selected: (choice: string) => void,
  process: SupervisedProcess,
  notifyHeldAssistantReached: () => void,
): AcpProtocolClient {
  return {
    authenticate: async () => undefined,
    logout: async () => undefined,
    cancel: async () => undefined,
    close: () => undefined,
    closeSession: async () => undefined,
    initialize: async () => ({
      agentCapabilities: {},
      authMethods: [],
      metadata: {},
      protocolVersion: 1,
    }),
    newSession: async () => ({ configOptions: [], metadata: {}, sessionId: "new-session" }),
    prompt: async () => {
      if (scenario === "held-interruption" || scenario === "held-prompt-error") {
        handlers.update("new-session", {
          sessionUpdate: "usage_update",
          usage: { inputTokens: 11, outputTokens: 7, thoughtTokens: 3 },
        });
        handlers.update("new-session", {
          content: { text: "partial reply", type: "text" },
          sessionUpdate: "agent_message_chunk",
        });
        notifyHeldAssistantReached();
        if (scenario === "held-prompt-error") throw new Error("prompt RPC failed");
        await process.exited;
        throw new Error("ACP process exited");
      }
      if (scenario === "held-assistant-deadline") {
        handlers.update("new-session", {
          content: { text: "The error", type: "text" },
          sessionUpdate: "agent_message_chunk",
        });
        handlers.update("new-session", {
          content: { text: " is fixed.", type: "text" },
          sessionUpdate: "agent_message_chunk",
        });
        return { stopReason: "end_turn" };
      }
      if (scenario === "usage-held-assistant-error") {
        handlers.update("new-session", {
          content: { text: "native provider error", type: "text" },
          sessionUpdate: "agent_message_chunk",
        });
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 11, outputTokens: 7, reasoningTokens: 3 },
        };
      }
      if (scenario.startsWith("usage-")) {
        handlers.update("new-session", {
          sessionUpdate: "usage_update",
          usage: { inputTokens: 11, outputTokens: 7, thoughtTokens: 3 },
        });
        if (scenario === "usage-prompt-error") throw new Error("prompt RPC failed");
        if (scenario === "usage-process-exit") {
          await process.terminate();
          await process.exited;
          throw new Error("ACP process exited");
        }
        if (scenario === "usage-interruption") {
          await process.exited;
          throw new Error("ACP process exited");
        }
        return { stopReason: "end_turn" };
      }
      if (scenario === "background") {
        handlers.update("new-session", { sessionUpdate: "child-started" });
        return { stopReason: "end_turn" };
      }
      if (scenario === "prompt-error") {
        handlers.update("new-session", {
          content: { text: "streamed", type: "text" },
          sessionUpdate: "agent_message_chunk",
        });
        throw new Error("prompt RPC failed");
      }
      if (scenario === "permission") {
        const choice = await handlers.permission(
          {
            options: [
              { id: "allow", kind: "allow_once", label: "Allow" },
              { id: "reject", kind: "reject_once", label: "Reject" },
            ],
            sessionId: "new-session",
            toolCall: { id: "call-1", rawInput: { command: "pwd" }, title: "Run command" },
          },
          new AbortController().signal,
        );
        if (choice) selected(choice);
      }
      handlers.update("native-session", {
        content: { text: "live answer", type: "text" },
        sessionUpdate: "agent_message_chunk",
      });
      return { stopReason: "end_turn" };
    },
    resumeSession: async (reference) => {
      handlers.update(reference, {
        content: { text: "historical answer", type: "text" },
        sessionUpdate: "agent_message_chunk",
      });
      return { configOptions: [], metadata: {}, sessionId: reference };
    },
    setConfigOption: async () => [],
    setMode: async () => undefined,
    setModel: async () => undefined,
    version: 1,
  };
}

function observe(events: AsyncIterable<HarnessEvent>) {
  const collected: HarnessEvent[] = [];
  const done = (async () => {
    for await (const event of events) collected.push(event);
  })();
  return { done, events: collected };
}

function expectUsageBeforeTerminal(
  events: readonly HarnessEvent[],
  terminal: "run.completed" | "run.failed" | "run.interrupted",
): void {
  const usage = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "run.usage");
  expect(usage).toHaveLength(1);
  expect(usage[0]?.event).toMatchObject({
    data: { inputTokens: 11, outputTokens: 7, reasoningTokens: 3 },
    type: "run.usage",
  });
  expect(usage[0]?.index).toBeLessThan(events.findIndex((event) => event.type === terminal));
}

function expectAssistantBeforeTerminal(
  events: readonly HarnessEvent[],
  text: string,
  terminal: "run.failed" | "run.interrupted",
): void {
  const assistant = events.findIndex(
    (event) => event.type === "assistant.delta" && event.data.text === text,
  );
  expect(assistant).toBeGreaterThan(-1);
  expect(assistant).toBeLessThan(events.findIndex((event) => event.type === terminal));
}

async function expectTerminal(
  events: readonly HarnessEvent[],
  terminal: "run.completed" | "run.failed" | "run.interrupted",
): Promise<void> {
  await vi.waitFor(() => {
    expect(events.some((event) => event.type === terminal)).toBe(true);
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-acp-"));
  directories.push(directory);
  return directory;
}
