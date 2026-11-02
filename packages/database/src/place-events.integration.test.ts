import { BrowserSessionIdSchema, BrowserSurfaceIdSchema } from "@opensteer/core";
import { PendingAgentEventSchema } from "@opensteer/protocol";
import { expect } from "vitest";
import { OpensteerStore } from "./store.js";
import {
  describeStore,
  pendingEvent,
  testModelSelection,
  testContinuationIdentity,
} from "./store.integration.test-support.js";

describeStore("durable browser place entries", (it) => {
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
      data: { place: a, title: "A", site: "https://example.com" },
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
    expect(
      await store.recordRunPlace({ ...input, data: { ...input.data, place: b } }),
    ).toBeUndefined();
  });
});
