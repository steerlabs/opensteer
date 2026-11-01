import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelSelectionSchema, createId, type HarnessInstanceId } from "@opensteer/core";
import {
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
  type HarnessEvent,
  type HarnessInput,
  type HarnessRunInput,
  type HarnessSessionContext,
} from "@opensteer/harness";
import { afterEach, describe, expect, it } from "vitest";
import { museModelDescriptors } from "./model-catalog.js";
import { MuseHarnessDriver } from "./muse-driver.js";

const fakeMuse = fileURLToPath(new URL("./test-fixtures/fake-muse.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Muse Code model catalog", () => {
  it("keeps Meta models only once and supplies the conservative unknown effort set", () => {
    const models = museModelDescriptors({
      models: [model("muse-large", "unknown"), model("muse-large", ["none", "ultra"])],
      profileId: "p",
      providerId: "meta",
      source: "bundledCatalog",
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ modelId: "muse-large", providerId: "meta" });
    expect(models[0]?.options[0]).toEqual({
      defaultValue: "high",
      id: "effort",
      label: "Reasoning",
      type: "select",
      values: [
        { label: "Low", value: "low" },
        { label: "Medium", value: "medium" },
        { label: "High", value: "high" },
        { label: "Extra high", value: "xhigh" },
        { label: "Max", value: "max" },
      ],
    });
  });

  it("refuses a catalog routed through a non-Meta provider", () => {
    expect(() =>
      museModelDescriptors({
        models: [],
        profileId: null,
        providerId: "other",
        source: "bundledCatalog",
      }),
    ).toThrow(/other than Meta/u);
  });

  it("accepts the recorded signed-out model-list shape from Muse Code 1.4.14", async () => {
    const fixture = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./test-fixtures/real-signed-out-model-list.json", import.meta.url)),
        "utf8",
      ),
    ) as Parameters<typeof museModelDescriptors>[0];
    expect(museModelDescriptors(fixture)).toEqual([]);
  });
});

describe("Muse Code inspection", () => {
  it("reports the real wire model and display-safe usage", async () => {
    const fixture = await setup("happy");
    const result = await fixture.driver.inspect?.(fixture.inspection);
    expect(result).toMatchObject({ status: "ready" });
    if (result?.status !== "ready") throw new Error("Expected ready inspection");
    expect(result.models[0]).toMatchObject({ modelId: "muse-test", providerId: "meta" });
    expect(result.connections?.[0]).toMatchObject({
      authKind: "subscription",
      billingLabel: "pro",
      logoutSupported: true,
    });
    expect(result.connections?.[0]?.usage?.windows.map((window) => window.label)).toEqual([
      "5h",
      "weekly",
    ]);
  });

  it("returns authentication-required for the signed-out usage shape", async () => {
    const fixture = await setup("logged-out");
    expect(await fixture.driver.inspect?.(fixture.inspection)).toMatchObject({
      status: "authentication-required",
    });
  });

  it("refuses a shared isolated-service Runner before spawning Muse", async () => {
    const fixture = await setup("happy");
    expect(
      await fixture.driver.inspect?.({
        ...fixture.inspection,
        runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      }),
    ).toEqual({
      detail: "Muse Code runs only on a computer you own.",
      status: "unavailable",
    });
    expect(await fixture.messages()).toEqual([]);
  });
});

describe("Muse Code authentication", () => {
  it("parses and cancels the device-code flow without persisting its output", async () => {
    const fixture = await setup("happy");
    const flow = await fixture.driver.authenticate?.(fixture.inspection, {
      methodId: "muse-subscription",
    });
    expect(flow).toMatchObject({
      challenge: {
        kind: "device-code",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
      },
      status: "pending",
    });
    if (flow?.status !== "pending") throw new Error("Expected pending sign-in");
    await flow.cancel();
    await expect(flow.result).resolves.toMatchObject({ status: "failed" });
  });

  it("offers the account-owned API key only for an isolated profile", async () => {
    const fixture = await setup("logged-out");
    await expect(
      fixture.driver.authenticate?.(fixture.inspection, { methodId: "muse-api-key" }),
    ).rejects.toThrow(/private Muse Code profile/u);
  });
});

describe("Muse Code sessions", () => {
  it("pins the canonical workspace, keeps MCP secrets off argv, and emits usage before completion", async () => {
    const fixture = await setup("happy");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    const session = await adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("hello"));
    await session.stop();
    await observer.done;
    const messages = await fixture.messages();
    const launch = messages.find(
      (entry) => Array.isArray(entry.argv) && entry.argv.includes("serve"),
    );
    expect(launch?.argv).toEqual(["serve", "--trust-workspace", "--disable-sandbox"]);
    expect(JSON.stringify(launch)).not.toContain("agent-tools-token");
    expect(launch?.environment).not.toHaveProperty("META_API_KEY");
    const start = messages.find((entry) => entry.message?.method === "session/start")?.message;
    expect(start?.params?.config?.mcpServers?.opensteer).toMatchObject({
      headers: { Authorization: "Bearer agent-tools-token" },
      transport: "streamableHttp",
    });
    const turn = messages.find((entry) => entry.message?.method === "turn/start")?.message;
    expect(turn?.params?.workspaceRoots).toEqual([await realpath(fixture.context.workspacePath)]);
    expect(observer.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.started", "assistant.message", "run.usage", "run.completed"]),
    );
    expect(observer.events.findIndex((event) => event.type === "run.usage")).toBeLessThan(
      observer.events.findIndex((event) => event.type === "run.completed"),
    );
    await adapter.close();
  });

  it("streams reply, reasoning summary and tool output each to its own stream", async () => {
    const fixture = await setup("streaming");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    const session = await adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("hello"));
    await session.stop();
    await observer.done;
    const streamed = observer.events.filter((event) =>
      ["assistant.delta", "reasoning.delta", "tool.delta"].includes(event.type),
    );
    expect(streamed).toEqual([
      { data: { blockId: "reasoning-1", text: "Reading " }, type: "reasoning.delta" },
      { data: { blockId: "reasoning-1", text: "the file" }, type: "reasoning.delta" },
      { data: { blockId: "reasoning-1", text: "\n\nPlanning" }, type: "reasoning.delta" },
      { data: { callId: "call-1", text: "README.md\n" }, type: "tool.delta" },
      { data: { text: "Hello " }, type: "assistant.delta" },
      { data: { text: "from Muse" }, type: "assistant.delta" },
    ]);
    const durable = observer.events.filter((event) =>
      ["assistant.message", "reasoning.completed", "tool.started", "tool.completed"].includes(
        event.type,
      ),
    );
    expect(durable).toEqual([
      {
        data: { blockId: "reasoning-1", text: "Reading the file\n\nPlanning" },
        type: "reasoning.completed",
      },
      expect.objectContaining({ data: expect.objectContaining({ callId: "call-1" }) }),
      {
        data: {
          callId: "call-1",
          isError: false,
          output: expect.objectContaining({ text: "README.md\n" }),
        },
        type: "tool.completed",
      },
      {
        data: {
          content: [{ text: "Hello from Muse", type: "text" }],
          messageId: expect.any(String),
        },
        type: "assistant.message",
      },
    ]);
    await adapter.close();
  });

  it("uses exact-turn native steering", async () => {
    const fixture = await setup("steer");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    const session = await adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const executing = session.execute(fixture.turn("begin"));
    await observer.waitFor("run.started");
    await session.steer?.({ input: humanInput("new direction") });
    await executing;
    const steer = (await fixture.messages()).find(
      (entry) => entry.message?.method === "turn/steer",
    )?.message;
    expect(steer?.params?.expectedTurnId).toBe("019a2222-2222-7222-8222-222222222222");
    await session.stop();
    await adapter.close();
  });

  it("closes the host to stop native compaction", async () => {
    const fixture = await setup("compaction");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    const session = await adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const executing = session.execute(fixture.turn("compact"));
    await observer.waitFor("reasoning.completed");
    await session.interrupt();
    await executing;
    expect(await observer.waitFor("run.interrupted")).toBeTruthy();
    expect(
      (await fixture.messages()).some((entry) => entry.message?.method === "turn/interrupt"),
    ).toBe(false);
    await session.stop();
    await adapter.close();
  });

  it("re-applies approval mode and model after a strict native resume", async () => {
    const fixture = await setup("happy");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    const reference = "019a1111-1111-7111-8111-111111111111";
    const session = await adapter.resumeSession(reference, fixture.context);
    const methods = (await fixture.messages()).flatMap((entry) =>
      entry.message?.method ? [entry.message.method] : [],
    );
    expect(methods).toEqual(
      expect.arrayContaining(["session/resume", "session/setApprovalMode", "session/setModel"]),
    );
    await session.stop();
    await adapter.close();
  });

  it("fails a missing native resume instead of creating a replacement", async () => {
    const fixture = await setup("missing-session");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    await expect(
      adapter.resumeSession("019a1111-1111-7111-8111-111111111111", fixture.context),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      (await fixture.messages()).some((entry) => entry.message?.method === "session/start"),
    ).toBe(false);
    await adapter.close();
  });

  it("turns host death during a turn into a terminal failure", async () => {
    const fixture = await setup("host-death");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    const session = await adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("fail now"));
    expect((await observer.waitFor("run.failed")).data.message).toContain("exited during the turn");
    await session.stop();
    await adapter.close();
  });

  it("maps quota failures to the usage-limit code with the latest valid reset", async () => {
    const fixture = await setup("quota");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    const session = await adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("use quota"));
    expect(await observer.waitFor("run.failed")).toMatchObject({
      data: {
        code: "harness_usage_limit",
        message: expect.stringContaining("2027-01-15T13:00:00.000Z"),
        retryable: false,
      },
    });
    await session.stop();
    await adapter.close();
  });

  it("names a listed model when the account is not entitled to it", async () => {
    const fixture = await setup("model-denied");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    const session = await adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("try model"));
    expect(await observer.waitFor("run.failed")).toMatchObject({
      data: {
        code: "muse_model_unavailable",
        message: expect.stringContaining("muse-test"),
        retryable: false,
      },
    });
    await session.stop();
    await adapter.close();
  });

  it("refuses a host that withholds sessionMcp", async () => {
    const fixture = await setup("no-mcp");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    await expect(adapter.startSession(fixture.context)).rejects.toThrow(/required session MCP/u);
    await adapter.close();
  });

  it("keeps a child approval routable after its foreground turn completes", async () => {
    const fixture = await setup("child-approval");
    const context = { ...fixture.context, accessMode: "approval-required" as const };
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: context.harnessInstanceId,
      sourceId: "meta",
    });
    const session = await adapter.startSession(context);
    const observer = observe(session.events);
    const executing = session.execute(fixture.turn("check"));
    const opened = await observer.waitFor("request.opened");
    expect((await observer.waitFor("run.phase")).data.phase).toBe("background");
    expect(opened.data.request.originatingNodeId).toBeTruthy();
    await session.resolveRequest(opened.data.request.id, {
      kind: "choice",
      optionId: "approve-once",
    });
    await executing;
    expect(observer.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["node.started", "node.completed", "run.completed"]),
    );
    await session.stop();
    await adapter.close();
  });

  it("answers workflow-child approvals itself in Full mode", async () => {
    const fixture = await setup("child-approval");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    const session = await adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("check"));
    expect(observer.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(
      (await fixture.messages()).some((entry) => entry.message?.method === "approval/decide"),
    ).toBe(true);
    await session.stop();
    await adapter.close();
  });

  it("names a thread in a separate tool-free ephemeral host", async () => {
    const fixture = await setup("happy");
    const adapter = await fixture.driver.create({
      config: {},
      instanceId: fixture.context.harnessInstanceId,
      sourceId: "meta",
    });
    const session = await adapter.startSession(fixture.context);
    expect(
      await session.generateTitle?.({
        prompt: "Name this thread",
        signal: AbortSignal.timeout(5_000),
      }),
    ).toBe("Hello from Muse");
    const launches = (await fixture.messages()).filter((entry) => entry.argv?.includes("serve"));
    const title = launches.find((entry) => entry.argv?.includes("--no-session-log"));
    expect(title?.argv).toEqual([
      "serve",
      "--disable-shell",
      "--disable-write",
      "--no-session-log",
    ]);
    expect(title?.argv).not.toContain("--trust-workspace");
    expect(title?.environment?.XDG_CONFIG_HOME).toContain("title-");
    await session.stop();
    await adapter.close();
  });
});

async function setup(scenario: string) {
  const directory = await mkdtemp(join(tmpdir(), "osmuse-"));
  temporaryDirectories.push(directory);
  const capture = join(directory, "capture.jsonl");
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const harnessInstanceId = createId("harnessInstance") as HarnessInstanceId;
  const environment = {
    FAKE_MUSE_CAPTURE: capture,
    FAKE_MUSE_SCENARIO: scenario,
    META_API_KEY: "inherited-must-not-pass",
    PATH: process.env.PATH ?? "",
  };
  const providerState = {
    continuationKey: `muse:${directory}`,
    kind: "ambient" as const,
    privateStateRoot: join(directory, "private"),
    providerHomeDirectory: undefined,
    store: { directory: join(directory, "store"), id: "muse-test-store" },
  };
  const context: HarnessSessionContext = {
    accessMode: "full-access",
    agentTools: {
      capabilityProfileId: "main",
      token: "agent-tools-token",
      url: "https://host.test/mcp",
    },
    environment,
    environmentId: createId("environment"),
    harnessInstanceId,
    history: [],
    historyWindow: { byteCount: 0, hasEarlier: false, itemCount: 0 },
    instructions: "Workspace instructions.",
    integrationTools: { token: "integration-tools-token", url: "https://host.test/integrations" },
    machineAccessNotice: "No other computers are reachable.",
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "muse-test",
      options: { effort: "high" },
      providerId: "meta",
    }),
    platformGuide: "Opensteer platform guide.",
    providerState,
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
  await mkdir(context.threadStateDirectory, { recursive: true });
  const driver = new MuseHarnessDriver({ arguments: [fakeMuse], executable: process.execPath });
  return {
    context,
    driver,
    inspection: {
      config: {},
      environment,
      providerState,
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "meta",
      workingDirectory: directory,
    },
    async messages(): Promise<Capture[]> {
      return (await readFile(capture, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Capture);
    },
    turn(text: string): HarnessRunInput {
      return {
        context: {
          assignment: null,
          requesterTimeZone: null,
          threadState: { previousAssignment: null, previousRun: null },
        },
        environment,
        inputs: [humanInput(text)],
        reports: { messages: [], omittedCount: 0, throughSequence: null },
        requestedBy: createId("user"),
        runId: createId("run"),
        signal: new AbortController().signal,
      };
    },
  };
}

interface Capture {
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly message?: {
    readonly method?: string;
    readonly params?: Record<string, unknown> & {
      config?: { mcpServers?: Record<string, unknown> };
      workspaceRoots?: readonly string[];
      expectedTurnId?: string;
    };
  };
}

function model(
  modelId: string,
  variants:
    "unknown" | ("none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra")[],
) {
  return {
    contextLimit: 100_000,
    cost: null,
    defaultReasoningEffort: "high" as const,
    description: null,
    displayLabel: "Muse Large",
    isActive: false,
    isDefault: true,
    modelId,
    outputLimit: 8_000,
    profileId: "p",
    providerId: "meta",
    reasoningEffortVariants: [],
    releaseDate: null,
    variants,
  };
}

function humanInput(text: string): HarnessInput {
  return {
    author: { displayName: "Test user", kind: "human", principalId: "test-principal" },
    content: [{ text, type: "text" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "input",
    messageId: createId("message"),
  };
}

function observe(stream: AsyncIterable<HarnessEvent>) {
  const events: HarnessEvent[] = [];
  let error: unknown;
  const done = (async () => {
    try {
      for await (const event of stream) events.push(event);
    } catch (caught) {
      error = caught;
    }
  })();
  return {
    done,
    events,
    async waitFor<T extends HarnessEvent["type"]>(
      type: T,
    ): Promise<Extract<HarnessEvent, { type: T }>> {
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out waiting for ${type}; saw ${events.map((event) => event.type).join(", ")}`,
              ),
            ),
          10_000,
        );
        const check = () => {
          const event = events.find(
            (candidate): candidate is Extract<HarnessEvent, { type: T }> => candidate.type === type,
          );
          if (event) {
            clearTimeout(deadline);
            resolve(event);
            return;
          }
          if (error) {
            clearTimeout(deadline);
            reject(error);
            return;
          }
          setImmediate(check);
        };
        check();
      });
    },
  };
}
