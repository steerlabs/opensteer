import { resolvedInputParts } from "@opensteer/harness";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  assignmentResultMaxBytes,
  createId,
  HarnessIdSchema,
  MessageContentSchema,
  ModelSelectionSchema,
  PendingRequestSchema,
  SequenceSchema,
  ThreadAccessModeSchema,
  WorkspaceIdSchema,
  type AssignmentId,
  type EnvironmentId,
  type RequestId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  createDatabase,
  migrateToLatest,
  migrationProvider,
  OpensteerStore,
} from "@opensteer/database";
import { assignmentPresentation } from "@opensteer/client/host";
import { CommandService, KeyedAdmissionQueue } from "@opensteer/orchestration";
import {
  HarnessInstanceCatalogSchema,
  EnvironmentDiscoverySchema,
  AgentControlResponseSchema,
  type HarnessInstanceCatalog,
  type RunnerCommand,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentControlService,
  type AgentControlRunScope,
  type AgentControlTokenService,
} from "./agent-control-service.js";
import { ContinuationService } from "./continuation-service.js";
import { HostCommandDispatcher } from "./dispatcher.js";
import { AgentToolsMcpService } from "./agent-tools-mcp-service.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const nativeDriver = HarnessIdSchema.parse("native");

/** Every engine in this fixture declares exactly one source, and this is it. */
function sourceForDriver(driverKind: string): string {
  return driverKind === "codex" ? "openai" : driverKind;
}
const testModelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

/**
 * A Thread delegated to another machine used to inherit its parent's harness
 * instance, which belongs to the parent's environment. The Host created the
 * child Thread and its Run, and the dispatcher then failed that Run outright on
 * the environment mismatch. This exercise runs the whole path against a real
 * database and ends at the Runner command, which is the only place the mismatch
 * could still surface.
 */
integration("cross-environment delegation reaches the Runner", () => {
  const database = createDatabase({
    applicationName: "opensteer-cross-environment-delegation-integration-test",
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 4,
  });
  const store = new OpensteerStore(database);
  const acceptanceEvidence: Record<string, unknown>[] = [];
  const claimsByToken = new Map<string, AgentControlRunScope>();
  const commands = new CommandService({
    admission: new KeyedAdmissionQueue({
      maxInFlight: 4,
      maxQueuedBytes: 4_000_000,
      maxQueuedCommands: 64,
    }),
    onExecutionQueued: vi.fn(),
    onWorkspaceEvent: vi.fn(),
    store,
  });
  const assertDelegatedPlaces = vi.fn(async () => undefined);
  const service = new AgentControlService({
    placeContext: { assertDelegated: assertDelegatedPlaces },
    browserSources: {
      agentSignIn: async () => {
        throw new Error("Unexpected browser sign-in");
      },
    },
    machineFullDiskAccess: {
      request: async () => {
        throw new Error("Unexpected full access request");
      },
    },
    browser: {
      createProfile: unexpected,
      profileSiteData: unexpected,
      closeAgentSession: unexpected,
      listAgentSessions: unexpected,
      listGrantedProfiles: unexpected,
      openAgentSession: unexpected,
      requestAccess: unexpected,
      requestSaveProfile: unexpected,
    },
    canRunHarness: () => true,
    commands,
    isEnvironmentConnected: () => true,
    onWorkspaceEvent: vi.fn(),
    store,
    tokens: {
      authenticate: async (token: string) => {
        const claims = claimsByToken.get(token);
        if (!claims) throw new Error(`No test claims for ${token}`);
        return claims;
      },
    } as unknown as AgentControlTokenService,
    defaultWorkspaceBacking: "portablefs",
    environmentWorkspaceBackings: () => ["portablefs"],
    workspaceMounts: { mount: unexpected },
    workspaces: { create: unexpected },
  });

  beforeAll(async () => {
    await migrateToLatest(database);
  });

  beforeEach(async (context) => {
    context.onTestFailed(async ({ task }) => {
      const evidencePath = process.env.OPENSTEER_HOME_ACCEPTANCE_EVIDENCE;
      if (evidencePath)
        await writeFile(
          `${evidencePath}.failure.json`,
          JSON.stringify(
            { test: task.name, errors: task.result?.errors, cases: acceptanceEvidence },
            null,
            2,
          ),
        );
    });
    claimsByToken.clear();
    await sql`
      truncate table
        workspace_events,
        agent_control_requests,
        commands,
        thread_inputs,
        causal_chains,
        delegations,
        messages,
        runs,
        threads,
        harness_catalogs,
        harness_instances,
        workspaces,
        execution_environments,
        runners,
        deployments,
        users
      restart identity cascade
    `.execute(database);
    await sql`
      insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing
    `.execute(database);
  });

  afterEach(async () => {
    const evidencePath = process.env.OPENSTEER_HOME_ACCEPTANCE_EVIDENCE;
    if (evidencePath)
      await writeFile(
        evidencePath,
        JSON.stringify(
          { recordedAt: new Date().toISOString(), cases: acceptanceEvidence },
          null,
          2,
        ),
      );
  });

  afterAll(async () => {
    const evidencePath = process.env.OPENSTEER_HOME_ACCEPTANCE_EVIDENCE;
    if (evidencePath) {
      await writeFile(
        evidencePath,
        `${JSON.stringify({ recordedAt: new Date().toISOString(), cases: acceptanceEvidence }, null, 2)}\n`,
      );
    }
    await database.destroy();
  });

  it("dispatches the delegated Run on the lent machine's own AI engine", async () => {
    const fixture = await createFixture();

    const response = await service.handle(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      requestId: randomUUID(),
      task: "Build the release on the lent Mac",
      title: "Lent build",
      type: "thread.delegate",
      workspaceId: fixture.workspaceId,
    });
    if (response.type !== "thread.delegate.result") throw new Error("Expected a delegate result");

    // The child is placed on the lent machine and on that machine's own engine.
    expect(response.result.assignmentId).toMatch(/^dlg_/u);
    expect(response.result.thread.role).toBe("work");
    expect(response.result.thread.modelSelection).toEqual(testModelSelection);
    expect(response.result.thread.environmentId).toBe(fixture.lentEnvironmentId);
    expect(response.result.thread.harnessInstanceId).toBe(fixture.lentHarnessInstanceId);
    expect(response.result.thread.harnessInstanceId).not.toBe(fixture.mainHarnessInstanceId);
    expect(response.result.run?.environmentId).toBe(fixture.lentEnvironmentId);

    const childRunId = response.result.run?.id;
    if (!childRunId) throw new Error("Expected the delegation to queue a Run");
    const pending = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", childRunId)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    const claimed = await store.claimCommand(pending.id, "delegation-dispatcher");
    if (!claimed) throw new Error("Expected the child Run command to be claimable");

    const dispatched: RunnerCommand[] = [];
    const dispatcher = makeDispatcher(fixture.lentRunnerId, dispatched);

    await dispatcher.dispatch(claimed.command, new AbortController().signal);

    const [runnerCommand] = dispatched;
    expect(runnerCommand).toMatchObject({
      environmentId: fixture.lentEnvironmentId,
      type: "run.execute",
    });
    expect(runnerCommand?.type === "run.execute" && runnerCommand.context.harnessInstanceId).toBe(
      fixture.lentHarnessInstanceId,
    );
  });

  it("shares a delegation admission while the accepted attempt waits before PostgreSQL commit", async () => {
    const fixture = await createFixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforeCommit = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = store.delegateAdmittedThread.bind(store);
    const probe = vi.spyOn(store, "delegateAdmittedThread").mockImplementation(async (input) => {
      entered();
      await gate;
      return original(input);
    });
    assertDelegatedPlaces.mockClear();
    assertDelegatedPlaces
      .mockImplementationOnce(async () => undefined)
      .mockImplementation(async () => {
        throw new Error("Target is now blocked");
      });
    const request = {
      type: "thread.delegate",
      requestId: randomUUID(),
      workspaceId: fixture.workspaceId,
      task: "Forward this place once",
      places: [
        { type: "phone", machineId: fixture.lentRunnerId, display: "main", name: "Fixture phone" },
      ],
    };
    const first = service.handle(fixture.token, request);
    await beforeCommit;
    let settled = false;
    const second = service.handle(fixture.token, request).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    expect(assertDelegatedPlaces).toHaveBeenCalledTimes(1);
    release();
    const accepted = await Promise.all([first, second]);
    probe.mockRestore();
    assertDelegatedPlaces.mockImplementation(async () => undefined);
    if (
      accepted[0].type !== "thread.delegate.result" ||
      accepted[1].type !== "thread.delegate.result"
    )
      throw new Error("Wrong delegation response");
    expect(accepted[0].result.message.id).toBe(accepted[1].result.message.id);
    expect(accepted[0].result.assignmentId).toBe(accepted[1].result.assignmentId);
    expect(await service.handle(fixture.token, request)).toMatchObject({
      type: "thread.delegate.result",
      result: {
        message: { id: accepted[0].result.message.id },
        assignmentId: accepted[0].result.assignmentId,
      },
    });
    acceptanceEvidence.push({
      caseId: "same-key-delegation-before-commit",
      accepted,
      retryWaited: true,
      blockedRetryPreflightPrevented: true,
    });
  });

  it("requires the native capability for a later text-only send whose history contains native places", async () => {
    const fixture = await createFixture();
    const native = {
      type: "computer-app",
      machineId: fixture.lentRunnerId,
      app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
      name: "Lent Mac",
    } as const;
    const first = await commands.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.lentEnvironmentId,
      harnessInstanceId: fixture.lentHarnessInstanceId,
      idempotencyKey: "native-history-first",
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: fixture.parent.runId,
        parentThreadId: fixture.parentThreadId,
      },
      task: [native],
      title: "Native history",
      workspaceId: fixture.workspaceId,
    });
    const worker = await activateRun(fixture, first.run.id);
    await end(worker, "completed");
    const later = await commands.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: first.thread.id,
      content: [{ type: "text", text: "Continue with text only" }],
      policy: "queue",
      source: { kind: "human" },
      idempotencyKey: "native-history-text-only",
    });
    if (!later.command) throw new Error("Missing text-only dispatch");
    const claimed = await store.claimCommand(later.command.id, "native-history-dispatcher");
    if (!claimed) throw new Error("Missing text-only command claim");
    const sent: RunnerCommand[] = [];
    await expect(
      makeDispatcher(fixture.lentRunnerId, sent, false).dispatch(
        claimed.command,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Update this Runner");
    expect(sent).toEqual([]);
    await makeDispatcher(fixture.lentRunnerId, sent).dispatch(
      claimed.command,
      new AbortController().signal,
    );
    const execution = sent.find((command) => command.type === "run.execute");
    if (!execution || execution.type !== "run.execute")
      throw new Error("Missing current Runner dispatch");
    expect(
      execution.inputs.every((input) => input.content.every((part) => part.type === "text")),
    ).toBe(true);
    expect(execution.context.history.flatMap((message) => message.content)).toContainEqual(native);
    acceptanceEvidence.push({
      caseId: "native-history-text-only-negotiation",
      olderRunnerDispatched: 0,
      current: execution,
    });
  });

  it("keeps native references through the inbox and refuses an older Runner before dispatch", async () => {
    const fixture = await createFixture();
    const native = [
      {
        type: "computer-app",
        machineId: fixture.lentRunnerId,
        app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
        name: "Lent Mac",
      },
      { type: "phone", machineId: fixture.lentRunnerId, display: "main", name: "Fixture phone" },
    ] as const;
    const child = await commands.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.lentEnvironmentId,
      harnessInstanceId: fixture.lentHarnessInstanceId,
      idempotencyKey: "native-reference-dispatch",
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: fixture.parent.runId,
        parentThreadId: fixture.parentThreadId,
      },
      task: [{ type: "text", text: "Inspect the included places" }, ...native],
      title: "Inspect places",
      workspaceId: fixture.workspaceId,
    });
    const pending = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", child.run.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    const claimed = await store.claimCommand(pending.id, "native-dispatcher");
    if (!claimed) throw new Error("Expected native Run dispatch");
    const sent: RunnerCommand[] = [];
    await expect(
      makeDispatcher(fixture.lentRunnerId, sent, false).dispatch(
        claimed.command,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Update this Runner");
    expect(sent).toEqual([]);
    await makeDispatcher(fixture.lentRunnerId, sent).dispatch(
      claimed.command,
      new AbortController().signal,
    );
    const command = sent.find((entry) => entry.type === "run.execute");
    if (!command || command.type !== "run.execute") throw new Error("No native input dispatched");
    expect(command.inputs.flatMap((input) => input.content)).toEqual(
      expect.arrayContaining([...native]),
    );
    const projected = command.inputs.map((input) => resolvedInputParts(input, undefined).body);
    expect(projected.join("\n")).toContain("com.apple.Notes");
    expect(projected.join("\n")).toContain('display "main"');
    acceptanceEvidence.push({
      caseId: "native-place-negotiation",
      submitted: native,
      runnerInputs: command.inputs,
      projected,
      olderRunnerDispatched: 0,
    });
  });

  it("reports an unavailable catalog separately from a ready no-match result", async () => {
    const fixture = await createFixture();
    await store.recordHarnessCatalogs({
      environmentId: fixture.mainEnvironmentId,
      expectedRevisions: new Map([[fixture.mainHarnessInstanceId, 1]]),
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          driverKind: nativeDriver,
          harnessInstanceId: fixture.mainHarnessInstanceId,
          status: "authentication-required",
          models: [],
          detail: "Reconnect this account",
        }),
      ],
    });
    const mcp = await startDiscoveryMcp(fixture.token);
    try {
      const result = await mcp.client.callTool({
        name: "environment_list",
        arguments: { harnessInstanceId: fixture.mainHarnessInstanceId, query: "sol" },
      });
      expect(result.isError).not.toBe(true);
      const page = EnvironmentDiscoverySchema.parse(result.structuredContent);
      expect(page.harnesses[0]).toMatchObject({
        status: "authentication-required",
        detail: "Reconnect this account",
        models: [],
        modelsOmitted: 0,
      });
      acceptanceEvidence.push({ caseId: "unready-catalog", page });
    } finally {
      await mcp.client.close();
      await mcp.service.close();
      await new Promise<void>((resolve) => mcp.server.close(() => resolve()));
    }
  });

  it("bounds option payloads while retaining every allowed value across focused pages", async () => {
    const fixture = await createFixture();
    const base = readyCatalog(fixture.mainHarnessInstanceId, nativeDriver);
    if (base.status !== "ready") throw new Error("Expected ready catalog");
    const options = Array.from({ length: 16 }, (_, index) => ({
      id: `option-${index}`,
      label: `Option ${index}`,
      type: "select",
      values: Array.from({ length: 32 }, (_, value) => ({
        label: `Value ${value}`,
        value: `${value}`.padEnd(255, "x"),
      })),
    }));
    await store.recordHarnessCatalogs({
      environmentId: fixture.mainEnvironmentId,
      expectedRevisions: new Map([[fixture.mainHarnessInstanceId, 1]]),
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          ...base,
          models: Array.from({ length: 4 }, (_, index) => ({
            ...base.models[0]!,
            modelId: `large-${index}`,
            options,
          })),
        }),
      ],
    });
    const mcp = await startDiscoveryMcp(fixture.token);
    try {
      let cursor: string | undefined;
      const seen: string[] = [];
      const bytes: number[] = [];
      do {
        const result = await mcp.client.callTool({
          name: "environment_list",
          arguments: {
            harnessInstanceId: fixture.mainHarnessInstanceId,
            ...(cursor ? { cursor } : {}),
          },
        });
        expect(result.isError).not.toBe(true);
        const page = EnvironmentDiscoverySchema.parse(result.structuredContent);
        const size = Buffer.byteLength(JSON.stringify(page));
        expect(size).toBeLessThan(432 * 1_024);
        bytes.push(size);
        const engine = page.harnesses[0]!;
        expect(engine.models.length).toBeGreaterThan(0);
        for (const model of engine.models) {
          expect(model.options).toEqual(
            options.map((option) => ({
              id: option.id,
              values: option.values.map(({ value }) => value),
            })),
          );
          seen.push(model.modelId);
        }
        cursor = engine.modelsNextCursor;
      } while (cursor);
      expect(seen).toEqual(["large-0", "large-1", "large-2", "large-3"]);
      acceptanceEvidence.push({ caseId: "bounded-model-option-pages", seen, bytes });
    } finally {
      await mcp.client.close();
      await mcp.service.close();
      await new Promise<void>((resolve) => mcp.server.close(() => resolve()));
    }
  });

  it("Workspace and delegated agents discover Sol by name and delegate typed model options through MCP", async () => {
    const fixture = await createFixture({ specialized: true });
    const base = readyCatalog(fixture.mainHarnessInstanceId, nativeDriver);
    if (base.status !== "ready") throw new Error("Expected ready catalog");
    const selected = {
      ...base.models[0]!,
      options: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          defaultValue: "max",
          values: [
            { label: "Low", value: "low" },
            { label: "Max", value: "max" },
          ],
        },
        { id: "thinking", label: "Thinking", type: "toggle", defaultValue: false },
      ],
    };
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          ...base,
          models: [
            ...Array.from({ length: 12 }, (_, index) => ({
              ...base.models[1]!,
              modelId: `other-${index}`,
              displayName: `Other ${index}`,
            })),
            selected,
          ],
        }),
      ],
      environmentId: fixture.mainEnvironmentId,
      expectedRevisions: new Map([[fixture.mainHarnessInstanceId, 1]]),
    });
    let caller = fixture.parent;
    for (const profile of ["workspace", "delegated"] as const) {
      const mcp = await startDiscoveryMcp(caller.token);
      try {
        expect(claimsByToken.get(caller.token)?.capabilityProfileId).toBe(profile);
        const listed = await mcp.client.listTools();
        expect(listed.tools.map(({ name }) => name)).toContain("environment_list");
        expect(listed.tools.map(({ name }) => name)).not.toContain("workspace_list");
        const accounts = EnvironmentDiscoverySchema.parse(
          (
            await mcp.client.callTool({
              name: "environment_list",
              arguments: { query: "sol OPENAI" },
            })
          ).structuredContent,
        );
        expect(
          accounts.harnesses
            .filter(({ models }) =>
              models.some(({ modelId }) => modelId === testModelSelection.modelId),
            )
            .map(({ id }) => id)
            .sort(),
        ).toEqual([fixture.mainHarnessInstanceId, fixture.lentHarnessInstanceId].sort());
        const workspacePages = vi.spyOn(store, "workspacePageForOwner");
        const threadPages = vi.spyOn(store, "ownerThreadPageForOwner");
        let discovery: Awaited<ReturnType<typeof mcp.client.callTool>>;
        try {
          discovery = await mcp.client.callTool({
            name: "environment_list",
            arguments: { query: "sol OPENAI", harnessInstanceId: fixture.mainHarnessInstanceId },
          });
          expect(workspacePages).not.toHaveBeenCalled();
          expect(threadPages).not.toHaveBeenCalled();
        } finally {
          workspacePages.mockRestore();
          threadPages.mockRestore();
        }
        expect(discovery.isError).not.toBe(true);
        const page = EnvironmentDiscoverySchema.parse(discovery.structuredContent);
        const engine = page.harnesses[0]!;
        const model = engine.models[0]!;
        expect(model.modelId).toBe(testModelSelection.modelId);
        expect(model.options).toEqual([
          { id: "effort", values: ["low", "max"], default: "max" },
          { id: "thinking", values: [false, true], default: false },
        ]);
        const choice = {
          modelId: model.modelId,
          providerId: model.providerId,
          options: { effort: "max", thinking: false },
        };
        const delegated = await mcp.client.callTool({
          name: "thread_delegate",
          arguments: {
            workspaceId: fixture.workspaceId,
            task: "Have Sol review this",
            harnessInstanceId: engine.id,
            model: choice,
          },
        });
        expect(delegated.isError).not.toBe(true);
        const result = AgentControlResponseSchema.parse({
          requestId: randomUUID(),
          type: "thread.delegate.result",
          result: delegated.structuredContent,
        });
        if (result.type !== "thread.delegate.result" || !result.result.run)
          throw new Error("Expected delegated Run");
        expect(result.result.thread.modelSelection).toMatchObject(choice);
        expect(
          (await store.getThreadForOwner(result.result.thread.id, fixture.userId))?.modelSelection,
        ).toMatchObject(choice);
        acceptanceEvidence.push({
          caseId: `${profile}-named-model-options`,
          inventory: listed.tools,
          discovery: page,
          choice,
          resultingThread: result.result.thread,
        });
        caller = await activateRun(fixture, result.result.run.id);
      } finally {
        await mcp.client.close();
        await mcp.service.close();
        await new Promise<void>((resolve) => mcp.server.close(() => resolve()));
      }
    }
  });

  it.each([true, false])(
    "discovers every authorized profile and model through MCP (legacy: %s)",
    async (legacy) => {
      const fixture = await createFixture();
      const extraEnvironments = Array.from({ length: 70 }, () => createId("environment")).sort();
      const extraHarnesses = extraEnvironments.map(() => createId("harnessInstance")).sort();
      await database
        .insertInto("executionEnvironments")
        .values(
          extraEnvironments.map((id, index) => ({
            capabilities: sql`'["filesystem"]'::jsonb`,
            id,
            kind: "local" as const,
            name: `Extra machine ${index}`,
            runnerId: fixture.lentRunnerId,
          })),
        )
        .execute();
      await database
        .insertInto("harnessInstances")
        .values(
          extraHarnesses.map((id, index) => ({
            config: {},
            driverKind: nativeDriver,
            enabled: true,
            environmentId: extraEnvironments[index]!,
            id,
            isDefault: false,
            name: `Extra engine ${index}`,
            runtimeRevision: 1,
            sourceId: "native",
            stateKind: "isolated" as const,
          })),
        )
        .execute();
      const targetId = extraHarnesses[69]!;
      const targetEnvironmentId = extraEnvironments[69]!;
      const base = readyCatalog(targetId, nativeDriver);
      if (base.status !== "ready") throw new Error("Expected a ready catalog");
      const catalog = {
        ...base,
        models: Array.from({ length: 111 }, (_, index) => ({
          displayName: `Catalog model ${index}`,
          isDefault: index === 0,
          modelId: `catalog-model-${String(index).padStart(3, "0")}`,
          options: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              defaultValue: "max",
              values: [{ label: "Max", value: "max" }],
            },
            { id: "thinking", label: "Thinking", type: "toggle", defaultValue: false },
          ],
          providerId: "openai",
        })),
      };
      await store.recordHarnessCatalogs({
        catalogs: [HarnessInstanceCatalogSchema.parse(catalog)],
        environmentId: targetEnvironmentId,
        expectedRevisions: new Map([[targetId, 1]]),
      });
      const otherCatalogIds = extraHarnesses.slice(0, 6);
      for (const [index, id] of otherCatalogIds.entries()) {
        const baseCatalog = readyCatalog(id, nativeDriver);
        if (baseCatalog.status !== "ready") throw new Error("Expected a ready catalog");
        await store.recordHarnessCatalogs({
          catalogs: [
            HarnessInstanceCatalogSchema.parse({
              ...baseCatalog,
              models: Array.from({ length: 30 }, (_, model) => ({
                displayName: `Other ${index} model ${model}`,
                isDefault: model === 0,
                modelId: `other-${index}-${model}`,
                options: [],
                providerId: "openai",
              })),
            }),
          ],
          environmentId: extraEnvironments[index]!,
          expectedRevisions: new Map([[id, 1]]),
        });
      }
      const privateUser = await store.createUser("Private owner");
      const privateEnvironmentId = createId("environment");
      const privateRunnerId = createId("runner");
      await enrollRunner({
        createdBy: privateUser,
        driverKind: nativeDriver,
        environmentId: privateEnvironmentId,
        name: "Private machine",
        runnerId: privateRunnerId,
        runnerKind: "local",
      });
      const privateHarness = await store.createHarnessInstance({
        config: {},
        driverKind: nativeDriver,
        environmentId: privateEnvironmentId,
        name: "Private engine",
        sourceId: "native",
        stateKind: "isolated",
      });
      const revokedEnvironmentId = createId("environment");
      const revokedRunnerId = createId("runner");
      await enrollRunner({
        createdBy: fixture.userId,
        driverKind: nativeDriver,
        environmentId: revokedEnvironmentId,
        name: "Revoked machine",
        runnerId: revokedRunnerId,
        runnerKind: "local",
      });
      const revokedHarness = await store.createHarnessInstance({
        config: {},
        driverKind: nativeDriver,
        environmentId: revokedEnvironmentId,
        name: "Revoked engine",
        sourceId: "native",
        stateKind: "isolated",
      });
      await database
        .updateTable("runners")
        .set({ revokedAt: new Date() })
        .where("id", "=", revokedRunnerId)
        .execute();
      const disabledId = extraHarnesses[68]!;
      await database
        .updateTable("harnessInstances")
        .set({ enabled: false })
        .where("id", "=", disabledId)
        .execute();

      const mcp = await startDiscoveryMcp(fixture.token, legacy);
      const discoveryClient = {
        callTool: (call: { arguments: Record<string, unknown>; name: string }) => {
          const { modelPage, ...rest } = call.arguments;
          return mcp.client.callTool({
            name: legacy ? "workspace_list" : "environment_list",
            arguments: legacy
              ? call.arguments
              : { ...rest, ...(modelPage as Record<string, unknown> | undefined) },
          });
        },
      };
      try {
        const seen = new Map<
          string,
          { environmentId: string; models: readonly { modelId: string }[]; modelsOmitted: number }
        >();
        let harnessCursor: string | undefined;
        for (;;) {
          const result = await discoveryClient.callTool({
            arguments: harnessCursor ? { harnessCursor } : {},
            name: "workspace_list",
          });
          if (result.isError) throw new Error(JSON.stringify(result.content));
          const page = result.structuredContent as {
            delegationDefault: {
              environmentId: string;
              harnessInstanceId: string;
              model: { modelId: string; providerId: string };
            };
            environmentsTruncated: boolean;
            harnesses: {
              id: string;
              environmentId: string;
              models: { modelId: string }[];
              modelsOmitted: number;
            }[];
            harnessesNextCursor?: string;
          };
          expect(page.delegationDefault).toMatchObject({
            environmentId: fixture.mainEnvironmentId,
            harnessInstanceId: fixture.mainHarnessInstanceId,
            model: {
              modelId: testModelSelection.modelId,
              providerId: testModelSelection.providerId,
            },
          });
          if (!harnessCursor) expect(page.harnesses.map(({ id }) => id)).not.toContain(targetId);
          expect(page.harnesses.every(({ models }) => models.length <= (legacy ? 20 : 8))).toBe(
            true,
          );
          expect(
            page.harnesses.reduce((count, { models }) => count + models.length, 0),
          ).toBeLessThanOrEqual(legacy ? 100 : 40);
          for (const harness of page.harnesses) seen.set(harness.id, harness);
          harnessCursor = page.harnessesNextCursor;
          if (!harnessCursor) break;
        }
        expect(seen.size).toBe(legacy ? 71 : 72);
        expect(seen.get(targetId)?.environmentId).toBe(targetEnvironmentId);
        expect(seen.has(disabledId)).toBe(!legacy);
        expect(seen.has(privateHarness.id)).toBe(false);
        expect(seen.has(revokedHarness.id)).toBe(false);
        if (!legacy) {
          const environmentIds = new Set<string>();
          let environmentCursor: string | undefined;
          do {
            const result = await discoveryClient.callTool({
              name: "environment_list",
              arguments: environmentCursor ? { environmentCursor } : {},
            });
            expect(result.isError).not.toBe(true);
            const page = result.structuredContent as {
              environments: { id: string }[];
              environmentsNextCursor?: string;
            };
            if (!environmentCursor)
              expect(page.environments.map(({ id }) => id)).not.toContain(targetEnvironmentId);
            page.environments.forEach(({ id }) => environmentIds.add(id));
            environmentCursor = page.environmentsNextCursor;
          } while (environmentCursor);
          expect(environmentIds.size).toBe(72);
          const found = await discoveryClient.callTool({
            name: "environment_list",
            arguments: { harnessInstanceId: targetId, query: "OPENAI catalog 110" },
          });
          expect(found.isError).not.toBe(true);
          const foundPage = found.structuredContent as {
            environments: { id: string }[];
            harnesses: {
              status: string;
              models: { modelId: string; options: unknown[] }[];
              modelsOmitted: number;
            }[];
          };
          expect(foundPage.environments.map(({ id }) => id)).toEqual([targetEnvironmentId]);
          expect(foundPage.harnesses[0]).toMatchObject({
            status: "ready",
            modelsOmitted: 0,
            models: [
              {
                modelId: "catalog-model-110",
                options: [
                  { id: "effort", values: ["max"], default: "max" },
                  { id: "thinking", values: [false, true], default: false },
                ],
              },
            ],
          });
          const none = await discoveryClient.callTool({
            name: "environment_list",
            arguments: { harnessInstanceId: targetId, query: "nothing matches this" },
          });
          expect(none.structuredContent).toMatchObject({
            harnesses: [{ status: "ready", models: [], modelsOmitted: 0 }],
          });
          const first = await discoveryClient.callTool({
            name: "environment_list",
            arguments: { harnessInstanceId: targetId },
          });
          const cursor = (first.structuredContent as { harnesses: { modelsNextCursor: string }[] })
            .harnesses[0]!.modelsNextCursor;
          for (const args of [{ cursor }, { harnessInstanceId: targetId, cursor, query: "110" }]) {
            expect(
              (await discoveryClient.callTool({ name: "environment_list", arguments: args }))
                .isError,
            ).toBe(true);
          }
          const workspaces = await mcp.client.callTool({ name: "workspace_list", arguments: {} });
          expect(workspaces.isError, JSON.stringify(workspaces.content)).not.toBe(true);
          expect(Object.keys(workspaces.structuredContent ?? {}).sort()).toEqual([
            "window",
            "workspaces",
          ]);
          acceptanceEvidence.push({
            caseId: "environment-discovery-v3",
            environments: [...environmentIds],
            found: found.structuredContent,
            none: none.structuredContent,
            workspaces: workspaces.structuredContent,
          });
        }
        const starvedId = otherCatalogIds.find((id) => {
          const summary = seen.get(id);
          return summary && summary.models.length === 0 && summary.modelsOmitted === 30;
        });
        expect(starvedId).toBeDefined();
        if (!starvedId) throw new Error("Expected one profile past the broad model budget");
        const recovered = new Set<string>();
        let recoveredCursor: string | undefined;
        for (;;) {
          const focused = await discoveryClient.callTool({
            arguments: {
              modelPage: {
                harnessInstanceId: starvedId,
                ...(recoveredCursor ? { cursor: recoveredCursor } : {}),
              },
            },
            name: "workspace_list",
          });
          if (focused.isError) throw new Error(JSON.stringify(focused.content));
          const page = focused.structuredContent as {
            harnesses: { models: { modelId: string }[]; modelsNextCursor?: string }[];
          };
          for (const model of page.harnesses[0]!.models) recovered.add(model.modelId);
          recoveredCursor = page.harnesses[0]!.modelsNextCursor;
          if (!recoveredCursor) break;
        }
        expect(recovered.size).toBe(30);
        const discovered = new Set<string>();
        let modelCursor: string | undefined;
        let staleCursor: string | undefined;
        let repeatedCatalog = false;
        for (;;) {
          const result = await discoveryClient.callTool({
            arguments: {
              modelPage: {
                harnessInstanceId: targetId,
                ...(modelCursor ? { cursor: modelCursor } : {}),
              },
            },
            name: "workspace_list",
          });
          if (result.isError) throw new Error(JSON.stringify(result.content));
          const page = result.structuredContent as {
            harnesses: { models: { modelId: string }[]; modelsNextCursor?: string }[];
          };
          for (const model of page.harnesses[0]!.models) discovered.add(model.modelId);
          modelCursor = page.harnesses[0]!.modelsNextCursor;
          staleCursor ??= modelCursor;
          if (modelCursor && !repeatedCatalog) {
            await store.recordHarnessCatalogs({
              catalogs: [HarnessInstanceCatalogSchema.parse(catalog)],
              environmentId: targetEnvironmentId,
              expectedRevisions: new Map([[targetId, 1]]),
            });
            repeatedCatalog = true;
          }
          if (!modelCursor) break;
        }
        expect(discovered.size).toBe(111);
        expect(discovered.has("catalog-model-110")).toBe(true);
        if (!staleCursor) throw new Error("Expected a second model page");
        expect(
          (
            await discoveryClient.callTool({
              arguments: { modelPage: { harnessInstanceId: privateHarness.id } },
              name: "workspace_list",
            })
          ).isError,
        ).toBe(true);
        expect(
          (
            await discoveryClient.callTool({
              arguments: { modelPage: { harnessInstanceId: revokedHarness.id } },
              name: "workspace_list",
            })
          ).isError,
        ).toBe(true);
        expect(
          (
            await discoveryClient.callTool({
              arguments: { modelPage: { harnessInstanceId: disabledId } },
              name: "workspace_list",
            })
          ).isError,
        ).toBe(legacy ? true : undefined);
        expect(
          (
            await discoveryClient.callTool({
              arguments: {
                modelPage: {
                  harnessInstanceId: fixture.mainHarnessInstanceId,
                  cursor: staleCursor,
                },
              },
              name: "workspace_list",
            })
          ).isError,
        ).toBe(true);
        expect(
          (
            await discoveryClient.callTool({
              arguments: { modelPage: { harnessInstanceId: targetId, cursor: "garbage" } },
              name: "workspace_list",
            })
          ).isError,
        ).toBe(true);
        await store.recordHarnessCatalogs({
          catalogs: [
            HarnessInstanceCatalogSchema.parse({
              ...catalog,
              models: catalog.models.slice(0, 110),
            }),
          ],
          environmentId: targetEnvironmentId,
          expectedRevisions: new Map([[targetId, 1]]),
        });
        expect(
          (
            await discoveryClient.callTool({
              arguments: { modelPage: { harnessInstanceId: targetId, cursor: staleCursor } },
              name: "workspace_list",
            })
          ).isError,
        ).toBe(true);
        acceptanceEvidence.push({
          caseId: legacy ? "model-discovery-legacy" : "model-discovery-current",
          profiles: seen.size,
          models: discovered.size,
          targetEnvironmentId,
        });
      } finally {
        await mcp.client.close();
        await mcp.service.close();
        await new Promise<void>((resolve) => mcp.server.close(() => resolve()));
      }
    },
    60_000,
  );

  it("fails the delegation by name when the lent machine has no engine of that driver", async () => {
    const fixture = await createFixture({ lentDriverKind: HarnessIdSchema.parse("codex") });

    await expect(
      service.handle(fixture.token, {
        environmentId: fixture.lentEnvironmentId,
        requestId: randomUUID(),
        task: "Build the release on the lent Mac",
        type: "thread.delegate",
        workspaceId: fixture.workspaceId,
      }),
    ).rejects.toThrow(
      /Lent Mac has no enabled native AI engine on native\. Name another engine with harnessInstanceId/u,
    );
    await expect(
      database
        .selectFrom("delegations")
        .select("childThreadId")
        .where("origin", "=", "run")
        .execute(),
    ).resolves.toEqual([]);
  });

  it("creates one durable assignment when a delegate request is retried", async () => {
    const fixture = await createFixture();
    const request = {
      environmentId: fixture.lentEnvironmentId,
      requestId: randomUUID(),
      task: "Research the mattress choices and report with sources",
      title: "Mattress research",
      type: "thread.delegate" as const,
      workspaceId: fixture.workspaceId,
    };

    const first = await service.handle(fixture.token, request);
    const replay = await service.handle(fixture.token, request);
    if (first.type !== "thread.delegate.result" || replay.type !== "thread.delegate.result") {
      throw new Error("Expected a delegate result");
    }
    expect(replay.result.assignmentId).toBe(first.result.assignmentId);
    expect(replay.result.thread.id).toBe(first.result.thread.id);
    expect(replay.result.run?.id).toBe(first.result.run?.id);
    await expect(
      database.selectFrom("delegations").select("id").where("origin", "=", "run").execute(),
    ).resolves.toHaveLength(1);
    acceptanceEvidence.push({
      caseId: "H02",
      assignmentId: first.result.assignmentId,
      workerThreadId: first.result.thread.id,
      initialRunId: first.result.run?.id,
      replayAssignmentId: replay.result.assignmentId,
    });
  });

  it("completes with the finishing Run's own final reply and returns it exactly once", async () => {
    const fixture = await createFixture();
    const task = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Compare mattresses using cited sources",
      title: "Mattress comparison",
      workspaceId: fixture.workspaceId,
    });
    const worker = await activateRun(fixture, task.run!.id);
    await reply(worker, "Preliminary note that must not become the result");
    const finalReply =
      "Final result: Helix for side sleepers; Saatva for a traditional spring feel.";
    await reply(worker, finalReply);
    const terminal = await end(worker, "completed");
    const replayed = await store.commitRunnerEvent(terminal.commit);
    expect(replayed).toMatchObject({ compensatingEvents: [], wasDuplicate: true });

    expect(await assignmentRow(task.assignmentId)).toMatchObject({
      resultRunId: worker.runId,
      resultStatus: "pending",
      resultText: finalReply,
      status: "completed",
    });
    // The immediate delivery and the periodic reconcile race; one return lands.
    const deliveries = await Promise.all([
      store.drainAssignmentReturn(task.assignmentId),
      store.drainPendingAssignmentReturns(),
      store.drainAssignmentReturn(task.assignmentId),
    ]);
    expect(deliveries[1].failures).toEqual([]);
    await expect(store.drainPendingAssignmentReturns()).resolves.toEqual({
      events: [],
      failures: [],
    });
    const returned = await returnMessages(fixture.parentThreadId);
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({
      author: { cause: "assignment-result", kind: "platform", referenceId: task.assignmentId },
      kind: "continuation",
    });
    expect(messageText(returned[0]!.content)).toBe(
      `Task completed: Mattress comparison\nTask Thread: ${task.thread.id} · Assignment: ${task.assignmentId}\n\n${finalReply}`,
    );
    // The parent is still mid-turn, so the result waits as its next work item.
    const returnInput = await database
      .selectFrom("threadInputs")
      .select(["assignmentId", "policy", "state"])
      .where("messageId", "=", returned[0]!.id)
      .executeTakeFirstOrThrow();
    expect(returnInput).toEqual({ assignmentId: null, policy: "queue", state: "pending" });

    // Later work in the task Thread is unbound and never rewrites the result.
    const later = await commands.enqueueThreadInput({
      content: [{ text: "One more question about firmness", type: "text" }],
      idempotencyKey: `later-${randomUUID()}`,
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: task.thread.id,
    });
    expect(later.input.assignmentId).toBeNull();
    expect(later.run?.assignmentId).toBeNull();
    const laterWorker = await activateRun(fixture, later.run!.id);
    await reply(laterWorker, "A later reply that belongs to no task");
    await end(laterWorker, "completed");
    expect(await assignmentRow(task.assignmentId)).toMatchObject({
      resultRunId: worker.runId,
      resultText: finalReply,
    });
    acceptanceEvidence.push({
      caseId: "L01+L11+L23",
      assignmentId: task.assignmentId,
      resultRunId: worker.runId,
      resultText: finalReply,
      returnMessageCount: returned.length,
      replayedTerminalEventWasDuplicate: replayed.wasDuplicate,
      laterUnboundRunId: laterWorker.runId,
    });
  });

  it("says plainly when a task ended without a reply or its reply is too long", async () => {
    const fixture = await createFixture();
    const silent = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Tidy the notes quietly",
      workspaceId: fixture.workspaceId,
    });
    const silentWorker = await activateRun(fixture, silent.run!.id);
    await end(silentWorker, "completed");
    expect((await assignmentRow(silent.assignmentId)).resultText).toBe(
      "The task ended without a written reply.",
    );

    const verbose = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Write everything down",
      workspaceId: fixture.workspaceId,
    });
    const verboseWorker = await activateRun(fixture, verbose.run!.id);
    const note = "\n\n[Reply truncated. The full reply is in the task Thread.]";
    const budget = assignmentResultMaxBytes - Buffer.byteLength(note, "utf8");
    // The cut falls inside a four-byte character, which must not be split.
    await reply(verboseWorker, `${"x".repeat(budget - 1)}🙂${"y".repeat(4_096)}`);
    await end(verboseWorker, "completed");
    const truncated = (await assignmentRow(verbose.assignmentId)).resultText ?? "";
    expect(truncated).toBe(`${"x".repeat(budget - 1)}${note}`);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(assignmentResultMaxBytes);
    acceptanceEvidence.push({
      caseId: "L02+L03",
      silentAssignmentId: silent.assignmentId,
      truncatedAssignmentId: verbose.assignmentId,
      truncatedResultBytes: Buffer.byteLength(truncated, "utf8"),
    });
  });

  it("stays open across durable Requests and completes with the continuation Run's reply", async () => {
    const fixture = await createFixture();
    const task = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Verify the retailer's return policy",
      workspaceId: fixture.workspaceId,
    });
    const first = await activateRun(fixture, task.run!.id);
    const firstRequest = await openDurableRequest(fixture, first);
    expect(await store.drainPendingThreadStates()).toContainEqual(
      expect.objectContaining({
        data: {
          assignment: expect.objectContaining({
            id: task.assignmentId,
            workerThread: expect.objectContaining({ pendingRequests: 1 }),
          }),
        },
        threadId: task.thread.id,
        type: "assignment.updated",
      }),
    );
    await reply(first, "I asked for file access and will continue once it is answered.");
    await end(first, "completed");
    expect(await assignmentRow(task.assignmentId)).toMatchObject({
      resultStatus: "pending",
      resultText: null,
      status: "open",
    });
    await expect(store.drainPendingAssignmentReturns()).resolves.toEqual({
      events: [],
      failures: [],
    });
    const waiting = await store.listThreadAssignmentsForOwner({
      ownerId: fixture.userId,
      threadId: task.thread.id,
    });
    expect(waiting?.assignments[0]).toMatchObject({
      status: "open",
      workerThread: { pendingRequests: 1 },
    });

    await declineRequest(fixture, firstRequest.request.id);
    await drainContinuations();
    const second = await activateRun(fixture, (await queuedRun(task.thread.id)).id);
    expect(await runAssignment(second.runId)).toBe(task.assignmentId);
    // Answered while this Run still works; its continuation is not queued yet
    // when the Run ends, so the task must not finish with this interim reply.
    const secondRequest = await openDurableRequest(fixture, second);
    await declineRequest(fixture, secondRequest.request.id);
    await reply(second, "Interim: still waiting for the second answer.");
    await end(second, "completed");
    expect((await assignmentRow(task.assignmentId)).status).toBe("open");
    await expect(
      database
        .selectFrom("requestContinuations")
        .select("status")
        .where("requestId", "=", secondRequest.request.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "waiting" });

    await drainContinuations();
    const third = await activateRun(fixture, (await queuedRun(task.thread.id)).id);
    const finalReply = "Final: returns are free within 100 days; no file access was needed.";
    await reply(third, finalReply);
    await end(third, "completed");
    expect(await assignmentRow(task.assignmentId)).toMatchObject({
      resultRunId: third.runId,
      resultText: finalReply,
      status: "completed",
    });
    acceptanceEvidence.push({
      caseId: "L04+L05",
      assignmentId: task.assignmentId,
      runs: [first.runId, second.runId, third.runId],
      requests: [firstRequest.request.id, secondRequest.request.id],
      resultRunId: third.runId,
    });
  });

  it("waits for its own children's results and never takes a child's reply as its own", async () => {
    const fixture = await createFixture();
    const parent = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Coordinate a mattress comparison with helpers",
      title: "Coordinated comparison",
      workspaceId: fixture.workspaceId,
    });
    const parentFirst = await activateRun(fixture, parent.run!.id);
    const trial = await delegate(parentFirst.token, {
      task: "Check the manufacturer trial terms",
      workspaceId: fixture.workspaceId,
    });
    await reply(parentFirst, "Asked a helper to check the trial terms.");
    await end(parentFirst, "completed");
    expect((await assignmentRow(parent.assignmentId)).status).toBe("open");

    const trialWorker = await activateRun(fixture, trial.run!.id);
    await reply(trialWorker, "Trial terms: 100 nights.");
    await end(trialWorker, "completed");
    expect(await drainReturns()).toContainEqual(
      expect.objectContaining({ threadId: parent.thread.id, type: "message.created" }),
    );
    const parentSecond = await activateRun(fixture, (await queuedRun(parent.thread.id)).id);
    expect(await runAssignment(parentSecond.runId)).toBe(parent.assignmentId);
    const warranty = await delegate(parentSecond.token, {
      task: "Check the warranty",
      workspaceId: fixture.workspaceId,
    });
    const warrantyWorker = await activateRun(fixture, warranty.run!.id);
    await reply(warrantyWorker, "Warranty: 10 years.");
    await end(warrantyWorker, "completed");
    // The warranty result has not reached the parent Thread yet.
    await reply(parentSecond, "Interim: 100-night trial; the warranty check is still out.");
    await end(parentSecond, "completed");
    expect((await assignmentRow(parent.assignmentId)).status).toBe("open");

    await drainReturns();
    const parentThird = await activateRun(fixture, (await queuedRun(parent.thread.id)).id);
    const finalReply = "Final: 100-night trial and a 10-year warranty.";
    await reply(parentThird, finalReply);
    await end(parentThird, "completed");
    expect(await assignmentRow(parent.assignmentId)).toMatchObject({
      resultRunId: parentThird.runId,
      resultText: finalReply,
      status: "completed",
    });
    await drainReturns();
    const returned = await returnMessages(fixture.parentThreadId);
    expect(returned.map(({ content }) => messageText(content))).toEqual([
      `Task completed: Coordinated comparison\nTask Thread: ${parent.thread.id} · Assignment: ${parent.assignmentId}\n\n${finalReply}`,
    ]);
    acceptanceEvidence.push({
      caseId: "L06+L07",
      parentAssignmentId: parent.assignmentId,
      childAssignmentIds: [trial.assignmentId, warranty.assignmentId],
      parentRuns: [parentFirst.runId, parentSecond.runId, parentThird.runId],
      resultRunId: parentThird.runId,
    });
  });

  it("lets reports ride along without blocking completion or reuse, and reuse starts fresh", async () => {
    const fixture = await createFixture();
    const first = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "First comparison",
      workspaceId: fixture.workspaceId,
    });
    const firstWorker = await activateRun(fixture, first.run!.id);
    const correction = await service.handle(fixture.token, {
      content: [{ text: "Also compare return shipping.", type: "text" }],
      delivery: "report",
      requestId: randomUUID(),
      threadId: first.thread.id,
      type: "thread.message",
    });
    if (correction.type !== "thread.message.result") throw new Error("Expected a message result");
    expect(correction.result.assignmentId).toBe(first.assignmentId);
    const toParent = await service.handle(firstWorker.token, {
      content: [{ text: "Progress: two retailers checked.", type: "text" }],
      delivery: "report",
      requestId: randomUUID(),
      threadId: fixture.parentThreadId,
      type: "thread.message",
    });
    if (toParent.type !== "thread.message.result") throw new Error("Expected a message result");
    expect(toParent.result.assignmentId).toBeNull();
    await reply(firstWorker, "First result");
    await end(firstWorker, "completed");
    // The correction is still a pending report; it neither blocks nor occupies.
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["policy", "state"])
        .where("messageId", "=", correction.result.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ policy: "report", state: "pending" });
    expect((await assignmentRow(first.assignmentId)).status).toBe("completed");
    await drainReturns();

    const second = await delegate(fixture.token, {
      task: "Update the comparison with new sources",
      threadId: first.thread.id,
    });
    expect(second.thread.id).toBe(first.thread.id);
    expect(second.assignmentId).not.toBe(first.assignmentId);
    expect(await assignmentRow(second.assignmentId)).toMatchObject({
      resultText: null,
      status: "open",
    });
    // The first Assignment's ended Run cannot continue into the new one.
    await expect(
      store.enqueueThreadInput({
        content: [{ text: "Stale continuation", type: "text" }],
        idempotencyKey: `stale-${randomUUID()}`,
        policy: "queue",
        requestedBy: fixture.userId,
        source: { cause: "request-resolved", kind: "platform", sourceRunId: firstWorker.runId },
        threadId: first.thread.id,
      }),
    ).rejects.toThrow(/Assignment/u);
    const secondWorker = await activateRun(fixture, second.run!.id);
    await reply(secondWorker, "Second result");
    await end(secondWorker, "completed");
    const rows = await database
      .selectFrom("delegations")
      .select(["id", "resultRunId", "resultText", "status"])
      .where("childThreadId", "=", first.thread.id)
      .orderBy("createdAt", "asc")
      .execute();
    expect(rows).toEqual([
      {
        id: first.assignmentId,
        resultRunId: firstWorker.runId,
        resultText: "First result",
        status: "completed",
      },
      {
        id: second.assignmentId,
        resultRunId: secondWorker.runId,
        resultText: "Second result",
        status: "completed",
      },
    ]);
    acceptanceEvidence.push({
      caseId: "L08+L17+L18",
      firstAssignmentId: first.assignmentId,
      secondAssignmentId: second.assignmentId,
      workerThreadId: first.thread.id,
      correctionAssignmentId: correction.result.assignmentId,
      unboundMessageAssignmentId: toParent.result.assignmentId,
    });
  });

  it("reports provider failures once and recovers a lost delegated execution before returning its result", async () => {
    const fixture = await createFixture();
    const runnerFailure = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Investigate mattress trial terms",
      title: "Trial terms",
      workspaceId: fixture.workspaceId,
    });
    const runnerWorker = await activateRun(fixture, runnerFailure.run!.id);
    await reply(runnerWorker, "Checked two of the three sources.");
    await end(runnerWorker, "failed", "The provider rejected the request");
    expect(await assignmentRow(runnerFailure.assignmentId)).toMatchObject({
      resultRunId: runnerWorker.runId,
      resultText:
        "The task stopped because of an error: The provider rejected the request.\n\nLast reply before the error:\nChecked two of the three sources.",
      status: "failed",
    });

    const hostRecovery = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Compare delivery windows",
      title: "Delivery windows",
      workspaceId: fixture.workspaceId,
    });
    const hostWorker = await activateRun(fixture, hostRecovery.run!.id);
    await database
      .updateTable("providerSessions")
      .set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where("threadId", "=", hostRecovery.thread.id)
      .where("active", "=", true)
      .execute();
    const recovery = await store.recoverRunsWithExpiredExecutionBindings();
    expect(recovery.events).toContainEqual(
      expect.objectContaining({
        runId: hostWorker.runId,
        type: "run.restarted",
        data: expect.objectContaining({ reason: "recovery" }),
      }),
    );
    expect(await assignmentRow(hostRecovery.assignmentId)).toMatchObject({
      status: "open",
      resultRunId: null,
    });
    const resumedWorker = await activateRun(fixture, hostWorker.runId);
    expect(resumedWorker.runId).toBe(hostWorker.runId);
    expect(resumedWorker.bindingGeneration).toBeGreaterThan(hostWorker.bindingGeneration);
    await reply(resumedWorker, "Delivery windows compared after recovery.");
    await end(resumedWorker, "completed");
    const hostRow = await assignmentRow(hostRecovery.assignmentId);
    expect(hostRow).toMatchObject({
      resultRunId: hostWorker.runId,
      status: "completed",
      resultText: "Delivery windows compared after recovery.",
    });

    await drainReturns();
    await drainReturns();
    const returned = await returnMessages(fixture.parentThreadId);
    expect(returned.map(({ content }) => messageText(content).split("\n")[0])).toEqual([
      "Task failed: Trial terms",
      "Task completed: Delivery windows",
    ]);
    const policies = await database
      .selectFrom("threadInputs")
      .select("policy")
      .where(
        "messageId",
        "in",
        returned.map(({ id }) => id),
      )
      .execute();
    expect(policies).toEqual([{ policy: "queue" }, { policy: "queue" }]);
    acceptanceEvidence.push({
      caseId: "L09",
      runnerFailureAssignmentId: runnerFailure.assignmentId,
      hostRecoveryAssignmentId: hostRecovery.assignmentId,
      returnMessageCount: returned.length,
    });
  });

  it("stays open when a person stops its Run and finishes after the person's next message", async () => {
    const fixture = await createFixture();
    const task = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Summarize the reviews",
      workspaceId: fixture.workspaceId,
    });
    const interrupted = await activateRun(fixture, task.run!.id);
    await reply(interrupted, "Halfway through the reviews.");
    await end(interrupted, "interrupted");
    expect(await assignmentRow(task.assignmentId)).toMatchObject({
      resultText: null,
      status: "open",
    });
    await expect(store.drainPendingAssignmentReturns()).resolves.toEqual({
      events: [],
      failures: [],
    });
    const nudge = await commands.enqueueThreadInput({
      content: [{ text: "Please finish the summary", type: "text" }],
      idempotencyKey: `nudge-${randomUUID()}`,
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: task.thread.id,
    });
    expect(nudge.input.assignmentId).toBe(task.assignmentId);
    const resumed = await activateRun(fixture, nudge.run!.id);
    expect(await runAssignment(resumed.runId)).toBe(task.assignmentId);
    await reply(resumed, "Summary: reviewers favour the medium-firm model.");
    await end(resumed, "completed");
    expect(await assignmentRow(task.assignmentId)).toMatchObject({
      resultRunId: resumed.runId,
      status: "completed",
    });
    acceptanceEvidence.push({
      caseId: "L10+L23",
      assignmentId: task.assignmentId,
      interruptedRunId: interrupted.runId,
      resultRunId: resumed.runId,
    });
  });

  it("stops a queued task so nothing starts, and tells the parent without starting its turn", async () => {
    const fixture = await createFixture();
    const task = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Do research when the lent computer becomes available",
      title: "Deferred research",
      workspaceId: fixture.workspaceId,
    });
    await end(fixture.parent, "completed");
    const idempotencyKey = `stop-${randomUUID()}`;
    const stopped = await commands.cancelAssignment({
      assignmentId: task.assignmentId,
      idempotencyKey,
      requestedBy: fixture.userId,
    });
    const again = await commands.cancelAssignment({
      assignmentId: task.assignmentId,
      idempotencyKey,
      requestedBy: fixture.userId,
    });
    expect(stopped.assignment.status).toBe("cancelled");
    expect(again.wasDuplicate).toBe(true);
    expect(stopped.interruptCommands).toEqual([]);
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", task.run!.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "interrupted" });
    await expect(nonterminalRuns(task.thread.id)).resolves.toEqual([]);

    await drainReturns();
    const returned = await returnMessages(fixture.parentThreadId);
    expect(returned.map(({ content }) => messageText(content))).toEqual([
      `Task cancelled: Deferred research\nTask Thread: ${task.thread.id} · Assignment: ${task.assignmentId}`,
    ]);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["policy", "state"])
        .where("messageId", "=", returned[0]!.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ policy: "report", state: "pending" });
    await expect(nonterminalRuns(fixture.parentThreadId)).resolves.toEqual([]);
    const parent = await database
      .selectFrom("threads")
      .select("inputQueuePaused")
      .where("id", "=", fixture.parentThreadId)
      .executeTakeFirstOrThrow();
    expect(parent.inputQueuePaused).toBe(false);
    acceptanceEvidence.push({
      caseId: "L13-queued",
      assignmentId: task.assignmentId,
      interruptedRunId: task.run!.id,
      parentRunsStarted: 0,
    });
  });

  it("stops a running task tree with its Requests, fences late work and never restarts it", async () => {
    const fixture = await createFixture();
    const parent = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Coordinate a mattress shortlist",
      title: "Shortlist",
      workspaceId: fixture.workspaceId,
    });
    const parentWorker = await activateRun(fixture, parent.run!.id);
    const child = await delegate(parentWorker.token, {
      task: "Verify return terms",
      workspaceId: fixture.workspaceId,
    });
    const childWorker = await activateRun(fixture, child.run!.id);
    const durable = await openDurableRequest(fixture, childWorker);

    const stopped = await service.handle(fixture.token, {
      assignmentId: parent.assignmentId,
      requestId: randomUUID(),
      type: "assignment.cancel",
    });
    expect(stopped).toMatchObject({
      assignment: { id: parent.assignmentId, status: "cancelled" },
      type: "assignment.cancel.result",
    });
    expect((await assignmentRow(child.assignmentId)).status).toBe("cancelled");
    await expect(store.requests.get(durable.request.id)).resolves.toMatchObject({
      cancellationReason: "source-closed",
      status: "cancelled",
    });
    const interrupts = await database
      .selectFrom("commands")
      .select("runId")
      .where("type", "=", "run.interrupt")
      .where("runId", "in", [parentWorker.runId, childWorker.runId])
      .orderBy("runId", "asc")
      .execute();
    expect(interrupts.map(({ runId }) => runId)).toEqual(
      [parentWorker.runId, childWorker.runId].sort(),
    );

    // The stopped Runs cannot ask for anything new, from the Host or the Runner:
    // cancelling the tree revoked their tool authority.
    await expect(openDurableRequest(fixture, childWorker)).rejects.toThrow(
      /Run tool authority has ended/u,
    );
    const liveRequestId = createId("request");
    await openLiveRequest(childWorker, liveRequestId, fixture.userId);
    await expect(store.requests.get(liveRequestId)).resolves.toMatchObject({
      status: "cancelled",
    });
    // A late completion neither revives nor reports the stopped work.
    await reply(childWorker, "A stale result after the stop");
    await end(childWorker, "completed");
    await end(parentWorker, "interrupted");
    expect(await assignmentRow(child.assignmentId)).toMatchObject({
      resultRunId: null,
      resultText: null,
      status: "cancelled",
    });
    await expect(nonterminalRuns(parent.thread.id)).resolves.toEqual([]);
    await expect(nonterminalRuns(child.thread.id)).resolves.toEqual([]);

    await drainReturns();
    const returned = await returnMessages(fixture.parentThreadId);
    expect(returned.map(({ content }) => messageText(content).split("\n")[0])).toEqual([
      "Task cancelled: Shortlist",
    ]);
    expect(await assignmentRow(child.assignmentId)).toMatchObject({
      resultReason: "parent-assignment-terminal",
      resultStatus: "undeliverable",
    });
    await expect(returnMessages(parent.thread.id)).resolves.toEqual([]);
    acceptanceEvidence.push({
      caseId: "L13-running+L14+L15",
      parentAssignmentId: parent.assignmentId,
      childAssignmentId: child.assignmentId,
      cancelledRequestIds: [durable.request.id, liveRequestId],
      interruptedRunIds: interrupts.map(({ runId }) => runId),
    });
  });

  it("stops a task that is waiting on a durable Request", async () => {
    const fixture = await createFixture();
    const task = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Check the account settings",
      workspaceId: fixture.workspaceId,
    });
    const worker = await activateRun(fixture, task.run!.id);
    const durable = await openDurableRequest(fixture, worker);
    await reply(worker, "Waiting for file access.");
    await end(worker, "completed");
    const stopped = await commands.cancelAssignment({
      assignmentId: task.assignmentId,
      idempotencyKey: `stop-waiting-${randomUUID()}`,
      requestedBy: fixture.userId,
    });
    expect(stopped.assignment.status).toBe("cancelled");
    expect(stopped.interruptCommands).toEqual([]);
    await expect(store.requests.get(durable.request.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(declineRequest(fixture, durable.request.id)).rejects.toThrow(/no longer pending/u);
    await drainContinuations();
    await expect(nonterminalRuns(task.thread.id)).resolves.toEqual([]);
    acceptanceEvidence.push({
      caseId: "L13-waiting",
      assignmentId: task.assignmentId,
      cancelledRequestId: durable.request.id,
    });
  });

  it("refuses new work for a Thread whose task is still open and names that task", async () => {
    const fixture = await createFixture();
    const task = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Long mattress research",
      workspaceId: fixture.workspaceId,
    });
    await expect(
      delegate(fixture.token, { task: "A different objective", threadId: task.thread.id }),
    ).rejects.toThrow(
      new RegExp(`task ${task.assignmentId}.*thread_message.*assignment_cancel`, "u"),
    );
    await expect(
      database
        .selectFrom("delegations")
        .select("id")
        .where("childThreadId", "=", task.thread.id)
        .execute(),
    ).resolves.toEqual([{ id: task.assignmentId }]);
    acceptanceEvidence.push({ caseId: "L16", assignmentId: task.assignmentId });
  });

  // Eight races, each from its own state and with its own budget. Run back to
  // back on one parent, they took 25 of their shared 30 seconds on an idle
  // machine, each slower than the last.
  it.each(Array.from({ length: 8 }, (_, round) => round))(
    "never deadlocks when a cross-Workspace task is stopped while its Request is answered (race %i)",
    async (round) => {
      // The old deadlock needed the parent Workspace to sort first. These IDs
      // fix that order; their shared random end keeps each pair unique.
      const unique = randomUUID().slice(-12);
      const fixture = await createFixture({
        workspaceId: WorkspaceIdSchema.parse(`wsp_00000000-0000-4000-8000-${unique}`),
      });
      const workerWorkspaceId = (
        await createWorkspace(
          fixture.userId,
          "Worker workspace",
          WorkspaceIdSchema.parse(`wsp_ffffffff-ffff-4fff-bfff-${unique}`),
        )
      ).id;
      expect(fixture.workspaceId < workerWorkspaceId).toBe(true);
      const started = performance.now();
      const stages: Record<string, number> = {};
      const reached = (name: string) => {
        stages[name] = Math.round(performance.now() - started);
      };
      const progress: Record<string, unknown> = {
        caseId: "L19",
        parentWorkspaceId: fixture.workspaceId,
        round,
        stages,
        workerWorkspaceId,
      };
      // Recorded before the race, so a race that stalls shows where.
      acceptanceEvidence.push(progress);
      // One task waits on its Request with no Run left to serialize on; a
      // sibling keeps its Runner busy in the same worker Workspace.
      // Past the per-Run agent quota, so the parent Run delegates directly.
      const task = await delegateFromParent(fixture, workerWorkspaceId, `Research round ${round}`);
      reached("task delegated");
      const worker = await activateRun(fixture, task.run.id);
      reached("task Run active");
      const durable = await openDurableRequest(fixture, worker);
      reached("Request open");
      await end(worker, "completed");
      reached("task Run ended");
      const sibling = await delegateFromParent(
        fixture,
        workerWorkspaceId,
        `Sibling round ${round}`,
      );
      reached("sibling delegated");
      const siblingWorker = await activateRun(fixture, sibling.run.id);
      reached("sibling Run active");
      const race = (name: string, operation: Promise<unknown>) =>
        operation.finally(() => reached(name));
      const [stopped, declined, progressed, drained] = await Promise.allSettled([
        race(
          "stop settled",
          commands.cancelAssignment({
            assignmentId: task.assignment.id,
            idempotencyKey: `race-stop-${round}-${randomUUID()}`,
            requestedBy: fixture.userId,
          }),
        ),
        race("decline settled", declineRequest(fixture, durable.request.id)),
        race(
          "sibling progress settled",
          commit(siblingWorker, (scope) => ({
            ...scope,
            data: { status: "running" },
            type: "run.status",
          })),
        ),
        race("returns drained", store.drainPendingAssignmentReturns()),
      ]);
      for (const outcome of [stopped, declined, progressed, drained]) {
        if (outcome.status === "rejected") {
          expect(String(outcome.reason)).not.toMatch(/deadlock/iu);
        }
      }
      expect(stopped.status).toBe("fulfilled");
      expect(progressed.status).toBe("fulfilled");
      expect(drained.status).toBe("fulfilled");
      if (declined.status === "rejected") {
        expect(declined.reason).toMatchObject({ code: "conflict" });
      }
      const request = await store.requests.get(durable.request.id);
      expect(["cancelled", "declined"]).toContain(request?.status);
      expect((await assignmentRow(task.assignment.id)).status).toBe("cancelled");
      await end(siblingWorker, "completed");
      reached("sibling Run ended");
      Object.assign(progress, {
        assignmentId: task.assignment.id,
        declineOutcome: declined.status,
        requestStatus: request?.status,
        siblingAssignmentId: sibling.assignment.id,
      });
    },
  );

  it("applies one stop rule to people and agents", async () => {
    const fixture = await createFixture();
    const parent = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Coordinate research",
      workspaceId: fixture.workspaceId,
    });
    const sibling = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Unrelated research",
      workspaceId: fixture.workspaceId,
    });
    const parentWorker = await activateRun(fixture, parent.run!.id);
    const child = await delegate(parentWorker.token, {
      task: "A helper step",
      workspaceId: fixture.workspaceId,
    });
    const cancel = (token: string, assignmentId: typeof parent.assignmentId) =>
      service.handle(token, { assignmentId, requestId: randomUUID(), type: "assignment.cancel" });
    // A task's own Run stops only what it started.
    await expect(cancel(parentWorker.token, parent.assignmentId)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(cancel(parentWorker.token, sibling.assignmentId)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(cancel(parentWorker.token, child.assignmentId)).resolves.toMatchObject({
      assignment: { status: "cancelled" },
    });
    // A member who neither started the work nor owns the Workspace cannot stop it.
    const collaboratorId = await store.createUser("Collaborator");
    await addMembership(fixture.workspaceId, collaboratorId, "collaborator", fixture.userId);
    await expect(
      commands.cancelAssignment({
        assignmentId: sibling.assignmentId,
        idempotencyKey: `collaborator-stop-${randomUUID()}`,
        requestedBy: collaboratorId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      commands.cancelAssignment({
        assignmentId: sibling.assignmentId,
        idempotencyKey: `owner-stop-${randomUUID()}`,
        requestedBy: fixture.userId,
      }),
    ).resolves.toMatchObject({ assignment: { status: "cancelled" } });
    // A Main-profile Run stops whatever its person could.
    await expect(cancel(fixture.token, parent.assignmentId)).resolves.toMatchObject({
      assignment: { status: "cancelled" },
    });
    acceptanceEvidence.push({
      caseId: "L20",
      parentAssignmentId: parent.assignmentId,
      siblingAssignmentId: sibling.assignmentId,
      childAssignmentId: child.assignmentId,
    });
  });

  it("keeps a revoked parent Workspace out of a worker's completion", async () => {
    const fixture = await createFixture();
    const workerWorkspace = await createWorkspace(fixture.userId, "Worker workspace");
    const task = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      task: "Research mattress options in the worker workspace",
      workspaceId: workerWorkspace.id,
    });
    const worker = await activateRun(fixture, task.run!.id);
    const remainingOwnerId = await store.createUser("Remaining parent Workspace owner");
    await addMembership(fixture.workspaceId, remainingOwnerId, "owner", fixture.userId);
    await database
      .updateTable("workspaceMemberships")
      .set({ revokedAt: new Date(), revokedBy: remainingOwnerId, state: "revoked" })
      .where("workspaceId", "=", fixture.workspaceId)
      .where("userId", "=", fixture.userId)
      .executeTakeFirstOrThrow();
    await reply(worker, "The worker found the evidence, but parent access was revoked");
    const terminal = await end(worker, "completed");
    const completion = terminal.committed.compensatingEvents.filter(
      ({ type }) => type === "assignment.updated",
    );
    expect(completion).toEqual([
      expect.objectContaining({ threadId: task.thread.id, workspaceId: workerWorkspace.id }),
    ]);
    await drainReturns();
    expect(await assignmentRow(task.assignmentId)).toMatchObject({
      resultReason: "execution-authority-unavailable",
      resultStatus: "undeliverable",
      status: "completed",
    });
    await expect(returnMessages(fixture.parentThreadId)).resolves.toEqual([]);
    const parentEvents = await database
      .selectFrom("workspaceEvents")
      .select("type")
      .where("workspaceId", "=", fixture.workspaceId)
      .where("type", "=", "assignment.updated")
      .execute();
    expect(parentEvents).toEqual([]);
    acceptanceEvidence.push({
      caseId: "L22",
      assignmentId: task.assignmentId,
      workerWorkspaceId: workerWorkspace.id,
      parentWorkspaceId: fixture.workspaceId,
    });
  });

  it("keeps a completed cross-Workspace task's model after reload and Thread reuse", async () => {
    const fixture = await createFixture();
    const workerWorkspace = await createWorkspace(fixture.userId, "Model worker workspace");
    const alternateModel = ModelSelectionSchema.parse({
      modelId: "gpt-5.6-terra",
      options: { effort: "low" },
      providerId: "openai",
    });
    const task = await delegate(fixture.token, {
      environmentId: fixture.lentEnvironmentId,
      model: alternateModel,
      task: "Research across workspaces",
      workspaceId: workerWorkspace.id,
    });
    const list = async () => {
      const page = await store.listThreadAssignmentsForOwner({
        ownerId: fixture.userId,
        threadId: fixture.parentThreadId,
      });
      if (!page) throw new Error("Expected task summaries");
      return page.assignments;
    };
    const selectModel = async (
      threadId: ThreadId,
      harnessInstanceId: Fixture["lentHarnessInstanceId"],
      modelSelection: typeof alternateModel,
    ) => {
      await store.updateThreadExecutionSelection({
        continuationIdentity: {
          continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
          driverKind: nativeDriver,
        },
        harnessInstanceId,
        idempotencyKey: `change-task-model-${randomUUID()}`,
        modelSelection,
        requestedBy: fixture.userId,
        threadId,
      });
    };
    expect((await list()).find(({ id }) => id === task.assignmentId)?.modelLabel).toBe(
      alternateModel.modelId,
    );
    const worker = await activateRun(fixture, task.run!.id);
    await reply(worker, "Research complete.");
    await end(worker, "completed");
    await drainReturns();
    await selectModel(task.thread.id, fixture.lentHarnessInstanceId, testModelSelection);
    const followUp = await delegate(fixture.token, {
      task: "Check return shipping",
      threadId: task.thread.id,
    });
    const parentRun = await database
      .selectFrom("runs")
      .select("providerSessionId")
      .where("id", "=", fixture.parent.runId)
      .executeTakeFirstOrThrow();
    if (!parentRun?.providerSessionId) throw new Error("Expected parent provider session");
    await store.bindProviderSession({
      bindingGeneration: fixture.parent.bindingGeneration,
      harnessInstanceId: fixture.mainHarnessInstanceId,
      providerSessionId: parentRun.providerSessionId,
      providerSessionReference: `native-session-${fixture.parentThreadId}`,
      runId: fixture.parent.runId,
      runnerBootId: "boot-1",
      runnerId: fixture.mainRunnerId,
      threadId: fixture.parentThreadId,
    });
    await end(fixture.parent, "completed");
    const parentContinuation = await activateRun(
      fixture,
      (await queuedRun(fixture.parentThreadId)).id,
    );
    await end(parentContinuation, "completed");
    await selectModel(fixture.parentThreadId, fixture.mainHarnessInstanceId, alternateModel);
    const summaries = await list();
    expect(summaries.find(({ id }) => id === task.assignmentId)?.modelLabel).toBe(
      alternateModel.modelId,
    );
    expect(summaries.find(({ id }) => id === followUp.assignmentId)?.modelLabel).toBeNull();
    const originalSummary = summaries.find(({ id }) => id === task.assignmentId);
    if (!originalSummary) throw new Error("Expected original task summary");
    expect(
      assignmentPresentation(originalSummary, {
        connection: "connected",
        environments: [],
        homeThreadId: null,
        network: "online",
        requests: {},
        threads: [],
        transcripts: {},
        waitingRequests: [],
      }).model,
    ).toBe(alternateModel.modelId);
    const firstFollowUpRun = await activateRun(fixture, followUp.run!.id);
    await reply(firstFollowUpRun, "Checking return shipping now.");
    await end(firstFollowUpRun, "interrupted");
    await selectModel(task.thread.id, fixture.lentHarnessInstanceId, alternateModel);
    const nudge = await commands.enqueueThreadInput({
      content: [{ text: "Please finish the return shipping check", type: "text" }],
      idempotencyKey: `model-follow-up-${randomUUID()}`,
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: task.thread.id,
    });
    expect(nudge.input.assignmentId).toBe(followUp.assignmentId);
    const finalFollowUpRun = await activateRun(fixture, nudge.run!.id);
    expect((await list()).find(({ id }) => id === followUp.assignmentId)?.modelLabel).toBe(
      alternateModel.modelId,
    );
    await reply(finalFollowUpRun, "Return shipping is free.");
    await end(finalFollowUpRun, "completed");
    expect((await list()).find(({ id }) => id === followUp.assignmentId)?.modelLabel).toBe(
      alternateModel.modelId,
    );
    const historicalEvent = await database
      .selectFrom("workspaceEvents")
      .select("sequence")
      .where("type", "=", "assignment.created")
      .where("workspaceId", "=", workerWorkspace.id)
      .where(sql<boolean>`data #>> '{assignment,id}' = ${followUp.assignmentId}`)
      .orderBy("sequence", "desc")
      .executeTakeFirstOrThrow();
    await database
      .updateTable("workspaceEvents")
      .set({ data: sql`data #- '{assignment,modelLabel}'` })
      .where("workspaceId", "=", workerWorkspace.id)
      .where("sequence", "=", historicalEvent.sequence)
      .executeTakeFirstOrThrow();
    const migration = (await migrationProvider().getMigrations())["0071_assignment_run_models"];
    if (!migration) throw new Error("Assignment model migration missing");
    await migration.up(database);
    const replayed = await store.eventsAfter(workerWorkspace.id, SequenceSchema.parse("0"));
    expect(
      replayed.find(({ sequence }) => sequence === String(historicalEvent.sequence))?.data,
    ).toMatchObject({ assignment: { id: followUp.assignmentId, modelLabel: null } });
    const committed = await database
      .selectFrom("workspaceEvents")
      .select("data")
      .where("type", "=", "assignment.updated")
      .where("workspaceId", "=", workerWorkspace.id)
      .execute();
    expect(
      committed.some(
        ({ data }) =>
          (data as { assignment?: { id?: string; modelLabel?: string | null } }).assignment?.id ===
            task.assignmentId &&
          (data as { assignment?: { modelLabel?: string | null } }).assignment?.modelLabel ===
            alternateModel.modelId,
      ),
    ).toBe(true);
    acceptanceEvidence.push({
      caseId: "assignment-model-reload",
      firstAssignmentId: task.assignmentId,
      followUpAssignmentId: followUp.assignmentId,
      firstModelLabel: alternateModel.modelId,
      followUpInitialModelLabel: null,
      followUpFinalModelLabel: alternateModel.modelId,
      followUpRunIds: [firstFollowUpRun.runId, finalFollowUpRun.runId],
    });
  });

  it("never turns a person's message into a work Thread into a returned task", async () => {
    const fixture = await createFixture();
    const { thread } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.mainEnvironmentId,
      harnessInstanceId: fixture.mainHarnessInstanceId,
      idempotencyKey: `human-task-${randomUUID()}`,
      modelSelection: testModelSelection,
      title: "Personal mattress shortlist",
      workspaceId: fixture.workspaceId,
    });
    expect(thread.role).toBe("work");
    const turn = await commands.enqueueThreadInput({
      content: [{ text: "Research mattress choices", type: "text" }],
      idempotencyKey: `human-task-input-${randomUUID()}`,
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    // A person's own work is not handed out, so nothing returns anywhere.
    expect(turn.input.assignmentId).toBeNull();
    expect(turn.run?.assignmentId).toBeNull();
    const worker = await activateRun(fixture, turn.run!.id);
    await reply(worker, "Shortlist saved in this task");
    await end(worker, "completed");
    await expect(
      database
        .selectFrom("delegations")
        .select("id")
        .where("childThreadId", "=", thread.id)
        .execute(),
    ).resolves.toEqual([]);
    await expect(store.drainPendingAssignmentReturns()).resolves.toEqual({
      events: [],
      failures: [],
    });
    acceptanceEvidence.push({
      caseId: "L23-unbound",
      workerThreadId: thread.id,
      runId: worker.runId,
    });
  });

  it("lists what Home hands off, once, and keeps a task's own helpers inside it", async () => {
    const fixture = await createFixture({ home: true });
    const task = await delegate(fixture.token, {
      task: "Compare mattress trial terms",
      title: "Mattress research",
      workspaceId: fixture.workspaceId,
    });
    const taskFirst = await activateRun(fixture, task.run!.id);
    const helper = await delegate(taskFirst.token, {
      task: "Check the warranty",
      title: "Warranty check",
      workspaceId: fixture.workspaceId,
    });
    expect(helper.thread.parentThreadId).toBe(task.thread.id);

    // What a person's client reads: the realtime snapshot, the next page, and
    // the live event for each new Thread must make the same decision.
    const listedIds = async () => {
      const snapshot = await store.workspaceSnapshot(fixture.workspaceId, {
        listedOnly: true,
        viewerId: fixture.userId,
      });
      const page = await store.taskPageForUser({
        userId: fixture.userId,
        workspaceId: fixture.workspaceId,
      });
      expect(page.window.totalItems).toBe(page.tasks.length);
      return {
        page: page.tasks.map(({ thread }) => thread.id).sort(),
        snapshot: snapshot.threads.map(({ id }) => id).sort(),
      };
    };
    const expected = [fixture.parentThreadId, task.thread.id].sort();
    expect(await listedIds()).toEqual({ page: expected, snapshot: expected });
    const created = await database
      .selectFrom("workspaceEvents")
      .select(["data", "threadId"])
      .where("type", "=", "thread.created")
      .where("threadId", "in", [task.thread.id, helper.thread.id])
      .execute();
    expect(
      Object.fromEntries(
        created.map(({ data, threadId }) => [
          threadId,
          (data as { thread: { listed: boolean } }).thread.listed,
        ]),
      ),
    ).toEqual({ [helper.thread.id]: false, [task.thread.id]: true });

    // Finishing the task and handing it more work reuses its one row.
    const helperWorker = await activateRun(fixture, helper.run!.id);
    const helperActor = await store.resolvePlaceActor({
      agentBindingId: `run:${helperWorker.runId}`,
      ownerId: fixture.userId,
    });
    expect(helperActor).toMatchObject({ threadId: task.thread.id, home: false });
    expect(
      await store.resolvePlaceActor({
        agentBindingId: `run:${fixture.parent.runId}`,
        ownerId: fixture.userId,
      }),
    ).toMatchObject({ threadId: fixture.parentThreadId, home: true });
    expect(
      await store.resolvePlaceActor({
        agentBindingId: `trigger:${randomUUID()}`,
        ownerId: fixture.userId,
      }),
    ).toBeNull();
    expect(
      await store.resolvePlaceActor({
        agentBindingId: `run:${helperWorker.runId}`,
        ownerId: createId("user"),
      }),
    ).toBeNull();

    await reply(helperWorker, "Warranty: 10 years.");
    await end(helperWorker, "completed");
    await reply(taskFirst, "Waiting on the warranty check.");
    await end(taskFirst, "completed");
    await drainReturns();
    const taskSecond = await activateRun(fixture, (await queuedRun(task.thread.id)).id);
    await reply(taskSecond, "100-night trial and a 10-year warranty.");
    await end(taskSecond, "completed");
    expect((await assignmentRow(task.assignmentId)).status).toBe("completed");
    const followUp = await delegate(fixture.token, {
      task: "Also compare return shipping",
      threadId: task.thread.id,
    });
    expect(followUp.thread.id).toBe(task.thread.id);
    expect(await listedIds()).toEqual({ page: expected, snapshot: expected });
    acceptanceEvidence.push({
      caseId: "sidebar-listing",
      helperActor,
      helperThreadId: helper.thread.id,
      homeThreadId: fixture.parentThreadId,
      listedThreadIds: expected,
      reusedAssignmentId: followUp.assignmentId,
      taskThreadId: task.thread.id,
    });
  }, 60_000);

  it("tells Home's person what a helper inside a task asks, and follows reused work to its new owner", async () => {
    const fixture = await createFixture({ home: true });
    const task = await delegate(fixture.token, {
      task: "Compare mattress trial terms",
      title: "Mattress research",
      workspaceId: fixture.workspaceId,
    });
    const taskRun = await activateRun(fixture, task.run!.id);
    const helper = await delegate(taskRun.token, {
      task: "Check the warranty",
      title: "Warranty check",
      workspaceId: fixture.workspaceId,
    });
    const helperRun = await activateRun(fixture, helper.run!.id);
    const asked = await openDurableRequest(fixture, helperRun);

    // The question is Alex's, and it holds up the helper, the task and so Home.
    const waiting = await store.requests.waitingOnUserPage({ limit: 100, userId: fixture.userId });
    expect(
      waiting.requests.map(({ assignments, request }) => ({ assignments, id: request.id })),
    ).toEqual([
      {
        assignments: [
          {
            id: helper.assignmentId,
            parentThreadId: task.thread.id,
            workerThread: { id: helper.thread.id, title: "Warranty check" },
          },
          {
            id: task.assignmentId,
            parentThreadId: fixture.parentThreadId,
            workerThread: { id: task.thread.id, title: "Mattress research" },
          },
        ],
        id: asked.request.id,
      },
    ]);
    // A teammate in the same Workspace is not the one to answer it.
    const teammate = await store.createUser("Sam");
    await addMembership(fixture.workspaceId, teammate, "collaborator", fixture.userId);
    expect(
      (await store.requests.waitingOnUserPage({ limit: 100, userId: teammate })).requests,
    ).toEqual([]);
    // Home's handoff names whose assistant it is to anyone but its owner.
    const [handoff] = await database
      .selectFrom("messages")
      .select("author")
      .where("threadId", "=", task.thread.id)
      .orderBy("sequence", "asc")
      .execute();
    expect(handoff?.author).toMatchObject({ displayName: "Alex’s Opensteer", kind: "agent" });

    // Answered, it waits on nobody.
    await declineRequest(fixture, asked.request.id);
    expect(
      (await store.requests.waitingOnUserPage({ limit: 100, userId: fixture.userId })).requests,
    ).toEqual([]);

    // Home now gives the helper's Thread work of its own: it becomes one of
    // Alex's tasks, and what it asks next holds up that work, not the old task.
    // The declined question resumes the helper once before it can finish.
    await end(helperRun, "completed");
    await drainContinuations();
    const helperResumed = await activateRun(fixture, (await queuedRun(helper.thread.id)).id);
    await reply(helperResumed, "Warranty: 10 years.");
    await end(helperResumed, "completed");
    expect((await assignmentRow(helper.assignmentId)).status).toBe("completed");
    await drainReturns();
    expect(await listedFlag(helper.thread.id)).toBe(false);
    const adopted = await delegate(fixture.token, {
      task: "Now compare return shipping",
      threadId: helper.thread.id,
    });
    expect(await listedFlag(helper.thread.id)).toBe(true);
    const listedEvents = await database
      .selectFrom("workspaceEvents")
      .select(["data", "threadId"])
      .where("type", "=", "thread.listed")
      .execute();
    expect(listedEvents).toEqual([
      {
        data: expect.objectContaining({
          thread: expect.objectContaining({ id: helper.thread.id, listed: true }),
        }),
        threadId: helper.thread.id,
      },
    ]);
    const adoptedRun = await activateRun(fixture, adopted.run!.id);
    expect(
      await store.resolvePlaceActor({
        agentBindingId: `run:${adoptedRun.runId}`,
        ownerId: fixture.userId,
      }),
    ).toMatchObject({ threadId: helper.thread.id, home: false });
    expect(
      await store.resolvePlaceActor({
        agentBindingId: `run:${helperRun.runId}`,
        ownerId: fixture.userId,
      }),
    ).toBeNull();

    const askedAgain = await openDurableRequest(fixture, adoptedRun);
    const rewaiting = await store.requests.waitingOnUserPage({
      limit: 100,
      userId: fixture.userId,
    });
    expect(
      rewaiting.requests.map(({ assignments, request }) => ({ assignments, id: request.id })),
    ).toEqual([
      {
        assignments: [
          {
            id: adopted.assignmentId,
            parentThreadId: fixture.parentThreadId,
            workerThread: { id: helper.thread.id, title: "Warranty check" },
          },
        ],
        id: askedAgain.request.id,
      },
    ]);
    acceptanceEvidence.push({
      adoptedAssignmentId: adopted.assignmentId,
      caseId: "waiting-on-you",
      helperAssignmentId: helper.assignmentId,
      helperThreadId: helper.thread.id,
      taskAssignmentId: task.assignmentId,
    });
  }, 60_000);

  it("never copies a result into Home once its person cannot read the task's Workspace", async () => {
    const fixture = await createFixture({ home: true });
    const shared = await createWorkspace(fixture.userId, "Customer launch");
    const task = await delegate(fixture.token, {
      task: "Draft the launch announcement",
      title: "Launch announcement",
      workspaceId: shared.id,
    });
    const worker = await activateRun(fixture, task.run!.id);
    await reply(worker, "Draft: private launch details.");
    await end(worker, "completed");
    // Alex leaves the Workspace; it keeps an owner of its own.
    const remainingOwner = await store.createUser("Remaining owner");
    await addMembership(shared.id, remainingOwner, "owner", fixture.userId);
    await database
      .updateTable("workspaceMemberships")
      .set({ revokedAt: new Date(), revokedBy: remainingOwner, state: "revoked" })
      .where("workspaceId", "=", shared.id)
      .where("userId", "=", fixture.userId)
      .execute();
    await drainReturns();
    expect(await assignmentRow(task.assignmentId)).toMatchObject({
      resultReason: "execution-authority-unavailable",
      resultStatus: "undeliverable",
    });
    expect(await returnMessages(fixture.parentThreadId)).toEqual([]);
    acceptanceEvidence.push({ assignmentId: task.assignmentId, caseId: "revoked-worker-result" });
  });

  function listedFlag(threadId: ThreadId) {
    return database
      .selectFrom("threads")
      .select("listed")
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow()
      .then(({ listed }) => listed);
  }

  /**
   * One user, a Deployment-owned Main Runner, and a second Runner the same user
   * lent to this Deployment — the shape `runner.enrollment.createLocal` produces.
   */
  async function createFixture(
    options: {
      /** The assigning Thread is the person's Home rather than one of their tasks. */
      readonly home?: boolean;
      readonly specialized?: boolean;
      readonly lentDriverKind?: ReturnType<typeof HarnessIdSchema.parse>;
      readonly workspaceId?: WorkspaceId;
    } = {},
  ) {
    const userId = await store.createUser("Alex");
    const mainEnvironmentId = createId("environment");
    const lentEnvironmentId = createId("environment");
    const mainRunnerId = createId("runner");
    const lentRunnerId = createId("runner");
    await enrollRunner({
      createdBy: userId,
      driverKind: nativeDriver,
      environmentId: mainEnvironmentId,
      name: "Main runner",
      runnerId: mainRunnerId,
      runnerKind: "main",
    });
    await enrollRunner({
      createdBy: userId,
      driverKind: options.lentDriverKind ?? nativeDriver,
      environmentId: lentEnvironmentId,
      name: "Lent Mac",
      runnerId: lentRunnerId,
      runnerKind: "local",
    });
    const workspace = await store.createWorkspace({
      kind: options.specialized ? "specialized" : "main",
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: `wsp_main_${randomUUID()}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: userId,
      ...(options.workspaceId ? { id: options.workspaceId } : {}),
      idempotencyKey: `delegation-workspace-${randomUUID()}`,
      name: "Main workspace",
      status: "ready",
    });
    const mainHarness = await store.createHarnessInstance({
      config: {},
      driverKind: nativeDriver,
      environmentId: mainEnvironmentId,
      name: "Opensteer",
      sourceId: sourceForDriver(nativeDriver),
      stateKind: "isolated",
    });
    const lentHarness = await store.createHarnessInstance({
      config: {},
      driverKind: options.lentDriverKind ?? nativeDriver,
      environmentId: lentEnvironmentId,
      // The whole point of lending a personal computer: the person's own CLI
      // sign-in, which only a user-owned Runner may reach.
      name: "My Claude Code",
      sourceId: sourceForDriver(options.lentDriverKind ?? nativeDriver),
      stateKind: "ambient",
    });
    for (const [environmentId, harness] of [
      [mainEnvironmentId, mainHarness],
      [lentEnvironmentId, lentHarness],
    ] as const) {
      await store.recordHarnessCatalogs({
        catalogs: [readyCatalog(harness.id, harness.driverKind)],
        environmentId,
        expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
      });
    }
    const { thread: parent } = await store.createThread({
      createdBy: userId,
      environmentId: mainEnvironmentId,
      harnessInstanceId: mainHarness.id,
      idempotencyKey: `delegation-parent-${randomUUID()}`,
      modelSelection: testModelSelection,
      title: options.home ? "Chat" : "Release coordination",
      workspaceId: workspace.id,
      ...(options.home ? { home: true } : {}),
    });
    const turn = await commands.enqueueThreadInput({
      content: [{ text: "Coordinate the release", type: "text" }],
      idempotencyKey: `delegation-human-${randomUUID()}`,
      policy: "queue",
      requestedBy: userId,
      source: { kind: "human" },
      threadId: parent.id,
    });
    if (!turn.command || !turn.run) throw new Error("Expected the human input to queue a Run");
    await store.claimCommand(turn.command.id, "delegation-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: {
        continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        driverKind: nativeDriver,
      },
      harnessInstanceId: mainHarness.id,
      leaseTokenHash: `lease-${randomUUID()}`,
      membershipGeneration: 1,
      runnerBootId: "boot-1",
      runnerId: mainRunnerId,
      runId: turn.run.id,
      threadId: parent.id,
    });
    await store.commitRunnerEvent({
      environmentId: mainEnvironmentId,
      event: {
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        emittedAt: new Date().toISOString(),
        environmentId: mainEnvironmentId,
        ordinal: 0,
        runId: turn.run.id,
        threadId: parent.id,
        type: "run.started",
        workspaceId: workspace.id,
      },
      runnerBootId: "boot-1",
      runnerId: mainRunnerId,
    });
    const token = `token-${randomUUID()}`;
    claimsByToken.set(token, {
      aud: "opensteer-agent-control",
      bindingGeneration: binding.bindingGeneration,
      capabilityProfileId: parent.capabilityProfileId,
      environmentId: mainEnvironmentId,
      exp: Math.floor(Date.now() / 1_000) + 60,
      iat: Math.floor(Date.now() / 1_000),
      iss: "opensteer-host",
      jti: randomUUID(),
      membershipGeneration: 1,
      requestedBy: userId,
      runId: turn.run.id,
      runnerBootId: "boot-1",
      runnerId: mainRunnerId,
      threadId: parent.id,
      workspaceId: workspace.id,
    });
    const parentRun: WorkerRun = {
      bindingGeneration: binding.bindingGeneration,
      environmentId: mainEnvironmentId,
      ordinal: 1,
      runId: turn.run.id,
      runnerId: mainRunnerId,
      threadId: parent.id,
      token,
      workspaceId: workspace.id,
    };
    return {
      mainEnvironmentId,
      lentEnvironmentId,
      lentHarnessInstanceId: lentHarness.id,
      lentRunnerId,
      mainHarnessInstanceId: mainHarness.id,
      mainRunnerId,
      parent: parentRun,
      parentThreadId: parent.id,
      token,
      userId,
      workspaceId: workspace.id,
    };
  }

  const controlService = service;
  async function startDiscoveryMcp(token: string, legacyEnvironment = false) {
    let service: AgentToolsMcpService;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body =
          chunks.length > 0
            ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown)
            : undefined;
        const bearer = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
        await service.handle(request, response, body, bearer);
      })().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error("MCP request failed")),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP server did not bind");
    const url = new URL(`http://127.0.0.1:${address.port}/internal/v1/mcp`);
    service = new AgentToolsMcpService({
      agentControl: controlService,
      runnerCapabilities: async () => [
        "browser-profile-create-v1",
        "task-done-v1",
        ...(legacyEnvironment ? [] : ["environment-list-v1"]),
      ],
      store,
      publicUrl: url,
      tokens: {
        authenticate: async (presented: string) => {
          const claims = claimsByToken.get(presented);
          if (!claims || presented !== token) throw new Error("Invalid MCP token");
          return claims;
        },
      } as AgentControlTokenService,
    });
    const client = new Client({ name: "model-discovery-e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }) as unknown as Transport,
    );
    return { client, server, service };
  }

  /** A Run the test plays the Runner for: its binding, its agent token, its next ordinal. */
  interface WorkerRun {
    readonly bindingGeneration: number;
    readonly environmentId: EnvironmentId;
    ordinal: number;
    readonly runId: RunId;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
    readonly token: string;
    readonly workspaceId: WorkspaceId;
  }

  type Fixture = Awaited<ReturnType<typeof createFixture>>;
  type RunnerEventInput = Parameters<typeof store.commitRunnerEvent>[0];

  /** Claims a queued Run's execute command and starts it as its Runner would. */
  async function activateRun(fixture: Fixture, runId: RunId): Promise<WorkerRun> {
    const target = await database
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select([
        "runs.environmentId",
        "runs.nextRunnerOrdinal",
        "runs.providerSessionId",
        "threads.capabilityProfileId",
        "threads.id as threadId",
        "threads.workspaceId",
      ])
      .where("runs.id", "=", runId)
      .executeTakeFirstOrThrow();
    if (!target.providerSessionId) throw new Error(`Run ${runId} has no provider session`);
    const lent = target.environmentId === fixture.lentEnvironmentId;
    const runnerId = lent ? fixture.lentRunnerId : fixture.mainRunnerId;
    const pending = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", runId)
      .where("type", "=", "run.execute")
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    if (!(await store.claimCommand(pending.id, "assignment-dispatcher"))) {
      throw new Error(`Run ${runId} could not be claimed`);
    }
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: {
        continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        driverKind: nativeDriver,
      },
      harnessInstanceId: lent ? fixture.lentHarnessInstanceId : fixture.mainHarnessInstanceId,
      leaseTokenHash: `lease-${randomUUID()}`,
      membershipGeneration: 1,
      runnerBootId: "boot-1",
      runnerId,
      runId,
      threadId: target.threadId,
    });
    // The native session each Run resumes, so a Thread's next Run may start.
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: lent ? fixture.lentHarnessInstanceId : fixture.mainHarnessInstanceId,
      providerSessionId: target.providerSessionId,
      providerSessionReference: `native-session-${target.threadId}`,
      runId,
      runnerBootId: "boot-1",
      runnerId,
      threadId: target.threadId,
    });
    const token = `assignment-run-${randomUUID()}`;
    claimsByToken.set(token, {
      aud: "opensteer-agent-control",
      bindingGeneration: binding.bindingGeneration,
      capabilityProfileId: target.capabilityProfileId,
      environmentId: target.environmentId,
      exp: Math.floor(Date.now() / 1_000) + 60,
      iat: Math.floor(Date.now() / 1_000),
      iss: "opensteer-host",
      jti: randomUUID(),
      membershipGeneration: 1,
      requestedBy: fixture.userId,
      runId,
      runnerBootId: "boot-1",
      runnerId,
      threadId: target.threadId,
      workspaceId: target.workspaceId,
    });
    const worker: WorkerRun = {
      bindingGeneration: binding.bindingGeneration,
      environmentId: target.environmentId,
      ordinal: target.nextRunnerOrdinal,
      runId,
      runnerId,
      threadId: target.threadId,
      token,
      workspaceId: target.workspaceId,
    };
    await commit(worker, (scope) => ({
      ...scope,
      data: { status: "running" },
      type: "run.started",
    }));
    return worker;
  }

  /** Commits the worker's next Runner event, numbered as its Runner would number it. */
  async function commit(
    worker: WorkerRun,
    build: (scope: {
      readonly bindingGeneration: number;
      readonly emittedAt: string;
      readonly environmentId: EnvironmentId;
      readonly ordinal: number;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly workspaceId: WorkspaceId;
    }) => RunnerEventInput["event"],
  ) {
    const input: RunnerEventInput = {
      environmentId: worker.environmentId,
      event: build({
        bindingGeneration: worker.bindingGeneration,
        emittedAt: new Date().toISOString(),
        environmentId: worker.environmentId,
        ordinal: worker.ordinal,
        runId: worker.runId,
        threadId: worker.threadId,
        workspaceId: worker.workspaceId,
      }),
      runnerBootId: "boot-1",
      runnerId: worker.runnerId,
    };
    worker.ordinal += 1;
    return { commit: input, committed: await store.commitRunnerEvent(input) };
  }

  function reply(worker: WorkerRun, text: string) {
    return commit(worker, (scope) => ({
      ...scope,
      data: { content: [{ text, type: "text" }], messageId: createId("message") },
      type: "assistant.message",
    }));
  }

  function end(
    worker: WorkerRun,
    outcome: "completed" | "failed" | "interrupted",
    failure = "The provider failed",
  ) {
    return commit(worker, (scope) =>
      outcome === "failed"
        ? {
            ...scope,
            data: { code: "harness_error", message: failure, retryable: false, status: "failed" },
            type: "run.failed",
          }
        : outcome === "completed"
          ? { ...scope, data: { status: "completed" }, type: "run.completed" }
          : { ...scope, data: { status: "interrupted" }, type: "run.interrupted" },
    );
  }

  /** A live Request a harness opens through the Runner's event stream. */
  function openLiveRequest(worker: WorkerRun, requestId: RequestId, requestedBy: UserId) {
    return commit(worker, (scope) => ({
      ...scope,
      data: {
        request: PendingRequestSchema.parse({
          callId: requestId,
          cancellationReason: null,
          createdAt: new Date().toISOString(),
          id: requestId,
          kind: "harness.input",
          mode: "live",
          originatingOccurrenceId: null,
          originatingRunId: worker.runId,
          originatingThreadId: worker.threadId,
          originatingWorkspaceId: worker.workspaceId,
          payload: { kind: "harness.input" },
          presentation: {
            detail: "Approve this operation",
            kind: "choice",
            options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
            title: "Approval required",
          },
          requestedBy,
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
          targetWorkspaceId: worker.workspaceId,
        }),
      },
      type: "request.opened",
    }));
  }

  async function delegate(
    token: string,
    input: {
      readonly environmentId?: EnvironmentId;
      readonly model?: ReturnType<typeof ModelSelectionSchema.parse>;
      readonly task: string;
      readonly threadId?: ThreadId;
      readonly title?: string;
      readonly workspaceId?: WorkspaceId;
    },
  ) {
    const response = await service.handle(token, {
      requestId: randomUUID(),
      type: "thread.delegate",
      ...input,
    });
    if (response.type !== "thread.delegate.result") throw new Error("Expected a delegate result");
    return response.result;
  }

  /** The parent Run hands out work through the Host path an automation also uses. */
  function delegateFromParent(fixture: Fixture, workspaceId: WorkspaceId, title: string) {
    return commands.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.lentEnvironmentId,
      harnessInstanceId: fixture.lentHarnessInstanceId,
      idempotencyKey: `direct-delegation-${randomUUID()}`,
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: fixture.parent.runId,
        parentThreadId: fixture.parentThreadId,
      },
      task: [{ text: title, type: "text" }],
      title,
      workspaceId,
    });
  }

  function assignmentRow(id: AssignmentId) {
    return database
      .selectFrom("delegations")
      .select(["resultReason", "resultRunId", "resultStatus", "resultText", "status"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  /** What returned into a Thread from its tasks, in transcript order. */
  function returnMessages(threadId: ThreadId) {
    return database
      .selectFrom("messages")
      .select(["author", "content", "id", "kind"])
      .where("threadId", "=", threadId)
      .where(sql<string>`author ->> 'cause'`, "=", "assignment-result")
      .orderBy("sequence", "asc")
      .execute();
  }

  async function runAssignment(runId: RunId) {
    return (
      await database
        .selectFrom("runs")
        .select("assignmentId")
        .where("id", "=", runId)
        .executeTakeFirstOrThrow()
    ).assignmentId;
  }

  function queuedRun(threadId: ThreadId) {
    return database
      .selectFrom("runs")
      .select("id")
      .where("threadId", "=", threadId)
      .where("status", "=", "queued")
      .executeTakeFirstOrThrow();
  }

  function nonterminalRuns(threadId: ThreadId) {
    return database
      .selectFrom("runs")
      .select(["id", "status"])
      .where("threadId", "=", threadId)
      .where("status", "in", ["queued", "starting", "running", "waiting"])
      .execute();
  }

  function openDurableRequest(fixture: Fixture, worker: WorkerRun) {
    return store.requests.create({
      callId: `machine-approval-${randomUUID()}`,
      kind: "machine.full-disk-access",
      mode: "durable",
      originatingRunId: worker.runId,
      originatingThreadId: worker.threadId,
      originatingWorkspaceId: worker.workspaceId,
      payload: {
        kind: "machine.full-disk-access",
        machineId: fixture.lentRunnerId,
        machineName: "Lent Mac",
        reason: "Check the retailer policy",
      },
      presentation: {
        kind: "external",
        subject: { id: fixture.lentRunnerId, kind: "machine" },
        title: "Allow file access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester",
      targetWorkspaceId: worker.workspaceId,
    });
  }

  function declineRequest(fixture: Fixture, requestId: RequestId) {
    return store.requests.declineMachineFullDiskAccessRequest({
      requestId,
      resolvedBy: fixture.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
  }

  async function drainReturns() {
    const drained = await store.drainPendingAssignmentReturns();
    expect(drained.failures).toEqual([]);
    return drained.events;
  }

  /** The Host's continuation outbox, drained once as its timer would. */
  async function drainContinuations(): Promise<void> {
    const errors: unknown[] = [];
    const continuations = new ContinuationService({
      commands,
      integrations: {
        computerUseMachines: unexpected,
        computerUsePhones: unexpected,
        listCallableTools: unexpected,
        listDiscoveryInventory: unexpected,
      },
      onError: (error) => errors.push(error),
      requests: store.requests,
    });
    continuations.notify();
    await continuations.close();
    expect(errors).toEqual([]);
  }

  function createWorkspace(userId: UserId, name: string, id?: WorkspaceId) {
    return store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: `wsp_worker_${randomUUID()}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: userId,
      ...(id ? { id } : {}),
      idempotencyKey: `worker-workspace-${randomUUID()}`,
      name,
      status: "ready",
    });
  }

  async function addMembership(
    workspaceId: WorkspaceId,
    userId: UserId,
    role: "collaborator" | "owner",
    invitedBy: UserId,
  ): Promise<void> {
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role,
        state: "active",
        updatedAt: new Date(),
        userId,
        workspaceId,
      })
      .executeTakeFirstOrThrow();
  }

  /**
   * The dispatcher with every collaborator outside the durable path stubbed:
   * what is under test is the placement the Host recorded, which the real store
   * answers, so only the Runner send is captured.
   */
  function makeDispatcher(
    runnerId: RunnerId,
    dispatched: RunnerCommand[],
    nativePlaces = true,
  ): HostCommandDispatcher {
    const issue = () => "test-token";
    return new HostCommandDispatcher({
      executionLeaseMs: 90_000,
      attachmentRunTokens: { issue } as never,
      attachments: { listForRun: async () => [] },
      agentControlTokens: { issue } as never,
      browser: {} as never,
      egress: { issue: () => ({ allowedHosts: [], token: "test-egress" }) } as never,
      integrationSkillsTokens: { issue } as never,
      integrationToolsTokens: { issue } as never,
      onWorkspaceEvent: vi.fn(),
      publicUrl: new URL("https://delegation.opensteer.test"),
      requestResponseVault: {} as never,
      runners: {
        supportsMessageAttachments: () => false,
        canRunHarness: () => true,
        dispatch: async (command: RunnerCommand) => {
          dispatched.push(command);
        },
        identityForEnvironment: () => ({
          bootId: "rbt-lent",
          capabilities: [
            "native-session-continuation-v1",
            "assignments-v1",
            "steer-answer-v1",
            "browser-page-input-v1",
            ...(nativePlaces ? ["native-place-input-v1"] : []),
            "thread-state-v1",
            "requester-time-zone-v1",
            "execution-plane-v2",
          ],
          name: "Lent Mac",
          runnerId,
        }),
        inspectHarnesses: async (
          _environmentId: EnvironmentId,
          harnesses: readonly { readonly driverKind: string; readonly id: string }[],
        ) =>
          harnesses.map((harness) =>
            readyCatalog(
              harness.id as ReturnType<typeof createId<"harnessInstance">>,
              HarnessIdSchema.parse(harness.driverKind),
            ),
          ),
      } as never,
      store,
      triggerControlTokens: { issue } as never,
      triggerIntegrationToolsTokens: { issue } as never,
      triggers: {} as never,
      workspaceAccess: { plan: async () => ({ kind: "none" }) } as never,
      workspaces: { ensureExecutionReady: async () => undefined } as never,
    });
  }

  async function enrollRunner(input: {
    readonly createdBy: UserId;
    readonly driverKind: ReturnType<typeof HarnessIdSchema.parse>;
    readonly environmentId: EnvironmentId;
    readonly name: string;
    readonly runnerId: RunnerId;
    readonly runnerKind: "main" | "local";
  }): Promise<void> {
    if (!(await store.getDeployment())) {
      await store.ensureDeployment({
        canonicalOrigin: "https://delegation.opensteer.test",
        hostInstanceId: createId("hostInstance"),
        deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      });
    }
    const pair = generateKeyPairSync("ed25519");
    const descriptor: RunnerDescriptor = {
      bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
      capabilities: ["filesystem"],
      modules: {
        agents: {
          environmentIds: [input.environmentId],
          harnessDrivers: [
            {
              accessModes: [...ThreadAccessModeSchema.options],
              driverKind: input.driverKind,
              readiness: "configured",
              sources: [
                {
                  fields: [],
                  kind: "first-party",
                  label: input.driverKind,
                  quota: "none",
                  sourceId: sourceForDriver(input.driverKind),
                  stateKinds: ["ambient", "isolated"],
                },
              ],
            },
          ],
          localStorage: null,
          maxConcurrentRuns: 4,
          // A lent computer is single-user, so it may offer the person's own CLI.
          providerStateModes: input.runnerKind === "local" ? ["ambient", "isolated"] : ["isolated"],
          workspaceBackings: ["portablefs"],
          workspaceMounts: [],
        },
      },
      name: input.name,
      runnerId: input.runnerId,
      runnerKind: input.runnerKind,
      runtimeVersion: "test",
    };
    const suffix = randomUUID();
    const enrollmentTokenHash = `sha256:${createHash("sha256")
      .update(`delegation-${suffix}`, "utf8")
      .digest("base64url")}`;
    await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: `delegation-runner-${suffix}`,
      ...(input.runnerKind === "main" ? { mainEnrollmentPurpose: "initial" as const } : {}),
      name: descriptor.name,
      requestFingerprint: `sha256:delegation-${suffix}`,
      runnerKind: input.runnerKind,
      tokenHash: enrollmentTokenHash,
    });
    await store.enrollRunnerConnection({
      descriptor,
      enrollmentTokenHash,
      publicKeyFingerprint: `sha256:${createHash("sha256")
        .update(pair.publicKey.export({ format: "der", type: "spki" }))
        .digest("base64url")}`,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
  }
});

function readyCatalog(
  harnessInstanceId: ReturnType<typeof createId<"harnessInstance">>,
  driverKind: ReturnType<typeof HarnessIdSchema.parse>,
): HarnessInstanceCatalog {
  return HarnessInstanceCatalogSchema.parse({
    continuationIdentity: {
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
      driverKind,
    },
    driverKind,
    harnessInstanceId,
    models: [
      {
        displayName: "GPT-5.6 Sol",
        isDefault: true,
        modelId: testModelSelection.modelId,
        options: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            values: [{ label: "Low", value: "low" }],
          },
        ],
        providerId: testModelSelection.providerId,
      },
      {
        displayName: "GPT-5.6 Terra",
        isDefault: false,
        modelId: "gpt-5.6-terra",
        options: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            values: [{ label: "Low", value: "low" }],
          },
        ],
        providerId: "openai",
      },
    ],
    status: "ready",
  });
}

async function unexpected(): Promise<never> {
  throw new Error("Unexpected agent control dependency call");
}

function messageText(content: unknown): string {
  return MessageContentSchema.parse(content)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}
