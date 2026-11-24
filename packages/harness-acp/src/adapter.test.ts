import { createToolImageStore } from "@opensteer/harness";
import { collisionSkills } from "@opensteer/shared/test-support/agentSkills";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  ModelSelectionSchema,
  OpensteerError,
  createId,
  harnessSessionBrokenFailureCode,
  type HarnessInstanceId,
} from "@opensteer/core";
import {
  Deferred,
  HarnessSteerDeliveryUnknownError,
  spawnSupervised,
  type HarnessEvent,
  type HarnessRunInput,
  type HarnessSessionContext,
  type SupervisedProcess,
} from "@opensteer/harness";
import { RequestError } from "@agentclientprotocol/sdk";
import { EventEmitter } from "node:events";
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
  AcpPromptBlock,
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

describe("ACP guidance delivery", () => {
  it("delivers once, resends changed guidance, and preserves per-Run facts across reuse", async () => {
    const f = await setup("replay");
    const session = await f.adapter.startSession(f.context);
    try {
      // A person's text never reaches the engine as a native command that could change its authority.
      await session.execute(f.turn("/always-approve on"));
      const [lead] = f.prompts[0] as readonly AcpPromptBlock[];
      expect(lead?.type === "text" && lead.text.trimStart().startsWith("/")).toBe(false);
      expect(JSON.stringify(f.prompts[0])).toContain("Opensteer guide.");
      expect(await session.releaseForReuse?.()).toBe(true);
      session.rebind?.({ ...f.context, machineAccessNotice: "Computer changed" });
      await session.execute(f.turn("second"));
      expect(JSON.stringify(f.prompts[1])).not.toContain("Opensteer guide.");
      expect(JSON.stringify(f.prompts[1])).toContain("Computer changed");
      session.rebind?.({ ...f.context, platformGuide: "Changed guide" });
      await session.execute(f.turn("third"));
      expect(JSON.stringify(f.prompts[2])).toContain("Changed guide");
    } finally {
      await f.adapter.close();
    }
  });

  it("reinjects after root compaction, ignores duplicate completions and child compactions", async () => {
    const f = await setup("replay");
    const session = await f.adapter.startSession(f.context);
    const compact = (sessionId: string, compactionId: string) =>
      f.update(sessionId, {
        sessionUpdate: "compaction_update",
        status: "completed",
        compactionId,
      });
    try {
      await session.execute(f.turn("first"));
      compact("child-session", "child");
      await session.execute(f.turn("second"));
      expect(JSON.stringify(f.prompts[1])).not.toContain("Opensteer guide.");
      compact("new-session", "root");
      await session.execute(f.turn("third"));
      expect(JSON.stringify(f.prompts[2])).toContain("Opensteer guide.");
      compact("new-session", "root");
      await session.execute(f.turn("fourth"));
      expect(JSON.stringify(f.prompts[3])).not.toContain("Opensteer guide.");
    } finally {
      await f.adapter.close();
    }
  });

  it.each(["cancelled", "refusal", "error", "throw"])(
    "does not record %s outcomes",
    async (reason) => {
      const f = await setup("replay");
      f.promptOutcome = reason;
      const session = await f.adapter.startSession(f.context);
      try {
        await session.execute(f.turn("first"));
        f.promptOutcome = "end_turn";
        await session.execute(f.turn("second"));
        expect(JSON.stringify(f.prompts[1])).toContain("Opensteer guide.");
      } finally {
        await f.adapter.close();
      }
    },
  );

  it("observes compaction during preparation and preserves compaction during an RPC", async () => {
    const f = await setup("replay");
    const session = await f.adapter.startSession(f.context);
    const compact = (id: string) =>
      f.update("new-session", {
        sessionUpdate: "compaction_update",
        status: "completed",
        compactionId: id,
      });
    try {
      await session.execute(f.turn("first"));
      f.prepare = () => {
        f.prepare = undefined;
        compact("preparing");
      };
      await session.execute(f.turn("second"));
      expect(JSON.stringify(f.prompts[1])).toContain("Opensteer guide.");
      compact("before-rpc");
      f.duringPrompt = () => {
        f.duringPrompt = undefined;
        compact("running");
      };
      await session.execute(f.turn("third"));
      await session.execute(f.turn("fourth"));
      expect(JSON.stringify(f.prompts[3])).toContain("Opensteer guide.");
      await session.execute(f.turn("fifth"));
      expect(JSON.stringify(f.prompts[4])).not.toContain("Opensteer guide.");
    } finally {
      await f.adapter.close();
    }
  });

  it.each(["permission", "persistent-permission"] as const)(
    "keeps %s approval authority within its Run",
    async (scenario) => {
      const f = await setup(scenario);
      const session = await f.adapter.startSession(f.context);
      const observed = observe(session.events);
      try {
        const execution = session.execute(f.turn("ask"));
        await vi.waitFor(() =>
          expect(observed.events.some((event) => event.type === "request.opened")).toBe(true),
        );
        expect(await session.releaseForReuse?.()).toBe(false);
        expect(() => session.rebind?.(f.context)).toThrow("during a Run");
        const request = observed.events.find((event) => event.type === "request.opened");
        if (request?.type !== "request.opened") throw new Error("ACP approval never arrived");
        await session.resolveRequest(request.data.request.id, {
          kind: "choice",
          optionId: "allow",
        });
        await execution;
        expect(await session.releaseForReuse?.()).toBe(scenario === "permission");
      } finally {
        await f.adapter.close();
        await observed.done;
      }
      expect(await session.releaseForReuse?.()).toBe(false);
    },
  );

  it("ignores a replaced runtime's late prompt settlement", async () => {
    const f = await setup("replay");
    const first = await f.adapter.startSession(f.context);
    const started = new Deferred<void>();
    const gate = new Deferred<void>();
    f.duringPrompt = async () => {
      started.resolve();
      await gate.promise;
    };
    const execution = first.execute(f.turn("first"));
    try {
      await withTimeout(started.promise, 1_000, {
        timeoutError: () => new Error("First prompt never started"),
      });
      await first.stop();
      f.duringPrompt = undefined;
      const next = await f.adapter.resumeSession("new-session", {
        ...f.context,
        platformGuide: "Replacement guide",
      });
      await next.execute(f.turn("replacement"));
      expect(JSON.stringify(f.prompts[0])).toContain("Replacement guide");
      gate.resolve();
      await execution;
      await next.execute(f.turn("continue"));
      expect(JSON.stringify(f.prompts[2])).not.toContain("Replacement guide");
    } finally {
      gate.resolve();
      await execution;
      await f.adapter.close();
    }
  });

  it("resets delivery when a new process resumes the same native session", async () => {
    const f = await setup("replay");
    const first = await f.adapter.startSession(f.context);
    await first.execute(f.turn("first"));
    await first.stop();
    const next = await f.adapter.resumeSession("new-session", f.context);
    try {
      await next.execute(f.turn("second"));
      expect(JSON.stringify(f.prompts[1])).toContain("Opensteer guide.");
    } finally {
      await f.adapter.close();
    }
  });
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
    expect(observed.events.find((event) => event.type === "node.completed")?.data.status).toBe(
      "interrupted",
    );
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
    expectAssistantBeforeTerminal(observed.events, "streamed", "run.failed");
    expectReasoningBeforeTerminal(observed.events, "weighing it", "run.failed");
    await fixture.adapter.close();
  });

  it("saves a partial reply when the engine rejects the prompt after a wait-for-prompt cancel", async () => {
    const fixture = await setup("wait-interruption");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    const controller = new AbortController();
    const execution = session.execute(fixture.turn("stop", controller.signal));
    await fixture.heldAssistantReached;
    controller.abort(new Error("person stopped the Run"));
    await execution;
    await expectTerminal(observed.events, "run.interrupted");
    expectAssistantBeforeTerminal(observed.events, "partial reply", "run.interrupted");
    expectReasoningBeforeTerminal(observed.events, "weighing it", "run.interrupted");
    expectUsageBeforeTerminal(observed.events, "run.interrupted");
    await session.stop();
    await observed.done;
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
    expect(JSON.stringify(observed.events)).not.toContain("native provider error");
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
    const processFailed = expect(observed.done).rejects.toMatchObject({
      code: "harness_error",
      message: expect.stringContaining("ACP process exited"),
    });
    await session.execute(fixture.turn("lose process"));
    await expectTerminal(observed.events, "run.failed");
    expectUsageBeforeTerminal(observed.events, "run.failed");
    await processFailed;
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

  it("ends the engine process when it never answers session close", async () => {
    const fixture = await setup("close-hang");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let stopped = false;
    const stopping = session.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(
      () => {
        if (!stopped) throw new Error("stop never finished after the close deadline");
      },
      { timeout: 2_000 },
    );
    await stopping;
    vi.useRealTimers();
    await observed.done;
    await fixture.adapter.close();
  });

  it("keeps reading the protocol after a long session's traffic passes 512 KiB", async () => {
    const fixture = await setup("long-session", { agent: await longSessionAgent() });
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    try {
      for (let turn = 1; turn <= 4; turn += 1) {
        await withinDeadline(
          session.execute(fixture.turn(`turn ${turn}`)),
          1_000,
          `turn ${turn} never completed`,
        );
      }
    } finally {
      await session.stop();
      await fixture.adapter.close();
    }
    await observed.done;
    expect(observed.events.filter((event) => event.type === "run.completed")).toHaveLength(4);
    expect(observed.events.filter((event) => event.type === "assistant.message")).toHaveLength(4);
  });

  it.each(["permission", "child-permission"] as const)(
    "accepts only an offered permission choice for %s",
    async (scenario) => {
      const fixture = await setup(scenario);
      const session = await fixture.adapter.startSession(fixture.context);
      const observed = observe(session.events);
      const execution = session.execute(fixture.turn("needs approval"));
      await vi.waitFor(() => {
        expect(observed.events.some((event) => event.type === "request.opened")).toBe(true);
      });
      const opened = observed.events.find((event) => event.type === "request.opened");
      if (!opened || opened.type !== "request.opened") throw new Error("request did not open");
      const node = observed.events.find((event) => event.type === "node.started");
      expect(opened.data.request.originatingNodeId).toBe(
        scenario === "child-permission" ? node?.data.nodeId : undefined,
      );
      await expect(
        session.resolveRequest(opened.data.request.id, { kind: "choice", optionId: "invented" }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await session.resolveRequest(opened.data.request.id, { kind: "choice", optionId: "allow" });
      await execution;
      expect(fixture.selectedPermissions).toEqual(["allow"]);
      await session.stop();
      await observed.done;
      await fixture.adapter.close();
    },
  );
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
  | "close-hang"
  | "long-session"
  | "wait-interruption"
  | "held-interruption"
  | "held-prompt-error"
  | "held-assistant-deadline"
  | "persistent-permission"
  | "permission"
  | "child-permission"
  | "prompt-error"
  | "replay"
  | "usage-interruption"
  | "usage-process-exit"
  | "usage-prompt-error"
  | "usage-held-assistant-error"
  | "usage-success";

async function setup(scenario: Scenario, real: { readonly agent?: string } = {}) {
  const directory = await temporaryDirectory();
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const instanceId = createId("harnessInstance") as HarnessInstanceId;
  const selectedPermissions: string[] = [];
  const prompts: unknown[] = [];
  let notifyHeldAssistantReached: () => void = () => undefined;
  const heldAssistantReached = new Promise<void>((resolve) => {
    notifyHeldAssistantReached = resolve;
  });
  const controls: {
    promptOutcome: string;
    prepare?: (() => void) | undefined;
    duringPrompt?: (() => void | Promise<void>) | undefined;
  } = { promptOutcome: "end_turn" };
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
      rewritePromptText: (text) => {
        controls.prepare?.();
        return text;
      },
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
          : scenario === "held-interruption" ||
              scenario === "held-prompt-error" ||
              scenario === "wait-interruption"
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
        (scenario === "background" || scenario === "child-permission") &&
        typeof update === "object" &&
        update !== null &&
        "sessionUpdate" in update &&
        update.sessionUpdate === "child-started"
          ? [
              {
                key: "child",
                kind: "subagent",
                state: "started",
                sessionReference: "child-session",
              },
            ]
          : undefined,
    },
    launch: ({ context }) => ({
      args: real.agent ? [real.agent] : ["-e", "process.stdin.resume()"],
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
      cancel:
        scenario === "wait-interruption"
          ? { behavior: "wait-for-prompt" }
          : { behavior: "cancel-and-kill", metadata: { outcome: "cancelled" } },
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
    const client = fakeClient(
      scenario,
      input.handlers,
      (choice) => selectedPermissions.push(choice),
      input.process,
      notifyHeldAssistantReached,
      prompts,
    );
    return {
      ...client,
      prompt: async (...args) => {
        await controls.duringPrompt?.();
        if (controls.promptOutcome === "throw") {
          prompts.push(args[1]);
          throw new Error("prompt failed");
        }
        const result = await client.prompt(...args);
        return controls.promptOutcome === "end_turn"
          ? result
          : { stopReason: controls.promptOutcome };
      },
    };
  };
  const adapter = new AcpHarnessAdapter(
    instanceId,
    options,
    real.agent
      ? {}
      : { createClient: createClient as typeof import("./protocol.js").createAcpProtocolClient },
  );
  const environment = { PATH: process.env.PATH ?? "" };
  const context: HarnessSessionContext = {
    accessMode: "full-access",
    agentTools: {
      tools: ["opensteer_task_read", "plugin_call", "computer_use"],
      toolsRevision: "test-tools-v1",
      instructions: "Host Opensteer instructions",
      skills: ["opensteer:tasks"],
      token: "agent-token",
      url: "https://host/mcp",
    },
    commandEnvironment: {},
    environment,
    environmentId: createId("environment"),
    harnessInstanceId: instanceId,
    history: [],
    historyWindow: { byteCount: 0, hasEarlier: false, itemCount: 0 },
    instructions: undefined,
    personalContext: false,
    personLineage: false,
    machineAccessNotice: "No other computers are reachable.",
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
    signal: new AbortController().signal,
    skills: undefined,
    threadId: createId("thread"),
    threadStateDirectory: join(directory, "thread-state"),
    workspacePath,
    wrapProcessLaunch: (launch) => launch,
    writableRoots: [workspacePath],
  };
  expect(handlers).toBeUndefined();
  return {
    get promptOutcome() {
      return controls.promptOutcome;
    },
    set promptOutcome(value: string) {
      controls.promptOutcome = value;
    },
    get prepare() {
      return controls.prepare;
    },
    set prepare(value: (() => void) | undefined) {
      controls.prepare = value;
    },
    get duringPrompt() {
      return controls.duringPrompt;
    },
    set duringPrompt(value: (() => void | Promise<void>) | undefined) {
      controls.duringPrompt = value;
    },
    update: (sessionId: string, update: unknown) => handlers!.update(sessionId, update),
    adapter,
    context,
    heldAssistantReached,
    selectedPermissions,
    prompts,
    turn(text: string, signal = new AbortController().signal): HarnessRunInput {
      return {
        context: {
          assignment: null,
          threadState: { previousAssignment: null, previousRun: null },
          startedAt: "2026-08-22T00:00:00.000Z",
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
  prompts: unknown[],
): AcpProtocolClient {
  let cancelled: () => void = () => undefined;
  const cancellation = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  return {
    authenticate: async () => undefined,
    logout: async () => undefined,
    cancel: async () => cancelled(),
    close: () => undefined,
    closeSession: (): Promise<void> =>
      scenario === "close-hang" ? new Promise(() => undefined) : Promise.resolve(),
    initialize: async () => ({
      agentCapabilities: {},
      authMethods: [],
      metadata: {},
      protocolVersion: 1,
    }),
    newSession: async (environment) => {
      expect(environment.mcpServers).toEqual([
        {
          name: "opensteer",
          type: "http",
          url: "https://host/mcp",
          headers: [{ name: "Authorization", value: "Bearer agent-token" }],
        },
      ]);
      return { configOptions: [], metadata: {}, sessionId: "new-session" };
    },
    prompt: async (_sessionId, input) => {
      prompts.push(input);
      if (scenario === "wait-interruption") {
        handlers.update("new-session", {
          sessionUpdate: "usage_update",
          usage: { inputTokens: 11, outputTokens: 7, thoughtTokens: 3 },
        });
        handlers.update("new-session", {
          content: { text: "partial reply", type: "text" },
          sessionUpdate: "agent_message_chunk",
        });
        handlers.update("new-session", {
          content: { text: "weighing it", type: "text" },
          sessionUpdate: "agent_thought_chunk",
        });
        notifyHeldAssistantReached();
        await cancellation;
        throw new Error("prompt RPC failed after cancel");
      }
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
        handlers.update("new-session", {
          content: { text: "weighing it", type: "text" },
          sessionUpdate: "agent_thought_chunk",
        });
        throw new Error("prompt RPC failed");
      }
      if (
        scenario === "permission" ||
        scenario === "persistent-permission" ||
        scenario === "child-permission"
      ) {
        if (scenario === "child-permission")
          handlers.update("new-session", { sessionUpdate: "child-started" });
        const choice = await handlers.permission(
          {
            options: [
              {
                id: "allow",
                kind: scenario === "persistent-permission" ? "allow_always" : "allow_once",
                label: "Allow",
              },
              { id: "reject", kind: "reject_once", label: "Reject" },
            ],
            sessionId: scenario === "child-permission" ? "child-session" : "new-session",
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
    resumeSession: async (reference, environment) => {
      expect(environment.mcpServers).toEqual([
        {
          name: "opensteer",
          type: "http",
          url: "https://host/mcp",
          headers: [{ name: "Authorization", value: "Bearer agent-token" }],
        },
      ]);
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

it("scrubs proxy credentials from an ACP prompt failure", async () => {
  const fixture = await setup("replay");
  const proxy = "http://alice:p@ss-word@proxy.invalid:8080";
  fixture.duringPrompt = () => {
    throw new Error(`Connection failed via ${proxy}; password p@ss-word`);
  };
  const environment = { ...fixture.context.environment, HTTPS_PROXY: proxy };
  try {
    const session = await fixture.adapter.startSession({ ...fixture.context, environment });
    const observer = observe(session.events);
    await session.execute({ ...fixture.turn("Hello"), environment });
    await session.stop();
    await observer.done;
    expect(observer.events.find((event) => event.type === "run.failed")?.data.message).toBe(
      "Connection failed via http://[REDACTED]@proxy.invalid:8080; password [REDACTED]",
    );
  } finally {
    await fixture.adapter.close();
  }
});

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

/** The live delta is what the person saw; the message is what outlives the terminal event. */
function expectAssistantBeforeTerminal(
  events: readonly HarnessEvent[],
  text: string,
  terminal: "run.failed" | "run.interrupted",
): void {
  const end = events.findIndex((event) => event.type === terminal);
  const delta = events.findIndex(
    (event) => event.type === "assistant.delta" && event.data.text === text,
  );
  expect(delta).toBeGreaterThan(-1);
  expect(delta).toBeLessThan(end);
  const saved = events.flatMap((event, index) =>
    event.type === "assistant.message" ? [{ event, index }] : [],
  );
  expect(saved).toHaveLength(1);
  expect(saved[0]?.event.data.content).toEqual([{ text, type: "text" }]);
  expect(saved[0]?.index).toBeLessThan(end);
}

function expectReasoningBeforeTerminal(
  events: readonly HarnessEvent[],
  text: string,
  terminal: "run.failed" | "run.interrupted",
): void {
  const saved = events.findIndex(
    (event) => event.type === "reasoning.completed" && event.data.text === text,
  );
  expect(saved).toBeGreaterThan(-1);
  expect(saved).toBeLessThan(events.findIndex((event) => event.type === terminal));
}

async function withinDeadline<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A real ACP agent whose every turn streams about 220 KiB of reply. */
async function longSessionAgent(): Promise<string> {
  const directory = await temporaryDirectory();
  const agent = join(directory, "agent.mjs");
  await writeFile(
    agent,
    `
import { createInterface } from "node:readline";
const sessionId = "long-session";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const chunk = "x".repeat(1_024);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId, configOptions: [] } });
  } else if (message.method === "session/prompt") {
    for (let index = 0; index < 200; index += 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } }
      }});
    }
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
`,
  );
  return agent;
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

it("delivers distinct plugin and loose skill identities through ACP for Grok and Antigravity", async () => {
  const fixture = await setup("replay");
  const skills = await collisionSkills(fixture.context.workspacePath);
  const session = await fixture.adapter.startSession({ ...fixture.context, skills });
  await session.execute(fixture.turn("Use alpha:review, beta:review and review."));
  await session.stop();
  const payload = JSON.stringify(fixture.prompts);
  for (const skill of skills.skills) {
    expect(payload).toContain(`${skill.fullName} workflow`);
    expect(payload).toContain(skill.path);
  }
  await fixture.adapter.close();
});

it("retains ACP tool-result image content", async () => {
  const f = await setup("replay");
  const session = await f.adapter.startSession({
    ...f.context,
    imageStore: createToolImageStore(f.context.threadStateDirectory),
  });
  const events: HarnessEvent[] = [];
  const consume = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  f.duringPrompt = () => {
    f.update("new-session", {
      sessionUpdate: "tool_call",
      toolCallId: "image-1",
      name: "probe",
      status: "in_progress",
    });
    f.update("new-session", {
      sessionUpdate: "tool_call_update",
      toolCallId: "image-1",
      status: "completed",
      rawOutput: "Image ready",
      content: [
        {
          type: "content",
          content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgoA" },
        },
      ],
    });
  };
  try {
    await session.execute(f.turn("Show an image"));
    await session.stop();
    await consume;
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({
      data: {
        output: { images: [{ mediaType: "image/png", path: expect.stringMatching(/\.png$/) }] },
      },
    });
    expect(JSON.stringify(events)).not.toContain("iVBORw0KGgoA");
  } finally {
    await session.stop();
    await f.adapter.close();
  }
});

it("starts and finishes each ACP tool call once, whatever the engine resends", async () => {
  const f = await setup("replay");
  const session = await f.adapter.startSession(f.context);
  const observed = observe(session.events);
  const command = `ls -la ${"/a/very/long/path ".repeat(30)}`;
  f.duringPrompt = () => {
    f.update("new-session", {
      sessionUpdate: "tool_call",
      toolCallId: "s:1",
      kind: "execute",
      title: command,
      rawInput: { command_line: command },
      status: "in_progress",
    });
    f.update("new-session", {
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      kind: "read",
      title: "Running view_file",
      rawInput: { absolute_path: "/a/b.md" },
      status: "in_progress",
    });
    f.update("new-session", {
      sessionUpdate: "tool_call",
      toolCallId: "s:2",
      kind: "other",
      title: "opensteer_opensteer_task_read",
      _meta: { mcp: { server: "opensteer", tool: "opensteer_task_read" }, is_mcp_tool_call: true },
      status: "in_progress",
    });
    f.update("new-session", {
      sessionUpdate: "tool_call_update",
      toolCallId: "s:1",
      status: "completed",
      rawOutput: "ok",
    });
    // Antigravity fails every open call on an unrelated step error, then announces them again.
    for (const id of ["call_1", "s:2"])
      f.update("new-session", {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "failed",
      });
    for (const id of ["s:1", "call_1", "s:2"]) {
      f.update("new-session", {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: "Running view_file",
        status: "in_progress",
      });
      f.update("new-session", {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "completed",
      });
    }
    f.update("new-session", { sessionUpdate: "tool_call_update", status: "completed" });
    f.update("new-session", {
      sessionUpdate: "tool_call_update",
      toolCallId: "s:3",
      status: "completed",
      rawOutput: "done",
    });
  };
  await session.execute(f.turn("first"));
  f.duringPrompt = () => {
    // A call an earlier Run announced stays that Run's.
    f.update("new-session", {
      sessionUpdate: "tool_call_update",
      toolCallId: "s:1",
      status: "completed",
    });
    f.update("new-session", {
      sessionUpdate: "tool_call",
      toolCallId: "s:4",
      kind: "edit",
      title: "Running write_to_file",
      status: "in_progress",
    });
  };
  await session.execute(f.turn("second"));
  await session.stop();
  await observed.done;
  const lifecycle = observed.events.flatMap((event) =>
    event.type === "tool.started"
      ? [["started", event.data.callId, `${event.data.tool.namespace}/${event.data.tool.name}`]]
      : event.type === "tool.completed"
        ? [["completed", event.data.callId, event.data.isError]]
        : event.type === "run.completed"
          ? [["run"]]
          : [],
  );
  expect(lifecycle).toEqual([
    ["started", "s:1", "acp/execute"],
    ["started", "call_1", "acp/read"],
    ["started", "s:2", "opensteer/opensteer_task_read"],
    ["completed", "s:1", false],
    ["completed", "call_1", true],
    ["completed", "s:2", true],
    ["started", "s:3", "acp/other"],
    ["completed", "s:3", false],
    ["run"],
    ["started", "s:4", "acp/edit"],
    ["run"],
  ]);
  await f.adapter.close();
});

describe("ACP prompt steering, outcome inspection, and permission disposition", () => {
  it("steers a running turn with a follow-up session/prompt and ignores the superseded prompt response", async () => {
    const f = await setup("replay");
    const firstPrompt = new Deferred<{ readonly stopReason: string }>();
    const secondPrompt = new Deferred<{ readonly stopReason: string }>();
    const receivedPrompts: (readonly AcpPromptBlock[])[] = [];
    let handlers: AcpProtocolHandlers | undefined;
    const adapter = new AcpHarnessAdapter(
      f.context.harnessInstanceId,
      {
        capabilities: {
          approvals: true,
          attachments: true,
          interruption: true,
          mcpImageContent: false,
          resume: true,
          steering: true,
          toolCalls: true,
          userInput: true,
        },
        engineLabel: "Steerable ACP",
        hooks: {
          classifyError: (error) =>
            error instanceof OpensteerError
              ? error
              : new OpensteerError({ code: "harness_error", message: String(error) }),
          permissionChoices: () => [],
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
            "approval-required": "default",
            "auto-accept-edits": "default",
            auto: "auto",
            "full-access": "default",
          },
          cancel: { behavior: "wait-for-prompt" },
          clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
          clientInfo: { name: "opensteer_test", version: "0.0.0" },
          eagerAuthentication: false,
          initializeDeadlineMs: 100,
          model: { type: "set-model" },
          protocolVersion: 1,
          resume: { method: "resume", suppressReplay: false },
          steering: "prompt",
        },
      },
      {
        createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
          handlers = input.handlers;
          const base = fakeClient(
            "replay",
            input.handlers,
            () => undefined,
            {
              child: {} as SupervisedProcess["child"],
              exited: new Promise(() => undefined),
              stderr: (async function* () {})(),
              stdout: (async function* () {})(),
              terminate: async () => undefined,
            },
            () => undefined,
            [],
          );
          return {
            ...base,
            prompt: async (_sessionId, blocks) => {
              receivedPrompts.push(blocks);
              return receivedPrompts.length === 1 ? firstPrompt.promise : secondPrompt.promise;
            },
          };
        }) as typeof import("./protocol.js").createAcpProtocolClient,
      },
    );

    const nonSteerable = await f.adapter.startSession(f.context);
    expect(nonSteerable.steer).toBeUndefined();
    await nonSteerable.stop();

    const session = await adapter.startSession(f.context);
    expect(session.steer).toBeTypeOf("function");
    const observed = observe(session.events);
    const execution = session.execute(f.turn("initial prompt"));
    await vi.waitFor(() => {
      expect(receivedPrompts).toHaveLength(1);
    });

    const followUpMessageId = createId("message");
    await expect(
      session.steer!({
        input: {
          author: {
            displayName: "Person",
            kind: "human",
            principalId: "person:test",
            userId: createId("user"),
          },
          content: [{ text: "change direction now", type: "text" }],
          createdAt: new Date().toISOString(),
          kind: "input",
          messageId: followUpMessageId,
        },
      }),
    ).rejects.toBeInstanceOf(HarnessSteerDeliveryUnknownError);
    expect(receivedPrompts).toHaveLength(2);
    expect(receivedPrompts[1]).toEqual([
      { text: expect.stringContaining("change direction now"), type: "text" },
    ]);

    // Superseded initial prompt settling must NOT finish the Run.
    firstPrompt.resolve({ stopReason: "cancelled" });
    await Promise.resolve();
    await Promise.resolve();
    expect(observed.events.some((event) => event.type === "run.completed")).toBe(false);

    handlers!.update("new-session", {
      content: { text: "steered reply", type: "text" },
      sessionUpdate: "agent_message_chunk",
    });
    secondPrompt.resolve({ stopReason: "end_turn" });
    await execution;
    await session.stop();
    await observed.done;
    await adapter.close();
    await f.adapter.close();

    expect(
      observed.events.some(
        (event) => event.type === "message.injected" && event.data.messageId === followUpMessageId,
      ),
    ).toBe(true);
    expect(observed.events.some((event) => event.type === "run.completed")).toBe(true);
    expect(observed.events.find((event) => event.type === "assistant.message")).toMatchObject({
      data: { content: [{ text: "steered reply", type: "text" }] },
    });
  });

  it("keeps the original prompt alive if a steering prompt RPC is rejected while the original is still pending", async () => {
    const f = await setup("replay");
    const firstPrompt = new Deferred<{ readonly stopReason: string }>();
    const secondPrompt = Promise.withResolvers<{ readonly stopReason: string }>();
    let handlers: AcpProtocolHandlers | undefined;
    let promptCalls = 0;
    const adapter = new AcpHarnessAdapter(
      f.context.harnessInstanceId,
      {
        capabilities: {
          approvals: true,
          attachments: true,
          interruption: true,
          mcpImageContent: false,
          resume: true,
          steering: true,
          toolCalls: true,
          userInput: true,
        },
        engineLabel: "Steerable ACP",
        hooks: {
          classifyError: (error) =>
            error instanceof OpensteerError
              ? error
              : new OpensteerError({ code: "harness_error", message: String(error) }),
          permissionChoices: () => [],
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
            "approval-required": "default",
            "auto-accept-edits": "default",
            auto: "auto",
            "full-access": "default",
          },
          cancel: { behavior: "wait-for-prompt" },
          clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
          clientInfo: { name: "opensteer_test", version: "0.0.0" },
          eagerAuthentication: false,
          initializeDeadlineMs: 100,
          model: { type: "set-model" },
          protocolVersion: 1,
          resume: { method: "resume", suppressReplay: false },
          steering: "prompt",
        },
      },
      {
        createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
          handlers = input.handlers;
          const base = fakeClient(
            "replay",
            input.handlers,
            () => undefined,
            {
              child: {} as SupervisedProcess["child"],
              exited: new Promise(() => undefined),
              stderr: (async function* () {})(),
              stdout: (async function* () {})(),
              terminate: async () => undefined,
            },
            () => undefined,
            [],
          );
          return {
            ...base,
            prompt: async () => {
              promptCalls += 1;
              return promptCalls === 1 ? firstPrompt.promise : secondPrompt.promise;
            },
          };
        }) as typeof import("./protocol.js").createAcpProtocolClient,
      },
    );

    const session = await adapter.startSession(f.context);
    const observed = observe(session.events);
    const execution = session.execute(f.turn("initial prompt"));
    await vi.waitFor(() => {
      expect(promptCalls).toBe(1);
    });

    const steerCall = session.steer!({
      input: {
        author: {
          displayName: "Person",
          kind: "human",
          principalId: "person:test",
          userId: createId("user"),
        },
        content: [{ text: "rejected steer", type: "text" }],
        createdAt: new Date().toISOString(),
        kind: "input",
        messageId: createId("message"),
      },
    });
    await vi.waitFor(() => {
      expect(promptCalls).toBe(2);
    });

    // Provider rejects the steering RPC as busy while the first prompt is still pending:
    // steer() must reject so the Runner does not emit message.injected and the Host re-queues it,
    // while the original prompt stays alive and completes the Run.
    secondPrompt.reject(new RequestError(-32000, "busy"));
    await expect(steerCall).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("busy"),
    });
    expect(observed.events.some((event) => event.type === "run.failed")).toBe(false);

    handlers!.update("new-session", {
      content: { text: "original reply", type: "text" },
      sessionUpdate: "agent_message_chunk",
    });
    firstPrompt.resolve({ stopReason: "end_turn" });
    await execution;
    await session.stop();
    await observed.done;
    await adapter.close();
    await f.adapter.close();

    expect(observed.events.some((event) => event.type === "run.failed")).toBe(false);
    expect(observed.events.some((event) => event.type === "run.completed")).toBe(true);
    expect(observed.events.find((event) => event.type === "assistant.message")).toMatchObject({
      data: { content: [{ text: "original reply", type: "text" }] },
    });
  });

  it("fails the Run if an already-admitted steering prompt fails later during execution", async () => {
    const f = await setup("replay");
    const firstPrompt = new Deferred<{ readonly stopReason: string }>();
    const secondPrompt = Promise.withResolvers<{ readonly stopReason: string }>();
    let promptCalls = 0;
    const adapter = new AcpHarnessAdapter(
      f.context.harnessInstanceId,
      {
        capabilities: {
          approvals: true,
          attachments: true,
          interruption: true,
          mcpImageContent: false,
          resume: true,
          steering: true,
          toolCalls: true,
          userInput: true,
        },
        engineLabel: "Steerable ACP",
        hooks: {
          classifyError: (error) =>
            error instanceof OpensteerError
              ? error
              : new OpensteerError({ code: "harness_error", message: String(error) }),
          permissionChoices: () => [],
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
            "approval-required": "default",
            "auto-accept-edits": "default",
            auto: "auto",
            "full-access": "default",
          },
          cancel: { behavior: "wait-for-prompt" },
          clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
          clientInfo: { name: "opensteer_test", version: "0.0.0" },
          eagerAuthentication: false,
          initializeDeadlineMs: 100,
          model: { type: "set-model" },
          protocolVersion: 1,
          resume: { method: "resume", suppressReplay: false },
          steering: "prompt",
        },
      },
      {
        createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
          const base = fakeClient(
            "replay",
            input.handlers,
            () => undefined,
            {
              child: {} as SupervisedProcess["child"],
              exited: new Promise(() => undefined),
              stderr: (async function* () {})(),
              stdout: (async function* () {})(),
              terminate: async () => undefined,
            },
            () => undefined,
            [],
          );
          return {
            ...base,
            prompt: async () => {
              promptCalls += 1;
              return promptCalls === 1 ? firstPrompt.promise : secondPrompt.promise;
            },
          };
        }) as typeof import("./protocol.js").createAcpProtocolClient,
      },
    );

    const session = await adapter.startSession(f.context);
    const observed = observe(session.events);
    const execution = session.execute(f.turn("initial prompt"));
    await vi.waitFor(() => {
      expect(promptCalls).toBe(1);
    });

    await expect(
      session.steer!({
        input: {
          author: {
            displayName: "Person",
            kind: "human",
            principalId: "person:test",
            userId: createId("user"),
          },
          content: [{ text: "accepted steer", type: "text" }],
          createdAt: new Date().toISOString(),
          kind: "input",
          messageId: createId("message"),
        },
      }),
    ).rejects.toBeInstanceOf(HarnessSteerDeliveryUnknownError);
    // Steer remained pending on the wire; a later execution error must surface as run.failed,
    // never silently vanish, and never emit message.injected.
    secondPrompt.reject(new Error("upstream failure"));
    await execution;
    await session.stop();
    await observed.done;
    await adapter.close();
    await f.adapter.close();

    expect(observed.events.some((event) => event.type === "message.injected")).toBe(false);
    expect(observed.events.find((event) => event.type === "run.failed")).toMatchObject({
      data: { code: "harness_error", message: expect.stringContaining("upstream failure") },
    });
  });

  it("finishes as interrupted if Stop arrives while watchPromptOutcome is awaiting", async () => {
    const f = await setup("replay");
    const outcomeStarted = new Deferred<void>();
    const releaseOutcome = new Deferred<void>();
    const adapter = new AcpHarnessAdapter(
      f.context.harnessInstanceId,
      {
        capabilities: {
          approvals: true,
          attachments: true,
          interruption: true,
          mcpImageContent: false,
          resume: true,
          steering: false,
          toolCalls: true,
          userInput: true,
        },
        engineLabel: "Outcome ACP",
        hooks: {
          classifyError: (error) =>
            error instanceof OpensteerError
              ? error
              : new OpensteerError({ code: "harness_error", message: String(error) }),
          permissionChoices: () => [],
          watchPromptOutcome: async () => async () => {
            outcomeStarted.resolve();
            await releaseOutcome.promise;
            return {
              error: new OpensteerError({
                code: harnessSessionBrokenFailureCode,
                message: "Should not fail after Stop",
                retryable: true,
              }),
            };
          },
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
            "approval-required": "default",
            "auto-accept-edits": "default",
            auto: "auto",
            "full-access": "default",
          },
          cancel: { behavior: "wait-for-prompt" },
          clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
          clientInfo: { name: "opensteer_test", version: "0.0.0" },
          eagerAuthentication: false,
          initializeDeadlineMs: 100,
          model: { type: "set-model" },
          protocolVersion: 1,
          resume: { method: "resume", suppressReplay: false },
        },
      },
      {
        createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
          const base = fakeClient(
            "replay",
            input.handlers,
            () => undefined,
            {
              child: {} as SupervisedProcess["child"],
              exited: new Promise(() => undefined),
              stderr: (async function* () {})(),
              stdout: (async function* () {})(),
              terminate: async () => undefined,
            },
            () => undefined,
            [],
          );
          return {
            ...base,
            prompt: async () => ({ stopReason: "end_turn" }),
          };
        }) as typeof import("./protocol.js").createAcpProtocolClient,
      },
    );

    const session = await adapter.startSession(f.context);
    const observed = observe(session.events);
    const abort = new AbortController();
    const execution = session.execute(f.turn("run", abort.signal));
    await outcomeStarted.promise;
    abort.abort();
    releaseOutcome.resolve();
    await execution;
    await session.stop();
    await observed.done;
    await adapter.close();
    await f.adapter.close();

    expect(observed.events.some((event) => event.type === "run.failed")).toBe(false);
    expect(observed.events.some((event) => event.type === "run.interrupted")).toBe(true);
  });

  it("surfaces hidden watchPromptOutcome failures, drops echoed assistant text, and disables reuse", async () => {
    const f = await setup("replay");
    const adapter = new AcpHarnessAdapter(
      f.context.harnessInstanceId,
      {
        capabilities: {
          approvals: true,
          attachments: true,
          interruption: true,
          mcpImageContent: false,
          resume: true,
          steering: false,
          toolCalls: true,
          userInput: true,
        },
        engineLabel: "Outcome ACP",
        hooks: {
          classifyError: (error) =>
            error instanceof OpensteerError
              ? error
              : new OpensteerError({ code: "harness_error", message: String(error) }),
          holdAssistant: {
            deadlineMs: 0,
            maxCharacters: 2_048,
            settle: () => ({ status: "succeeded" }),
          },
          permissionChoices: () => [],
          watchPromptOutcome: async () => async () => ({
            discardAssistant: true,
            error: new OpensteerError({
              code: harnessSessionBrokenFailureCode,
              message: "Saved conversation is corrupted",
              retryable: true,
            }),
          }),
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
            "approval-required": "default",
            "auto-accept-edits": "default",
            auto: "auto",
            "full-access": "default",
          },
          cancel: { behavior: "wait-for-prompt" },
          clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
          clientInfo: { name: "opensteer_test", version: "0.0.0" },
          eagerAuthentication: false,
          initializeDeadlineMs: 100,
          model: { type: "set-model" },
          protocolVersion: 1,
          resume: { method: "resume", suppressReplay: false },
        },
      },
      {
        createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
          const base = fakeClient(
            "replay",
            input.handlers,
            () => undefined,
            {
              child: {} as SupervisedProcess["child"],
              exited: new Promise(() => undefined),
              stderr: (async function* () {})(),
              stdout: (async function* () {})(),
              terminate: async () => undefined,
            },
            () => undefined,
            [],
          );
          return {
            ...base,
            prompt: async () => {
              input.handlers.update("new-session", {
                content: {
                  text: "messages.1.content.0.thinking.signature: Field required",
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              });
              return { stopReason: "end_turn" };
            },
          };
        }) as typeof import("./protocol.js").createAcpProtocolClient,
      },
    );

    const session = await adapter.startSession(f.context);
    const observed = observe(session.events);
    await session.execute(f.turn("continue"));
    expect(await session.releaseForReuse!()).toBe(false);
    await session.stop();
    await observed.done;
    await adapter.close();
    await f.adapter.close();

    expect(observed.events.some((event) => event.type === "assistant.message")).toBe(false);
    expect(observed.events.find((event) => event.type === "run.failed")).toMatchObject({
      data: {
        code: harnessSessionBrokenFailureCode,
        message: "Saved conversation is corrupted",
        retryable: true,
      },
    });
  });

  it("auto-answers permission prompts via permissionDisposition without opening a user request", async () => {
    const f = await setup("permission");
    const chosen: (string | null)[] = [];
    const adapter = new AcpHarnessAdapter(
      f.context.harnessInstanceId,
      {
        capabilities: {
          approvals: true,
          attachments: true,
          interruption: true,
          mcpImageContent: false,
          resume: true,
          steering: false,
          toolCalls: true,
          userInput: true,
        },
        engineLabel: "Policy ACP",
        hooks: {
          classifyError: (error) =>
            error instanceof OpensteerError
              ? error
              : new OpensteerError({ code: "harness_error", message: String(error) }),
          permissionChoices: () => [],
          permissionDisposition: () => "allow",
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
            "approval-required": "default",
            "auto-accept-edits": "default",
            auto: "auto",
            "full-access": "default",
          },
          cancel: { behavior: "wait-for-prompt" },
          clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
          clientInfo: { name: "opensteer_test", version: "0.0.0" },
          eagerAuthentication: false,
          initializeDeadlineMs: 100,
          model: { type: "set-model" },
          protocolVersion: 1,
          resume: { method: "resume", suppressReplay: false },
        },
      },
      {
        createClient: ((input: { readonly handlers: AcpProtocolHandlers }) =>
          fakeClient(
            "permission",
            input.handlers,
            (choice) => chosen.push(choice),
            {
              child: {} as SupervisedProcess["child"],
              exited: new Promise(() => undefined),
              stderr: (async function* () {})(),
              stdout: (async function* () {})(),
              terminate: async () => undefined,
            },
            () => undefined,
            [],
          )) as typeof import("./protocol.js").createAcpProtocolClient,
      },
    );

    const session = await adapter.startSession(f.context);
    const observed = observe(session.events);
    await session.execute(f.turn("run command"));
    expect(await session.releaseForReuse!()).toBe(true);
    await session.stop();
    await observed.done;
    await adapter.close();
    await f.adapter.close();

    expect(chosen).toEqual(["allow"]);
    expect(observed.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(observed.events.some((event) => event.type === "run.completed")).toBe(true);
  });

  it("reports silence, non-RPC transport errors, and post-send aborts on steer as unknown instead of delivered or refused (T1)", async () => {
    const f = await setup("replay");
    const envSecret = "synthetic-value-8A4Z";
    const launchSecret = "launch-only-secret-9Q7K";
    const toolToken = "synthetic-tool-token-5M2X";
    const context: HarnessSessionContext = {
      ...f.context,
      agentTools: { ...f.context.agentTools, token: toolToken },
      environment: { ...f.context.environment, TEST_API_KEY: envSecret },
    };

    const makeAdapter = (
      promptImpl: (call: number) => Promise<{ readonly stopReason: string }>,
      onHandlers?: (handlers: AcpProtocolHandlers) => void,
    ) =>
      new AcpHarnessAdapter(
        context.harnessInstanceId,
        {
          capabilities: {
            approvals: true,
            attachments: true,
            interruption: true,
            mcpImageContent: false,
            resume: true,
            steering: true,
            toolCalls: true,
            userInput: true,
          },
          engineLabel: "Steerable ACP",
          hooks: {
            classifyError: (error) =>
              error instanceof OpensteerError
                ? error
                : new OpensteerError({ code: "harness_error", message: String(error) }),
            permissionChoices: () => [],
          },
          launch: ({ context: launchContext }) => ({
            args: ["-e", "process.stdin.resume()"],
            cwd: launchContext.workspacePath,
            environment: { ...launchContext.environment, DRIVER_API_KEY: launchSecret },
            executable: process.execPath,
          }),
          maxEventBytes: 1_000_000,
          maxEventItems: 1_000,
          policy: {
            accessModeIds: {
              "approval-required": "default",
              "auto-accept-edits": "default",
              auto: "auto",
              "full-access": "default",
            },
            cancel: { behavior: "wait-for-prompt" },
            clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
            clientInfo: { name: "opensteer_test", version: "0.0.0" },
            eagerAuthentication: false,
            initializeDeadlineMs: 100,
            model: { type: "set-model" },
            protocolVersion: 1,
            resume: { method: "resume", suppressReplay: false },
            steering: "prompt",
          },
        },
        {
          createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
            onHandlers?.(input.handlers);
            let calls = 0;
            const base = fakeClient(
              "replay",
              input.handlers,
              () => undefined,
              {
                child: {} as SupervisedProcess["child"],
                exited: new Promise(() => undefined),
                stderr: (async function* () {})(),
                stdout: (async function* () {})(),
                terminate: async () => undefined,
              },
              () => undefined,
              [],
            );
            return {
              ...base,
              newSession: async () => ({
                configOptions: [],
                metadata: {},
                sessionId: "new-session",
              }),
              prompt: async () => {
                calls += 1;
                return promptImpl(calls);
              },
            };
          }) as typeof import("./protocol.js").createAcpProtocolClient,
        },
      );

    const steerInput = (text: string) => ({
      author: {
        displayName: "Person",
        kind: "human" as const,
        principalId: "person:test",
        userId: createId("user"),
      },
      content: [{ text, type: "text" as const }],
      createdAt: new Date().toISOString(),
      kind: "input" as const,
      messageId: createId("message"),
    });

    // 1. Silent follow-up prompt (even with an unrelated session/update) must reject as unknown,
    //    then promote via message.injected only when that steer prompt actually resolves.
    {
      const first = new Deferred<{ readonly stopReason: string }>();
      const second = new Deferred<{ readonly stopReason: string }>();
      let handlers: AcpProtocolHandlers | undefined;
      let calls = 0;
      const adapter = makeAdapter(
        (call) => {
          calls = call;
          return call === 1 ? first.promise : second.promise;
        },
        (h) => {
          handlers = h;
        },
      );
      const session = await adapter.startSession(context);
      const observed = observe(session.events);
      const executing = session.execute({ ...f.turn("initial"), environment: context.environment });
      await vi.waitFor(() => expect(calls).toBe(1));

      const followUp = steerInput("silent steer");
      const steerPromise = session.steer!({ input: followUp });
      await vi.waitFor(() => expect(calls).toBe(2));
      // Unrelated session/update carries no prompt correlation and must not confirm steer delivery.
      handlers!.update("new-session", {
        content: { text: "still talking", type: "text" },
        sessionUpdate: "agent_message_chunk",
      });
      await expect(steerPromise).rejects.toBeInstanceOf(HarnessSteerDeliveryUnknownError);
      expect(observed.events.some((event) => event.type === "message.injected")).toBe(false);

      first.resolve({ stopReason: "cancelled" });
      second.resolve({ stopReason: "end_turn" });
      await executing;
      await session.stop();
      await observed.done;
      await adapter.close();

      const injectedIndex = observed.events.findIndex(
        (event) => event.type === "message.injected" && event.data.messageId === followUp.messageId,
      );
      const completedIndex = observed.events.findIndex((event) => event.type === "run.completed");
      expect(injectedIndex).toBeGreaterThanOrEqual(0);
      expect(completedIndex).toBeGreaterThan(injectedIndex);
    }

    // 2. Non-RPC error (transport drop) after send is unknown (not conflict) and redacts secrets.
    {
      const first = new Deferred<{ readonly stopReason: string }>();
      const second = Promise.withResolvers<{ readonly stopReason: string }>();
      let calls = 0;
      const adapter = makeAdapter((call) => {
        calls = call;
        return call === 1 ? first.promise : second.promise;
      });
      const session = await adapter.startSession(context);
      const observed = observe(session.events);
      const executing = session.execute({ ...f.turn("initial"), environment: context.environment });
      await vi.waitFor(() => expect(calls).toBe(1));

      const steerPromise = session.steer!({ input: steerInput("closed steer") });
      await vi.waitFor(() => expect(calls).toBe(2));
      second.reject(new Error(`ACP connection closed: ${envSecret} ${launchSecret} ${toolToken}`));
      const rejection = await steerPromise.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(HarnessSteerDeliveryUnknownError);
      expect((rejection as Error).message).not.toContain(envSecret);
      expect((rejection as Error).message).not.toContain(launchSecret);
      expect((rejection as Error).message).not.toContain(toolToken);

      first.resolve({ stopReason: "end_turn" });
      await executing;
      await session.stop();
      await observed.done;
      await adapter.close();
    }

    // 3. Post-send abort and ambiguous JSON-RPC codes (-32800 / -32603) are unknown.
    {
      const first = new Deferred<{ readonly stopReason: string }>();
      const second = new Deferred<{ readonly stopReason: string }>();
      const third = Promise.withResolvers<{ readonly stopReason: string }>();
      let calls = 0;
      const adapter = makeAdapter((call) => {
        calls = call;
        if (call === 1) return first.promise;
        if (call === 2) return second.promise;
        return third.promise;
      });
      const session = await adapter.startSession(context);
      const observed = observe(session.events);
      const executing = session.execute({ ...f.turn("initial"), environment: context.environment });
      await vi.waitFor(() => expect(calls).toBe(1));

      const steerAbort = new AbortController();
      const abortedSteer = session.steer!({
        input: steerInput("abort after send"),
        signal: steerAbort.signal,
      });
      await vi.waitFor(() => expect(calls).toBe(2));
      steerAbort.abort();
      await expect(abortedSteer).rejects.toBeInstanceOf(HarnessSteerDeliveryUnknownError);

      const cancelledRpcSteer = session.steer!({ input: steerInput("cancelled rpc") });
      await vi.waitFor(() => expect(calls).toBe(3));
      third.reject(RequestError.requestCancelled());
      await expect(cancelledRpcSteer).rejects.toBeInstanceOf(HarnessSteerDeliveryUnknownError);

      second.resolve({ stopReason: "end_turn" });
      first.resolve({ stopReason: "cancelled" });
      await executing;
      await session.stop();
      await observed.done;
      await adapter.close();
    }

    // 4. Immediate JSON-RPC result on the steer prompt itself proves delivery:
    //    steer() resolves without emitting a duplicate message.injected from the session.
    {
      const first = new Deferred<{ readonly stopReason: string }>();
      const second = new Deferred<{ readonly stopReason: string }>();
      let calls = 0;
      const adapter = makeAdapter((call) => {
        calls = call;
        return call === 1 ? first.promise : second.promise;
      });
      const session = await adapter.startSession(context);
      const observed = observe(session.events);
      const executing = session.execute({ ...f.turn("initial"), environment: context.environment });
      await vi.waitFor(() => expect(calls).toBe(1));

      const steerPromise = session.steer!({ input: steerInput("fast steer") });
      await vi.waitFor(() => expect(calls).toBe(2));
      second.resolve({ stopReason: "end_turn" });
      await expect(steerPromise).resolves.toBeUndefined();
      first.resolve({ stopReason: "cancelled" });
      await executing;
      await session.stop();
      await observed.done;
      await adapter.close();

      expect(observed.events.some((event) => event.type === "message.injected")).toBe(false);
      expect(observed.events.some((event) => event.type === "run.completed")).toBe(true);
    }

    await f.adapter.close();
  });

  it("redacts context, launch, and tool secrets from watchPromptOutcome failures, steer refusals, and stderr (T2)", async () => {
    const f = await setup("replay");
    const envSecret = "synthetic-value-8A4Z";
    const launchSecret = "launch-only-secret-4P9R";
    const toolToken = "synthetic-tool-token-7K3V";
    const context: HarnessSessionContext = {
      ...f.context,
      agentTools: { ...f.context.agentTools, token: toolToken },
      environment: { ...f.context.environment, TEST_API_KEY: envSecret },
    };

    // 1. watchPromptOutcome hook error (SQLite turn outcome) must redact all three secrets.
    {
      const stderr = new EventEmitter();
      const exited = Promise.withResolvers<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>();
      const adapter = new AcpHarnessAdapter(
        context.harnessInstanceId,
        {
          capabilities: {
            approvals: true,
            attachments: true,
            interruption: true,
            mcpImageContent: false,
            resume: true,
            steering: true,
            toolCalls: true,
            userInput: true,
          },
          engineLabel: "Redacted ACP",
          hooks: {
            classifyError: (error, { stderrTail }) =>
              new OpensteerError({ code: "harness_error", message: stderrTail || String(error) }),
            permissionChoices: () => [],
            watchPromptOutcome: async () => () => ({
              discardAssistant: true,
              error: new OpensteerError({
                code: "harness_error",
                message: `sqlite failure leaked ${envSecret} ${launchSecret} ${toolToken}`,
              }),
            }),
          },
          launch: ({ context: launchContext }) => ({
            args: [],
            cwd: launchContext.workspacePath,
            environment: { ...launchContext.environment, DRIVER_API_KEY: launchSecret },
            executable: "unused",
          }),
          maxEventBytes: 1_000_000,
          maxEventItems: 1_000,
          policy: {
            accessModeIds: {
              "approval-required": "default",
              "auto-accept-edits": "default",
              auto: "auto",
              "full-access": "default",
            },
            cancel: { behavior: "wait-for-prompt" },
            clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
            clientInfo: { name: "opensteer_test", version: "0.0.0" },
            eagerAuthentication: false,
            initializeDeadlineMs: 100,
            model: { type: "set-model" },
            protocolVersion: 1,
            resume: { method: "resume", suppressReplay: false },
            steering: "prompt",
          },
        },
        {
          spawn: (() => ({
            child: { stderr } as unknown as SupervisedProcess["child"],
            exited: exited.promise,
            stderr: (async function* () {})(),
            stdout: (async function* () {})(),
            terminate: async () => {
              exited.resolve({ code: 0, signal: null });
            },
          })) as typeof spawnSupervised,
          createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
            const base = fakeClient(
              "replay",
              input.handlers,
              () => undefined,
              {
                child: { stderr } as unknown as SupervisedProcess["child"],
                exited: exited.promise,
                stderr: (async function* () {})(),
                stdout: (async function* () {})(),
                terminate: async () => {
                  exited.resolve({ code: 0, signal: null });
                },
              },
              () => undefined,
              [],
            );
            return {
              ...base,
              newSession: async () => ({
                configOptions: [],
                metadata: {},
                sessionId: "new-session",
              }),
            };
          }) as typeof import("./protocol.js").createAcpProtocolClient,
        },
      );
      const session = await adapter.startSession(context);
      const observed = observe(session.events);
      await session.execute({ ...f.turn("sqlite leak"), environment: context.environment });
      await session.stop();
      await observed.done;
      await adapter.close();

      const failed = observed.events.find((event) => event.type === "run.failed");
      expect(failed).toBeDefined();
      const message = failed?.type === "run.failed" ? failed.data.message : "";
      expect(message).not.toContain(envSecret);
      expect(message).not.toContain(launchSecret);
      expect(message).not.toContain(toolToken);
      expect(message).toContain("[REDACTED]");
    }

    // 2. Explicit JSON-RPC steer refusal must redact launch/context/tool secrets.
    {
      const first = new Deferred<{ readonly stopReason: string }>();
      const second = Promise.withResolvers<{ readonly stopReason: string }>();
      let calls = 0;
      const adapter = new AcpHarnessAdapter(
        context.harnessInstanceId,
        {
          capabilities: {
            approvals: true,
            attachments: true,
            interruption: true,
            mcpImageContent: false,
            resume: true,
            steering: true,
            toolCalls: true,
            userInput: true,
          },
          engineLabel: "Redacted ACP",
          hooks: {
            classifyError: (error) =>
              error instanceof OpensteerError
                ? error
                : new OpensteerError({ code: "harness_error", message: String(error) }),
            permissionChoices: () => [],
          },
          launch: ({ context: launchContext }) => ({
            args: ["-e", "process.stdin.resume()"],
            cwd: launchContext.workspacePath,
            environment: { ...launchContext.environment, DRIVER_API_KEY: launchSecret },
            executable: process.execPath,
          }),
          maxEventBytes: 1_000_000,
          maxEventItems: 1_000,
          policy: {
            accessModeIds: {
              "approval-required": "default",
              "auto-accept-edits": "default",
              auto: "auto",
              "full-access": "default",
            },
            cancel: { behavior: "wait-for-prompt" },
            clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
            clientInfo: { name: "opensteer_test", version: "0.0.0" },
            eagerAuthentication: false,
            initializeDeadlineMs: 100,
            model: { type: "set-model" },
            protocolVersion: 1,
            resume: { method: "resume", suppressReplay: false },
            steering: "prompt",
          },
        },
        {
          createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
            const base = fakeClient(
              "replay",
              input.handlers,
              () => undefined,
              {
                child: {} as SupervisedProcess["child"],
                exited: new Promise(() => undefined),
                stderr: (async function* () {})(),
                stdout: (async function* () {})(),
                terminate: async () => undefined,
              },
              () => undefined,
              [],
            );
            return {
              ...base,
              newSession: async () => ({
                configOptions: [],
                metadata: {},
                sessionId: "new-session",
              }),
              prompt: async () => {
                calls += 1;
                return calls === 1 ? first.promise : second.promise;
              },
            };
          }) as typeof import("./protocol.js").createAcpProtocolClient,
        },
      );
      const session = await adapter.startSession(context);
      const observed = observe(session.events);
      const executing = session.execute({ ...f.turn("initial"), environment: context.environment });
      await vi.waitFor(() => expect(calls).toBe(1));

      const steerPromise = session.steer!({
        input: {
          author: {
            displayName: "Person",
            kind: "human",
            principalId: "person:test",
            userId: createId("user"),
          },
          content: [{ text: "busy steer", type: "text" }],
          createdAt: new Date().toISOString(),
          kind: "input",
          messageId: createId("message"),
        },
      });
      await vi.waitFor(() => expect(calls).toBe(2));
      second.reject(
        new RequestError(-32000, `busy echoing ${envSecret} ${launchSecret} ${toolToken}`),
      );
      const rejection = await steerPromise.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(OpensteerError);
      expect((rejection as OpensteerError).code).toBe("conflict");
      expect((rejection as OpensteerError).message).not.toContain(envSecret);
      expect((rejection as OpensteerError).message).not.toContain(launchSecret);
      expect((rejection as OpensteerError).message).not.toContain(toolToken);

      first.resolve({ stopReason: "end_turn" });
      await executing;
      await session.stop();
      await observed.done;
      await adapter.close();
    }

    await f.adapter.close();
  });

  it("preserves the previous prompt outcome and stderr boundary when a steer is explicitly refused", async () => {
    const f = await setup("replay");

    // 1. Old prompt resolves while steer is pending, then steer is explicitly refused -> Run completes.
    {
      const first = new Deferred<{ readonly stopReason: string }>();
      const second = Promise.withResolvers<{ readonly stopReason: string }>();
      let handlers: AcpProtocolHandlers | undefined;
      let calls = 0;
      const adapter = new AcpHarnessAdapter(
        f.context.harnessInstanceId,
        {
          capabilities: {
            approvals: true,
            attachments: true,
            interruption: true,
            mcpImageContent: false,
            resume: true,
            steering: true,
            toolCalls: true,
            userInput: true,
          },
          engineLabel: "Steerable ACP",
          hooks: {
            classifyError: (error) =>
              error instanceof OpensteerError
                ? error
                : new OpensteerError({ code: "harness_error", message: String(error) }),
            permissionChoices: () => [],
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
              "approval-required": "default",
              "auto-accept-edits": "default",
              auto: "auto",
              "full-access": "default",
            },
            cancel: { behavior: "wait-for-prompt" },
            clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
            clientInfo: { name: "opensteer_test", version: "0.0.0" },
            eagerAuthentication: false,
            initializeDeadlineMs: 100,
            model: { type: "set-model" },
            protocolVersion: 1,
            resume: { method: "resume", suppressReplay: false },
            steering: "prompt",
          },
        },
        {
          createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
            handlers = input.handlers;
            const base = fakeClient(
              "replay",
              input.handlers,
              () => undefined,
              {
                child: {} as SupervisedProcess["child"],
                exited: new Promise(() => undefined),
                stderr: (async function* () {})(),
                stdout: (async function* () {})(),
                terminate: async () => undefined,
              },
              () => undefined,
              [],
            );
            return {
              ...base,
              prompt: async () => {
                calls += 1;
                return calls === 1 ? first.promise : second.promise;
              },
            };
          }) as typeof import("./protocol.js").createAcpProtocolClient,
        },
      );

      const session = await adapter.startSession(f.context);
      const observed = observe(session.events);
      const executing = session.execute(f.turn("initial"));
      await vi.waitFor(() => expect(calls).toBe(1));

      const steerPromise = session.steer!({
        input: {
          author: {
            displayName: "Person",
            kind: "human",
            principalId: "person:test",
            userId: createId("user"),
          },
          content: [{ text: "late busy steer", type: "text" }],
          createdAt: new Date().toISOString(),
          kind: "input",
          messageId: createId("message"),
        },
      });
      await vi.waitFor(() => expect(calls).toBe(2));

      // First prompt finishes cleanly BEFORE the steer rejects as busy.
      handlers!.update("new-session", {
        content: { text: "preserved original reply", type: "text" },
        sessionUpdate: "agent_message_chunk",
      });
      first.resolve({ stopReason: "end_turn" });
      await Promise.resolve();
      await Promise.resolve();

      second.reject(new RequestError(-32000, "session busy"));
      await expect(steerPromise).rejects.toMatchObject({ code: "conflict" });
      await executing;
      await session.stop();
      await observed.done;
      await adapter.close();

      expect(observed.events.some((event) => event.type === "run.failed")).toBe(false);
      expect(observed.events.some((event) => event.type === "run.completed")).toBe(true);
      expect(observed.events.find((event) => event.type === "assistant.message")).toMatchObject({
        data: { content: [{ text: "preserved original reply", type: "text" }] },
      });
    }

    // 2. Old prompt stays pending while steer is refused -> its original stderr boundary is preserved.
    {
      const first = Promise.withResolvers<{ readonly stopReason: string }>();
      const second = Promise.withResolvers<{ readonly stopReason: string }>();
      const stderr = new EventEmitter();
      const exited = Promise.withResolvers<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>();
      let calls = 0;
      let observedStderrTail = "";
      const adapter = new AcpHarnessAdapter(
        f.context.harnessInstanceId,
        {
          capabilities: {
            approvals: true,
            attachments: true,
            interruption: true,
            mcpImageContent: false,
            resume: true,
            steering: true,
            toolCalls: true,
            userInput: true,
          },
          engineLabel: "Steerable ACP",
          hooks: {
            classifyError: (error, { stderrTail }) => {
              observedStderrTail = stderrTail;
              return new OpensteerError({
                code: "harness_error",
                message: stderrTail || String(error),
              });
            },
            permissionChoices: () => [],
          },
          launch: ({ context }) => ({
            args: [],
            cwd: context.workspacePath,
            environment: context.environment,
            executable: "unused",
          }),
          maxEventBytes: 1_000_000,
          maxEventItems: 1_000,
          policy: {
            accessModeIds: {
              "approval-required": "default",
              "auto-accept-edits": "default",
              auto: "auto",
              "full-access": "default",
            },
            cancel: { behavior: "wait-for-prompt" },
            clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
            clientInfo: { name: "opensteer_test", version: "0.0.0" },
            eagerAuthentication: false,
            initializeDeadlineMs: 100,
            model: { type: "set-model" },
            protocolVersion: 1,
            resume: { method: "resume", suppressReplay: false },
            steering: "prompt",
          },
        },
        {
          spawn: (() => ({
            child: { stderr } as unknown as SupervisedProcess["child"],
            exited: exited.promise,
            stderr: (async function* () {})(),
            stdout: (async function* () {})(),
            terminate: async () => {
              exited.resolve({ code: 0, signal: null });
            },
          })) as typeof spawnSupervised,
          createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
            const base = fakeClient(
              "replay",
              input.handlers,
              () => undefined,
              {
                child: { stderr } as unknown as SupervisedProcess["child"],
                exited: exited.promise,
                stderr: (async function* () {})(),
                stdout: (async function* () {})(),
                terminate: async () => {
                  exited.resolve({ code: 0, signal: null });
                },
              },
              () => undefined,
              [],
            );
            return {
              ...base,
              prompt: async () => {
                calls += 1;
                return calls === 1 ? first.promise : second.promise;
              },
            };
          }) as typeof import("./protocol.js").createAcpProtocolClient,
        },
      );

      const session = await adapter.startSession(f.context);
      const observed = observe(session.events);
      const executing = session.execute(f.turn("initial"));
      await vi.waitFor(() => expect(calls).toBe(1));

      stderr.emit("data", Buffer.from("diagnostic-before-steer\n"));
      const steerPromise = session.steer!({
        input: {
          author: {
            displayName: "Person",
            kind: "human",
            principalId: "person:test",
            userId: createId("user"),
          },
          content: [{ text: "busy steer", type: "text" }],
          createdAt: new Date().toISOString(),
          kind: "input",
          messageId: createId("message"),
        },
      });
      await vi.waitFor(() => expect(calls).toBe(2));
      second.reject(new RequestError(-32000, "busy"));
      await expect(steerPromise).rejects.toMatchObject({ code: "conflict" });

      first.reject(new Error("original prompt failed"));
      await executing;
      await session.stop();
      await observed.done;
      await adapter.close();

      expect(observedStderrTail).toContain("diagnostic-before-steer");
    }

    await f.adapter.close();
  });

  it("does not expose prompt steering on ACP v2 sessions and never auto-selects allow_always", async () => {
    const f = await setup("permission");
    const chosen: (string | null)[] = [];
    const permissionResults: (string | null)[] = [];
    const adapter = new AcpHarnessAdapter(
      f.context.harnessInstanceId,
      {
        capabilities: {
          approvals: true,
          attachments: true,
          interruption: true,
          mcpImageContent: false,
          resume: true,
          steering: true,
          toolCalls: true,
          userInput: true,
        },
        engineLabel: "Policy ACP v2",
        hooks: {
          classifyError: (error) =>
            error instanceof OpensteerError
              ? error
              : new OpensteerError({ code: "harness_error", message: String(error) }),
          permissionChoices: () => [],
          permissionDisposition: () => "allow",
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
            "approval-required": "default",
            "auto-accept-edits": "default",
            auto: "auto",
            "full-access": "default",
          },
          cancel: { behavior: "wait-for-prompt" },
          clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
          clientInfo: { name: "opensteer_test", version: "0.0.0" },
          eagerAuthentication: false,
          initializeDeadlineMs: 100,
          model: { type: "set-model" },
          protocolVersion: 2,
          resume: { method: "resume", suppressReplay: false },
          steering: "prompt",
        },
      },
      {
        createClient: ((input: { readonly handlers: AcpProtocolHandlers }) => {
          const wrappedHandlers: AcpProtocolHandlers = {
            ...input.handlers,
            permission: async (request, signal) => {
              const result = await input.handlers.permission(request, signal);
              permissionResults.push(result);
              return result;
            },
          };
          const base = fakeClient(
            "persistent-permission",
            wrappedHandlers,
            (choice) => chosen.push(choice),
            {
              child: {} as SupervisedProcess["child"],
              exited: new Promise(() => undefined),
              stderr: (async function* () {})(),
              stdout: (async function* () {})(),
              terminate: async () => undefined,
            },
            () => undefined,
            [],
          );
          return {
            ...base,
            initialize: async () => ({
              agentCapabilities: {},
              authMethods: [],
              metadata: {},
              protocolVersion: 2,
            }),
          };
        }) as typeof import("./protocol.js").createAcpProtocolClient,
      },
    );

    const session = await adapter.startSession(f.context);
    expect(session.steer).toBeUndefined();
    const observed = observe(session.events);
    await session.execute(f.turn("run command"));
    expect(await session.releaseForReuse!()).toBe(true);
    await session.stop();
    await observed.done;
    await adapter.close();
    await f.adapter.close();

    expect(permissionResults).toEqual([null]);
    expect(chosen).toEqual([]);
  });
});
