import { randomUUID } from "node:crypto";
import { createId, type AccessMutation, type UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { createDatabase } from "./connection.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";
import { migrateToLatest, migrationProvider } from "./migrations.js";
import { expect } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createTestWorkspace } from "./workspace-fixture.test-support.js";
import { lockWorkspaceRow, requireActiveWorkspaceMembership } from "./store-primitives.js";
import { testModelSelection } from "./store.integration.test-support.js";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";
import type { DatabaseSchema } from "./schema.js";
import { checkAccess, expireAccessMemberships, mutateAccess } from "./access-store.js";
import { createAccessExpiryScheduler } from "./access-expiry.js";

async function setup(fixture: StoreFixture) {
  const run = await fixture.createRunFixture("access", null, "project");
  await fixture.database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
  await fixture.database
    .updateTable("users")
    .set({ instanceRole: "administrator", admittedAt: new Date() })
    .where("id", "=", run.userId)
    .execute();
  let revision = 1;
  const mutate = async (change: AccessMutation) => {
    revision = Number(
      (
        await fixture.database
          .selectFrom("accessState")
          .select("revision")
          .executeTakeFirstOrThrow()
      ).revision,
    );
    const result = await mutateAccess(fixture.database, {
      actor: { userId: run.userId },
      expectedRevision: revision,
      commandIdentity: createId("command"),
      change,
    });
    revision = result.revision;
    return result;
  };
  const member = async (name = "Member") => {
    const userId = await fixture.store.createUser(name);
    await mutate({ kind: "member", userId, admit: true });
    return userId;
  };
  const membership = (userId: UserId) =>
    fixture.database
      .selectFrom("workspaceMemberships")
      .selectAll()
      .where("workspaceId", "=", run.workspace.id)
      .where("userId", "=", userId)
      .executeTakeFirst();
  const allowed = (userId: UserId, generation?: number) =>
    checkAccess(fixture.database, {
      principal: { kind: "person", userId },
      callerKind: "person",
      target: { kind: "project", workspaceId: run.workspace.id },
      action: "use",
      ...(generation === undefined ? {} : { expectedMembershipGeneration: generation }),
    });
  return { ...run, mutate, member, membership, allowed, revision: () => revision };
}

async function advance(database: Kysely<DatabaseSchema>, milliseconds: number) {
  await database.transaction().execute(async (transaction) => {
    await sql`update access_entries set granted_at = granted_at - ${milliseconds} * interval '1 millisecond', expires_at = expires_at - ${milliseconds} * interval '1 millisecond'`.execute(
      transaction,
    );
    await sql`update workspace_memberships set effective_until = effective_until - ${milliseconds} * interval '1 millisecond' where effective_until is not null`.execute(
      transaction,
    );
  });
}

describeStore("dormant Project access", (it) => {
  it("migrates the previous schema without changing legacy membership data or DTO bytes", async ({
    storeFixture,
  }) => {
    const source = await storeFixture.createRunFixture("migration-compatibility", null, "project");
    const membership = await storeFixture.database
      .selectFrom("workspaceMemberships")
      .selectAll()
      .where("workspaceId", "=", source.workspace.id)
      .executeTakeFirstOrThrow();
    const workspace = await storeFixture.database
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", source.workspace.id)
      .executeTakeFirstOrThrow();
    const clone = await cloneTestDatabase("host");
    const owned = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({ connectionString: clone.url });
      return { database, close: () => database.destroy() };
    });
    try {
      const database = owned.database;
      await sql`drop schema public cascade; create schema public`.execute(database);
      const migrations = await migrationProvider().getMigrations();
      delete migrations["0169_access_foundation"];
      const previous = await new Migrator({
        db: database,
        provider: { getMigrations: async () => migrations },
      }).migrateToLatest();
      if (previous.error) throw previous.error;
      const disabledAt = new Date("2026-01-02T03:04:05.000Z");
      const disabledId = createId("user");
      await database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto("users")
          .values([
            {
              id: source.userId,
              displayName: "Owner",
              email: "owner@fixture.invalid",
              emailVerified: true,
              image: null,
              instanceRole: "user",
              disabledAt: null,
            },
            {
              id: disabledId,
              displayName: "Disabled",
              email: "disabled@fixture.invalid",
              emailVerified: true,
              image: null,
              instanceRole: "user",
              disabledAt,
            },
          ])
          .execute();
        await sql`insert into execution_environments(id, name, kind, runner_id, capabilities) values (${source.environmentId}, 'Fixture', 'main', null, '[]'::jsonb)`.execute(
          transaction,
        );
        const { ownerEnvironmentId: _environment, ...workspaceRow } = workspace;
        await transaction
          .insertInto("workspaces")
          .values({ ...workspaceRow, homeThreadId: null, voiceThreadId: null })
          .execute();
        const { effectiveUntil: _deadline, ...membershipRow } = membership;
        await transaction.insertInto("workspaceMemberships").values(membershipRow).execute();
      });
      const before =
        await sql`select generation::double precision as generation, id, invited_by, joined_at, role, state, user_id, workspace_id from workspace_memberships where id = ${membership.id}`.execute(
          database,
        );
      await migrateToLatest(database);
      const { workspaceMembershipForUser } = await import("./workspace-membership-store.js");
      expect(
        JSON.stringify(
          await workspaceMembershipForUser(database, source.workspace.id, source.userId),
        ),
      ).toBe(JSON.stringify(before.rows[0]));
      expect(
        await database
          .selectFrom("users")
          .select(["disabledAt", "memberState", "authorityGeneration", "admittedAt"])
          .where("id", "=", disabledId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        disabledAt,
        memberState: "suspended",
        authorityGeneration: "1",
        admittedAt: null,
      });
      const catalog = (connection: Kysely<DatabaseSchema>) =>
        sql`select table_name, column_name, data_type, is_nullable, column_default
        from information_schema.columns where table_schema = 'public' and table_name in ('users','deployments','workspace_memberships','access_groups','access_group_members','access_entries','access_state','security_effects') order by table_name, ordinal_position`.execute(
          connection,
        );
      expect((await catalog(database)).rows).toEqual((await catalog(storeFixture.database)).rows);
    } finally {
      await owned.close();
      await clone.drop();
    }
  });
  it("applies an old Run cleanup while active again, without touching newly admitted work", async ({
    storeFixture,
  }) => {
    const run = await storeFixture.startRunFixture("old-effect", "project");
    const { database, store } = storeFixture;
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    await database
      .updateTable("users")
      .set({ instanceRole: "administrator", admittedAt: new Date() })
      .where("id", "=", run.userId)
      .execute();
    const entryId = randomUUID();
    await database
      .insertInto("accessEntries")
      .values({
        id: entryId,
        subjectKind: "user",
        subjectId: run.userId,
        targetKind: "project",
        targetId: run.workspace.id,
        level: "manage",
        grantedBy: run.userId,
        revokedBy: null,
      })
      .execute();
    await mutateAccess(database, {
      actor: { userId: run.userId },
      commandIdentity: createId("command"),
      expectedRevision: 1,
      change: { kind: "revoke", entryId },
    });
    await mutateAccess(database, {
      actor: { userId: run.userId },
      commandIdentity: createId("command"),
      expectedRevision: 2,
      change: {
        kind: "grant",
        id: randomUUID(),
        subject: { kind: "person", userId: run.userId },
        target: { kind: "project", workspaceId: run.workspace.id },
        level: "manage",
      },
    });
    const { thread } = await store.createThread({
      createdBy: run.userId,
      environmentId: run.environmentId,
      harnessInstanceId: run.harnessInstance.id,
      idempotencyKey: "new-incarnation-thread",
      modelSelection: testModelSelection,
      title: "New incarnation",
      workspaceId: run.workspace.id,
    });
    const fresh = await storeFixture.enqueueHumanTrigger({
      content: [{ type: "text", text: "New work" }],
      idempotencyKey: "new-incarnation-input",
      requestedBy: run.userId,
      threadId: thread.id,
    });
    expect(
      (
        await database
          .selectFrom("runs")
          .select("membershipGeneration")
          .where("id", "=", fresh.run.id)
          .executeTakeFirstOrThrow()
      ).membershipGeneration,
    ).toBe("3");
    const effects = await store.claimSecurityEffects({
      now: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
      limit: 100,
    });
    const effect = effects.find((candidate) => candidate.kind === "stop-runs")!;
    expect(effect).toMatchObject({ membershipGenerationCutoff: 1 });
    await expect(
      database
        .updateTable("securityEffects")
        .set({ membershipGenerationCutoff: 2 })
        .where("id", "=", effect.id)
        .execute(),
    ).rejects.toMatchObject({ code: "P0001" });
    const recovery = await store.failActiveRunsForMembershipRevocation({
      userId: run.userId,
      workspaceId: run.workspace.id,
      membershipGenerationCutoff: effect.membershipGenerationCutoff,
    });
    expect(recovery.terminatedRuns.map((target) => target.runId)).toEqual([run.run.id]);
    expect(
      (
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", fresh.run.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("queued");
  });

  it("keeps the existing Workspace-before-membership order against concurrent admission", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const userId = await access.member();
    const id = randomUUID();
    await access.mutate({
      kind: "grant",
      id,
      subject: { kind: "person", userId },
      target: { kind: "project", workspaceId: access.workspace.id },
      level: "use",
    });
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writerReachedWorkspace = Promise.withResolvers<void>();
    const admission = storeFixture.database.transaction().execute(async (transaction) => {
      await lockWorkspaceRow(transaction, access.workspace.id);
      await requireActiveWorkspaceMembership(transaction, access.workspace.id, userId, true);
      admitted.resolve();
      await withTimeout(release.promise, 3000, {
        timeoutError: () => new Error("Admission release was never signalled"),
      });
    });
    let mutation: Promise<unknown> | undefined;
    try {
      await withTimeout(admitted.promise, 3000, {
        timeoutError: () => new Error("Admission never acquired scoped locks"),
      });
      const database = storeFixture.database.withPlugin({
        transformQuery(args) {
          const node = JSON.stringify(args.node);
          if (
            args.node.kind === "SelectQueryNode" &&
            node.includes('"name":"workspaces"') &&
            node.includes("ForNoKeyUpdate")
          )
            writerReachedWorkspace.resolve();
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      });
      mutation = mutateAccess(database, {
        actor: { userId: access.userId },
        commandIdentity: createId("command"),
        expectedRevision: access.revision(),
        change: { kind: "revoke", entryId: id },
      });
      await withTimeout(writerReachedWorkspace.promise, 3000, {
        timeoutError: () => new Error("Access writer never reached the Workspace fence"),
      });
    } finally {
      release.resolve();
      await admission;
    }
    await mutation;
    expect(await access.allowed(userId, 1)).toEqual({ allowed: false });
  });

  it("measures one destructive recompute over 512 effective pairs", async ({ storeFixture }) => {
    const access = await setup(storeFixture);
    const groupId = randomUUID();
    await access.mutate({ kind: "create-group", id: groupId, name: "Scale" });
    const users = [];
    for (let index = 0; index < 64; index++)
      users.push(await storeFixture.store.createUser(`Scale ${index}`));
    await storeFixture.database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "in", users)
      .execute();
    await storeFixture.database
      .insertInto("accessGroupMembers")
      .values(
        users.map((userId) => ({
          groupId,
          memberKind: "user" as const,
          memberId: userId,
          addedBy: access.userId,
        })),
      )
      .execute();
    for (let index = 0; index < 8; index++) {
      const workspace = await createTestWorkspace(storeFixture.store, {
        createdBy: access.userId,
        kind: "project",
        name: `Scale ${index}`,
        idempotencyKey: `scale-${index}`,
        status: "ready",
        backing: {
          kind: "local-directory",
          generation: 1,
          bindingId: createId("workspaceBinding"),
          ownerEnvironmentId: access.environmentId,
          storageAuthorityId: createId("storageAuthority"),
        },
      });
      await access.mutate({
        kind: "grant",
        id: randomUUID(),
        subject: { kind: "group", groupId },
        target: { kind: "project", workspaceId: workspace.id },
        level: "use",
      });
    }
    const started = performance.now();
    const result = await access.mutate({ kind: "delete-group", groupId });
    const elapsed = performance.now() - started;
    expect(result.transitions).toHaveLength(512);
    expect(
      result.transitions.every(
        (transition) => transition.state === "revoked" && transition.generation === 2,
      ),
    ).toBe(true);
    console.info(`access recompute: pairs=512 elapsedMs=${elapsed.toFixed(2)}`);
  });
  it("does not activate authority writers on an existing Deployment", async ({ storeFixture }) => {
    const { database, createRunFixture } = storeFixture;
    const fixture = await createRunFixture("access-legacy", null, "project");
    await expect(
      mutateAccess(database, {
        actor: { userId: fixture.userId },
        expectedRevision: 1,
        commandIdentity: createId("command"),
        change: { kind: "create-group", id: randomUUID(), name: "Engineers" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await database.selectFrom("accessGroups").selectAll().execute()).toEqual([]);
    expect(
      await checkAccess(database, {
        principal: { kind: "person", userId: fixture.userId },
        callerKind: "person",
        target: { kind: "project", workspaceId: fixture.workspace.id },
        action: "use",
        expectedMembershipGeneration: 1,
      }),
    ).toMatchObject({ allowed: true, membershipGeneration: 1 });
  });

  it("creates a Project and its creator grant in one authority commit", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const workspaceId = createId("workspace");
    const entryId = randomUUID();
    const result = await access.mutate({
      kind: "create-project",
      workspaceId,
      entryId,
      name: "Grant-created Project",
      color: "blue",
      backing: {
        kind: "local-directory",
        generation: 1,
        bindingId: createId("workspaceBinding"),
        ownerEnvironmentId: access.environmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
    });
    expect(result.transitions).toMatchObject([
      { workspaceId, userId: access.userId, state: "active", role: "owner", generation: 1 },
    ]);
    expect(
      await storeFixture.database
        .selectFrom("accessEntries")
        .selectAll()
        .where("targetId", "=", workspaceId)
        .execute(),
    ).toMatchObject([
      { id: entryId, subjectKind: "user", subjectId: access.userId, level: "manage" },
    ]);
    expect(
      await checkAccess(storeFixture.database, {
        principal: { kind: "person", userId: access.userId },
        callerKind: "person",
        target: { kind: "project", workspaceId },
        action: "manage",
      }),
    ).toMatchObject({ allowed: true, membershipGeneration: 1 });
  });

  it("drains overdue memberships on explicit startup and earlier-deadline notification", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const userId = await access.member();
    await access.mutate({
      kind: "grant",
      id: randomUUID(),
      subject: { kind: "person", userId },
      target: { kind: "project", workspaceId: access.workspace.id },
      level: "use",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const expired = Promise.withResolvers<void>();
    const scheduler = createAccessExpiryScheduler({
      database: storeFixture.database,
      committed: (transitions) => {
        if (transitions.length) expired.resolve();
      },
      failed: expired.reject,
    });
    try {
      await scheduler.start();
      await advance(storeFixture.database, 120_000);
      expect(await access.allowed(userId, 1)).toEqual({ allowed: false });
      await scheduler.changed();
      await withTimeout(expired.promise, 3000, {
        timeoutError: () => new Error("Expiry scheduler never committed the overdue membership"),
      });
      expect(await access.membership(userId)).toMatchObject({ state: "revoked", generation: "2" });
    } finally {
      await scheduler.close();
    }
  });

  it("denies expired membership in the SQL Thread guard before expiry cleanup", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    await access.mutate({
      kind: "grant",
      id: randomUUID(),
      subject: { kind: "person", userId: access.userId },
      target: { kind: "project", workspaceId: access.workspace.id },
      level: "manage",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await advance(storeFixture.database, 120_000);
    expect(await access.membership(access.userId)).toMatchObject({ state: "active" });
    const threadId = createId("thread");
    await expect(
      sql`insert into threads (
      id, workspace_id, title, environment_id, harness_instance_id, created_by,
      created_by_principal_id, model_selection, lineage_root_thread_id, inherits_main, listed, color, icon_source
    ) select ${threadId}, workspace_id, title, environment_id, harness_instance_id, created_by,
      created_by_principal_id, model_selection, ${threadId}, inherits_main, listed, color, icon_source
      from threads where id = ${access.thread.id}`.execute(storeFixture.database),
    ).rejects.toThrow("thread creator must be an active workspace member");
  });

  it("refuses unsupported targets and a ninth nesting level without partial writes", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const groups = Array.from({ length: 9 }, () => randomUUID());
    for (const [index, groupId] of groups.entries())
      await access.mutate({ kind: "create-group", id: groupId, name: `Depth ${index}` });
    for (let index = 0; index < 7; index++)
      await access.mutate({
        kind: "add-group-member",
        groupId: groups[index]!,
        member: { kind: "group", groupId: groups[index + 1]! },
      });
    await expect(
      access.mutate({
        kind: "add-group-member",
        groupId: groups[7]!,
        member: { kind: "group", groupId: groups[8]! },
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted", reason: "access-capacity" });
    expect(
      await storeFixture.database.selectFrom("accessGroupMembers").selectAll().execute(),
    ).toHaveLength(7);
    for (const target of [
      { kind: "topic", topicId: "future" },
      { kind: "team-account", accountId: "future" },
    ] as const) {
      await expect(
        access.mutate({
          kind: "grant",
          id: randomUUID(),
          subject: { kind: "person", userId: access.userId },
          target,
          level: "use",
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
      expect(
        await checkAccess(storeFixture.database, {
          principal: { kind: "person", userId: access.userId },
          callerKind: "person",
          target,
          action: "use",
        }),
      ).toEqual({ allowed: false });
    }
    await expect(
      access.mutate({
        kind: "grant",
        id: randomUUID(),
        subject: { kind: "project", workspaceId: access.workspace.id },
        target: { kind: "project", workspaceId: access.workspace.id },
        level: "use",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("keeps stable tombstones, rejects old handles, and settles expiry before a replacement", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const userId = await access.member();
    const grant = async (expiresAt?: Date) => {
      const id = randomUUID();
      await access.mutate({
        kind: "grant",
        id,
        subject: { kind: "person", userId },
        target: { kind: "project", workspaceId: access.workspace.id },
        level: "use",
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      return id;
    };
    const first = await grant();
    const original = (await access.membership(userId))!;
    await access.mutate({ kind: "revoke", entryId: first });
    const second = await grant(new Date(Date.now() + 60_000));
    expect(await access.membership(userId)).toMatchObject({
      id: original.id,
      generation: "3",
      state: "active",
    });
    expect(await access.allowed(userId, 1)).toEqual({ allowed: false });
    await advance(storeFixture.database, 120_000);
    expect(await access.allowed(userId, 3)).toEqual({ allowed: false });
    await grant();
    expect(await access.membership(userId)).toMatchObject({
      id: original.id,
      generation: "5",
      state: "active",
      effectiveUntil: null,
    });
    expect(await access.allowed(userId, 3)).toEqual({ allowed: false });
    await access.mutate({ kind: "revoke", entryId: second });
    expect((await access.membership(userId))!.generation).toBe("5");
    const effects = await storeFixture.store.claimSecurityEffects({
      now: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
      limit: 100,
    });
    expect(
      effects
        .filter((effect) => effect.userId === userId)
        .map((effect) => effect.membershipGenerationCutoff),
    ).toEqual(expect.arrayContaining([1, 2, 3, 4]));
  });

  it("collapses nested diamonds and Everyone, ignoring guests and redundant expiries", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const full = await access.member("Full");
    const guest = await access.member("Guest");
    await access.mutate({ kind: "member", userId: guest, memberKind: "guest" });
    const groups = Array.from({ length: 4 }, () => randomUUID());
    for (const [index, id] of groups.entries())
      await access.mutate({
        kind: "create-group",
        id,
        name: `Group ${index}`,
        ...(index === 3 ? { builtin: "everyone" as const } : {}),
      });
    for (const [parent, child] of [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
    ])
      await access.mutate({
        kind: "add-group-member",
        groupId: groups[parent!]!,
        member: { kind: "group", groupId: groups[child!]! },
      });
    const target = { kind: "project" as const, workspaceId: access.workspace.id };
    const permanent = randomUUID();
    await access.mutate({
      kind: "grant",
      id: permanent,
      subject: { kind: "group", groupId: groups[0]! },
      target,
      level: "use",
    });
    expect((await access.membership(full))!.generation).toBe("1");
    expect(await access.allowed(guest)).toEqual({ allowed: false });
    const shorter = randomUUID();
    await access.mutate({
      kind: "grant",
      id: shorter,
      subject: { kind: "person", userId: full },
      target,
      level: "use",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await advance(storeFixture.database, 120_000);
    expect(await expireAccessMemberships(storeFixture.database)).toEqual([]);
    expect(await access.membership(full)).toMatchObject({ generation: "1", effectiveUntil: null });
    await access.mutate({
      kind: "grant",
      id: randomUUID(),
      subject: { kind: "person", userId: full },
      target,
      level: "manage",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await access.membership(full))!.generation).toBe("2");
    await advance(storeFixture.database, 120_000);
    expect(await access.allowed(full, 2)).toEqual({ allowed: false });
    await access.mutate({
      kind: "remove-group-member",
      groupId: groups[1]!,
      member: { kind: "group", groupId: groups[3]! },
    });
    expect(await access.membership(full)).toMatchObject({
      generation: "3",
      role: "collaborator",
      effectiveUntil: null,
    });
  });

  it("serializes competing nesting edits so exactly one can introduce the edge", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const first = randomUUID();
    const second = randomUUID();
    await access.mutate({ kind: "create-group", id: first, name: "First" });
    await access.mutate({ kind: "create-group", id: second, name: "Second" });
    const input = { actor: { userId: access.userId }, expectedRevision: access.revision() };
    const results = await Promise.allSettled([
      mutateAccess(storeFixture.database, {
        ...input,
        commandIdentity: createId("command"),
        change: {
          kind: "add-group-member",
          groupId: first,
          member: { kind: "group", groupId: second },
        },
      }),
      mutateAccess(storeFixture.database, {
        ...input,
        commandIdentity: createId("command"),
        change: {
          kind: "add-group-member",
          groupId: second,
          member: { kind: "group", groupId: first },
        },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "bad_request" });
    expect(
      await storeFixture.database.selectFrom("accessGroupMembers").selectAll().execute(),
    ).toHaveLength(1);
  });

  it("rolls back the source and preview revision when projection fails", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const userId = await access.member();
    const id = randomUUID();
    await sql`create function access_test_failure() returns trigger language plpgsql as $$ begin raise exception 'injected projection failure'; end $$;
      create trigger access_test_failure before insert on workspace_memberships for each row execute function access_test_failure()`.execute(
      storeFixture.database,
    );
    await expect(
      access.mutate({
        kind: "grant",
        id,
        subject: { kind: "person", userId },
        target: { kind: "project", workspaceId: access.workspace.id },
        level: "use",
      }),
    ).rejects.toThrow("injected projection failure");
    expect(
      await storeFixture.database
        .selectFrom("accessEntries")
        .select("id")
        .where("id", "=", id)
        .execute(),
    ).toEqual([]);
    expect(await access.membership(userId)).toBeUndefined();
    expect(
      (
        await storeFixture.database
          .selectFrom("accessState")
          .select("revision")
          .executeTakeFirstOrThrow()
      ).revision,
    ).toBe(String(access.revision()));
  });

  it("does not charge expired grant history against live pair capacity or offboarding", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const userId = await access.member();
    const prefix = `usr_history_${randomUUID()}_`;
    await sql`insert into users (id, display_name, email, email_verified, image, instance_role, admitted_at)
      select ${prefix} || ordinal::text, 'Historical member', ${prefix} || ordinal::text || '@fixture.invalid', true, null, 'user', clock_timestamp()
      from generate_series(1, 16385) as ordinal`.execute(storeFixture.database);
    await sql`insert into access_entries (id, subject_kind, subject_id, target_kind, target_id, level, granted_by, granted_at, expires_at, revoked_by)
      select gen_random_uuid(), 'user', id, 'project', ${access.workspace.id}, 'use', ${access.userId},
        clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day', null
      from users where id like ${`${prefix}%`}`.execute(storeFixture.database);
    await access.mutate({
      kind: "create-group",
      id: randomUUID(),
      name: "History does not occupy capacity",
    });
    await access.mutate({ kind: "member", userId, memberState: "removed" });
    expect(await access.membership(userId)).toBeUndefined();
  });

  it("refuses capacity growth atomically but permits reductions above a bound", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const userId = await access.member();
    const entries = Array.from({ length: 257 }, () => ({
      id: randomUUID(),
      subjectKind: "user" as const,
      subjectId: userId,
      targetKind: "project" as const,
      targetId: access.workspace.id,
      level: "use" as const,
      grantedBy: access.userId,
      revokedBy: null,
    }));
    await storeFixture.database.insertInto("accessEntries").values(entries).execute();
    const id = randomUUID();
    await expect(
      access.mutate({
        kind: "grant",
        id,
        subject: { kind: "person", userId },
        target: { kind: "project", workspaceId: access.workspace.id },
        level: "use",
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted", details: { limit: "matchingEntries" } });
    expect(
      await storeFixture.database
        .selectFrom("accessEntries")
        .select("id")
        .where("id", "=", id)
        .execute(),
    ).toEqual([]);
    await expect(access.mutate({ kind: "revoke", entryId: entries[0]!.id })).resolves.toMatchObject(
      { revision: access.revision() + 1 },
    );
  });

  it("matches an independent uncached graph interpreter through a seeded mutation trace", async ({
    storeFixture,
  }) => {
    const seed = 0x792a51;
    let random = seed;
    const choose = (count: number) => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return (random >>> 0) % count;
    };
    try {
      const access = await setup(storeFixture);
      const people = await Promise.all(
        Array.from({ length: 4 }, (_, index) => storeFixture.store.createUser(`Trace ${index}`)),
      );
      const kinds = new Map<UserId, "full" | "guest">();
      const active = new Map<UserId, boolean>();
      const observedPeople = [access.userId, ...people];
      kinds.set(access.userId, "full");
      active.set(access.userId, true);
      for (const userId of people) {
        await access.mutate({ kind: "member", userId, admit: true });
        kinds.set(userId, "full");
        active.set(userId, true);
      }
      const groups = Array.from({ length: 4 }, () => randomUUID());
      const children = new Map<string, Set<string>>(groups.map((group) => [group, new Set()]));
      for (const [index, id] of groups.entries())
        await access.mutate({
          kind: "create-group",
          id,
          name: `Trace group ${index}`,
          ...(index === 0 ? { builtin: "everyone" as const } : {}),
        });
      const grants = new Map<
        string,
        { subject: string; level: "use" | "manage"; expiresAt: Date | null }
      >();
      const history = new Map<
        UserId,
        { id: string; generation: number; state: string; role: string; until: Date | null }
      >();
      const creatorEntry = randomUUID();
      await access.mutate({
        kind: "grant",
        id: creatorEntry,
        subject: { kind: "person", userId: access.userId },
        target: { kind: "project", workspaceId: access.workspace.id },
        level: "manage",
      });
      grants.set(creatorEntry, { subject: access.userId, level: "manage", expiresAt: null });
      const creatorMembership = (await access.membership(access.userId))!;
      history.set(access.userId, {
        id: creatorMembership.id,
        generation: Number(creatorMembership.generation),
        state: "active",
        role: "owner",
        until: null,
      });
      const interpret = (userId: UserId, now: Date) => {
        if (!active.get(userId)) return null;
        const subjects = new Set<string>([userId]);
        const contains = (group: string, visited: Set<string>): boolean => {
          if (visited.has(group)) return false;
          visited.add(group);
          if (group === groups[0]) return kinds.get(userId) === "full";
          return [...children.get(group)!].some(
            (child) =>
              child === userId || (children.has(child) && contains(child, new Set(visited))),
          );
        };
        for (const group of groups) if (contains(group, new Set())) subjects.add(group);
        const matching = [...grants.values()].filter(
          (grant) => subjects.has(grant.subject) && (!grant.expiresAt || grant.expiresAt > now),
        );
        const top = matching.some((grant) => grant.level === "manage")
          ? matching.filter((grant) => grant.level === "manage")
          : matching;
        if (!top.length) return null;
        return {
          role: top[0]!.level === "manage" ? "owner" : "collaborator",
          until: top.some((grant) => !grant.expiresAt)
            ? null
            : new Date(Math.max(...top.map((grant) => grant.expiresAt!.getTime()))),
        };
      };
      for (let step = 0; step < 80; step++) {
        const userId = people[choose(people.length)]!;
        const groupId = groups[1 + choose(groups.length - 1)]!;
        const operation = choose(9);
        if (operation === 0) {
          const id = randomUUID();
          const subject = choose(2) ? userId : groupId;
          const level = choose(2) ? "use" : "manage";
          const expiresAt = choose(2) ? new Date(Date.now() + 60_000) : null;
          if (!active.get(userId) && subject === userId) continue;
          await access.mutate({
            kind: "grant",
            id,
            subject: children.has(subject)
              ? { kind: "group", groupId: subject }
              : { kind: "person", userId },
            target: { kind: "project", workspaceId: access.workspace.id },
            level,
            expiresAt,
          });
          grants.set(id, { subject, level, expiresAt });
        } else if (operation === 1 && grants.size) {
          const id = [...grants.keys()][choose(grants.size)]!;
          await access.mutate({ kind: "revoke", entryId: id });
          grants.delete(id);
        } else if (operation === 2) {
          const present = children.get(groupId)!.has(userId);
          await access.mutate({
            kind: present ? "remove-group-member" : "add-group-member",
            groupId,
            member: { kind: "person", userId },
          });
          if (present) children.get(groupId)!.delete(userId);
          else children.get(groupId)!.add(userId);
        } else if (operation === 3) {
          active.set(userId, !active.get(userId));
          await access.mutate({
            kind: "member",
            userId,
            memberState: active.get(userId) ? "active" : "suspended",
          });
        } else if (operation === 4) {
          const kind = kinds.get(userId) === "full" ? "guest" : "full";
          await access.mutate({ kind: "member", userId, memberKind: kind });
          kinds.set(userId, kind);
        } else if (operation === 5) {
          const parent = groups[2 + choose(2)]!;
          const child = groups[choose(2)]!;
          const present = children.get(parent)!.has(child);
          await access.mutate({
            kind: present ? "remove-group-member" : "add-group-member",
            groupId: parent,
            member: { kind: "group", groupId: child },
          });
          if (present) children.get(parent)!.delete(child);
          else children.get(parent)!.add(child);
        } else if (operation === 6) {
          await advance(storeFixture.database, 120_000);
          for (const grant of grants.values())
            if (grant.expiresAt) grant.expiresAt = new Date(grant.expiresAt.getTime() - 120_000);
          for (const prior of history.values())
            if (prior.until) prior.until = new Date(prior.until.getTime() - 120_000);
          for (const [person, prior] of history)
            if (prior.until && prior.until <= new Date())
              expect(await access.allowed(person, prior.generation)).toEqual({ allowed: false });
          await expireAccessMemberships(storeFixture.database);
        } else if (operation === 7 || !active.get(userId)) {
          const id = randomUUID();
          await expect(
            mutateAccess(storeFixture.database, {
              actor: { userId: access.userId },
              expectedRevision: 0,
              commandIdentity: createId("command"),
              change: { kind: "create-group", id, name: `Rolled back ${step}` },
            }),
          ).rejects.toMatchObject({ code: "conflict" });
          expect(
            await storeFixture.database
              .selectFrom("accessGroups")
              .select("id")
              .where("id", "=", id)
              .execute(),
          ).toEqual([]);
        } else {
          const expectedRevision = Number(
            (
              await storeFixture.database
                .selectFrom("accessState")
                .select("revision")
                .executeTakeFirstOrThrow()
            ).revision,
          );
          const changes = (["use", "manage"] as const).map((level) => ({
            kind: "grant" as const,
            id: randomUUID(),
            subject: { kind: "person" as const, userId },
            target: { kind: "project" as const, workspaceId: access.workspace.id },
            level,
          }));
          const results = await Promise.allSettled(
            changes.map((change) =>
              mutateAccess(storeFixture.database, {
                actor: { userId: access.userId },
                expectedRevision,
                commandIdentity: createId("command"),
                change,
              }),
            ),
          );
          expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          for (const [index, result] of results.entries()) {
            if (result.status === "fulfilled") {
              const grant = changes[index]!;
              grants.set(grant.id, { subject: userId, level: grant.level, expiresAt: null });
            } else expect(result.reason).toMatchObject({ code: "conflict" });
          }
        }
        for (const person of observedPeople) {
          const previous = history.get(person);
          const now = new Date();
          const times =
            operation === 6 && previous?.until && previous.state === "active"
              ? [
                  ...new Set([
                    previous.until.getTime(),
                    ...[...grants.values()].flatMap((grant) =>
                      grant.expiresAt &&
                      grant.expiresAt >= previous.until! &&
                      grant.expiresAt <= now
                        ? [grant.expiresAt.getTime()]
                        : [],
                    ),
                    now.getTime(),
                  ]),
                ].sort((first, second) => first - second)
              : [now.getTime()];
          let expected = previous;
          for (const time of times) {
            const value = interpret(person, new Date(time));
            if (!expected && !value) continue;
            const state = value ? "active" : "revoked";
            expected = {
              id: expected?.id ?? "",
              generation: expected
                ? expected.generation +
                  Number(expected.state !== state || (!!value && expected.role !== value.role))
                : 1,
              state,
              role: value?.role ?? expected!.role,
              until: value?.until ?? null,
            };
          }
          const row = await access.membership(person);
          if (!expected) {
            expect(row).toBeUndefined();
            continue;
          }
          expect(row, `seed=${seed} step=${step} person=${person}`).toMatchObject({
            state: expected.state,
            role: expected.role,
            generation: String(expected.generation),
            effectiveUntil: expected.until,
            ...(previous ? { id: previous.id } : {}),
          });
          history.set(person, { ...expected, id: row!.id });
        }
        expect(
          await storeFixture.database
            .selectFrom("workspaceMemberships")
            .select("userId")
            .where("workspaceId", "=", access.workspace.id)
            .execute(),
        ).toHaveLength(history.size);
      }
      await access.mutate({
        kind: "delete-project",
        workspaceId: access.workspace.id,
        purgeAfter: new Date(Date.now() + 86_400_000),
      });
      for (const [person, previous] of history) {
        expect(await access.membership(person)).toMatchObject({
          id: previous.id,
          state: "revoked",
          role: previous.role,
          generation: String(previous.generation + Number(previous.state === "active")),
          effectiveUntil: null,
        });
      }
    } catch (error) {
      throw new Error(`Access invariant seed=${seed}`, { cause: error });
    }
  });
});
