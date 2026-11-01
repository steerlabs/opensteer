import {
  ModelSelectionSchema,
  createId,
  harnessUsageLimitFailureCode,
  type HarnessInstanceId,
} from "@opensteer/core";
import { AcpHarnessAdapter, type AcpSessionConfigOption } from "@opensteer/harness-acp";
import {
  nativeUserHarnessRuntimeBoundary,
  type HarnessEvent,
  type HarnessRunInput,
  type HarnessSessionContext,
} from "@opensteer/harness";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  antigravityModelDescriptors,
  antigravitySessionPolicy,
  classifyAntigravityAcpError,
  normalizeAntigravityUpdate,
  settleAntigravityHeldAssistant,
} from "./driver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const initial: readonly AcpSessionConfigOption[] = [
  {
    category: "model",
    currentValue: "gemini-3.1-pro",
    id: "model",
    name: "Model",
    options: [
      { label: "Gemini 3.1 Pro", value: "gemini-3.1-pro" },
      { label: "Claude Sonnet", value: "claude-sonnet-5-5" },
    ],
    type: "select",
  },
  {
    category: "thought_level",
    currentValue: "high",
    id: "thinking",
    name: "Thinking",
    options: [
      { label: "Low", value: "low" },
      { label: "High", value: "high" },
    ],
    type: "select",
  },
];

describe("Antigravity ACP policy", () => {
  it("uses Zed identity, read-only files, resume, and explicit access-mode mappings", () => {
    expect(antigravitySessionPolicy(1)).toMatchObject({
      accessModeIds: {
        "approval-required": "default",
        "auto-accept-edits": "auto_edit",
        auto: "default",
        "full-access": "yolo",
      },
      cancel: { behavior: "wait-for-prompt" },
      clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
      clientInfo: { name: "zed", version: "0.0.0" },
      eagerAuthentication: true,
      model: {
        effortCategory: "thought_level",
        effortOptionId: "effort",
        type: "config-options",
      },
      resume: { method: "resume", suppressReplay: false },
    });
  });

  it("publishes model-specific thought levels as effort", () => {
    const claude = initial.map((option) =>
      option.category === "thought_level"
        ? {
            ...option,
            currentValue: "medium",
            options: [
              { label: "Medium", value: "medium" },
              { label: "Ultra", value: "ultra" },
            ],
          }
        : option,
    );
    const models = antigravityModelDescriptors(
      initial,
      new Map([
        ["gemini-3.1-pro", initial],
        ["claude-sonnet-5-5", claude],
      ]),
    );

    expect(models).toMatchObject([
      {
        isDefault: true,
        modelId: "gemini-3.1-pro",
        options: [
          { defaultValue: "high", id: "effort", values: [{ value: "low" }, { value: "high" }] },
        ],
        providerId: "google",
      },
      {
        isDefault: false,
        modelId: "claude-sonnet-5-5",
        options: [
          {
            defaultValue: "medium",
            id: "effort",
            values: [{ value: "medium" }, { value: "ultra" }],
          },
        ],
        providerId: "anthropic",
      },
    ]);
  });
});

type TurnScenario =
  | "credits-split"
  | "credits-stderr-first"
  | "credits-stdout-first"
  | "foreign-session"
  | "late-block"
  | "long-reply"
  | "rate-limit"
  | "redaction"
  | "success-order"
  | "thought-error-delayed-close"
  | "thought-first"
  | "unauthorized";

describe("Antigravity in-turn provider failures", () => {
  it.each(["credits-stderr-first", "credits-stdout-first"] as const)(
    "fails depleted credits with %s delivery and drops the error reply",
    async (scenario) => {
      const fixture = await setupTurn(scenario);
      const events = await executeTurn(fixture);

      const failed = events.find((event) => event.type === "run.failed");
      expect(failed).toMatchObject({
        data: {
          code: harnessUsageLimitFailureCode,
          message: expect.stringContaining("prepayment credits are depleted"),
          retryable: false,
        },
      });
      expectAssistantDeltas(events).toBe("");
    },
  );

  it("drops a provider error split across assistant chunks", async () => {
    const events = await executeTurn(await setupTurn("credits-split"));

    expect(events.find((event) => event.type === "run.failed")).toMatchObject({
      data: { code: harnessUsageLimitFailureCode },
    });
    expectAssistantDeltas(events).toBe("");
    expectAssistantMessages(events).toEqual([]);
  });

  it("classifies HTTP 429 as a usage limit and keeps its reset detail", async () => {
    const events = await executeTurn(await setupTurn("rate-limit"));

    expect(events.find((event) => event.type === "run.failed")).toMatchObject({
      data: {
        code: harnessUsageLimitFailureCode,
        message: expect.stringContaining("2026-11-01T18:00:00Z"),
      },
    });
    expectAssistantDeltas(events).toBe("");
  });

  it("routes HTTP 401 through Antigravity authentication-required", async () => {
    const events = await executeTurn(await setupTurn("unauthorized"));

    expect(events.find((event) => event.type === "run.failed")).toMatchObject({
      data: {
        code: "harness_error",
        message: "Antigravity requires Google authentication",
      },
    });
    expectAssistantDeltas(events).toBe("");
  });

  it("redacts a key-looking string from a generic provider failure", async () => {
    const events = await executeTurn(await setupTurn("redaction"));
    const failed = events.find((event) => event.type === "run.failed");

    expect(failed).toMatchObject({
      data: { code: "harness_error", message: "API key=[REDACTED]" },
    });
    expect(JSON.stringify(events)).not.toContain("AIza012345678901234567890123456789");
    expectAssistantDeltas(events).toBe("");
  });

  it("preserves successful multi-chunk reply order", async () => {
    const events = await executeTurn(await setupTurn("success-order", 0));

    expectAssistantDeltas(events).toBe("The error is fixed.");
    expectAssistantMessages(events).toEqual(["The error is fixed."]);
    expect(events.some((event) => event.type === "run.failed")).toBe(false);
  });

  it("streams a thought-first reply without holding its assistant text", async () => {
    const fixture = await setupTurn("thought-first");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("Think first"));
    await expectTerminal(observed.events, "run.completed");
    await session.stop();
    await observed.done;
    await fixture.adapter.close();

    const thought = observed.events.findIndex((event) => event.type === "reasoning.delta");
    const reply = observed.events.findIndex((event) => event.type === "assistant.delta");
    const terminal = observed.events.findIndex((event) => event.type === "run.completed");
    expect(thought).toBeGreaterThan(-1);
    expect(reply).toBeGreaterThan(thought);
    expect(reply).toBeLessThan(terminal);
    expectAssistantDeltas(observed.events).toBe("READY");
  });

  it("fails a thought-first turn when its correlated diagnostic block closes after the prompt", async () => {
    const events = await executeTurn(await setupTurn("thought-error-delayed-close"));

    expect(events.find((event) => event.type === "run.failed")).toMatchObject({
      data: {
        code: harnessUsageLimitFailureCode,
        message: expect.stringContaining("prepayment credits are depleted"),
      },
    });
    expectAssistantDeltas(events).toBe("Your prepayment credits are depleted.");
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  });

  it("flushes an assistant-only reply in order after it exceeds 2048 characters", async () => {
    const events = await executeTurn(await setupTurn("long-reply"));

    expectAssistantDeltas(events).toBe(`${"a".repeat(1_024)}${"b".repeat(1_025)}`);
    expectAssistantMessages(events).toEqual([`${"a".repeat(1_024)}${"b".repeat(1_025)}`]);
  });

  it("ignores a complete error block attributed to another session", async () => {
    const events = await executeTurn(await setupTurn("foreign-session", 0));

    expect(events.some((event) => event.type === "run.failed")).toBe(false);
    expectAssistantDeltas(events).toBe("FOREIGN SAFE");
    expectAssistantMessages(events).toEqual(["FOREIGN SAFE"]);
  });

  it("keeps waiting when diagnostics have not closed a block for this session", () => {
    expect(
      settleAntigravityHeldAssistant({
        assistantText: "wrong session",
        providerSessionReference: "11111111-1111-4111-8111-111111111111",
        stderrTail: [
          "received model response error: Error 500, Message: foreign failure, Status: INTERNAL, Details: []",
          "Antigravity SDK error processing prompt for session 22222222-2222-4222-8222-222222222222",
          "received model response error: Error 500, Message: current failure, Status: INTERNAL, Details: []",
        ].join("\n"),
      }),
    ).toEqual({ status: "pending" });
  });

  it("takes status and message only from the matching session block", () => {
    const foreign = [
      "received model response error: Error 402, Message: current echo, Status: RESOURCE_EXHAUSTED, Details: []",
      "System step error (HTTP 402): foreign failure",
      "Antigravity SDK error processing prompt for session 22222222-2222-4222-8222-222222222222",
    ];
    const current = [
      "received model response error: Error 500, Message: current echo, Status: INTERNAL, Details: []",
      "System step error (HTTP 500): current failure",
      "Antigravity SDK error processing prompt for session 11111111-1111-4111-8111-111111111111",
    ];

    expect(
      settleAntigravityHeldAssistant({
        assistantText: "current echo",
        providerSessionReference: "11111111-1111-4111-8111-111111111111",
        stderrTail: [...foreign, ...current].join("\n"),
      }),
    ).toMatchObject({
      discardAssistant: true,
      error: { code: "harness_error", message: "current echo" },
      status: "failed",
    });
  });

  it("uses only this session's block to classify a prompt RPC error", () => {
    const foreign = [
      "received model response error: Error 429, Message: foreign quota, Status: RESOURCE_EXHAUSTED, Details: []",
      "Antigravity SDK error processing prompt for session 22222222-2222-4222-8222-222222222222",
    ].join("\n");

    expect(
      classifyAntigravityAcpError(new Error("prompt RPC failed"), {
        operation: "prompt",
        providerSessionReference: "11111111-1111-4111-8111-111111111111",
        stderrTail: foreign,
      }),
    ).toMatchObject({ code: "harness_error", message: "Antigravity could not continue" });
  });

  it("does not let a block closed before the prompt fail the turn", async () => {
    const fixture = await setupTurn("late-block");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("Turn after old diagnostics"));
    await vi.waitFor(() => {
      expect(observed.events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    });
    await session.stop();
    await observed.done;
    await fixture.adapter.close();

    expect(observed.events.some((event) => event.type === "run.failed")).toBe(false);
    expectAssistantDeltas(observed.events).toBe("SECOND");
  });
});

async function setupTurn(scenario: TurnScenario, deadlineMs = 500) {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-error-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const instanceId = createId("harnessInstance") as HarnessInstanceId;
  const environment = { GEMINI_API_KEY: "fixture-owned-secret", PATH: process.env.PATH ?? "" };
  const fixture = fileURLToPath(
    new URL("./test-fixtures/fake-antigravity-acp.mjs", import.meta.url),
  );
  const adapter = new AcpHarnessAdapter(instanceId, {
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
    engineLabel: "Antigravity",
    hooks: {
      classifyError: classifyAntigravityAcpError,
      holdAssistant: {
        deadlineMs,
        maxCharacters: 2_048,
        settle: settleAntigravityHeldAssistant,
      },
      normalizeUpdate: normalizeAntigravityUpdate,
      permissionChoices: () => [],
    },
    launch: () => ({
      args: [fixture, scenario],
      cwd: dirname(fixture),
      environment,
      executable: process.execPath,
    }),
    maxEventBytes: 1_000_000,
    maxEventItems: 1_000,
    policy: {
      accessModeIds: {
        "approval-required": "default",
        "auto-accept-edits": "auto_edit",
        auto: "default",
        "full-access": "yolo",
      },
      cancel: { behavior: "wait-for-prompt" },
      clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
      clientInfo: { name: "zed", version: "0.0.0" },
      eagerAuthentication: false,
      initializeDeadlineMs: 1_000,
      model: { type: "set-model" },
      protocolVersion: 1,
      resume: { method: "resume", suppressReplay: false },
    },
  });
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
      modelId: "gemini-test",
      options: {},
      providerId: "google",
    }),
    platformGuide: "Opensteer guide.",
    providerState: {
      continuationKey: "test-store",
      kind: "isolated",
      privateStateRoot: directory,
      providerHomeDirectory: join(directory, "profile"),
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
  return {
    adapter,
    context,
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

async function executeTurn(fixture: Awaited<ReturnType<typeof setupTurn>>) {
  const session = await fixture.adapter.startSession(fixture.context);
  const observed = observe(session.events);
  await session.execute(fixture.turn("Trigger provider failure"));
  await expectTerminal(observed.events);
  await session.stop();
  await observed.done;
  await fixture.adapter.close();
  return observed.events;
}

function observe(events: AsyncIterable<HarnessEvent>) {
  const collected: HarnessEvent[] = [];
  const done = (async () => {
    for await (const event of events) collected.push(event);
  })();
  return { done, events: collected };
}

function expectAssistantDeltas(events: readonly HarnessEvent[]) {
  return expect(
    events.flatMap((event) => (event.type === "assistant.delta" ? [event.data.text] : [])).join(""),
  );
}

function expectAssistantMessages(events: readonly HarnessEvent[]) {
  return expect(
    events.flatMap((event) =>
      event.type === "assistant.message"
        ? event.data.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    ),
  );
}

async function expectTerminal(
  events: readonly HarnessEvent[],
  expected?: "run.completed" | "run.failed",
): Promise<void> {
  await vi.waitFor(() => {
    expect(
      events.some((event) =>
        expected ? event.type === expected : ["run.completed", "run.failed"].includes(event.type),
      ),
    ).toBe(true);
  });
}
