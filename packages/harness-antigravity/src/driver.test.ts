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

type FailureScenario =
  "credits-stderr-first" | "credits-stdout-first" | "generic" | "rate-limit" | "unauthorized";

describe("Antigravity in-turn provider failures", () => {
  it.each(["credits-stderr-first", "credits-stdout-first"] as const)(
    "fails depleted credits with %s delivery and drops the error reply",
    async (scenario) => {
      const fixture = await setupFailureTurn(scenario);
      const events = await executeFailureTurn(fixture);

      const failed = events.find((event) => event.type === "run.failed");
      expect(failed).toMatchObject({
        data: {
          code: harnessUsageLimitFailureCode,
          message: expect.stringContaining("prepayment credits are depleted"),
          retryable: false,
        },
      });
      expectAssistantText(events).toBe("");
    },
  );

  it("classifies HTTP 429 as a usage limit and keeps its reset detail", async () => {
    const fixture = await setupFailureTurn("rate-limit");
    const events = await executeFailureTurn(fixture);

    expect(events.find((event) => event.type === "run.failed")).toMatchObject({
      data: {
        code: harnessUsageLimitFailureCode,
        message: expect.stringContaining("2026-11-01T18:00:00Z"),
      },
    });
    expectAssistantText(events).toBe("");
  });

  it("routes HTTP 401 through Antigravity authentication-required", async () => {
    const fixture = await setupFailureTurn("unauthorized");
    const events = await executeFailureTurn(fixture);

    expect(events.find((event) => event.type === "run.failed")).toMatchObject({
      data: {
        code: "harness_error",
        message: "Antigravity requires Google authentication",
      },
    });
    expectAssistantText(events).toBe("");
  });

  it("uses a sanitized provider message for other failures", async () => {
    const fixture = await setupFailureTurn("generic");
    const events = await executeFailureTurn(fixture);
    const failed = events.find((event) => event.type === "run.failed");

    expect(failed).toMatchObject({
      data: { code: "harness_error", message: "Provider exploded: [REDACTED]" },
    });
    expect(JSON.stringify(failed)).not.toContain("fixture-owned-secret");
    expectAssistantText(events).toBe("");
  });

  it("does not fail a successful turn for an unrelated stderr error", async () => {
    const fixture = await setupFailureTurn("unrelated");
    const session = await fixture.adapter.startSession(fixture.context);
    const observed = observe(session.events);
    await session.execute(fixture.turn("Reply READY"));
    await vi.waitFor(() => {
      expect(observed.events.some((event) => event.type === "run.completed")).toBe(true);
    });
    await session.stop();
    await observed.done;
    await fixture.adapter.close();

    expect(observed.events.some((event) => event.type === "run.failed")).toBe(false);
    expectAssistantText(observed.events).toBe("READYREADY");
  });

  it("ignores an SDK marker for a different native session", () => {
    expect(
      classifyAntigravityAcpError(undefined, {
        operation: "prompt-result",
        providerSessionReference: "11111111-1111-4111-8111-111111111111",
        stderrTail: [
          "Error 500, Message: wrong session, Status: INTERNAL, Details: []",
          "Antigravity SDK error processing prompt for session 22222222-2222-4222-8222-222222222222",
        ].join("\n"),
      }),
    ).toBeUndefined();
  });
});

async function setupFailureTurn(scenario: FailureScenario | "unrelated") {
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

async function executeFailureTurn(fixture: Awaited<ReturnType<typeof setupFailureTurn>>) {
  const session = await fixture.adapter.startSession(fixture.context);
  const observed = observe(session.events);
  await session.execute(fixture.turn("Trigger provider failure"));
  await vi.waitFor(() => {
    expect(observed.events.some((event) => event.type === "run.failed")).toBe(true);
  });
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

function expectAssistantText(events: readonly HarnessEvent[]) {
  return expect(
    events
      .flatMap((event) =>
        event.type === "assistant.delta"
          ? [event.data.text]
          : event.type === "assistant.message"
            ? event.data.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            : [],
      )
      .join(""),
  );
}
