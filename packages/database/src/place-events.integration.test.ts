import { BrowserSessionIdSchema, BrowserSurfaceIdSchema, createId } from "@opensteer/core";
import { PendingAgentEventSchema, WorkspaceSnapshotSchema } from "@opensteer/protocol";
import { expect } from "vitest";
import { OpensteerStore } from "./store.js";
import {
  describeStore,
  pendingEvent,
  testModelSelection,
  testContinuationIdentity,
} from "./store.integration.test-support.js";

describeStore("durable Run place entries", (it) => {
  it("deduplicates only the last place across restarts, pages negotiated history and fences terminal Runs", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("place-entries");
    const a = {
      kind: "browser" as const,
      sessionId: BrowserSessionIdSchema.parse("bsn_11111111-1111-4111-8111-111111111111"),
      surfaceId: BrowserSurfaceIdSchema.parse("A"),
    };
    const b = { ...a, surfaceId: BrowserSurfaceIdSchema.parse("B") };
    const input = {
      runId: f.run.id,
      bindingGeneration: f.bindingGeneration,
      data: {
        place: a,
        title: ("A".repeat(255) + "😀").slice(0, 256),
        site: "https://example.com",
      },
    };
    const first = await store.recordRunPlace(input);
    expect(first).toMatchObject({
      type: "place.entered",
      threadId: f.thread.id,
      workspaceId: f.workspace.id,
      environmentId: f.environmentId,
    });
    expect(
      await store.recordRunPlace({ ...input, data: { ...input.data, title: "Navigated" } }),
    ).toBeUndefined();
    expect(await new OpensteerStore(database).recordRunPlace(input)).toBeUndefined();
    const second = await store.recordRunPlace({ ...input, data: { ...input.data, place: b } });
    const third = await store.recordRunPlace(input);
    expect(await new OpensteerStore(database).latestRunPlace(f.run.id)).toEqual(third);
    expect([first, second, third].every(Boolean)).toBe(true);
    expect(BigInt(first!.sequence)).toBeLessThan(BigInt(second!.sequence));
    expect(BigInt(second!.sequence)).toBeLessThan(BigInt(third!.sequence));
    expect(
      await store.recordRunPlace({
        ...input,
        bindingGeneration: f.bindingGeneration + 1,
        data: { ...input.data, place: b },
      }),
    ).toBeUndefined();
    const hidden = await store.threadEventPageForOwner({
      ownerId: f.userId,
      threadId: f.thread.id,
    });
    expect(hidden!.events.some((event) => event.type === "place.entered")).toBe(false);
    const visible = await store.threadEventPageForOwner({
      ownerId: f.userId,
      threadId: f.thread.id,
      placeEvents: "include",
      maxItems: 2,
    });
    expect(visible!.events.map((event) => event.eventId)).toEqual([
      second!.eventId,
      third!.eventId,
    ]);
    expect(visible!.window.hasMore).toBe(true);
    const older = await store.threadEventPageForOwner({
      ownerId: f.userId,
      threadId: f.thread.id,
      placeEvents: "include",
      before: visible!.window.nextBefore!,
      maxItems: 2,
    });
    expect(older!.events).toContainEqual(first);
    const storedPlace = older!.events.find((event) => event.eventId === first!.eventId);
    expect(storedPlace).toMatchObject({
      type: "place.entered",
      data: { title: "A".repeat(255) + "\uFFFD" },
    });
    if (storedPlace?.type !== "place.entered")
      throw new Error("Stored place event was not returned");
    expect(storedPlace.data.title.isWellFormed()).toBe(true);
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "place-worker",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.thread.id },
      task: [{ type: "text", text: "Inspect the page" }],
      title: "Page worker",
      workspaceId: f.workspace.id,
    });
    await store.claimCommand(delegated.command.id, "place-worker-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: f.harnessInstance.id,
      leaseTokenHash: "place-worker-lease",
      membershipGeneration: 1,
      runnerBootId: "place-worker-boot",
      runnerId: f.runnerId,
      runId: delegated.run.id,
      threadId: delegated.thread.id,
    });
    await expect(
      store.resolvePlaceActors({
        agentBindingIds: [`run:${f.run.id}`],
        ownerIds: [f.userId],
      }),
    ).resolves.toMatchObject([{ threadId: f.thread.id, home: false }]);
    // Unlisted non-call workers without an Assignment stay unrepresented.
    await database
      .updateTable("threads")
      .set({ listed: false })
      .where("id", "=", f.thread.id)
      .execute();
    await expect(
      store.resolvePlaceActors({
        agentBindingIds: [`run:${f.run.id}`],
        ownerIds: [f.userId],
      }),
    ).resolves.toEqual([]);
    await database
      .updateTable("threads")
      .set({ listed: true })
      .where("id", "=", f.thread.id)
      .execute();
    const actors = await store.resolvePlaceActors({
      agentBindingIds: [`run:${delegated.run.id}`],
      ownerIds: [f.userId],
    });
    expect(actors[0]?.threadId).toBe(f.thread.id);
    expect(
      await store.recordRunPlace({
        ...input,
        runId: delegated.run.id,
        bindingGeneration: binding.bindingGeneration,
      }),
    ).toMatchObject({ threadId: delegated.thread.id, runId: delegated.run.id });
    const appPlace = {
      place: { kind: "app" as const, machineId: f.runnerId, appKey: "com.apple.Notes" },
      title: "Notes",
      site: null,
    };
    const native = await store.recordRunPlace({ ...input, data: appPlace });
    const phone = await store.recordRunPlace({
      ...input,
      runId: delegated.run.id,
      bindingGeneration: binding.bindingGeneration,
      data: {
        place: { kind: "phone", machineId: f.runnerId, display: "main" },
        title: "Phone",
        site: null,
      },
    });
    const seedOptions = {
      viewerId: f.userId,
      placeEvents: "include" as const,
      listedOnly: true,
      omitMessages: true,
      maxThreads: 1,
    };
    let placeQueries = 0;
    const observed = new OpensteerStore(
      database.withPlugin({
        transformQuery({ node }) {
          if (JSON.stringify(node).includes('"name":"workspace_events"')) placeQueries += 1;
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      }),
    );
    const seeded = await observed.workspaceSnapshot(f.workspace.id, seedOptions);
    expect(placeQueries).toBe(1);
    expect(seeded.runPlaces).toEqual([phone, native]);
    expect(seeded.threads).toHaveLength(1);
    expect(WorkspaceSnapshotSchema.safeParse(seeded).success).toBe(true);
    expect(seeded.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(seeded)));
    expect(
      await observed.workspaceSnapshot(f.workspace.id, { viewerId: f.userId }),
    ).not.toHaveProperty("runPlaces");
    expect(placeQueries).toBe(1);
    const outsider = await store.createUser("Outsider");
    expect(
      (await store.workspaceSnapshot(f.workspace.id, { ...seedOptions, viewerId: outsider }))
        .runPlaces,
    ).toEqual([]);
    const membership = await database
      .selectFrom("workspaceMemberships")
      .selectAll()
      .where("workspaceId", "=", f.workspace.id)
      .where("userId", "=", f.userId)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("workspaceMemberships")
      .values({
        ...membership,
        id: createId("workspaceMembership"),
        userId: outsider,
        state: "revoked",
        role: "collaborator",
        revokedAt: new Date(),
        revokedBy: f.userId,
      })
      .execute();
    expect(
      (await store.workspaceSnapshot(f.workspace.id, { ...seedOptions, viewerId: outsider }))
        .runPlaces,
    ).toEqual([]);
    const baseline = await store.workspaceSnapshot(f.workspace.id, {
      viewerId: f.userId,
      listedOnly: true,
      omitMessages: true,
      maxThreads: 1,
    });
    const bounded = await store.workspaceSnapshot(f.workspace.id, {
      ...seedOptions,
      maxSerializedBytes: baseline.serializedBytes + 20,
    });
    expect(bounded.serializedBytes).toBeLessThanOrEqual(baseline.serializedBytes + 20);
    // Missing Runs in a complete seed are terminal; a budget-limited seed must stay unknown.
    expect(bounded).not.toHaveProperty("runPlaces");
    expect(bounded.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(bounded)));
    const terminalEvent = pendingEvent({
      bindingGeneration: f.bindingGeneration,
      data: { status: "completed" },
      environmentId: f.environmentId,
      ordinal: 1,
      runId: f.run.id,
      threadId: f.thread.id,
      type: "run.completed",
      workspaceId: f.workspace.id,
    });
    expect(
      PendingAgentEventSchema.safeParse({
        ...terminalEvent,
        type: "place.entered",
        data: input.data,
      }).success,
    ).toBe(false);
    const terminal = await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: terminalEvent,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    expect(BigInt(third!.sequence)).toBeLessThan(BigInt(terminal.event.sequence));
    expect((await store.workspaceSnapshot(f.workspace.id, seedOptions)).runPlaces).toEqual([phone]);
    expect(
      await store.recordRunPlace({ ...input, data: { ...input.data, place: b } }),
    ).toBeUndefined();
  });
});
