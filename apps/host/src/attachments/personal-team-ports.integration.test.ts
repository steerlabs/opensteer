import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createId, TeamMessageIdSchema, type TeamSource } from "@opensteer/core";
import { AttachmentStore } from "@opensteer/database/attachment-store";
import { admitTeamTaskRequest } from "@opensteer/database/task-admission-store";
import { createStoreFixture, testModelSelection } from "@opensteer/database/test-support/store";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import { RunnerRunFileResultSchema } from "@opensteer/protocol";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { afterEach, expect, it, vi } from "vitest";
import { SignedTokenService } from "../identity/host-keys.js";
import { RunFileRelay } from "../integrations/run-file-relay.js";
import { AttachmentService, RunAttachmentsTokenService } from "./attachment-service.js";
import { PersonalTeamAttachments } from "./personal-team-ports.js";

// Startup has a separate owner; every file authority check below reads the real personal database.
vi.mock("../../../../packages/database/src/deployment-store.js", () => ({
  ensureDeployment: () => {
    throw new Error("This fixture seeds its personal Deployment directly");
  },
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const f = await createStoreFixture();
  cleanup.push(f.close);
  const personal = await f.createRunFixture("team-file-owner");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-team-files-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const teamId = createId("deployment");
  const source: TeamSource = {
    teamId,
    channelId: createId("teamChannel"),
    threadRootId: TeamMessageIdSchema.parse("1"),
    messageId: TeamMessageIdSchema.parse("2"),
    audience: {
      teamName: "Studio",
      channelName: "Files",
      channelKind: "private",
      memberCount: 2,
      peopleOnly: false,
    },
  };
  await f.database
    .insertInto("personalTeamLinks")
    .values({
      id: crypto.randomUUID(),
      teamDeploymentId: teamId,
      teamHostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: "fixture",
      approvedOrigin: "https://team.example.invalid",
      authorityEnvelope: {},
      remoteLinkId: null,
      remoteOwnerUserId: null,
      state: "active",
      credentialReference: null,
      lastContactAt: null,
    })
    .execute();
  const admitted = await admitTeamTaskRequest(f.database, {
    origin: { teamId, channelId: source.channelId, threadRootId: source.threadRootId },
    requestId: createId("teamAgentRequest"),
    triggerMessageId: source.messageId!,
    folder: personal.folder,
    source,
    ownerId: personal.userId,
    execution: {
      environmentId: personal.environmentId,
      harnessInstanceId: personal.harnessInstance.id,
      modelSelection: testModelSelection,
    },
  });
  const run = await startPersonalQueuedRunFixture(f.store, admitted.receipt.runId!);
  const attachmentStore = new AttachmentStore(f.database),
    relay = new RunFileRelay();
  const tokens = new RunAttachmentsTokenService({
    authorizer: f.store,
    tokens: new SignedTokenService(generateKeyPairSync("ed25519"), {
      deploymentId: personal.deploymentId,
      hostInstanceId: personal.hostInstanceId,
    }),
  });
  const attachments = new AttachmentService({
    dataDirectory: directory,
    store: attachmentStore,
    runTokens: tokens,
  });
  const received: Buffer[] = [];
  const requestRunFile: RunnerRegistry["requestRunFile"] = async (runnerId, request) => {
    expect(runnerId).toBe(personal.runnerId);
    expect(request.execution).toEqual({
      runId: run.runId,
      bindingGeneration: run.bindingGeneration,
    });
    if (request.type === "host.run-file.receive") {
      const file = await relay.download(request.transfers[0]!.id, request.transfers[0]!.token);
      try {
        for await (const chunk of file.stream) received.push(Buffer.from(chunk));
        file.settled();
      } catch (error) {
        file.settled(error instanceof Error ? error : new Error("Transfer failed"));
        throw error;
      }
      return RunnerRunFileResultSchema.parse({
        type: "runner.run-file.result",
        ok: true,
        paths: ["/fixture/run-files/report.txt"],
        requestId: crypto.randomUUID(),
        bootId: "rbt_00000000-0000-4000-8000-000000000001",
        connectionGeneration: 1,
        connectionId: "rcn_00000000-0000-4000-8000-000000000001",
        connectionLeaseId: "rls_00000000-0000-4000-8000-000000000001",
        runnerId,
      });
    }
    const transfer = request.files[0]!.transfer;
    await relay.upload(transfer.id, transfer.token, {
      name: "local.txt",
      sizeBytes: 5,
      stream: Readable.from([Buffer.from("local")]),
    });
    return RunnerRunFileResultSchema.parse({
      type: "runner.run-file.result",
      ok: true,
      requestId: crypto.randomUUID(),
      bootId: "rbt_00000000-0000-4000-8000-000000000001",
      connectionGeneration: 1,
      connectionId: "rcn_00000000-0000-4000-8000-000000000001",
      connectionLeaseId: "rls_00000000-0000-4000-8000-000000000001",
      runnerId,
    });
  };
  const port = new PersonalTeamAttachments({
    store: f.store,
    attachments,
    attachmentStore,
    tokens,
    runners: { requestRunFile },
    relay,
  });
  return { ...f, ...run, personal, source, port, received };
}

it("imports verified bytes into the private attachment store and the exact Run cache, then exports them", async () => {
  const f = await fixture();
  const bytes = Buffer.from("team report");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = {
    id: createId("teamBlob"),
    channelId: f.source.channelId,
    filename: "report.txt",
    mediaType: "text/plain",
    sizeBytes: bytes.length,
    sha256,
    preview: null,
  };
  const imported = await f.port.import({
    runId: f.runId,
    file,
    source: f.source,
    bytes: Readable.from([bytes]),
    signal: AbortSignal.timeout(5_000),
  });
  expect(imported.path).toBe("/fixture/run-files/report.txt");
  expect(Buffer.concat(f.received)).toEqual(bytes);
  const exported = await f.port.export(f.runId, imported.attachment);
  const chunks: Buffer[] = [];
  for await (const chunk of exported.bytes) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(exported.sha256).toBe(sha256);
  const row = await f.database
    .selectFrom("attachments")
    .select(["messageId", "threadId"])
    .where("id", "=", imported.attachment.artifactId)
    .executeTakeFirstOrThrow();
  expect(row).toEqual({ messageId: f.run.seedInputId, threadId: f.run.threadId });
  const local = await f.port.admitPath(
    f.runId,
    "/fixture/explicit.txt",
    AbortSignal.timeout(5_000),
  );
  expect(local.sizeBytes).toBe(5);
  await f.store.enqueueRunnerControl({
    type: "run.interrupt",
    runId: f.runId,
    threadId: f.run.threadId,
    requestedBy: f.personal.userId,
    idempotencyKey: "end-file-authority",
  });
  await expect(f.port.export(f.runId, imported.attachment)).rejects.toMatchObject({
    code: "forbidden",
  });
});

it("discards a bad digest and refuses provenance from another team task", async () => {
  const f = await fixture();
  const file = {
    id: createId("teamBlob"),
    channelId: f.source.channelId,
    filename: "report.txt",
    mediaType: "text/plain",
    sizeBytes: 3,
    sha256: "0".repeat(64),
    preview: null,
  };
  await expect(
    f.port.import({
      runId: f.runId,
      file,
      source: f.source,
      bytes: Readable.from([Buffer.from("bad")]),
      signal: AbortSignal.timeout(5_000),
    }),
  ).rejects.toThrow("checksum");
  const bytes = Buffer.from("yes");
  await expect(
    f.port.import({
      runId: f.runId,
      file: { ...file, sha256: createHash("sha256").update(bytes).digest("hex") },
      source: { ...f.source, channelId: createId("teamChannel") },
      bytes: Readable.from([bytes]),
      signal: AbortSignal.timeout(5_000),
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(await f.database.selectFrom("attachments").selectAll().execute()).toEqual([]);
  expect(f.received).toEqual([]);
});
