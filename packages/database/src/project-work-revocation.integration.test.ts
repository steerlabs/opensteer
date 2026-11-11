import { expect } from "vitest";
import { failActiveRunsForAccessRevocation } from "./execution-recovery.js";
import { threadPathLinks } from "./store-primitives.js";
import type { AgentEvent, RunId } from "@opensteer/core";
import { describeStore } from "./store.integration.test-support.js";
import { prepareProjectAdmission, projectWatchWorkSource } from "./project-work.test-support.js";
import {
  ProjectWorkRevocationStore,
  type ProjectWorkRevocationRoot,
} from "./project-work-revocation.js";
import { ProjectWorkStopStore } from "./run-finalization.js";

describeStore("Project captured-root revocation", (it) => {
  it("does not cancel a re-added membership or a re-enabled global incarnation, including queued inputs without a Run", async ({
    storeFixture,
  }) => {
    const context = await prepareProjectAdmission(storeFixture);
    const { database, project, prepared, store, origin } = context;
    const admit = async (suffix: string, root = origin) => {
      const target = suffix.startsWith("old")
        ? prepared.thread
        : (
            await store.createProjectThread({
              workspaceId: project.workspace.id,
              origin: root,
              title: suffix,
              role: "work",
              home: false,
              idempotencyKey: suffix,
            })
          ).thread;
      return store.admitProjectWork({
        threadId: target.id,
        origin: root,
        source: { kind: "human" },
        content: [{ type: "text", text: suffix }],
        policy: "queue",
        idempotencyKey: suffix,
      });
    };
    const old = await admit("old");
    const orphan = await admit("old-without-run");
    await database
      .updateTable("threadInputs")
      .set({ runId: null })
      .where("messageId", "=", orphan.input.messageId)
      .execute();
    await database
      .updateTable("workspaceMemberships")
      .set({ generation: "3" })
      .where("workspaceId", "=", project.workspace.id)
      .where("userId", "=", origin.userId)
      .execute();
    const readded = await admit("re-added", { ...origin, membershipGeneration: 3 });
    await database
      .updateTable("users")
      .set({ authorityGeneration: "3" })
      .where("id", "=", origin.userId)
      .execute();
    const reenabled = await admit("re-enabled", {
      ...origin,
      membershipGeneration: 3,
      initiatorGeneration: 3,
    });
    const { source } = await projectWatchWorkSource(context, "unattended");
    const unattended = await store.admitProjectWork({
      threadId: prepared.thread.id,
      origin: null,
      source,
      content: [{ type: "text", text: "unattended" }],
      policy: "queue",
      idempotencyKey: "unattended",
    });
    const events: AgentEvent[] = [];
    const work = new ProjectWorkStopStore((_transaction, committed) => events.push(...committed));
    const adapter = new ProjectWorkRevocationStore({
      work,
      requests: {
        async discover() {
          return { runIds: [], workspaceIds: [] };
        },
        async cancel() {},
      },
    });
    const cancel = (roots: readonly ProjectWorkRevocationRoot[]) =>
      database.transaction().execute(async (transaction) => {
        const scope = await adapter.discover(transaction, roots);
        if (scope.runIds.length)
          await transaction
            .selectFrom("runs")
            .select("id")
            .where("id", "in", [...scope.runIds])
            .orderBy("id")
            .forNoKeyUpdate()
            .execute();
        if (scope.workspaceIds.length)
          await transaction
            .selectFrom("workspaces")
            .select("id")
            .where("id", "in", [...scope.workspaceIds])
            .orderBy("id")
            .forNoKeyUpdate()
            .execute();
        await adapter.discover(transaction, roots);
        await adapter.cancel(transaction, roots);
      });
    await cancel([
      {
        kind: "membership",
        userId: origin.userId,
        workspaceId: project.workspace.id,
        membershipGenerationCutoff: 1,
      },
    ]);
    const state = async (runId: RunId | null) =>
      runId
        ? (
            await database
              .selectFrom("runs")
              .select("status")
              .where("id", "=", runId)
              .executeTakeFirstOrThrow()
          ).status
        : null;
    expect(await state(old.runId)).toBe("failed");
    expect(
      (
        await database
          .selectFrom("threadInputs")
          .select("state")
          .where("messageId", "=", orphan.input.messageId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("cancelled");
    expect(await state(readded.runId)).toBe("queued");
    expect(await state(reenabled.runId)).toBe("queued");
    const bounded = await failActiveRunsForAccessRevocation(database, threadPathLinks, {
      userId: origin.userId,
      workspaceId: project.workspace.id,
      membershipGenerationCutoff: 3,
      initiatorGenerationCutoff: 1,
    });
    expect(bounded.terminatedRuns.map((row) => row.runId)).toEqual([readded.runId]);
    events.push(...bounded.events);
    await cancel([{ kind: "member", userId: origin.userId, memberGenerationCutoff: 1 }]);
    expect(await state(readded.runId)).toBe("failed");
    expect(await state(reenabled.runId)).toBe("queued");
    expect(
      (
        await database
          .selectFrom("threadInputs")
          .select("state")
          .where("messageId", "=", unattended.input.messageId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("pending");
    expect(
      (
        await database
          .selectFrom("threadInputs")
          .select("state")
          .where("messageId", "=", reenabled.input.messageId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("pending");
    expect(events.filter((event) => event.type === "run.failed")).toHaveLength(2);
  });

  it("selects connection work independently and requires discovery before the authority writer changes state", async ({
    storeFixture,
  }) => {
    const { database, project, prepared, store, origin } =
      await prepareProjectAdmission(storeFixture);
    // The connection is a captured immutable field; direct inserts below only change fixtures before admission.
    const { randomUUID } = await import("node:crypto");
    const connectionId = `mcn_${randomUUID()}`;
    const now = new Date();
    await database
      .insertInto("agentConnections")
      .values({
        id: connectionId,
        userId: origin.userId,
        label: "Scoped agent",
        clientName: "test",
        accessMode: "full-access",
        workspaceId: project.workspace.id,
        resource: "https://test-host.invalid/mcp",
        tokenHash: null,
        lastUsedAt: null,
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: null,
        memberGeneration: "1",
        membershipGeneration: "1",
        createdAt: now,
      })
      .execute();
    const direct = await store.admitProjectWork({
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" },
      content: [{ type: "text", text: "direct" }],
      policy: "queue",
      idempotencyKey: "direct",
    });
    const target = (
      await store.createProjectThread({
        workspaceId: project.workspace.id,
        origin,
        title: "Connection task",
        role: "work",
        home: false,
        idempotencyKey: "connection-thread",
      })
    ).thread;
    const connected = await store.admitProjectWork({
      threadId: target.id,
      origin: { ...origin, originConnectionId: connectionId },
      source: { kind: "connection", connectionId },
      content: [{ type: "text", text: "connected" }],
      policy: "queue",
      idempotencyKey: "connected",
    });
    if (!connected.runId || !direct.runId) throw new Error("Connection fixture Runs are missing");
    const connectedRunId = connected.runId;
    const directRunId = direct.runId;
    const work = new ProjectWorkStopStore(() => {});
    const adapter = new ProjectWorkRevocationStore({
      work,
      requests: {
        async discover() {
          return { runIds: [], workspaceIds: [] };
        },
        async cancel() {},
      },
    });
    const roots: readonly ProjectWorkRevocationRoot[] = [
      {
        kind: "connection",
        userId: origin.userId,
        workspaceId: project.workspace.id,
        connectionId,
        memberGenerationCutoff: 1,
        membershipGenerationCutoff: 1,
      },
    ];
    await expect(
      database.transaction().execute((transaction) => adapter.cancel(transaction, roots)),
    ).rejects.toMatchObject({ name: "Error" });
    await database.transaction().execute(async (transaction) => {
      const scope = await adapter.discover(transaction, roots);
      expect(scope.runIds).toEqual([connected.runId]);
      await transaction
        .selectFrom("runs")
        .select("id")
        .where("id", "in", [...scope.runIds])
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("workspaces")
        .select("id")
        .where("id", "in", [...scope.workspaceIds])
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      await adapter.cancel(transaction, roots);
    });
    expect(
      (
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", connectedRunId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("failed");
    expect(
      (
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", directRunId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("queued");
  });
});
