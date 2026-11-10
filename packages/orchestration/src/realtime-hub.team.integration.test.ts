import { createId, zeroSequence } from "@opensteer/core";
import { describeStore } from "@opensteer/database/test-support/store";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, vi } from "vitest";
import type { HostToClientMessage } from "@opensteer/protocol";
import { RealtimeHub } from "./realtime-hub.js";

function memorySink() {
  const messages: HostToClientMessage[] = [];
  const close = vi.fn();
  return {
    messages,
    close,
    id: crypto.randomUUID(),
    send: async (message: HostToClientMessage) => {
      messages.push(message);
    },
  };
}

describeStore("team realtime incarnations", (it) => {
  it("refuses removal between snapshot and replay and preserves a rejoined subscription during old cleanup", async ({
    storeFixture,
  }) => {
    const run = await storeFixture.createRunFixture("realtime-incarnation", null, "project");
    const { database, store } = storeFixture;
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", run.userId)
      .execute();
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = store.workspaceSnapshot.bind(store);
    const snapshot = vi
      .spyOn(store, "workspaceSnapshot")
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        ready.resolve();
        await withTimeout(release.promise, 5000, {
          timeoutError: () => new Error("Snapshot barrier was never released"),
        });
        return result;
      });
    const hub = new RealtimeHub({ store });
    const oldSink = memorySink();
    const pending = hub.subscribe({
      userId: run.userId,
      workspaceId: run.workspace.id,
      afterSequence: zeroSequence,
      sink: oldSink,
    });
    const refused = expect(pending).rejects.toMatchObject({ code: "forbidden" });
    try {
      await withTimeout(ready.promise, 5000, {
        timeoutError: () => new Error("Snapshot was never captured"),
      });
      await database
        .updateTable("workspaceMemberships")
        .set({ state: "revoked", generation: 2, revokedAt: new Date(), revokedBy: run.userId })
        .where("workspaceId", "=", run.workspace.id)
        .where("userId", "=", run.userId)
        .execute();
    } finally {
      release.resolve();
    }
    await refused;
    expect(oldSink.messages).toEqual([]);
    snapshot.mockRestore();
    await database
      .updateTable("workspaceMemberships")
      .set({ state: "active", generation: 3, revokedAt: null, revokedBy: null })
      .where("workspaceId", "=", run.workspace.id)
      .where("userId", "=", run.userId)
      .execute();
    const fresh = memorySink();
    const unsubscribe = await hub.subscribe({
      userId: run.userId,
      workspaceId: run.workspace.id,
      afterSequence: zeroSequence,
      sink: fresh,
    });
    hub.closeUserWorkspace(run.userId, run.workspace.id, 1);
    expect(fresh.close).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("fences host-level and command-result sinks by the captured session generation", async ({
    storeFixture,
  }) => {
    const run = await storeFixture.createRunFixture("realtime-global", null, "project");
    const { database, store } = storeFixture;
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", run.userId)
      .execute();
    const sessionId = createId("authSession");
    const now = new Date();
    await database
      .insertInto("authSessions")
      .values({
        id: sessionId,
        userId: run.userId,
        token: "test-session",
        expiresAt: new Date(now.getTime() + 86_400_000),
        absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        deviceLabel: "Test",
        memberGeneration: "1",
        ipAddress: null,
        userAgent: null,
      })
      .execute();
    const hub = new RealtimeHub({ store });
    const sink = memorySink();
    const guarded = hub.fenceConnectionSink(run.userId, sessionId, sink);
    await guarded.send({ type: "host.tasks-changed" });
    await database
      .updateTable("users")
      .set({ authorityGeneration: 2 })
      .where("id", "=", run.userId)
      .execute();
    await expect(guarded.send({ type: "host.tasks-changed" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(sink.messages).toHaveLength(1);
    expect(sink.close).toHaveBeenCalledWith(4003, "Access revoked");
  });
});
