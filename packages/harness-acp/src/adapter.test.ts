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
  await Promise.allSettled(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ACP lifecycle", () => {
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

type Scenario = "permission" | "prompt-error" | "replay";

async function setup(scenario: Scenario) {
  const directory = await temporaryDirectory();
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const instanceId = createId("harnessInstance") as HarnessInstanceId;
  const selectedPermissions: string[] = [];
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
      permissionChoices: (request: AcpPermissionRequest) =>
        request.options.map((option) => ({
          hint: option.id === "allow" ? "allow-once" : "reject-once",
          label: option.label,
          optionId: option.id,
        })),
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
  const createClient = (input: { readonly handlers: AcpProtocolHandlers }): AcpProtocolClient => {
    handlers = input.handlers;
    return fakeClient(scenario, input.handlers, (choice) => selectedPermissions.push(choice));
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
    selectedPermissions,
    turn(text: string): HarnessRunInput {
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
        signal: new AbortController().signal,
      };
    },
  };
}

function fakeClient(
  scenario: Scenario,
  handlers: AcpProtocolHandlers,
  selected: (choice: string) => void,
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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-acp-"));
  directories.push(directory);
  return directory;
}
