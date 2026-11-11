import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectAttachmentReader } from "./project-attachments.js";
import { agentToolsPlanForProject } from "./agent-tools-plan.js";
import { generateKeyPairSync, randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createId } from "@opensteer/core";
import { describeStore, testRunnerDescriptor } from "@opensteer/database/test-support/store";
import { prepareProjectAdmission } from "@opensteer/database/test-support/project";
import {
  AttachmentStore,
  assertActiveProjectBinding,
  ProjectControlDeliveryStore,
  ProjectRunEventAcceptanceStore,
} from "@opensteer/database";
import type { RunnerIdentity } from "@opensteer/orchestration";
import {
  ProjectExecutableCommandSchema,
  ProjectHostToRunnerMessageSchema,
  RunnerConnectionFenceSchema,
  type ProjectExecutableCommand,
  type ProjectHostToRunnerMessage,
} from "@opensteer/protocol";
import { expect, onTestFinished } from "vitest";
import { SignedTokenService } from "../identity/host-keys.js";
import { WorkspaceExecutionAccessService } from "../workspace/workspace-execution-access-service.js";
import { ProjectCapabilityTokenService } from "./run-capability.js";
import {
  ProjectCommandDispatcher,
  ProjectRunnerFrameService,
  projectPeerIsCurrentAndCapable,
  type ProjectRunnerTransport,
} from "./project-dispatcher.js";

describeStore("Project protocol dispatch", (it) => {
  it("runs the frozen Project command and binding-aware frames on the real stores without a person executor or legacy fallback", async ({
    storeFixture,
  }) => {
    const { database, store, prepared, project, origin } =
      await prepareProjectAdmission(storeFixture);
    const directory = await mkdtemp(join(tmpdir(), "f5-project-attachments-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const attachments = new AttachmentStore(database);
    const bytes = Buffer.from("Project uploaded bytes");
    const upload = await attachments.reserve({
      workspaceId: project.workspace.id,
      uploaderId: origin.userId,
      name: "project.txt",
      mediaType: "text/plain",
      sizeBytes: bytes.byteLength,
      idempotencyKey: "project-upload",
    });
    await attachments.complete({
      attachmentId: upload.id,
      uploaderId: origin.userId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      install: async () => {
        await mkdir(join(directory, "attachments", "originals"), { recursive: true });
        await writeFile(join(directory, "attachments", "originals", upload.id), bytes);
      },
    });
    const admitted = await store.admitProjectWork({
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" },
      content: [
        { type: "text", text: "Do Project work" },
        {
          type: "artifact",
          artifactId: upload.id,
          name: upload.name,
          mediaType: upload.mediaType,
          sizeBytes: upload.sizeBytes,
        },
      ],
      policy: "queue",
      idempotencyKey: "protocol-flow",
    });
    if (!admitted.commandId || !admitted.runId) throw new Error("Project work was not queued");
    const descriptor = testRunnerDescriptor({
      environmentId: project.environmentId,
      runnerId: project.runnerId,
      name: "Project protocol Runner",
      runnerKind: "local",
    });
    const fence = RunnerConnectionFenceSchema.parse({
      runnerId: project.runnerId,
      bootId: `rbt_${randomUUID()}`,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      connectionGeneration: 1,
    });
    let identity: RunnerIdentity = {
      ...descriptor,
      bootId: fence.bootId,
      capabilities: ["project-authority-v1"],
      allowedModules: ["agents"],
      personalRemoteAccessGeneration: null,
      connectionGeneration: fence.connectionGeneration,
      connectionId: fence.connectionId,
      connectionLeaseId: fence.connectionLeaseId,
      environmentIds: [project.environmentId],
      fence,
    };
    const commands: ProjectExecutableCommand[] = [];
    const frames: ProjectHostToRunnerMessage[] = [];
    const transport: ProjectRunnerTransport = {
      current: (environmentId) => (environmentId === project.environmentId ? identity : null),
      identityForRunner: (runnerId) => (runnerId === project.runnerId ? identity : undefined),
      isCurrent: (peer) => isDeepStrictEqual(peer, identity.fence),
      async sendCommand(peer, raw) {
        expect(peer).toEqual(identity.fence);
        commands.push(ProjectExecutableCommandSchema.parse(raw));
      },
      async sendFrame(peer, raw) {
        expect(peer).toEqual(identity.fence);
        frames.push(ProjectHostToRunnerMessageSchema.parse(raw));
      },
    };
    const deployment = await database
      .selectFrom("deployments")
      .select(["id", "activeHostInstanceId"])
      .executeTakeFirstOrThrow();
    if (!deployment.activeHostInstanceId) throw new Error("Fixture has no Host identity");
    const capabilities = new ProjectCapabilityTokenService({
      tokens: new SignedTokenService(generateKeyPairSync("ed25519"), {
        deploymentId: deployment.id,
        hostInstanceId: deployment.activeHostInstanceId,
      }),
      authorizer: {
        assertProjectBinding: (binding) =>
          assertActiveProjectBinding(database, binding, {
            runnerIsAttached: (id, boot) =>
              id === identity.runnerId &&
              boot === identity.bootId &&
              projectPeerIsCurrentAndCapable(transport, identity.fence),
          }).then(() => undefined),
      },
    });
    const attachmentReader = new ProjectAttachmentReader({
      dataDirectory: directory,
      store: attachments,
      capabilities,
    });
    const controls = new ProjectControlDeliveryStore(database, {
      currentRunnerBootId: () => identity.bootId,
      currentPeerIsProjectCapable: (peer) => projectPeerIsCurrentAndCapable(transport, peer),
      canContinue: async () => false,
    });
    const published: string[] = [];
    let loseGateDuringPlacement = false;
    const dispatcher = new ProjectCommandDispatcher({
      database,
      transport,
      capabilities,
      controls,
      executionLeaseMs: 60_000,
      dispatcherId: "Project protocol test",
      workspaceAccess: new WorkspaceExecutionAccessService({
        shape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
        local: {
          planExecutionAccess({ workspace }) {
            if (loseGateDuringPlacement) identity = { ...identity, capabilities: [] };
            return {
              ...workspace.backing,
              workspaceId: workspace.id,
              storageAuthorityId:
                workspace.backing.storageAuthorityId ?? createId("storageAuthority"),
            };
          },
        },
      }),
      agentToolsPlan: ({ token, role, accessMode }) =>
        agentToolsPlanForProject({
          url: "https://project.test.invalid/agent-tools",
          token,
          role,
          accessMode,
        }),
      egress: {
        relayUrl: "https://project.test.invalid/egress",
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
      },
      publish: (events) => published.push(...events.map((event) => event.type)),
    });
    identity = { ...identity, capabilities: [] };
    await expect(dispatcher.dispatchQueued(admitted.commandId)).rejects.toMatchObject({
      reason: "project-runner-unavailable",
    });
    expect(
      (
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", admitted.runId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("queued");
    identity = { ...identity, capabilities: ["project-authority-v1"] };
    loseGateDuringPlacement = true;
    await expect(dispatcher.dispatchQueued(admitted.commandId)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(commands).toEqual([]);
    loseGateDuringPlacement = false;
    identity = { ...identity, capabilities: ["project-authority-v1"] };
    // A reconstructed Host dispatcher discovers the durable command instead of relying on an in-memory wake.
    expect(await dispatcher.drainPending()).toContainEqual({
      commandId: admitted.commandId,
      state: "dispatched",
    });
    const binding = await dispatcher.dispatchQueued(admitted.commandId);
    expect(commands).toHaveLength(2);
    const command = commands[0];
    if (command?.type !== "run.execute.project")
      throw new Error("A legacy command reached the fake Runner");
    expect(command.context).toMatchObject({
      authority: binding.authority,
      grantId: binding.grantId,
      runnerBootId: fence.bootId,
      projectSettingsRevision: 1,
      projectTimeZone: "UTC",
      harness: { driverKind: "codex", stateKind: "isolated" },
    });
    for (const key of [
      "requestedBy",
      "requesterTimeZone",
      "membershipGeneration",
      "plugins",
      "browserCdp",
      "voiceCall",
      "machineAccess",
    ])
      expect(command.context).not.toHaveProperty(key);
    expect(command.context.agentTools.instructions).toContain("Project only");
    expect(
      await capabilities.verify(command.context.agentTools.token, "opensteer-project-run-tools"),
    ).toMatchObject(binding);
    expect(
      await capabilities.verify(
        command.context.attachments?.token ?? "",
        "opensteer-project-run-attachments",
      ),
    ).toMatchObject(binding);
    expect(
      await capabilities.verify(command.context.egress.relayToken, "opensteer-project-egress"),
    ).toMatchObject(binding);
    const events = new ProjectRunEventAcceptanceStore(database, {
      currentPeerIsProjectCapable: (peer) => projectPeerIsCurrentAndCapable(transport, peer),
      links: { threadUrl: () => "https://project.test.invalid/thread" },
      requests: {
        async propose() {
          throw new Error("No proposal belongs to this fixture");
        },
      },
    });
    const service = new ProjectRunnerFrameService({
      database,
      transport,
      capabilities,
      controls,
      events,
      executionLeaseMs: 60_000,
      publish: (batch) => published.push(...batch.map((event) => event.type)),
      live: () => undefined,
    });
    await service.handle(fence, {
      ...fence,
      type: "runner.project.executions.attach",
      complete: true,
      executions: [],
    });
    expect(
      (
        await database
          .selectFrom("runs")
          .select("bindingGeneration")
          .where("id", "=", binding.runId)
          .executeTakeFirstOrThrow()
      ).bindingGeneration,
    ).toBe(binding.bindingGeneration);
    await service.handle(fence, {
      ...fence,
      type: "runner.project.heartbeat",
      sentAt: new Date().toISOString(),
      bindings: [{ ...binding, kind: "run" }],
    });
    await service.handle(fence, {
      ...fence,
      type: "runner.project.session-bound",
      binding,
      providerSessionId: command.context.providerSessionId,
      harnessInstanceId: command.context.harnessInstanceId,
      providerSessionReference: "native-project-session",
    });
    await service.handle(fence, {
      ...fence,
      type: "runner.project.grants.refresh",
      requestId: "refresh-active",
      binding: { ...binding, kind: "run" },
    });
    expect(frames.at(-1)).toMatchObject({
      type: "host.project.grants.credentials",
      requestId: "refresh-active",
      result: { status: "issued", credentials: { kind: "run" } },
    });
    const attachmentToken = command.context.attachments?.token;
    if (!attachmentToken) throw new Error("Project attachment audience was not issued");
    expect(
      (await attachmentReader.listForRun(attachmentToken, null)).attachments.map((row) => row.id),
    ).toEqual([upload.id]);
    expect(
      Buffer.from((await attachmentReader.contentForRun(attachmentToken, upload.id)).bytes),
    ).toEqual(bytes);
    const beforePublication = await database
      .selectFrom("messages")
      .select("id")
      .where("threadId", "=", binding.threadId)
      .execute();
    await expect(
      store.admitProjectWork({
        threadId: binding.threadId,
        origin,
        source: { kind: "agent", runId: binding.runId },
        content: [
          {
            type: "artifact",
            artifactId: upload.id,
            name: upload.name,
            mediaType: upload.mediaType,
          },
        ],
        policy: "report",
        idempotencyKey: "project-publication",
      }),
    ).rejects.toMatchObject({ reason: "input-publication-not-supported" });
    expect(
      await database
        .selectFrom("messages")
        .select("id")
        .where("threadId", "=", binding.threadId)
        .execute(),
    ).toEqual(beforePublication);
    const started = {
      ...fence,
      type: "runner.project.event",
      event: {
        binding,
        ordinal: 0,
        emittedAt: new Date().toISOString(),
        type: "run.started",
        data: { status: "running" },
      },
    };
    await service.handle(fence, started);
    expect(published).toContain("run.started");
    expect(frames.at(-1)).toMatchObject({
      type: "host.project.events.acked",
      acks: [{ throughOrdinal: 0 }],
    });
    await service.handle(fence, {
      ...fence,
      type: "runner.project.event",
      event: {
        binding,
        ordinal: 1,
        emittedAt: new Date().toISOString(),
        type: "run.completed",
        data: { status: "completed" },
      },
    });
    expect(
      (
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", binding.runId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("completed");
    await expect(
      service.handle({ ...fence, connectionGeneration: 2 }, started),
    ).rejects.toMatchObject({ code: "forbidden" });
    await service.handle(fence, {
      ...fence,
      type: "runner.project.grants.refresh",
      requestId: "refresh-ended",
      binding: { ...binding, kind: "run" },
    });
    expect(frames.at(-1)).toMatchObject({
      type: "host.project.grants.credentials",
      requestId: "refresh-ended",
      result: { status: "refused" },
    });
    await expect(attachmentReader.contentForRun(attachmentToken, upload.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(commands.every((value) => value.type === "run.execute.project")).toBe(true);
    expect(frames.some((value) => value.type === "host.project.executions.renewed")).toBe(true);
  });
});
