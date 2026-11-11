import { createId } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect } from "vitest";
import { createProjectIdentityFixture } from "./project-work.test-support.js";
import { describeStore } from "./store.integration.test-support.js";
import { TeamAccessReadStore } from "./team-access-read-store.js";
import { prepareTeamComputerReplacement } from "./team-project-store.js";
import { mutateAccess } from "./access-store.js";

describeStore("team computer replacement", (it) => {
  it("refuses every nondeleted Project state without revoking or reading computer records", async ({
    storeFixture,
  }) => {
    const p = await createProjectIdentityFixture(storeFixture, "replacement-states");
    const queries: string[] = [];
    const database = storeFixture.database.withPlugin({
      transformQuery(args) {
        queries.push(storeFixture.database.getExecutor().compileQuery(args.node, args.queryId).sql);
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const reads = new TeamAccessReadStore(database);
    const operator = await storeFixture.store.createUser("Nonmember operator");
    await storeFixture.database
      .updateTable("users")
      .set({ admittedAt: new Date(), instanceRole: "administrator" })
      .where("id", "=", operator)
      .execute();
    const actor = { userId: operator };
    expect(
      await database
        .selectFrom("workspaceMemberships")
        .select("id")
        .where("workspaceId", "=", p.workspace.id)
        .where("userId", "=", operator)
        .execute(),
    ).toEqual([]);
    for (const status of [
      "provisioning",
      "ready",
      "archiving",
      "archived",
      "unavailable",
      "failed",
      "deleting",
    ] as const) {
      await storeFixture.database
        .updateTable("workspaces")
        .set({
          status,
          ...(status === "deleting"
            ? {
                deletionRequestedAt: new Date(),
                deletionRequestedBy: p.userId,
                purgeAfter: new Date(),
              }
            : {}),
        })
        .where("id", "=", p.workspace.id)
        .execute();
      expect((await reads.computer(actor, () => true)).can.replace, status).toEqual({
        allowed: false,
        reason: "projects-prevent-replacement",
      });
      queries.length = 0;
      await expect(
        prepareTeamComputerReplacement(database, actor, {
          commandId: createId("command"),
          expectedRevision: 1,
          expectedComputerId: p.runnerId,
        }),
        status,
      ).rejects.toMatchObject({ code: "forbidden", reason: "projects-prevent-replacement" });
      expect(
        queries.some((query) => /(?:from|update) "(?:runners|runner_enrollments)"/u.test(query)),
      ).toBe(false);
      expect(queries.some((query) => /^(?:insert|update|delete) /u.test(query))).toBe(false);
    }
    await storeFixture.database
      .updateTable("workspaces")
      .set({ status: "deleted", deletedAt: new Date() })
      .where("id", "=", p.workspace.id)
      .execute();
    expect((await reads.computer(actor, () => true)).can.replace).toEqual({ allowed: true });
    await expect(
      prepareTeamComputerReplacement(database, actor, {
        commandId: createId("command"),
        expectedRevision: 1,
        expectedComputerId: p.runnerId,
      }),
    ).resolves.toMatchObject({ accessRevision: 2, revokedComputerId: p.runnerId });
    expect(await reads.computer(actor, () => true)).toMatchObject({
      computer: null,
      can: { replace: { allowed: true } },
    });
    await expect(
      prepareTeamComputerReplacement(database, actor, {
        commandId: createId("command"),
        expectedRevision: 2,
        expectedComputerId: null,
      }),
    ).resolves.toMatchObject({ accessRevision: 3, revokedComputerId: null });
  });

  for (const first of ["create", "replace"] as const) {
    it(`serializes Project creation against replacement with ${first} holding the writer`, async ({
      storeFixture,
    }) => {
      const p = await createProjectIdentityFixture(storeFixture, `replacement-race-${first}`);
      const database = storeFixture.database;
      await database
        .updateTable("workspaces")
        .set({ status: "deleted", deletedAt: new Date() })
        .where("id", "=", p.workspace.id)
        .execute();
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const contender = Promise.withResolvers<void>();
      const fences = new Set<unknown>();
      const leader = database.withPlugin({
        transformQuery(args) {
          const text = database.getExecutor().compileQuery(args.node, args.queryId).sql;
          if (text.includes("pg_advisory_xact_lock") && text.includes("opensteer:access-writer"))
            fences.add(args.queryId);
          return args.node;
        },
        async transformResult(args) {
          if (fences.delete(args.queryId)) {
            held.resolve();
            await withTimeout(release.promise, 5000, {
              timeoutError: () => new Error("Replacement race writer was not released"),
            });
          }
          return args.result;
        },
      });
      const follower = database.withPlugin({
        transformQuery(args) {
          const text = database.getExecutor().compileQuery(args.node, args.queryId).sql;
          if (text.includes("pg_advisory_xact_lock") && text.includes("opensteer:access-writer"))
            contender.resolve();
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      });
      const actor = { userId: p.userId };
      const projectId = createId("workspace");
      const create = {
        actor,
        expectedRevision: first === "replace" ? 2 : 1,
        commandIdentity: createId("command"),
        changes: [
          {
            kind: "create-project" as const,
            workspaceId: projectId,
            entryId: randomUUID(),
            name: "Concurrent Project",
            color: "blue" as const,
            backing: {
              kind: "local-directory" as const,
              bindingId: createId("workspaceBinding"),
              generation: 1,
              ownerEnvironmentId: p.environmentId,
              storageAuthorityId: null,
            },
          },
        ],
      };
      const replace = {
        commandId: createId("command"),
        expectedRevision: 1,
        expectedComputerId: p.runnerId,
      };
      const winner = Promise.allSettled([
        first === "create"
          ? mutateAccess(leader, create)
          : prepareTeamComputerReplacement(leader, actor, replace),
      ]);
      let loser: typeof winner | undefined;
      try {
        await withTimeout(held.promise, 3000, {
          timeoutError: () => new Error("First replacement race writer never acquired its lock"),
        });
        loser = Promise.allSettled([
          first === "create"
            ? prepareTeamComputerReplacement(follower, actor, replace)
            : mutateAccess(follower, create),
        ]);
        await withTimeout(contender.promise, 3000, {
          timeoutError: () =>
            new Error("Contending replacement race writer never attempted its lock"),
        });
      } finally {
        release.resolve();
        await withTimeout(Promise.all([winner, loser]), 10000, {
          timeoutError: () =>
            new Error("Replacement race writers did not settle after releasing the barrier"),
        });
      }
      expect((await winner)[0]?.status).toBe("fulfilled");
      if (loser === undefined)
        throw new Error("Contending replacement race writer was not started");
      const outcome = (await loser)[0];
      if (outcome?.status !== "rejected")
        throw new Error("Both replacement race writers committed");
      expect(outcome.reason).toMatchObject({
        reason: first === "create" ? "projects-prevent-replacement" : "team-object-unavailable",
      });
      expect(
        await database.selectFrom("workspaces").select("id").where("id", "=", projectId).execute(),
      ).toHaveLength(first === "create" ? 1 : 0);
      expect(
        (
          await database
            .selectFrom("runners")
            .select("revokedAt")
            .where("id", "=", p.runnerId)
            .executeTakeFirstOrThrow()
        ).revokedAt,
      ).toEqual(first === "create" ? null : expect.any(Date));
      if (first === "replace")
        await expect(
          mutateAccess(database, { ...create, commandIdentity: createId("command") }),
        ).rejects.toMatchObject({
          reason: "team-object-unavailable",
        });
    });
  }
});
