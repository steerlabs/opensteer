import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { mutateAccess } from "./access-store.js";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { expect } from "vitest";
import { OpensteerStore } from "./store.js";
import {
  describeStore,
  pendingEvent,
  testContinuationIdentity,
} from "./store.integration.test-support.js";

// Classification remains held back: expiry itself must refuse renewal, events
// and tools. An ordinary refused event must not consume its Runner ordinal;
// the explicit lease-lost report must remain admissible for classification.
describeStore("execution lease clock", (it) => {
  it("preserves model-1 renewal acceptance across the legacy membership-generation race", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.startRunFixture("legacy-renewal-race");
    const session = await storeFixture.database
      .selectFrom("providerSessions")
      .selectAll()
      .where("id", "=", fixture.run.providerSessionId)
      .executeTakeFirstOrThrow();
    await storeFixture.database
      .updateTable("workspaceMemberships")
      .set({ generation: 2 })
      .where("workspaceId", "=", fixture.workspace.id)
      .execute();
    expect(
      await storeFixture.store.renewExecutionBinding({
        bindingGeneration: fixture.bindingGeneration,
        leaseExpiresAt: new Date(Date.now() + 120_000),
        leaseTokenHash: session.leaseTokenHash!,
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
      }),
    ).toBe(true);
  });
  for (const mode of ["single", "bulk"] as const)
    it(`serializes ${mode} renewal with a shortening while the session fence is held`, async ({
      storeFixture,
    }) => {
      const { database } = storeFixture;
      const fixture = await storeFixture.startRunFixture(`locked-${mode}-deadline`, "project");
      const oldDeadline = new Date(Date.now() + 20 * 60_000),
        newDeadline = new Date(Date.now() + 60_000);
      await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
      await database
        .updateTable("users")
        .set({ admittedAt: new Date(), instanceRole: "administrator" })
        .where("id", "=", fixture.userId)
        .execute();
      await database
        .updateTable("workspaceMemberships")
        .set({ effectiveUntil: oldDeadline })
        .where("workspaceId", "=", fixture.workspace.id)
        .execute();
      const entryId = randomUUID();
      await database
        .insertInto("accessEntries")
        .values({
          id: entryId,
          subjectKind: "user",
          subjectId: fixture.userId,
          targetKind: "project",
          targetId: fixture.workspace.id,
          level: "manage",
          grantedBy: fixture.userId,
          expiresAt: oldDeadline,
        })
        .execute();
      const session = await database
        .selectFrom("providerSessions")
        .selectAll()
        .where("id", "=", fixture.run.providerSessionId)
        .executeTakeFirstOrThrow();
      const held = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>(),
        attempting = Promise.withResolvers<void>(),
        authority = Promise.withResolvers<void>();
      const holder = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("providerSessions")
          .select("id")
          .where("id", "=", session.id)
          .forNoKeyUpdate()
          .execute();
        held.resolve();
        await withTimeout(release.promise, 3000, {
          timeoutError: () => new Error("Session fence was not released"),
        });
      });
      let renewal: Promise<unknown> | undefined, mutation: Promise<unknown> | undefined;
      try {
        await withTimeout(held.promise, 1000, {
          timeoutError: () => new Error("Session fence was never acquired"),
        });
        const measured = database.withPlugin({
          transformQuery(args) {
            const text = JSON.stringify(args.node);
            if (
              args.node.kind === "SelectQueryNode" &&
              text.includes('"name":"workspace_memberships"') &&
              text.includes("ForShare")
            )
              authority.resolve();
            if (
              text.includes('"name":"provider_sessions"') &&
              (args.node.kind === "UpdateQueryNode" || text.includes("ForNoKeyUpdate"))
            )
              attempting.resolve();
            return args.node;
          },
          async transformResult(args) {
            return args.result;
          },
        });
        const store = await OpensteerStore.create(measured);
        const input = {
          bindingGeneration: fixture.bindingGeneration,
          leaseExpiresAt: new Date(Date.now() + 15 * 60_000),
          leaseTokenHash: session.leaseTokenHash!,
          runnerBootId: fixture.runnerBootId,
          runnerId: fixture.runnerId,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
        };
        renewal =
          mode === "single"
            ? store.renewExecutionBinding(input)
            : store.renewActiveExecutionBindings({ ...input, activeRunIds: [fixture.run.id] });
        await withTimeout(attempting.promise, 1000, {
          timeoutError: () => new Error("Renewal never reached the held session fence"),
        });
        await withTimeout(authority.promise, 1000, {
          timeoutError: () =>
            new Error("Renewal did not reserve membership before the session fence"),
        });
        mutation = mutateAccess(database, {
          actor: { userId: fixture.userId },
          expectedRevision: 1,
          commandIdentity: createId("command"),
          changes: [
            { kind: "revoke", entryId },
            {
              kind: "grant",
              id: randomUUID(),
              subject: { kind: "person", userId: fixture.userId },
              target: { kind: "project", workspaceId: fixture.workspace.id },
              level: "manage",
              expiresAt: newDeadline,
            },
          ],
        });
        release.resolve();
        expect(await renewal).toEqual(mode === "single" ? true : [fixture.run.id]);
        expect(await mutation).toMatchObject({ transitions: [] });
        const current = await database
          .selectFrom("providerSessions")
          .select("leaseExpiresAt")
          .where("id", "=", session.id)
          .executeTakeFirstOrThrow();
        expect(current.leaseExpiresAt).toEqual(newDeadline);
        expect(
          (await store.workspaceMembershipForUser(fixture.workspace.id, fixture.userId))
            ?.generation,
        ).toBe(1);
      } finally {
        release.resolve();
        await holder;
        await Promise.allSettled([renewal, mutation].filter((value) => value !== undefined));
      }
    });
  it("does not renew from a deadline read before authority expired", async ({ storeFixture }) => {
    const { database, startRunFixture } = storeFixture;
    const fixture = await startRunFixture("racing-membership-deadline");
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", fixture.userId)
      .execute();
    const session = await database
      .selectFrom("providerSessions")
      .selectAll()
      .where("id", "=", fixture.run.providerSessionId)
      .executeTakeFirstOrThrow();
    const reads = new Set<object>();
    let expired = false;
    const racing = await OpensteerStore.create(
      database.withPlugin({
        transformQuery(args) {
          if (
            !expired &&
            args.node.kind === "SelectQueryNode" &&
            JSON.stringify(args.node).includes('"name":"runs"')
          )
            reads.add(args.queryId);
          return args.node;
        },
        async transformResult(args) {
          if (reads.delete(args.queryId)) {
            expired = true;
            await database
              .updateTable("workspaceMemberships")
              .set({ effectiveUntil: new Date("2020-01-01") })
              .where("workspaceId", "=", fixture.workspace.id)
              .where("userId", "=", fixture.userId)
              .execute();
          }
          return args.result;
        },
      }),
    );
    expect(
      await racing.renewExecutionBinding({
        bindingGeneration: fixture.bindingGeneration,
        leaseExpiresAt: new Date(Date.now() + 120_000),
        leaseTokenHash: session.leaseTokenHash!,
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
      }),
    ).toBe(false);
    expect(
      (
        await database
          .selectFrom("providerSessions")
          .select("leaseExpiresAt")
          .where("id", "=", session.id)
          .executeTakeFirstOrThrow()
      ).leaseExpiresAt,
    ).toEqual(session.leaseExpiresAt);
  });
  it("clamps initial admission and both renewal paths to the membership deadline", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const base = await storeFixture.createRunFixture("membership-deadline");
    const deadline = new Date(Date.now() + 60_000);
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    const store = await OpensteerStore.create(database);
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", base.userId)
      .execute();
    await database
      .updateTable("workspaceMemberships")
      .set({ effectiveUntil: deadline })
      .where("workspaceId", "=", base.workspace.id)
      .where("userId", "=", base.userId)
      .execute();
    const turn = await storeFixture.enqueueHumanTrigger({
      content: [{ type: "text", text: "Deadline-bound admission" }],
      idempotencyKey: "membership-deadline-turn",
      requestedBy: base.userId,
      threadId: base.thread.id,
    });
    await store.claimCommand(turn.command.id, "membership-deadline-dispatcher");
    const runnerBootId = "membership-deadline-boot";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 120_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: base.harnessInstance.id,
      leaseTokenHash: "membership-deadline-lease",
      membershipGeneration: 1,
      runnerBootId,
      runnerId: base.runnerId,
      runId: turn.run.id,
      threadId: base.thread.id,
    });
    expect(binding.leaseExpiresAt).toBe(deadline.toISOString());
    const fixture = { ...base, ...binding, run: turn.run, runnerBootId };
    const session = await database
      .selectFrom("providerSessions")
      .selectAll()
      .where("id", "=", fixture.run.providerSessionId)
      .executeTakeFirstOrThrow();
    const input = {
      bindingGeneration: fixture.bindingGeneration,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      leaseTokenHash: session.leaseTokenHash!,
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
      runId: fixture.run.id,
      threadId: fixture.thread.id,
    };
    expect(await store.renewExecutionBinding(input)).toBe(true);
    expect(
      (
        await database
          .selectFrom("providerSessions")
          .select("leaseExpiresAt")
          .where("id", "=", session.id)
          .executeTakeFirstOrThrow()
      ).leaseExpiresAt,
    ).toEqual(deadline);
    expect(
      await store.renewActiveExecutionBindings({
        ...input,
        activeRunIds: [fixture.run.id],
      }),
    ).toEqual([fixture.run.id]);
    expect(
      (
        await database
          .selectFrom("providerSessions")
          .select("leaseExpiresAt")
          .where("id", "=", session.id)
          .executeTakeFirstOrThrow()
      ).leaseExpiresAt,
    ).toEqual(deadline);
  });
  it("refuses expired authority before classification without consuming the ordinal", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("clock-expired-authority");
    const clock = new ManualClock();
    const store = new OpensteerStore(database, { executionClock: clock });
    const binding = await database
      .selectFrom("providerSessions")
      .select(["leaseExpiresAt", "leaseTokenHash"])
      .where("id", "=", f.run.providerSessionId)
      .executeTakeFirstOrThrow();
    clock.advanceBy(binding.leaseExpiresAt!.getTime() - clock.now());
    const authority = {
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      membershipGeneration: 1,
      requestedBy: f.userId,
      runId: f.run.id,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      threadId: f.thread.id,
      workspaceId: f.workspace.id,
    };
    const single = await store.renewExecutionBinding({
      ...authority,
      leaseExpiresAt: new Date(clock.now() + 60_000),
      leaseTokenHash: binding.leaseTokenHash!,
    });
    const multiple = await store.renewActiveExecutionBindings({
      activeRunIds: [f.run.id],
      leaseExpiresAt: new Date(clock.now() + 60_000),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    expect(single).toBe(false);
    expect(multiple).toEqual([]);
    // Renewal is > now; sweep remains < now. Equality must not be normalized.
    expect((await store.recoverRunsWithExpiredExecutionBindings()).events).toEqual([]);
    clock.advanceBy(1);
    await expect(store.assertActiveGrant(authority)).rejects.toMatchObject({ code: "forbidden" });
    const eventContext = {
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      runId: f.run.id,
      threadId: f.thread.id,
      workspaceId: f.workspace.id,
    };
    const ordinary = {
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        ...eventContext,
        data: { content: [{ type: "text", text: "Too late" }], messageId: createId("message") },
        ordinal: 1,
        type: "assistant.message",
      }),
    };
    await expect(store.commitRunnerEvent(ordinary)).rejects.toMatchObject({ code: "forbidden" });
    const beforeClassification = await database
      .selectFrom("runs")
      .select(["status", "nextRunnerOrdinal"])
      .where("id", "=", f.run.id)
      .executeTakeFirstOrThrow();
    expect(beforeClassification).toEqual({ status: "running", nextRunnerOrdinal: 1 });
    const admitted = await store.commitRunnerEvent({
      ...ordinary,
      event: pendingEvent({
        ...eventContext,
        data: { status: "interrupted", cause: "lease-lost" },
        ordinal: 1,
        type: "run.interrupted",
      }),
    });
    expect(admitted.wasDuplicate).toBe(false);
    const directory = await mkdtemp(join(tmpdir(), "opensteer-execution-clock-"));
    await writeFile(
      join(directory, "authority.json"),
      JSON.stringify(
        {
          domainNow: clock.now(),
          originalLeaseExpiresAt: binding.leaseExpiresAt,
          singleRenewal: single,
          renewedRuns: multiple,
          beforeClassification,
          leaseLostAdmitted: true,
        },
        null,
        2,
      ) + "\n",
    );
    console.info(`Expired execution authority evidence: ${directory}`);
  });
});
