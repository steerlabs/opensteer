import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { BrowserSessionIdSchema } from "@opensteer/core";
import { PendingAgentEventSchema } from "@opensteer/protocol";
import { expect } from "vitest";
import { OpensteerStore } from "./store.js";
import { readTranscriptPage, readTranscriptItem } from "./personal-sync-store.js";
import { readPersonalDetailSnapshot } from "./snapshot-store.js";
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
    const b = {
      ...a,
      surfaceId: BrowserSurfaceIdSchema.parse("B"),
    };
    const input = {
      runId: f.run.id,
      bindingGeneration: f.bindingGeneration,
      data: {
        tabId: a.surfaceId,
        title: ("A".repeat(255) + "😀").slice(0, 256),
        site: "https://example.com",
      },
    };
    expect(await store.recordRunTabPlace(input)).toBe(true);
    expect(
      await store.recordRunTabPlace({
        ...input,
        data: { ...input.data, title: "Navigated" },
      }),
    ).toBe(false);
    expect(await new OpensteerStore(database).recordRunTabPlace(input)).toBe(false);
    expect(
      await store.recordRunTabPlace({
        ...input,
        data: { ...input.data, tabId: b.surfaceId },
      }),
    ).toBe(true);
    expect(await store.recordRunTabPlace(input)).toBe(true);
    expect(await new OpensteerStore(database).latestRunPlace(f.run.id)).toMatchObject({
      tabId: a.surfaceId,
    });
    expect(
      await store.recordRunTabPlace({
        ...input,
        bindingGeneration: f.bindingGeneration + 1,
      }),
    ).toBe(false);

    const scope = { kind: "thread", threadId: f.thread.id } as const;
    const page = await readTranscriptPage(database, { viewerId: f.userId, scope, limit: 2 });
    if (page.kind !== "page") throw new Error("Expected a place page");
    expect(page.items.map(({ kind }) => kind)).toEqual(["place", "place"]);
    expect(page.hasMore).toBe(true);
    const older = await readTranscriptPage(database, {
      viewerId: f.userId,
      scope,
      cursor: page.nextBefore!,
    });
    if (older.kind !== "page") throw new Error("Expected an older place page");
    const firstPlace = older.items.find(({ kind }) => kind === "place")!;
    const stored = await readTranscriptItem(database, {
      viewerId: f.userId,
      scope,
      itemId: firstPlace.id,
    });
    expect(stored).toMatchObject({
      kind: "item",
      body: { kind: "place", place: { tabId: a.surfaceId, site: input.data.site } },
    });
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "place-worker",
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: f.run.id,
        parentThreadId: f.thread.id,
      },
      task: [
        {
          type: "text",
          text: "Inspect the page",
        },
      ],
      title: "Page worker",
    });
    await store.claimCommand(delegated.command.id, "place-worker-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: f.harnessInstance.id,
      leaseTokenHash: "place-worker-lease",
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
    ).resolves.toMatchObject([
      {
        threadId: f.thread.id,
      },
    ]);
    // Unlisted non-call workers without an Assignment stay unrepresented.
    await database
      .updateTable("threads")
      .set({
        listed: false,
      })
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
      .set({
        listed: true,
      })
      .where("id", "=", f.thread.id)
      .execute();
    const actors = await store.resolvePlaceActors({
      agentBindingIds: [`run:${delegated.run.id}`],
      ownerIds: [f.userId],
    });
    expect(actors[0]?.threadId).toBe(f.thread.id);
    expect(
      await store.recordRunTabPlace({
        ...input,
        runId: delegated.run.id,
        bindingGeneration: binding.bindingGeneration,
      }),
    ).toBe(true);
    const appPlace = {
      tabId: BrowserSurfaceIdSchema.parse("native-tab"),
      title: "Notes",
      site: null,
    };
    await store.recordRunTabPlace({
      ...input,
      data: appPlace,
    });
    await store.recordRunTabPlace({
      ...input,
      runId: delegated.run.id,
      bindingGeneration: binding.bindingGeneration,
      data: {
        tabId: BrowserSurfaceIdSchema.parse("phone-tab"),
        title: "Phone",
        site: null,
      },
    });
    const cut = await readPersonalDetailSnapshot(database, { viewerId: f.userId, scope });
    if (cut.kind !== "snapshot") throw new Error("Expected task detail");
    expect(cut.snapshot).toMatchObject({ thread: { latestPlace: appPlace } });
    expect(Buffer.byteLength(JSON.stringify(cut.snapshot))).toBeLessThanOrEqual(128 * 1024);
    const outsider = await store.createUser("Outsider");
    await expect(
      readPersonalDetailSnapshot(database, { viewerId: outsider, scope }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await store.latestRunPlace(delegated.run.id)).toMatchObject({
      title: "Phone",
      site: null,
    });
    const terminalEvent = pendingEvent({
      bindingGeneration: f.bindingGeneration,
      data: {
        status: "completed",
      },
      environmentId: f.environmentId,
      ordinal: 1,
      runId: f.run.id,
      threadId: f.thread.id,
      type: "run.completed",
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
    expect(terminal.throughOrdinal).toBe(1);
    expect(
      await store.recordRunTabPlace({
        ...input,
        data: {
          ...input.data,
          tabId: b.surfaceId,
        },
      }),
    ).toBe(false);
  });
});
