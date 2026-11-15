import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { AttachmentIdSchema, createId, type ReferenceId, type UserId } from "@opensteer/core";
import { AttachmentStore, requestInsert } from "@opensteer/database";
import {
  describeStore,
  liveRequest,
  type StoreFixture,
} from "@opensteer/database/test-support/store";
import type { HostApiServerContext } from "@opensteer/protocol";
import { createReferenceHandlers, createThreadRequestHandler } from "./resolve.js";

const {
  resolvePersonalReferences,
}: {
  resolvePersonalReferences: Parameters<typeof createReferenceHandlers>[1];
} = await import(
  new URL("../../../../packages/database/src/reference-store.ts", import.meta.url).href
);

function rpcData<T>(result: { ok: true; data: T } | { ok: false; error: never }): T {
  if (!result.ok) throw new Error("Unexpected RPC failure");
  return result.data;
}
function context(userId: UserId): HostApiServerContext {
  return {
    headers: {},
    requestId: randomUUID(),
    requestUrl: "https://host.test/rpc",
    setHeader: () => {},
    signal: new AbortController().signal,
    surface: "canonical",
    session: {
      id: createId("authSession"),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      user: {
        id: userId,
        displayName: "Owner",
        email: "owner@example.invalid",
        emailVerified: true,
        disabledAt: null,
        image: null,
      },
    },
  };
}
function resolver(fixture: StoreFixture, userId: UserId) {
  const handler = createReferenceHandlers(fixture.store, resolvePersonalReferences)[
    "references.resolve"
  ];
  return async (ids: readonly ReferenceId[]) =>
    rpcData(await handler({ ids: [...ids] }, context(userId))).results;
}
async function readyAttachment(fixture: StoreFixture, userId: UserId) {
  const attachments = new AttachmentStore(fixture.database);
  const row = await attachments.reserve({
    uploaderId: userId,
    name: "Report.pdf",
    mediaType: "application/pdf",
    sizeBytes: 0,
    idempotencyKey: randomUUID(),
  });
  await attachments.complete({
    attachmentId: row.id,
    uploaderId: userId,
    sha256: "a".repeat(64),
    install: async () => {},
  });
  return AttachmentIdSchema.parse(row.id);
}

describeStore("personal reference handlers", (it) => {
  it("resolves every kind with current titles and exact parent context, in first-occurrence order", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("references");
    await f.database
      .updateTable("threads")
      .set({ title: "Current **task**", listed: false, doneAt: new Date() })
      .where("id", "=", run.threadId)
      .execute();
    const request = liveRequest({
      id: createId("request"),
      harnessInstanceId: run.harnessInstance.id,
      requestedBy: run.userId,
      runId: run.run.id,
      threadId: run.threadId,
      presentation: {
        kind: "choice",
        title: "Choose a format",
        options: [{ id: "csv", label: "CSV" }],
      },
    });
    await f.database.insertInto("requests").values(requestInsert(request)).execute();
    const automation = await f.triggers.create({
      actorThreadId: null,
      anchorThreadId: run.threadId,
      createdBy: run.userId,
      idempotencyKey: randomUUID(),
      name: "Daily report",
      program: {
        language: "javascript",
        source: "export default async () => null",
        toolContractVersion: 4,
      },
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      },
    });
    const attachmentId = await readyAttachment(f, run.userId);
    const missing = createId("thread");
    const ids = [
      run.run.id,
      request.id,
      run.threadId,
      run.run.activationInputId,
      automation.trigger.id,
      run.runnerId,
      attachmentId,
      missing,
    ];
    const results = await resolver(f, run.userId)([...ids, run.threadId, request.id]);
    expect(results.map((row) => row.id)).toEqual(ids);
    expect(results).toEqual([
      {
        status: "available",
        kind: "run",
        id: run.run.id,
        title: `Run ${run.run.runOrdinal} · Current task`,
        threadId: run.threadId,
        anchorMessageId: run.run.activationInputId,
      },
      {
        status: "available",
        kind: "request",
        id: request.id,
        title: "Choose a format",
        threadId: run.threadId,
        requestStatus: "pending",
      },
      { status: "available", kind: "task", id: run.threadId, title: "Current task" },
      {
        status: "available",
        kind: "message",
        id: run.run.activationInputId,
        title: "Message · Current task",
        threadId: run.threadId,
        location: "transcript",
      },
      { status: "available", kind: "automation", id: automation.trigger.id, title: "Daily report" },
      { status: "available", kind: "computer", id: run.runnerId, title: expect.any(String) },
      {
        status: "available",
        kind: "attachment",
        id: attachmentId,
        title: "Report.pdf",
        threadId: null,
        messageId: null,
      },
      { status: "unavailable", id: missing },
    ]);
    const other = await f.store.createUser("Other");
    await expect(resolver(f, other)(ids)).rejects.toMatchObject({ code: "forbidden" });
    await f.database
      .updateTable("threads")
      .set({ createdBy: other })
      .where("id", "=", run.threadId)
      .execute();
    await f.database
      .updateTable("triggers")
      .set({ createdBy: other })
      .where("id", "=", automation.trigger.id)
      .execute();
    const forbidden = [
      run.threadId,
      run.run.id,
      request.id,
      run.run.activationInputId,
      automation.trigger.id,
    ];
    expect(await resolver(f, run.userId)(forbidden)).toEqual(
      forbidden.map((id) => ({ status: "unavailable", id })),
    );
  });

  it("admits waiting inputs and published reports, excludes cancelled inputs, and verifies Run anchors", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("reference-message-states");
    const enqueue = (policy: "queue" | "report") =>
      f.store.enqueueThreadInput({
        threadId: run.threadId,
        requestedBy: run.userId,
        content: [{ type: "text", text: "Private body never becomes the chip title" }],
        policy,
        source: { kind: "human" },
        idempotencyKey: randomUUID(),
      });
    const queued = await enqueue("queue");
    const published = await enqueue("report");
    const cancelled = await enqueue("queue");
    await f.database
      .updateTable("threadInputs")
      .set({ state: "cancelled", cancelReason: "cancelled" })
      .where("messageId", "=", cancelled.message.id)
      .execute();
    const ids = [queued.message.id, published.message.id, cancelled.message.id];
    expect(await resolver(f, run.userId)(ids)).toEqual([
      expect.objectContaining({ id: ids[0], location: "input-queue" }),
      expect.objectContaining({ id: ids[1], location: "transcript" }),
      { id: ids[2], status: "unavailable" },
    ]);
    const other = await f.startRunFixture("wrong-anchor-thread");
    await expect(
      f.database
        .updateTable("runs")
        .set({ activationInputId: other.run.activationInputId })
        .where("id", "=", run.run.id)
        .execute(),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await resolver(f, run.userId)([run.run.id])).toEqual([
      expect.objectContaining({ id: run.run.id, anchorMessageId: run.run.activationInputId }),
    ]);
  });

  it("shares attachment admission and excludes revoked computers and expired or unfinished uploads", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("reference-attachments");
    const own = await readyAttachment(f, run.userId);
    const expired = await readyAttachment(f, run.userId);
    const bound = await readyAttachment(f, run.userId);
    const foreign = await readyAttachment(f, run.userId);
    const deleting = await readyAttachment(f, run.userId);
    const uploading = await new AttachmentStore(f.database).reserve({
      uploaderId: run.userId,
      name: "upload.txt",
      mediaType: "text/plain",
      sizeBytes: 0,
      idempotencyKey: randomUUID(),
    });
    const other = await f.store.createUser("Other uploader");
    await f.database
      .updateTable("attachments")
      .set({ expiresAt: new Date(0) })
      .where("id", "in", [expired, bound])
      .execute();
    await f.database
      .updateTable("attachments")
      .set({ uploaderId: other })
      .where("id", "in", [foreign, bound])
      .execute();
    await f.database
      .updateTable("attachments")
      .set({ messageId: run.run.activationInputId, threadId: run.threadId })
      .where("id", "=", bound)
      .execute();
    await f.database
      .updateTable("attachments")
      .set({ state: "deleting" })
      .where("id", "=", deleting)
      .execute();
    await f.database
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", run.runnerId)
      .execute();
    const denied = [
      expired,
      foreign,
      deleting,
      AttachmentIdSchema.parse(uploading.id),
      run.runnerId,
    ];
    expect(await resolver(f, run.userId)([own, bound, ...denied])).toEqual([
      expect.objectContaining({ id: own, status: "available", threadId: null, messageId: null }),
      expect.objectContaining({
        id: bound,
        status: "available",
        threadId: run.threadId,
        messageId: run.run.activationInputId,
      }),
      ...denied.map((id) => ({ id, status: "unavailable" })),
    ]);
    await expect(
      new AttachmentStore(f.database).getForUser(foreign, run.userId),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await new AttachmentStore(f.database).getForUser(bound, run.userId)).id).toBe(bound);
  });

  it("requires authentication, bounds the input before deduplication, and propagates infrastructure failure", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("reference-bounds");
    const handler = createReferenceHandlers(f.store, resolvePersonalReferences)[
      "references.resolve"
    ];
    const ctx = context(run.userId);
    await expect(handler({ ids: [run.threadId] }, { ...ctx, session: null })).rejects.toMatchObject(
      { code: "unauthorized" },
    );
    expect(
      rpcData(await handler({ ids: Array<ReferenceId>(64).fill(run.threadId) }, ctx)).results,
    ).toHaveLength(1);
    expect(
      await resolver(f, run.userId)(Array.from({ length: 64 }, () => createId("thread"))),
    ).toHaveLength(64);
    await expect(
      handler({ ids: Array<ReferenceId>(65).fill(run.threadId) }, ctx),
    ).rejects.toMatchObject({ code: "bad_request" });
    const failure = new Error("Database disconnected");
    const failing = createReferenceHandlers(f.store, vi.fn().mockRejectedValue(failure))[
      "references.resolve"
    ];
    await expect(failing({ ids: [run.threadId] }, ctx)).rejects.toBe(failure);
  });

  it("reads a settled Request by exact owner/thread and keeps the safe view and device opt-in", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("target-request");
    const otherTask = await f.startRunFixture("target-other-task");
    const request = liveRequest({
      id: createId("request"),
      harnessInstanceId: run.harnessInstance.id,
      requestedBy: run.userId,
      runId: run.run.id,
      threadId: run.threadId,
      presentation: {
        kind: "choice",
        title: "Choose export",
        options: [{ id: "csv", label: "CSV" }],
      },
    });
    await f.database.insertInto("requests").values(requestInsert(request)).execute();
    await f.database
      .updateTable("requests")
      .set({
        status: "fulfilled",
        resolvedAt: new Date(),
        resolvedBy: run.userId,
        response: { kind: "choice", optionId: "csv" },
        settlementProvenance: { sessionId: "private-session-id", deviceLabel: "Phone" },
      })
      .where("id", "=", request.id)
      .execute();
    const handler = createThreadRequestHandler(f.store);
    const read = async (...args: Parameters<typeof handler>) => rpcData(await handler(...args));
    const input = { threadId: run.threadId, requestId: request.id };
    const result = await read(input, context(run.userId));
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      id: request.id,
      status: "fulfilled",
      settlementProvenance: { deviceLabel: "Phone" },
    });
    expect(JSON.stringify(result)).not.toContain("private-session-id");
    expect(await resolver(f, run.userId)([request.id])).toEqual([
      expect.objectContaining({
        id: request.id,
        requestStatus: "fulfilled",
        threadId: run.threadId,
      }),
    ]);
    expect((await read({ threadId: run.threadId }, context(run.userId))).requests).toEqual([]);
    expect(
      (await read({ ...input, threadId: otherTask.threadId }, context(run.userId))).requests,
    ).toEqual([]);
    expect(
      (await read({ ...input, requestId: createId("request") }, context(run.userId))).requests,
    ).toEqual([]);
    for (const page of [{ limit: 1 }, { before: "cursor" }])
      await expect(read({ ...input, ...page }, context(run.userId))).rejects.toMatchObject({
        code: "bad_request",
      });
    const deviceRequestId = createId("request");
    await f.database
      .insertInto("requests")
      .values({
        ...requestInsert(request),
        id: deviceRequestId,
        callId: randomUUID(),
        kind: "device.access",
        mode: "durable",
        payload: {
          kind: "device.access",
          reason: "Read files",
          machineId: run.runnerId,
          machineName: "Mac",
          access: "files",
        },
      })
      .execute();
    expect(
      (await read({ ...input, requestId: deviceRequestId }, context(run.userId))).requests,
    ).toEqual([]);
    expect(
      (
        await read(
          { ...input, requestId: deviceRequestId, deviceAccessRequests: "include" },
          context(run.userId),
        )
      ).requests,
    ).toHaveLength(1);
    const other = await f.store.createUser("Foreign reader");
    await expect(read(input, context(other))).rejects.toMatchObject({ code: "forbidden" });
    await f.database
      .updateTable("threads")
      .set({ createdBy: other })
      .where("id", "=", run.threadId)
      .execute();
    await expect(read(input, context(run.userId))).rejects.toMatchObject({ code: "not_found" });
  });
});
