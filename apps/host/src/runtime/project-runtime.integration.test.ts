import { generateKeyPairSync, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { expect, onTestFinished } from "vitest";
import { createId, ProjectEngineRequestSchema } from "@opensteer/core";
import {
  ProjectExecutionStore,
  readProjectRunBinding,
  reserveProjectWorkStop,
} from "@opensteer/database";
import { prepareProjectAdmission } from "@opensteer/database/test-support/project";
import { describeStore, testRunnerDescriptor } from "@opensteer/database/test-support/store";
import type { RunnerIdentity } from "@opensteer/orchestration";
import {
  ProjectHostToRunnerMessageSchema,
  RunnerConnectionFenceSchema,
  type ProjectExecutableCommand,
  type ProjectHostToRunnerMessage,
} from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectRunnerTransport } from "../agents/project-dispatcher.js";
import { SignedTokenService } from "../identity/host-keys.js";
import { WorkspaceExecutionAccessService } from "../workspace/workspace-execution-access-service.js";
import { createExecutionRuntime } from "./execution-runtime.js";
import type { ProjectRuntimeInfrastructure } from "./project-runtime.js";

describeStore("stored Project runtime composition", (it) => {
  it("recovers durable startup work, binds Request proposal and cancellation, and joins shutdown work", async ({
    storeFixture,
  }) => {
    const context = await prepareProjectAdmission(storeFixture);
    const { database, project, origin, prepared, store } = context;
    const deployment = await storeFixture.store.getDeployment();
    if (!deployment) throw new Error("Cold Project identity is missing");
    await expect(createExecutionRuntime(database, deployment, {})).rejects.toMatchObject({
      reason: "project-runtime-infrastructure-unavailable",
    });
    const admitted = await store.admitProjectWork({
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" },
      content: [{ type: "text", text: "Work queued before Host startup" }],
      policy: "queue",
      idempotencyKey: "before-host-start",
    });
    if (!admitted.runId) throw new Error("No queued Project Run");
    const fence = RunnerConnectionFenceSchema.parse({
      runnerId: project.runnerId,
      bootId: `rbt_${randomUUID()}`,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      connectionGeneration: 1,
    });
    const identity: RunnerIdentity = {
      ...testRunnerDescriptor({
        environmentId: project.environmentId,
        runnerId: project.runnerId,
        name: "Team computer",
        runnerKind: "local",
      }),
      device: { platform: "linux", form: "server" },
      bootId: fence.bootId,
      capabilities: ["project-authority-v1"],
      allowedModules: ["agents", "shell"],
      personalRemoteAccessGeneration: null,
      connectionGeneration: 1,
      connectionId: fence.connectionId,
      connectionLeaseId: fence.connectionLeaseId,
      environmentIds: [project.environmentId],
      fence,
    };
    const commands: ProjectExecutableCommand[] = [];
    const frames: ProjectHostToRunnerMessage[] = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let block = false;
    const transport: ProjectRunnerTransport = {
      current: (id) => (id === project.environmentId ? identity : null),
      identityForRunner: (id) => (id === project.runnerId ? identity : undefined),
      isCurrent: (peer) => isDeepStrictEqual(peer, fence),
      sendCommand: async (_peer, command) => {
        commands.push(command);
      },
      sendFrame: async (_peer, raw) => {
        frames.push(ProjectHostToRunnerMessageSchema.parse(raw));
        if (block) {
          entered.resolve();
          await release.promise;
        }
      },
    };
    let queueWake: (() => void) | undefined;
    let runnerWake: (() => void) | undefined;
    const scheduled = new Set<() => void>();
    const errors: unknown[] = [];
    const directory = await mkdtemp(join(tmpdir(), "f5-runtime-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const infrastructure: ProjectRuntimeInfrastructure = {
      transport,
      tokens: new SignedTokenService(generateKeyPairSync("ed25519"), {
        deploymentId: deployment.id,
        hostInstanceId: deployment.activeHostInstanceId,
      }),
      workspaceAccess: new WorkspaceExecutionAccessService({
        shape: deployment.deploymentShape,
        local: {
          planExecutionAccess: ({ workspace }) => ({
            ...workspace.backing,
            workspaceId: workspace.id,
            storageAuthorityId:
              workspace.backing.storageAuthorityId ?? createId("storageAuthority"),
          }),
        },
      }),
      dataDirectory: directory,
      agentToolsUrl: "https://team.test/agent-tools",
      egress: {
        relayUrl: "https://team.test/egress",
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
      },
      dispatcherId: "Project Host fixture",
      executionLeaseMs: 60_000,
      publish: () => undefined,
      live: () => undefined,
      collectAccessEvents: () => undefined,
      onQueueWake: (wake) => {
        queueWake = wake;
        return () => {
          queueWake = undefined;
        };
      },
      onRunnerWake: (wake) => {
        runnerWake = wake;
        return () => {
          runnerWake = undefined;
        };
      },
      onError: (error) => errors.push(error),
      clock: {
        schedule: (callback) => {
          scheduled.add(callback);
          return () => {
            scheduled.delete(callback);
          };
        },
      },
    };
    const runtime = await createExecutionRuntime(database, deployment, {}, infrastructure);
    if (runtime.kind !== "project") throw new Error("Stored model 2 selected a person runtime");
    let active = runtime.project;
    onTestFinished(async () => {
      release.resolve();
      await active.close();
    });
    expect(commands.map((command) => command.type)).toEqual(["run.execute.project"]);
    const grant = await database
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", admitted.runId)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    const saved = await readProjectRunBinding(database, {
      runId: admitted.runId,
      grantId: grant.id,
    });
    if (!saved) throw new Error("Factory dispatch did not bind the Run");
    const binding = saved.binding;
    const frame = (type: "run.started" | "run.completed", ordinal: number) => ({
      ...fence,
      type: "runner.project.event",
      event: {
        type,
        ordinal,
        binding,
        emittedAt: new Date().toISOString(),
        data: { status: type === "run.started" ? "running" : "completed" },
      },
    });
    await active.frames.handle(fence, frame("run.started", 0));
    const request = ProjectEngineRequestSchema.parse({
      id: createId("request"),
      callId: "engine-question",
      createdAt: new Date().toISOString(),
      mode: "live",
      kind: "harness.input",
      requestClass: "question",
      payload: { kind: "harness.input" },
      presentation: {
        kind: "choice",
        title: "A private question",
        options: [{ id: "yes", label: "Yes", hint: "other" }],
      },
    });
    await active.frames.handle(fence, {
      ...fence,
      type: "runner.project.event",
      event: {
        type: "request.proposed.project",
        ordinal: 1,
        binding,
        emittedAt: new Date().toISOString(),
        data: { request },
      },
    });
    expect(
      await database
        .selectFrom("requests")
        .select(["requestedBy", "requiredActor", "originatingGrantId"])
        .where("id", "=", request.id)
        .executeTakeFirst(),
    ).toEqual({
      requestedBy: origin.userId,
      requiredActor: "requester",
      originatingGrantId: binding.grantId,
    });
    await active.close();
    expect(queueWake).toBeUndefined();
    expect(runnerWake).toBeUndefined();
    expect(scheduled.size).toBe(0);
    const enqueue = () =>
      database.transaction().execute(async (tx) => {
        await reserveProjectWorkStop(tx, { runIds: [binding.runId] });
        return new ProjectExecutionStore().enqueue(tx, {
          binding,
          idempotencyKey: `stop-${randomUUID()}`,
          control: { kind: "run.interrupt" },
        });
      });
    await enqueue();
    const restarted = await createExecutionRuntime(database, deployment, {}, infrastructure);
    if (restarted.kind !== "project") throw new Error("Restart selected a person runtime");
    active = restarted.project;
    expect(frames.some((item) => item.type === "host.project.run-control")).toBe(true);
    await active.frames.handle(fence, frame("run.completed", 2));
    expect(
      await database
        .selectFrom("requests")
        .select(["status", "cancellationReason"])
        .where("id", "=", request.id)
        .executeTakeFirst(),
    ).toEqual({ status: "cancelled", cancellationReason: "run-ended" });
    // A blocked active delivery must settle before shutdown releases this runtime's subscriptions.
    const next = await active.admission.admitProjectWork({
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" },
      content: [{ type: "text", text: "Next turn" }],
      policy: "queue",
      idempotencyKey: "next-turn",
    });
    const nextRunId = next.runId;
    if (!nextRunId) throw new Error("Next Run was not queued");
    await active.reconcile();
    const nextGrant = await database
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", next.runId)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    const nextBinding = await readProjectRunBinding(database, {
      runId: nextRunId,
      grantId: nextGrant.id,
    });
    if (!nextBinding) throw new Error("Next Run has no binding");
    await database.transaction().execute(async (tx) => {
      await reserveProjectWorkStop(tx, { runIds: [nextRunId] });
      await new ProjectExecutionStore().enqueue(tx, {
        binding: nextBinding.binding,
        idempotencyKey: "blocked-stop",
        control: { kind: "run.interrupt" },
      });
    });
    block = true;
    queueWake?.();
    await withTimeout(entered.promise, 3000, {
      timeoutError: () => new Error("Project queue wake never reached durable control delivery"),
    });
    let closed = false;
    const closing = active.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(queueWake).toBeUndefined();
    expect(runnerWake).toBeUndefined();
    expect(scheduled.size).toBe(0);
    release.resolve();
    await withTimeout(closing, 3000, {
      timeoutError: () => new Error("Project runtime did not join its active delivery on shutdown"),
    });
    expect(closed).toBe(true);
    expect(errors).toEqual([]);
  });
});
