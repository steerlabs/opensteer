import { ProjectRunnerToHostMessageSchema } from "@opensteer/protocol";
import { RunnerBootIdSchema } from "@opensteer/protocol";
import { ProjectExecuteTriggerSchema, ProjectReconcileWatchesSchema } from "@opensteer/protocol";
import { ProjectProgramExecution } from "./project-program-execution.js";
import { randomUUID } from "node:crypto";
import type { ProjectExecuteRun } from "@opensteer/protocol";
import type { ProjectExecutionEntry } from "./project-execution.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createId, ProjectRunBindingSchema } from "@opensteer/core";
import {
  ProjectExecuteRunSchema,
  ProjectHostToRunnerMessageSchema,
  RunnerConnectionFenceSchema,
} from "@opensteer/protocol";
import {
  BoundedEventStream,
  type ProjectHarnessEvent,
  type ProjectHarnessSession,
} from "@opensteer/harness";
import { ProjectExecution, type ProjectReport } from "./project-execution.js";
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  platform: () => "linux",
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(programs?: ConstructorParameters<typeof ProjectExecution>[0]["programs"]) {
  const directory = await mkdtemp(join(tmpdir(), "project-runner-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const environmentId = createId("environment"),
    workspaceId = createId("workspace");
  const fence = RunnerConnectionFenceSchema.parse({
    runnerId: createId("runner"),
    bootId: `rbt_${randomUUID()}`,
    connectionId: `rcn_${randomUUID()}`,
    connectionLeaseId: `rls_${randomUUID()}`,
    connectionGeneration: 1,
  });
  const frames: ProjectReport[] = [];
  let now = 0;
  const stream = new BoundedEventStream<ProjectHarnessEvent>({ maxBytes: 100000, maxItems: 100 });
  const finish = Promise.withResolvers<void>();
  const session: ProjectHarnessSession = {
    providerSessionReference: "provider",
    events: stream,
    execute: vi.fn(async () => {
      stream.publish(
        { type: "run.started", data: { status: "running" } },
        { delivery: "must-deliver" },
      );
      await finish.promise;
    }),
    interrupt: vi.fn(async () => {
      finish.resolve();
      stream.close();
    }),
    stop: async () => {
      finish.resolve();
      stream.close();
    },
    resolveRequest: vi.fn(async () => undefined),
    refuseRequest: vi.fn(async () => undefined),
  };
  const start = vi.fn(async (_command: ProjectExecuteRun, _entry: ProjectExecutionEntry) => ({
    session,
    cleanup: async () => undefined,
  }));
  const runtime = new ProjectExecution({
    bootId: fence.bootId,
    environmentId,
    privateDirectory: directory,
    maxConcurrent: 4,
    now: () => now,
    start,
    programs: programs ?? (async () => ({ status: "accepted" })),
  });
  cleanups.push(() => runtime.close());
  const sink = {
    sendProject: async (frame: ProjectReport) => {
      ProjectRunnerToHostMessageSchema.parse({ ...fence, ...frame });
      frames.push(frame);
    },
  };
  runtime.connect(fence, sink);
  const command = ProjectExecuteRunSchema.parse({
    commandId: createId("command"),
    correlationId: "project-test",
    environmentId,
    type: "run.execute.project",
    context: {
      authority: {
        version: 1,
        principal: { kind: "project", principalId: "project:test", workspaceId },
        origin: null,
      },
      grantId: createId("grant"),
      runnerBootId: fence.bootId,
      projectSettingsRevision: 2,
      projectTimeZone: "Europe/Paris",
      workspaceKind: "project",
      workspaceId,
      environmentId,
      runId: createId("run"),
      threadId: createId("thread"),
      threadRole: "work",
      threadState: { previousAssignment: null, previousRun: null },
      accessMode: "full-access",
      assignment: null,
      bindingGeneration: 1,
      executionLeaseMs: 10000,
      agentTools: {
        token: "project-tools",
        url: "https://host.invalid/mcp",
        tools: [],
        toolsRevision: "1",
        instructions: "",
        skills: [],
      },
      egress: {
        relayToken: "project-egress",
        relayUrl: "https://host.invalid/egress",
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
      },
      harness: {
        config: {},
        driverKind: "codex",
        stateKind: "isolated",
        name: "Codex",
        runtimeRevision: 1,
        sourceId: "openai",
      },
      harnessInstanceId: createId("harnessInstance"),
      history: [],
      historyWindow: { byteCount: 0, itemCount: 0, hasEarlier: false },
      initialContext: null,
      modelSelection: { modelId: "test", providerId: "openai", options: {} },
      providerSessionId: createId("providerSession"),
      providerSessionReference: null,
      providerSessionStateLayout: "session",
      workspaceInstructionsPath: null,
      workspaceAccess: {
        kind: "local-directory",
        generation: 1,
        bindingId: createId("workspaceBinding"),
        storageAuthorityId: createId("storageAuthority"),
        ownerEnvironmentId: environmentId,
        workspaceId,
      },
    },
    inputs: [
      {
        messageId: createId("message"),
        kind: "input",
        author: { kind: "human", principalId: "human:test", displayName: "Test" },
        content: [{ type: "text", text: "Run" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    reports: { messages: [], omittedCount: 0, throughSequence: null },
  });
  const binding = ProjectRunBindingSchema.parse({
    authority: command.context.authority,
    bindingGeneration: 1,
    environmentId,
    grantId: command.context.grantId,
    runnerBootId: fence.bootId,
    runnerId: fence.runnerId,
    runId: command.context.runId,
    threadId: command.context.threadId,
    workspaceId,
  });
  return {
    runtime,
    command,
    binding,
    fence,
    frames,
    start,
    session,
    stream,
    sink,
    setNow: (value: number) => {
      now = value;
    },
  };
}
it("executes schema-valid Project work with no person input and rejects mismatched boots and legacy envelopes before launch", async () => {
  const f = await fixture();
  await expect(
    f.runtime.dispatch({
      ...f.command,
      context: {
        ...f.command.context,
        runnerBootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
      },
    }),
  ).resolves.toMatchObject({ status: "rejected" });
  expect(f.start).not.toHaveBeenCalled();
  await expect(f.runtime.dispatch(f.command)).resolves.toEqual({ status: "accepted" });
  await vi.waitFor(() => expect(f.session.execute).toHaveBeenCalled(), { timeout: 1000 });
  expect(f.session.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      executionAuthority: { kind: "project", binding: f.binding },
      context: expect.objectContaining({
        projectTimeZone: "Europe/Paris",
        projectSettingsRevision: 2,
      }),
    }),
  );
  expect(vi.mocked(f.session.execute).mock.calls[0]?.[0]).not.toHaveProperty("requestedBy");
  await f.runtime.dispatch(f.command);
  expect(f.start).toHaveBeenCalledTimes(1);
  await f.runtime.announce();
  expect(f.frames.some((frame) => frame.type === "runner.project.executions.attach")).toBe(true);
});
it("keeps workflow detail and subagent progress on the Project binding", async () => {
  const f = await fixture();
  await f.runtime.dispatch(f.command);
  await vi.waitFor(() => expect(f.session.execute).toHaveBeenCalled(), { timeout: 1000 });
  const nodeId = createId("executionNode");
  const events: ProjectHarnessEvent[] = [
    {
      type: "node.started",
      data: {
        nodeId,
        kind: "workflow",
        model: null,
        nativeRef: "workflow",
        originCallId: null,
        parentNodeId: null,
        prompt: null,
        sessionRef: null,
        title: "Inspect",
        effort: "medium",
      },
    },
    { type: "node.updated", data: { nodeId, phases: ["Inspect", "Check"] } },
    { type: "node.progress", data: { nodeId, text: "Inspecting files" } },
    {
      type: "tool.started",
      data: {
        nodeId,
        callId: "child-tool",
        tool: { namespace: "codex", name: "shell" },
        arguments: {},
      },
    },
    { type: "tool.delta", data: { callId: "child-tool", text: "child output" } },
    { type: "node.message", data: { nodeId, text: "Found the cause" } },
  ];
  for (const event of events) f.stream.publish(event, { delivery: "must-deliver" });
  await vi.waitFor(
    () =>
      expect(f.frames).toContainEqual(
        expect.objectContaining({
          type: "runner.project.event",
          event: expect.objectContaining({
            type: "node.message",
            binding: f.binding,
            data: { nodeId, text: "Found the cause" },
          }),
        }),
      ),
    { timeout: 1000 },
  );
  const progress = f.frames.flatMap((frame) =>
    frame.type === "runner.project.live" ? frame.progress.items : [],
  );
  expect(progress).toContainEqual(
    expect.objectContaining({ stream: "node", nodeId, op: "replace", text: "Inspecting files" }),
  );
  expect(progress).toContainEqual(
    expect.objectContaining({ stream: "tool", nodeId, callId: "child-tool", text: "child output" }),
  );
  expect(
    f.frames
      .filter((frame) => frame.type === "runner.project.live")
      .every((frame) => JSON.stringify(frame.binding) === JSON.stringify(f.binding)),
  ).toBe(true);
});
it("renews only an exact binding and an emitted heartbeat, and never revives an expired binding", async () => {
  const f = await fixture();
  await f.runtime.dispatch(f.command);
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1), { timeout: 1000 });
  const tagged = { ...f.binding, kind: "run" as const };
  await f.runtime.heartbeat("2026-01-01T00:00:00.000Z");
  f.setNow(5000);
  await f.runtime.handle(
    ProjectHostToRunnerMessageSchema.parse({
      ...f.fence,
      type: "host.project.executions.renewed",
      heartbeatSentAt: "2026-01-01T00:00:00.000Z",
      leaseMs: 20000,
      bindings: [{ ...tagged, grantId: createId("grant") }],
    }),
  );
  await f.runtime.handle(
    ProjectHostToRunnerMessageSchema.parse({
      ...f.fence,
      type: "host.project.executions.renewed",
      heartbeatSentAt: "2026-01-01T00:00:01.000Z",
      leaseMs: 20000,
      bindings: [tagged],
    }),
  );
  expect(f.start.mock.calls[0]?.[1].deadline).toBe(10000);
  await f.runtime.handle(
    ProjectHostToRunnerMessageSchema.parse({
      ...f.fence,
      type: "host.project.executions.renewed",
      heartbeatSentAt: "2026-01-01T00:00:00.000Z",
      leaseMs: 20000,
      bindings: [tagged],
    }),
  );
  expect(f.start.mock.calls[0]?.[1].deadline).toBe(20000);
  f.setNow(20001);
  await f.runtime.handle(
    ProjectHostToRunnerMessageSchema.parse({
      ...f.fence,
      type: "host.project.executions.renewed",
      heartbeatSentAt: "2026-01-01T00:00:00.000Z",
      leaseMs: 20000,
      bindings: [tagged],
    }),
  );
  await f.runtime.announce();
  expect(f.start.mock.calls[0]?.[1].deadline).toBe(20000);
  const last = f.frames.findLast((frame) => frame.type === "runner.project.executions.attach");
  expect(last?.type).toBe("runner.project.executions.attach");
});
it("deduplicates provider controls durably and refuses a stale grant without touching the provider", async () => {
  const f = await fixture();
  await f.runtime.dispatch(f.command);
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1), { timeout: 1000 });
  await vi.waitFor(() => expect(f.session.execute).toHaveBeenCalled(), { timeout: 1000 });
  const control = ProjectHostToRunnerMessageSchema.parse({
    ...f.fence,
    type: "host.project.run-control",
    binding: f.binding,
    commandId: createId("command"),
    correlationId: "control",
    control: {
      kind: "request.refuse",
      requestId: createId("request"),
      callId: "call",
      reason: "no-eligible-manager",
    },
  });
  vi.mocked(f.session.refuseRequest).mockImplementation(async () => {
    f.stream.publish(
      {
        type: "assistant.message",
        data: {
          messageId: createId("message"),
          content: [{ type: "text", text: "After refusal" }],
        },
      },
      { delivery: "must-deliver" },
    );
  });
  await f.runtime.handle(control);
  await vi.waitFor(
    () =>
      expect(
        f.frames.some(
          (frame) =>
            frame.type === "runner.project.event" && frame.event.type === "assistant.message",
        ),
      ).toBe(true),
    { timeout: 1000 },
  );
  expect(
    f.frames.findIndex((frame) => frame.type === "runner.project.control-result"),
  ).toBeLessThan(
    f.frames.findIndex(
      (frame) => frame.type === "runner.project.event" && frame.event.type === "assistant.message",
    ),
  );
  await f.runtime.handle(control);
  expect(f.session.refuseRequest).toHaveBeenCalledTimes(1);
  await f.runtime.handle(
    ProjectHostToRunnerMessageSchema.parse({
      ...control,
      commandId: createId("command"),
      binding: { ...f.binding, grantId: createId("grant") },
    }),
  );
  expect(f.session.refuseRequest).toHaveBeenCalledTimes(1);
  expect(
    f.frames.findLast((frame) => frame.type === "runner.project.control-result"),
  ).toMatchObject({ result: { status: "rejected" } });
});

it("reaches the Project session through real Runner dispatch without legacy services", async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "project-runtime-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const authorizations = new Map<string, string>();
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "host.invalid") return originalFetch(input, init);
    authorizations.set(url.pathname, new Headers(init?.headers).get("authorization") ?? "");
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
  });
  cleanups.push(async () => {
    vi.unstubAllGlobals();
  });
  let started: import("@opensteer/harness").ProjectHarnessSessionContext | undefined;
  const { AttachmentCache } = await import("../attachments/attachment-cache.js");
  f.command.context.attachments = { token: "project-files" };
  const attachmentCache = new AttachmentCache({
    root: join(directory, "attachments"),
    transport: { hostOrigin: new URL("https://host.invalid"), mode: "development" },
    fetch: async (_input, init) => {
      authorizations.set("/attachments", new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ attachments: [], nextCursor: null });
    },
  });
  const registry = {
    state: () => ({
      definition: { ...f.command.context.harness, id: f.command.context.harnessInstanceId },
    }),
    adapter: async () => ({
      startProjectSession: async (
        context: import("@opensteer/harness").ProjectHarnessSessionContext,
      ) => {
        started = context;
        return f.session;
      },
      resumeProjectSession: async () => f.session,
    }),
    driverCapabilities: () => ({ messageAttachments: { darwinIsolatedServiceSandbox: true } }),
    providerStoreScope: () => ({ kind: "profile" }),
    environmentVariables: () => [],
    close: async () => undefined,
  } as unknown as import("@opensteer/harness").HarnessRegistry;
  const { RunnerRuntime } = await import("./runtime.js");
  const { ExecutionContainment } = await import("./execution-containment.js");
  const runtime = new RunnerRuntime({
    attachmentCache,
    nodeExecutable: process.execPath,
    bootId: f.fence.bootId,
    environmentId: f.command.environmentId,
    privateStateDirectory: directory,
    dataDirectory: directory,
    browserHarnessExecutable: "/unused-browser",
    harnesses: registry,
    harnessRuntimeBoundary: { kind: "isolated-service" },
    harnessSandbox: {
      plan: async () => (launch) => launch,
      planProgram: async () => (launch) => launch,
    },
    containment: new ExecutionContainment({
      bootId: f.fence.bootId,
      dataDirectory: directory,
      listProcesses: async () => [],
    }),
    agentSkills: { paths: {} } as unknown as ConstructorParameters<
      typeof RunnerRuntime
    >[0]["agentSkills"],
    plugins: async () => {
      throw new Error("Project must not load personal plugins");
    },
    maxConcurrentRuns: 2,
    deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
    projectContinuationIdentity: (() => {
      throw new Error("Project must not use legacy continuation identity");
    }) as unknown as ConstructorParameters<typeof RunnerRuntime>[0]["projectContinuationIdentity"],
    workspaceManager: {
      prepare: async () => ({ instructions: undefined, path: directory }),
      writableRoots: () => {
        throw new Error("Project must not request person roots");
      },
    },
  });
  cleanups.push(() => runtime.close());
  runtime.projectConnect(f.fence, f.sink);
  await expect(
    runtime.handleCommand(f.command, {
      send: async () => {
        throw new Error("Project must not report on legacy transport");
      },
      sendProject: f.sink.sendProject,
    }),
  ).resolves.toEqual({ status: "accepted" });
  await vi.waitFor(() => expect(f.session.execute).toHaveBeenCalledTimes(1), { timeout: 1000 });
  if (!started) throw new Error("Project session never opened");
  expect(started).not.toHaveProperty("voiceCall");
  expect(started).not.toHaveProperty("machineAccessNotice");
  expect(started.agentTools.token).not.toBe("project-tools");
  await (
    await fetch(started.agentTools.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${started.agentTools.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    })
  ).text();
  await (
    await fetch(started.environment.OPENSTEER_EGRESS_URL!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${started.environment.OPENSTEER_EGRESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
    })
  ).text();
  expect(Object.fromEntries(authorizations)).toEqual({
    "/mcp": "Bearer project-tools",
    "/egress": "Bearer project-egress",
    "/attachments": "Bearer project-files",
  });
});

it("executes Project Trigger programs with source-bound results and no creator credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-program-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const execute = vi.fn(
    async (
      input: Parameters<
        import("../agent/program-executor.js").TriggerProgramExecutor["execute"]
      >[0],
    ) => ({
      occurrenceId: input.context.occurrenceId,
      completedAt: "2026-01-01T00:00:00.000Z",
      error: null,
      exitCode: 0,
      result: null,
      status: "succeeded" as const,
      stdout: "",
      stderr: "",
    }),
  );
  const programs = new ProjectProgramExecution({
    privateDirectory: directory,
    nodeExecutable: process.execPath,
    mode: "development",
    executor: { execute },
    planLaunch: async () => (launch) => launch,
    terminate: async () => undefined,
    workspaceManager: {
      prepare: async () => ({ path: directory, instructions: undefined }),
      writableRoots: () => [],
    },
  });
  cleanups.push(() => programs.close());
  const f = await fixture((command, runtime) => programs.dispatch(command, runtime));
  const occurrenceId = createId("triggerOccurrence"),
    triggerId = createId("trigger"),
    revisionId = createId("triggerRevision");
  const context = {
    authority: f.binding.authority,
    workspaceId: f.binding.workspaceId,
    workspaceAccess: f.command.context.workspaceAccess,
    projectSettingsRevision: 1,
    projectTimeZone: "UTC",
    runnerBootId: f.fence.bootId,
    executionLeaseMs: 10000,
    executionGeneration: 1,
    triggerId,
    revisionId,
    occurrenceId,
    anchorThreadId: f.binding.threadId,
    mcp: { token: "project-program", url: "https://host.invalid/mcp" },
    program: {
      language: "javascript",
      source: "export default async () => null",
      toolContractVersion: 3,
    },
    event: {
      id: occurrenceId,
      payload: null,
      receivedAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "schedule", scheduledFor: "2026-01-01T00:00:00.000Z" },
      trigger: {
        id: triggerId,
        revisionId,
        workspaceId: f.binding.workspaceId,
        anchorThreadId: f.binding.threadId,
      },
    },
  };
  await f.runtime.dispatch(
    ProjectExecuteTriggerSchema.parse({
      type: "trigger.execute.project",
      commandId: createId("command"),
      correlationId: "program",
      environmentId: f.command.environmentId,
      context,
    }),
  );
  await vi.waitFor(
    () =>
      expect(f.frames.some((frame) => frame.type === "runner.project.trigger-result")).toBe(true),
    { timeout: 1000 },
  );
  expect(execute.mock.calls[0]?.[0].context).not.toHaveProperty("requestedBy");
  expect(execute.mock.calls[0]?.[0].endpoints).not.toHaveProperty("browserCdp");
  expect(execute.mock.calls[0]?.[0].endpoints.mcp.token).not.toBe("project-program");
  expect(f.frames.find((frame) => frame.type === "runner.project.trigger-result")).toMatchObject({
    binding: {
      kind: "trigger",
      occurrenceId,
      authority: f.binding.authority,
      runnerBootId: f.fence.bootId,
    },
    ordinal: 0,
    output: { status: "succeeded" },
  });
  await expect(
    f.runtime.dispatch(
      ProjectReconcileWatchesSchema.parse({
        type: "watch.reconcile.project",
        commandId: createId("command"),
        correlationId: "stop",
        environmentId: f.command.environmentId,
        reconcileGeneration: 1,
        desired: [],
      }),
    ),
  ).resolves.toEqual({ status: "accepted" });
});

it("reconciles multiple Project Watches on one environment, uses execution leases, and stops an empty batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-watches-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          language: "javascript",
          source:
            "export default async () => { await new Promise(() => setInterval(() => {}, 1000)); }",
          toolContractVersion: 3,
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  cleanups.push(async () => {
    vi.unstubAllGlobals();
  });
  const timeZones = new Map<string, string | undefined>();
  const programs = new ProjectProgramExecution({
    privateDirectory: directory,
    nodeExecutable: process.execPath,
    mode: "development",
    executor: {
      execute: async () => {
        throw new Error("Watch must not run a Trigger");
      },
    },
    planLaunch: async (id, plan) => {
      timeZones.set(id, plan.environment.TZ);
      return (launch) => launch;
    },
    terminate: async () => undefined,
    workspaceManager: {
      prepare: async ({ plan }) => {
        const path = join(directory, plan.workspaceId);
        await mkdir(path, { recursive: true });
        return { path, instructions: undefined };
      },
      writableRoots: () => [],
    },
  });
  cleanups.push(() => programs.close());
  const f = await fixture((command, runtime) => programs.dispatch(command, runtime));
  const desired = ["UTC", "Asia/Tokyo"].map((projectTimeZone) => {
    const workspaceId = createId("workspace");
    return {
      activationId: createId("triggerWatchActivation"),
      anchorThreadId: createId("thread"),
      authority: {
        version: 1,
        principal: { kind: "project", principalId: `project:${workspaceId}`, workspaceId },
        origin: null,
      },
      executionGeneration: 1,
      executionLeaseMs: 10000,
      projectSettingsRevision: 1,
      projectTimeZone,
      runnerBootId: f.fence.bootId,
      triggerId: createId("trigger"),
      revisionId: createId("triggerRevision"),
      workspaceId,
      workspaceAccess: { ...f.command.context.workspaceAccess, workspaceId },
      capabilities: {
        mcp: {
          url: "https://host.invalid/mcp",
          token: "project-watch",
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      },
    };
  });
  const reconcile = ProjectReconcileWatchesSchema.parse({
    type: "watch.reconcile.project",
    commandId: createId("command"),
    correlationId: "watches",
    environmentId: f.command.environmentId,
    reconcileGeneration: 1,
    desired,
  });
  await expect(f.runtime.dispatch(reconcile)).resolves.toEqual({ status: "accepted" });
  await vi.waitFor(
    () =>
      expect(
        new Set(
          f.frames
            .filter(
              (frame) =>
                frame.type === "runner.project.watch-status" && frame.observed === "running",
            )
            .map(
              (frame) => frame.type === "runner.project.watch-status" && frame.binding.workspaceId,
            ),
        ).size,
      ).toBe(2),
    { timeout: 2000 },
  );
  expect(Object.fromEntries(timeZones)).toEqual(
    Object.fromEntries(desired.map((item) => [item.activationId, item.projectTimeZone])),
  );
  await expect(
    f.runtime.dispatch({
      ...reconcile,
      commandId: createId("command"),
      reconcileGeneration: 2,
      desired: [],
    }),
  ).resolves.toEqual({ status: "accepted" });
  await f.runtime.announce();
  expect(
    f.frames.findLast((frame) => frame.type === "runner.project.executions.attach"),
  ).toMatchObject({ executions: [] });
});

it("keeps replay and refreshed credentials on their immutable grant and rejects mixed credential families", async () => {
  const f = await fixture();
  await f.runtime.dispatch(f.command);
  await vi.waitFor(
    () => expect(f.frames.some((frame) => frame.type === "runner.project.event")).toBe(true),
    { timeout: 1000 },
  );
  const entry = f.start.mock.calls[0]![1];
  const binding = { ...f.binding, kind: "run" as const };
  await f.runtime.heartbeat("2026-01-01T00:00:00.000Z");
  const refresh = f.frames.find((frame) => frame.type === "runner.project.grants.refresh");
  if (!refresh || refresh.type !== "runner.project.grants.refresh")
    throw new Error("Credential refresh never arrived");
  const issued = {
    ...f.fence,
    type: "host.project.grants.credentials",
    requestId: refresh.requestId,
    binding,
    result: {
      status: "issued",
      credentials: {
        kind: "run",
        agentTools: "fresh-tools",
        attachments: "fresh-files",
        egress: "fresh-egress",
      },
    },
  };
  await f.runtime.handle(
    ProjectHostToRunnerMessageSchema.parse({
      ...issued,
      binding: { ...binding, grantId: createId("grant") },
    }),
  );
  expect(entry.credentials.agentTools).toBe("project-tools");
  await f.runtime.handle(ProjectHostToRunnerMessageSchema.parse(issued));
  expect(entry.credentials).toMatchObject({
    agentTools: "fresh-tools",
    attachments: "fresh-files",
    egress: "fresh-egress",
  });
  await expect(
    f.runtime.handle({
      ...issued,
      result: {
        status: "issued",
        credentials: { kind: "watch", mcp: "wrong", expiresAt: "2030-01-01T00:00:00.000Z" },
      },
    } as unknown as import("@opensteer/protocol").ProjectHostToRunnerMessage),
  ).rejects.toThrow();
  await f.runtime.handle(
    ProjectHostToRunnerMessageSchema.parse({
      ...f.fence,
      type: "host.project.events.acked",
      acks: [
        {
          binding: { ...binding, grantId: createId("grant") },
          throughOrdinal: 0,
          sessionBound: true,
        },
      ],
    }),
  );
  const countBeforeReplay = f.frames.filter(
    (frame) => frame.type === "runner.project.event",
  ).length;
  await f.runtime.handle(
    ProjectHostToRunnerMessageSchema.parse({
      ...f.fence,
      type: "host.project.executions.attached",
      leaseMs: 10000,
      results: [{ binding, status: "attached", nextOrdinal: 0 }],
    }),
  );
  expect(f.frames.filter((frame) => frame.type === "runner.project.event")).toHaveLength(
    countBeforeReplay + 1,
  );
  await f.runtime.handle(
    ProjectHostToRunnerMessageSchema.parse({
      ...f.fence,
      type: "host.project.events.acked",
      acks: [{ binding, throughOrdinal: 0, sessionBound: true }],
    }),
  );
  expect(entry.journal.size).toBe(0);
});
