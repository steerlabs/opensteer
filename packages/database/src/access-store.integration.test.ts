import { randomUUID } from "node:crypto";
import {
  createId,
  type AccessMutation,
  type EnvironmentId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { createDatabase } from "./connection.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";
import { migrateToLatest, migrationProvider } from "./migrations.js";
import { expect } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { lockWorkspaceRow, requireActiveWorkspaceMembership } from "./store-primitives.js";
import { testModelSelection } from "./store.integration.test-support.js";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";
import type { DatabaseSchema } from "./schema.js";
import { accessCapacity, checkAccess, mutateAccess } from "./access-store.js";
import { claimAccessSecurityEffects } from "./access-effects.js";
import { failActiveRunsForAccessRevocation } from "./execution-recovery.js";
import { threadPathLinks } from "./store-primitives.js";
import { OpensteerStore } from "./store.js";

async function legacyMembershipLifecycle(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  workspaceId: import("@opensteer/core").WorkspaceId,
  phase: string,
) {
  const statements: string[] = [];
  const observed = database.withPlugin({
    transformQuery(args) {
      statements.push(database.getExecutor().compileQuery(args.node, args.queryId).sql);
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const store = new OpensteerStore(observed);
  const memberId = await new OpensteerStore(database).createUser(`Legacy ${phase}`);
  const invite = async (suffix: string) => {
    const selector = `${phase}-${suffix}`;
    await store.createWorkspaceInvitation({
      workspaceId,
      createdBy: ownerId,
      role: "collaborator",
      type: "link",
      intendedEmail: null,
      expiresAt: new Date("2099-01-01"),
      selector,
      tokenHash: selector,
      idempotencyKey: selector,
      requestFingerprint: selector,
    });
    return store.acceptWorkspaceInvitation({
      selector,
      tokenHash: selector,
      userId: memberId,
      userEmail: "legacy@fixture.invalid",
      userEmailVerified: true,
    });
  };
  const joined = await invite("join");
  const revoked = await store.changeWorkspaceMembership({
    actorId: ownerId,
    targetUserId: memberId,
    workspaceId,
    state: "revoked",
  });
  const effects = await database
    .selectFrom("securityEffects")
    .selectAll()
    .where("userId", "=", memberId)
    .orderBy("kind")
    .execute();
  expect(effects).toHaveLength(6);
  const projectedEffects = effects.map((row) => {
    const {
      id: _id,
      userId: _user,
      createdAt: _created,
      updatedAt: _updated,
      nextAttemptAt: _next,
      membershipGenerationCutoff,
      causeId,
      ...effect
    } = row;
    if (phase === "upgraded") {
      expect(membershipGenerationCutoff).toBe("1");
      expect(causeId).toBeNull();
    }
    return effect;
  });
  const claimed = await store.claimSecurityEffects({
    now: new Date("2099-01-01"),
    leaseUntil: new Date("2099-01-02"),
    limit: 100,
  });
  expect(claimed).toHaveLength(6);
  for (const effect of claimed) {
    expect(Object.keys(effect).sort()).toEqual([
      "attempts",
      "id",
      "kind",
      "membershipGeneration",
      "userId",
      "workspaceId",
    ]);
    await store.completeSecurityEffect(effect.id);
  }
  const rejoined = await invite("rejoin");
  expect(rejoined.id).toBe(joined.id);
  expect([joined.generation, revoked.membership.generation, rejoined.generation]).toEqual([
    1, 2, 3,
  ]);
  const serverStatements = [...statements];
  statements.length = 0;
  await database
    .updateTable("deployments")
    .set({
      deploymentShape: sql`'{"kind":"personal","defaultWorkspaceBacking":"local-directory"}'::jsonb`,
    })
    .execute();
  await expect(invite("personal")).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    store.changeWorkspaceMembership({
      actorId: ownerId,
      targetUserId: ownerId,
      workspaceId,
      state: "revoked",
    }),
  ).rejects.toThrow(/owner/i);
  const personalStatements = [...statements];
  await database
    .updateTable("deployments")
    .set({
      deploymentShape: sql`'{"kind":"server","defaultWorkspaceBacking":"local-directory"}'::jsonb`,
    })
    .execute();
  return { serverStatements, personalStatements, effects: projectedEffects };
}

async function seedPeople(
  database: Kysely<DatabaseSchema>,
  people: readonly { id: UserId; name: string; administrator?: boolean }[],
) {
  await sql`insert into users(id, display_name, email, email_verified, instance_role, admitted_at)
    select id, name, id || '@test.invalid', true,
      case when administrator then 'administrator' else 'user' end, now()
    from jsonb_to_recordset(${JSON.stringify(people)}::jsonb)
      as person(id text, name text, administrator boolean)`.execute(database);
}

async function seedProject(fixture: StoreFixture) {
  const run = {
    userId: createId("user"),
    environmentId: createId("environment"),
    workspace: { id: createId("workspace") },
  };
  await seedPeople(fixture.database, [{ id: run.userId, name: "Alex" }]);
  await sql`insert into deployments(id, active_host_instance_id, canonical_origin, deployment_shape)
      values (${createId("deployment")}, ${createId("hostInstance")}, 'https://test-host.invalid',
        '{"kind":"server","defaultWorkspaceBacking":"local-directory"}'::jsonb)`.execute(
    fixture.database,
  );
  await sql`insert into execution_environments(id, name, kind, runner_id, capabilities)
      values (${run.environmentId}, 'Fixture', 'main', null, '[]'::jsonb)`.execute(
    fixture.database,
  );
  await fixture.database.transaction().execute(async (transaction) => {
    await sql`insert into workspaces(id, name, color, kind, created_by, backing, status)
      values (${run.workspace.id}, 'Workspace access', 'blue', 'project', ${run.userId},
        ${JSON.stringify({
          kind: "local-directory",
          generation: 1,
          bindingId: createId("workspaceBinding"),
          ownerEnvironmentId: run.environmentId,
          storageAuthorityId: createId("storageAuthority"),
        })}::jsonb, 'ready')`.execute(transaction);
    await sql`insert into workspace_memberships(id, workspace_id, user_id, role, state, generation)
      values (${createId("workspaceMembership")}, ${run.workspace.id}, ${run.userId}, 'owner', 'active', 1)`.execute(
      transaction,
    );
  });
  return run;
}

async function setup(
  fixture: StoreFixture,
  existing?: {
    userId: UserId;
    environmentId: EnvironmentId;
    workspace: { id: WorkspaceId };
  },
) {
  const run = existing ?? (await seedProject(fixture));
  await fixture.database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
  await fixture.database
    .updateTable("users")
    .set({ instanceRole: "administrator", admittedAt: new Date() })
    .where("id", "=", run.userId)
    .execute();
  await fixture.database
    .insertInto("accessEntries")
    .values({
      id: randomUUID(),
      subjectKind: "user",
      subjectId: run.userId,
      targetKind: "project",
      targetId: run.workspace.id,
      level: "manage",
      grantedBy: run.userId,
      revokedBy: null,
    })
    .execute();
  let revision = 1;
  const mutate = async (change: AccessMutation | readonly AccessMutation[]) => {
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
      changes: Array.isArray(change) ? change : [change],
    });
    revision = result.revision;
    return result;
  };
  const member = async (name = "Member") => {
    const userId = createId("user");
    await seedPeople(fixture.database, [{ id: userId, name }]);
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

describeStore("dormant Project access", (it) => {
  it("adds no deadline columns or authority functions", async ({ storeFixture }) => {
    const columns = await sql`select table_name, column_name from information_schema.columns
      where table_schema = 'public' and ((table_name = 'access_entries' and column_name = 'expires_at')
        or (table_name = 'workspace_memberships' and column_name = 'effective_until'))`.execute(
      storeFixture.database,
    );
    expect(columns.rows).toEqual([]);
    const functions =
      await sql`select proname from pg_proc where proname = 'opensteer_membership_is_effective'`.execute(
        storeFixture.database,
      );
    expect(functions.rows).toEqual([]);
  });
  it("derives an omitted legacy cleanup cutoff from each revoked generation", async ({
    storeFixture,
  }) => {
    const access = await seedProject(storeFixture);
    for (const generation of [1, 2, 4]) {
      const result = await sql<{
        membershipGenerationCutoff: string;
      }>`insert into security_effects (
        id, kind, workspace_id, user_id, membership_generation, status, next_attempt_at
      ) values (${createId("securityEffect")}, 'close-realtime', ${access.workspace.id}, ${access.userId}, ${generation}, 'pending', clock_timestamp())
      returning membership_generation_cutoff`.execute(storeFixture.database);
      expect(Number(result.rows[0]!.membershipGenerationCutoff)).toBe(generation - 1);
    }
    await expect(
      sql`insert into security_effects (
      id, kind, workspace_id, user_id, membership_generation, cause_id, status, next_attempt_at
    ) values (${createId("securityEffect")}, 'close-realtime', ${access.workspace.id}, ${access.userId}, 6,
      ${createId("command")}, 'pending', clock_timestamp())`.execute(storeFixture.database),
    ).rejects.toThrow("marked security effects require an explicit generation cutoff");
  });
  it("migrates the previous schema without changing legacy membership data or DTO bytes", async ({
    storeFixture,
  }) => {
    const source = await seedProject(storeFixture);
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
      const previous = await new Migrator({
        db: database,
        provider: { getMigrations: async () => migrations },
      }).migrateTo("0169_browser_profile_homes");
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
        await transaction.insertInto("workspaceMemberships").values(membership).execute();
      });
      const before =
        await sql`select generation::double precision as generation, id, invited_by, joined_at, role, state, user_id, workspace_id from workspace_memberships where id = ${membership.id}`.execute(
          database,
        );
      await new OpensteerStore(database).ensureDeployment({
        canonicalOrigin: "https://legacy.fixture.invalid",
        hostInstanceId: createId("hostInstance"),
        deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
      });
      const legacy = await legacyMembershipLifecycle(
        database,
        source.userId,
        source.workspace.id,
        "previous",
      );
      const legacyObjects = (connection: Kysely<DatabaseSchema>) =>
        sql<{ name: string; definition: string }>`
        select 'function:' || oid::regprocedure::text as name, pg_get_functiondef(oid) as definition
        from pg_proc where pronamespace = 'public'::regnamespace and proname like 'opensteer_%'
        union all select 'index:' || indexname, indexdef from pg_indexes where schemaname = 'public'
        union all select 'trigger:' || tgrelid::regclass::text || ':' || tgname, pg_get_triggerdef(oid)
        from pg_trigger where tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
          and not tgisinternal
        union all select 'constraint:' || conrelid::regclass::text || ':' || conname, pg_get_constraintdef(oid)
        from pg_constraint where connamespace = 'public'::regnamespace order by name`.execute(
          connection,
        );
      const originalObjects = (await legacyObjects(database)).rows;
      await migrateToLatest(database);
      const upgradedObjects = new Map(
        (await legacyObjects(database)).rows.map((row) => [row.name, row.definition]),
      );
      for (const original of originalObjects)
        expect(upgradedObjects.get(original.name), original.name).toBe(original.definition);
      const upgraded = await legacyMembershipLifecycle(
        database,
        source.userId,
        source.workspace.id,
        "upgraded",
      );
      expect(upgraded).toEqual(legacy);
      console.info(
        `legacy lifecycle parity: server=${legacy.serverStatements.length} statements personal=${legacy.personalStatements.length} statements effects=6 generations=1,2,3; SQL and public effect DTOs identical`,
      );
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
    const otherOwner = await store.createUser("Retained owner");
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: run.workspace.id,
        userId: otherOwner,
        role: "owner",
        state: "active",
        generation: 1,
        invitedBy: null,
      })
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
      changes: [{ kind: "revoke", entryId }],
    });
    await mutateAccess(database, {
      actor: { userId: run.userId },
      commandIdentity: createId("command"),
      expectedRevision: 2,
      changes: [
        {
          kind: "grant",
          id: randomUUID(),
          subject: { kind: "person", userId: run.userId },
          target: { kind: "project", workspaceId: run.workspace.id },
          level: "manage",
        },
      ],
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
    const effects = await claimAccessSecurityEffects(database, {
      now: new Date("2099-01-01"),
      leaseUntil: new Date("2099-01-02"),
      limit: 100,
    });
    expect(
      effects
        .filter((candidate) => candidate.kind === "stop-runs")
        .map((candidate) => candidate.membershipGenerationCutoff)
        .sort(),
    ).toEqual([1, 2]);
    const effect = effects.find(
      (candidate) => candidate.kind === "stop-runs" && candidate.membershipGenerationCutoff === 1,
    )!;
    expect(effect).toMatchObject({ membershipGenerationCutoff: 1 });
    await expect(
      database
        .updateTable("securityEffects")
        .set({ membershipGenerationCutoff: 2 })
        .where("id", "=", effect.id)
        .execute(),
    ).rejects.toMatchObject({ code: "P0001" });
    const recovery = await failActiveRunsForAccessRevocation(database, threadPathLinks, {
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
        changes: [{ kind: "revoke", entryId: id }],
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

  for (const operation of ["delete-group", "suspend"] as const)
    it(`measures ${operation} on 128 Projects independently of other tests`, async ({
      storeFixture,
    }) => {
      const counts: number[] = [];
      const access = await setup(storeFixture);
      const { database } = storeFixture;
      expect(await database.selectFrom("authAccounts").select("id").execute()).toEqual([]);
      for (const projectCount of [2, 128]) {
        const setupStarted = performance.now();
        const groupId = randomUUID();
        const peopleCount = operation === "delete-group" ? accessCapacity.effectivePairs / 128 : 64;
        const users = Array.from({ length: peopleCount }, () => createId("user"));
        await seedPeople(
          database,
          users.map((id, index) => ({ id, name: `Scale ${index}` })),
        );
        const peopleMs = performance.now() - setupStarted;
        await database
          .insertInto("accessGroups")
          .values({ id: groupId, name: `Scale ${projectCount}`, createdBy: access.userId })
          .execute();
        const projects = [
          access.workspace.id,
          ...Array.from({ length: projectCount - 1 }, () => createId("workspace")),
        ];
        await database.transaction().execute(async (transaction) => {
          await sql`insert into workspaces(id, name, color, kind, created_by, backing, status)
          select project.id, 'Scale ' || project.id, 'blue', 'project', ${access.userId},
            jsonb_set(backing, '{bindingId}', to_jsonb(replace(project.id, 'wsp_', 'wbd_'))), 'ready'
          from workspaces cross join unnest(${projects.slice(1)}::text[]) as project(id)
          where workspaces.id = ${access.workspace.id}`.execute(transaction);
          await sql`insert into workspace_memberships(id, workspace_id, user_id, role, state, generation)
            select 'wmb_' || gen_random_uuid(), project.id, ${access.userId}, 'owner', 'active', 1
            from unnest(${projects.slice(1)}::text[]) as project(id)`.execute(transaction);
        });
        const projectsMs = performance.now() - setupStarted - peopleMs;
        await database
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
        await database
          .insertInto("accessEntries")
          .values(
            projects.map((workspaceId) => ({
              id: randomUUID(),
              subjectKind: "group" as const,
              subjectId: groupId,
              targetKind: "project" as const,
              targetId: workspaceId,
              level: "use" as const,
              grantedBy: access.userId,
            })),
          )
          .execute();
        const graphMs = performance.now() - setupStarted - peopleMs - projectsMs;
        const membershipStarted = performance.now();
        await database.transaction().execute(async (transaction) => {
          await sql`alter table workspace_memberships disable trigger workspace_memberships_account_directory_projection`.execute(
            transaction,
          );
          await sql`insert into workspace_memberships(id, workspace_id, user_id, role, state, generation)
            select 'wmb_' || gen_random_uuid(), project.id, person.id, 'collaborator', 'active', 1
            from unnest(${projects}::text[]) as project(id)
              cross join unnest(${users}::text[]) as person(id)`.execute(transaction);
          await sql`alter table workspace_memberships enable trigger workspace_memberships_account_directory_projection`.execute(
            transaction,
          );
        });
        expect(
          (
            await sql<{ enabled: string }>`select tgenabled as enabled from pg_trigger
              where tgrelid = 'workspace_memberships'::regclass
                and tgname = 'workspace_memberships_account_directory_projection'`.execute(database)
          ).rows,
        ).toEqual([{ enabled: "O" }]);
        await sql`analyze users; analyze workspace_memberships`.execute(database);
        console.info(
          `access fixture: people=${peopleCount} projects=${projectCount} peopleMs=${peopleMs.toFixed(2)} projectsMs=${projectsMs.toFixed(2)} graphMs=${graphMs.toFixed(2)} membershipsMs=${(performance.now() - membershipStarted).toFixed(2)}`,
        );
        const setupMs = performance.now() - setupStarted;
        let statements = 0;
        const measured = database.withPlugin({
          transformQuery(args) {
            statements++;
            return args.node;
          },
          async transformResult(args) {
            return args.result;
          },
        });
        const revision = Number(
          (await database.selectFrom("accessState").select("revision").executeTakeFirstOrThrow())
            .revision,
        );
        const started = performance.now();
        const result = await mutateAccess(measured, {
          actor: { userId: access.userId },
          commandIdentity: createId("command"),
          expectedRevision: revision,
          changes:
            operation === "delete-group"
              ? [{ kind: "delete-group", groupId }]
              : [{ kind: "member", userId: users[0]!, memberState: "suspended" }],
        });
        const elapsed = performance.now() - started;
        const pairs = operation === "delete-group" ? peopleCount * projectCount : projectCount;
        expect(result.transitions).toHaveLength(pairs);
        expect(
          result.transitions.every(
            (transition) => transition.state === "revoked" && transition.generation === 2,
          ),
        ).toBe(true);
        console.info(
          `access maximum: operation=${operation} pairs=${pairs} statements=${statements} setupMs=${setupMs.toFixed(2)} elapsedMs=${elapsed.toFixed(2)}`,
        );
        counts.push(statements);
      }
      expect(counts[1]).toBe(counts[0]);
    });

  it("keeps competing writes atomic on serialized success or retryable busy", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const userId = await access.member();
    const { database } = storeFixture;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const contenderReachedLock = Promise.withResolvers<void>();
    const fences = new Set<unknown>();
    const firstDatabase = database.withPlugin({
      transformQuery(args) {
        const node = JSON.stringify(args.node);
        if (
          args.node.kind === "SelectQueryNode" &&
          node.includes('"name":"workspaces"') &&
          node.includes("ForNoKeyUpdate")
        )
          fences.add(args.queryId);
        return args.node;
      },
      async transformResult(args) {
        if (fences.delete(args.queryId)) {
          held.resolve();
          await withTimeout(release.promise, 3000, {
            timeoutError: () => new Error("First access writer was never released"),
          });
        }
        return args.result;
      },
    });
    const secondDatabase = database.withPlugin({
      transformQuery(args) {
        if (
          database
            .getExecutor()
            .compileQuery(args.node, args.queryId)
            .sql.includes("pg_advisory_xact_lock")
        )
          contenderReachedLock.resolve();
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const commandIds = [createId("command"), createId("command")];
    const groupIds = [randomUUID(), randomUUID()];
    const entryIds = [randomUUID(), randomUUID()];
    const write = (observed: Kysely<DatabaseSchema>, position: number) =>
      mutateAccess(observed, {
        actor: { userId: access.userId },
        expectedRevision: access.revision() + position,
        commandIdentity: commandIds[position]!,
        changes: [
          { kind: "create-group", id: groupIds[position]!, name: `Contender ${position}` },
          {
            kind: "grant",
            id: entryIds[position]!,
            subject: { kind: "person", userId },
            target: { kind: "project", workspaceId: access.workspace.id },
            level: position === 0 ? "use" : "manage",
          },
        ],
      });
    const first = Promise.allSettled([write(firstDatabase, 0)]);
    let second: typeof first | undefined;
    try {
      await withTimeout(held.promise, 3000, {
        timeoutError: () => new Error("First writer never held its Workspace fence"),
      });
      second = Promise.allSettled([write(secondDatabase, 1)]);
      await withTimeout(contenderReachedLock.promise, 3000, {
        timeoutError: () => new Error("Contender never attempted the writer lock"),
      });
    } finally {
      release.resolve();
      await first;
      await second;
    }
    expect((await first)[0]!.status).toBe("fulfilled");
    const outcome = (await second!)[0]!;
    const committed = outcome.status === "fulfilled";
    if (!committed)
      expect(outcome.reason).toMatchObject({
        code: "conflict",
        retryable: true,
        message: "Access writer is busy",
      });
    const count = committed ? 2 : 1;
    expect(
      await database.selectFrom("accessGroups").select("id").where("id", "in", groupIds).execute(),
    ).toHaveLength(count);
    expect(
      await database.selectFrom("accessEntries").select("id").where("id", "in", entryIds).execute(),
    ).toHaveLength(count);
    expect(
      await database
        .selectFrom("securityAudit")
        .select("requestId")
        .where("requestId", "in", commandIds)
        .execute(),
    ).toHaveLength(count);
    expect(
      Number(
        (await database.selectFrom("accessState").select("revision").executeTakeFirstOrThrow())
          .revision,
      ),
    ).toBe(access.revision() + count);
    expect(await access.membership(userId)).toMatchObject({
      state: "active",
      role: committed ? "owner" : "collaborator",
      generation: String(count),
    });
    expect(
      await database
        .selectFrom("securityEffects")
        .select("id")
        .where("causeId", "in", commandIds)
        .execute(),
    ).toHaveLength(committed ? 6 : 0);
  });
  it("does not activate authority writers on an existing Deployment", async ({ storeFixture }) => {
    const { database, createRunFixture } = storeFixture;
    const fixture = await createRunFixture("access-legacy", null, "project");
    await expect(
      mutateAccess(database, {
        actor: { userId: fixture.userId },
        expectedRevision: 1,
        commandIdentity: createId("command"),
        changes: [{ kind: "create-group", id: randomUUID(), name: "Engineers" }],
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

    // Handing a new Project to someone else in the same list still records the creator's entry.
    const successor = await access.member("Successor");
    const handedOver = createId("workspace");
    const creatorEntry = randomUUID();
    const successorEntry = randomUUID();
    await access.mutate([
      {
        kind: "create-project",
        workspaceId: handedOver,
        entryId: creatorEntry,
        name: "Handed-over Project",
        color: "blue",
        backing: {
          kind: "local-directory",
          generation: 1,
          bindingId: createId("workspaceBinding"),
          ownerEnvironmentId: access.environmentId,
          storageAuthorityId: createId("storageAuthority"),
        },
      },
      {
        kind: "grant",
        id: successorEntry,
        subject: { kind: "person", userId: successor },
        target: { kind: "project", workspaceId: handedOver },
        level: "manage",
      },
      { kind: "revoke", entryId: creatorEntry },
    ]);
    expect(
      (
        await storeFixture.database
          .selectFrom("accessEntries")
          .select(["id", "revokedBy"])
          .where("targetId", "=", handedOver)
          .execute()
      ).sort((a, b) => (a.id < b.id ? -1 : 1)),
    ).toEqual(
      [
        { id: creatorEntry, revokedBy: access.userId },
        { id: successorEntry, revokedBy: null },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  it("returns a committed self-revoke's result when its command is retried", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const manager = await access.member("Manager");
    const entryId = randomUUID();
    await access.mutate({
      kind: "grant",
      id: entryId,
      subject: { kind: "person", userId: manager },
      target: { kind: "project", workspaceId: access.workspace.id },
      level: "manage",
    });
    const command = {
      actor: { userId: manager },
      expectedRevision: access.revision(),
      commandIdentity: createId("command"),
      changes: [{ kind: "revoke", entryId }],
    } as const;
    const committed = await mutateAccess(storeFixture.database, command);
    expect(committed.transitions).toMatchObject([{ userId: manager, state: "revoked" }]);
    // The response was lost: the manager can no longer manage, and the retry still answers.
    expect(await mutateAccess(storeFixture.database, command)).toEqual(committed);
    expect(await access.allowed(manager)).toEqual({ allowed: false });
  });

  const mutationKinds = [
    "create-project",
    "create-group",
    "delete-group",
    "add-group-member",
    "remove-group-member",
    "grant",
    "revoke",
    "member",
    "delete-project",
  ] as const;
  for (const first of mutationKinds)
    it(`reserves the complete lock set for ${first} paired with every mutation kind`, async ({
      storeFixture,
    }) => {
      const access = await setup(storeFixture);
      const { database } = storeFixture;
      const actorId = "usr_ffffffff-ffff-4fff-8fff-ffffffffffff" as UserId;
      const people = mutationKinds.flatMap((_kind, index) =>
        [0, 1].map((position) => ({
          id: `usr_00000000-0000-4000-8000-${((index + 1) * 2 - position).toString(16).padStart(12, "0")}` as UserId,
          name: `Pair ${index + 1}-${position}`,
        })),
      );
      await seedPeople(database, [
        { id: actorId, name: "High-ID administrator", administrator: true },
        ...people,
      ]);
      const mutate = async (changes: readonly AccessMutation[]) => {
        const state = await database
          .selectFrom("accessState")
          .select("revision")
          .executeTakeFirstOrThrow();
        return mutateAccess(database, {
          actor: { userId: actorId },
          expectedRevision: Number(state.revision),
          commandIdentity: createId("command"),
          changes,
        });
      };
      const prerequisites: AccessMutation[] = [];
      const pairs: { second: (typeof mutationKinds)[number]; changes: AccessMutation[] }[] = [];
      let ordinal = 0;
      for (const second of mutationKinds) {
        ordinal++;
        const change = (kind: (typeof mutationKinds)[number], position: number): AccessMutation => {
          const name = `Pair ${ordinal}-${position}`;
          const userId = people[(ordinal - 1) * 2 + position]!.id;
          const groupId = randomUUID();
          const entryId = randomUUID();
          const target = { kind: "project" as const, workspaceId: access.workspace.id };
          const subject = { kind: "person" as const, userId };
          switch (kind) {
            case "create-project":
              return {
                kind,
                workspaceId: createId("workspace"),
                entryId,
                name,
                color: "blue",
                backing: {
                  kind: "local-directory",
                  generation: 1,
                  bindingId: createId("workspaceBinding"),
                  ownerEnvironmentId: access.environmentId,
                  storageAuthorityId: createId("storageAuthority"),
                },
              };
            case "create-group":
              return { kind, id: groupId, name };
            case "delete-group":
            case "add-group-member":
            case "remove-group-member":
              prerequisites.push({ kind: "create-group", id: groupId, name });
              if (kind !== "add-group-member")
                prerequisites.push(
                  { kind: "add-group-member", groupId, member: subject },
                  {
                    kind: "grant",
                    id: entryId,
                    subject: { kind: "group", groupId },
                    target,
                    level: "use",
                  },
                );
              return kind === "delete-group"
                ? { kind, groupId }
                : { kind, groupId, member: subject };
            case "grant":
              return { kind, id: entryId, subject, target, level: "use" };
            case "revoke":
              prerequisites.push({ kind: "grant", id: entryId, subject, target, level: "use" });
              return { kind, entryId };
            case "member":
              return { kind, userId, memberKind: "guest" };
            case "delete-project": {
              const workspaceId = createId("workspace");
              prerequisites.push({
                kind: "create-project",
                workspaceId,
                entryId,
                name,
                color: "blue",
                backing: {
                  kind: "local-directory",
                  generation: 1,
                  bindingId: createId("workspaceBinding"),
                  ownerEnvironmentId: access.environmentId,
                  storageAuthorityId: createId("storageAuthority"),
                },
              });
              return { kind, workspaceId, purgeAfter: new Date("2099-01-01") };
            }
          }
        };
        pairs.push({ second, changes: [change(first, 0), change(second, 1)] });
      }
      await mutate(prerequisites);
      for (const { second, changes } of pairs) {
        if (changes.some((change) => change.kind === "delete-project")) {
          const state = await database
            .selectFrom("accessState")
            .select("revision")
            .executeTakeFirstOrThrow();
          await expect(mutate(changes), `${first} then ${second}`).rejects.toThrow(
            "workspace must retain at least one active owner",
          );
          expect(
            await database.selectFrom("accessState").select("revision").executeTakeFirstOrThrow(),
          ).toEqual(state);
        } else
          await expect(mutate(changes), `${first} then ${second}`).resolves.toMatchObject({
            revision: expect.any(Number),
          });
      }
      expect(ordinal).toBe(9);
    });

  for (const reverse of [false, true])
    it(`judges administrator handover on the final list state (reverse=${reverse})`, async ({
      storeFixture,
    }) => {
      const access = await setup(storeFixture);
      const successor = await access.member("Successor administrator");
      const keeper = await access.member("Retained Project owner");
      await access.mutate({
        kind: "grant",
        id: randomUUID(),
        subject: { kind: "person", userId: keeper },
        target: { kind: "project", workspaceId: access.workspace.id },
        level: "manage",
      });
      await storeFixture.database
        .updateTable("users")
        .set({ instanceRole: "administrator", memberState: "suspended", admittedAt: null })
        .where("id", "=", successor)
        .execute();
      const changes: AccessMutation[] = [
        { kind: "member", userId: successor, memberState: "active", admit: true },
        { kind: "member", userId: access.userId, memberState: "suspended" },
      ];
      if (reverse) changes.reverse();
      await expect(access.mutate(changes)).resolves.toMatchObject({
        revision: access.revision() + 1,
      });
      const state = await storeFixture.database
        .selectFrom("accessState")
        .select("revision")
        .executeTakeFirstOrThrow();
      await expect(
        mutateAccess(storeFixture.database, {
          actor: { userId: successor },
          expectedRevision: Number(state.revision),
          commandIdentity: createId("command"),
          changes: [
            { kind: "member", userId: access.userId, memberState: "active" },
            { kind: "member", userId: access.userId, memberState: "suspended" },
            { kind: "member", userId: successor, memberState: "suspended" },
          ],
        }),
      ).rejects.toThrow("The last active administrator cannot be removed");
      expect(
        await storeFixture.database
          .selectFrom("accessState")
          .select("revision")
          .executeTakeFirstOrThrow(),
      ).toEqual(state);
      expect(
        await storeFixture.database
          .selectFrom("users")
          .select(["id", "memberState", "admittedAt"])
          .where("id", "in", [access.userId, successor])
          .orderBy("id")
          .execute(),
      ).toEqual(
        [
          { id: access.userId, memberState: "suspended", admittedAt: expect.any(Date) },
          { id: successor, memberState: "active", admittedAt: expect.any(Date) },
        ].sort((first, second) => first.id.localeCompare(second.id)),
      );
    });

  it("judges cycles on the final graph rather than intermediate edge replacements", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const first = randomUUID();
    const second = randomUUID();
    const userId = await access.member();
    await access.mutate([
      { kind: "create-group", id: first, name: "Cycle first" },
      { kind: "create-group", id: second, name: "Cycle second" },
      { kind: "add-group-member", groupId: first, member: { kind: "group", groupId: second } },
      { kind: "add-group-member", groupId: second, member: { kind: "person", userId } },
      {
        kind: "grant",
        id: randomUUID(),
        subject: { kind: "group", groupId: first },
        target: { kind: "project", workspaceId: access.workspace.id },
        level: "use",
      },
    ]);
    await expect(
      access.mutate([
        { kind: "add-group-member", groupId: second, member: { kind: "group", groupId: first } },
        { kind: "remove-group-member", groupId: first, member: { kind: "group", groupId: second } },
      ]),
    ).resolves.toMatchObject({ revision: access.revision() + 1 });
    expect(await access.allowed(userId)).toEqual({ allowed: false });
    const unchanged = await storeFixture.database
      .selectFrom("accessGroupMembers")
      .selectAll()
      .orderBy("groupId")
      .orderBy("memberId")
      .execute();
    await expect(
      access.mutate([
        { kind: "add-group-member", groupId: first, member: { kind: "group", groupId: second } },
        { kind: "member", userId, memberKind: "guest" },
      ]),
    ).rejects.toThrow(/cycle/i);
    expect(
      await storeFixture.database
        .selectFrom("accessGroupMembers")
        .selectAll()
        .orderBy("groupId")
        .orderBy("memberId")
        .execute(),
    ).toEqual(unchanged);
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
    await access.mutate([
      {
        kind: "add-group-member",
        groupId: groups[7]!,
        member: { kind: "group", groupId: groups[8]! },
      },
      {
        kind: "remove-group-member",
        groupId: groups[0]!,
        member: { kind: "group", groupId: groups[1]! },
      },
    ]);
    const transientGroup = randomUUID();
    await expect(
      access.mutate([
        { kind: "create-group", id: transientGroup, name: "Depth must roll back" },
        {
          kind: "add-group-member",
          groupId: groups[0]!,
          member: { kind: "group", groupId: groups[1]! },
        },
      ]),
    ).rejects.toMatchObject({ code: "resource_exhausted", details: { limit: "depth" } });
    expect(
      await storeFixture.database
        .selectFrom("accessGroups")
        .select("id")
        .where("id", "=", transientGroup)
        .execute(),
    ).toEqual([]);
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

  it("keeps stable tombstones and refuses old handles after remove and re-add", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const userId = await access.member();
    const grant = async () => {
      const id = randomUUID();
      await access.mutate({
        kind: "grant",
        id,
        subject: { kind: "person", userId },
        target: { kind: "project", workspaceId: access.workspace.id },
        level: "use",
      });
      return id;
    };
    const first = await grant();
    const original = (await access.membership(userId))!;
    await access.mutate({ kind: "revoke", entryId: first });
    await grant();
    expect(await access.membership(userId)).toMatchObject({
      id: original.id,
      generation: "3",
      state: "active",
    });
    expect(await access.allowed(userId, 1)).toEqual({ allowed: false });
    const effects = await claimAccessSecurityEffects(storeFixture.database, {
      now: new Date("2099-01-01"),
      leaseUntil: new Date("2099-01-02"),
      limit: 100,
    });
    expect(
      effects
        .filter((effect) => effect.userId === userId)
        .map((effect) => effect.membershipGenerationCutoff),
    ).toEqual(expect.arrayContaining([1, 2]));
  });

  it("collapses nested diamonds and Everyone, ignoring guests and redundant grants", async ({
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
    });
    await access.mutate({ kind: "revoke", entryId: shorter });
    expect(await access.membership(full)).toMatchObject({ generation: "1" });
    const manager = randomUUID();
    await access.mutate({
      kind: "grant",
      id: manager,
      subject: { kind: "person", userId: full },
      target,
      level: "manage",
    });
    expect((await access.membership(full))!.generation).toBe("2");
    await access.mutate({ kind: "revoke", entryId: manager });
    expect(await access.allowed(full, 2)).toEqual({ allowed: false });
    await access.mutate({
      kind: "remove-group-member",
      groupId: groups[1]!,
      member: { kind: "group", groupId: groups[3]! },
    });
    expect(await access.membership(full)).toMatchObject({
      generation: "3",
      role: "collaborator",
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
        changes: [
          {
            kind: "add-group-member",
            groupId: first,
            member: { kind: "group", groupId: second },
          },
        ],
      }),
      mutateAccess(storeFixture.database, {
        ...input,
        commandIdentity: createId("command"),
        changes: [
          {
            kind: "add-group-member",
            groupId: second,
            member: { kind: "group", groupId: first },
          },
        ],
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
    const replacement = randomUUID();
    await expect(
      access.mutate([
        {
          kind: "grant",
          id: replacement,
          subject: { kind: "person", userId },
          target: { kind: "project", workspaceId: access.workspace.id },
          level: "use",
        },
        { kind: "revoke", entryId: entries[1]!.id },
      ]),
    ).resolves.toMatchObject({ transitions: [] });
    const rejected = randomUUID();
    await expect(
      access.mutate([
        {
          kind: "grant",
          id: rejected,
          subject: { kind: "person", userId },
          target: { kind: "project", workspaceId: access.workspace.id },
          level: "use",
        },
        { kind: "member", userId, memberKind: "guest" },
      ]),
    ).rejects.toMatchObject({ code: "resource_exhausted", details: { limit: "matchingEntries" } });
    expect(
      await storeFixture.database
        .selectFrom("accessEntries")
        .select("id")
        .where("id", "=", rejected)
        .execute(),
    ).toEqual([]);
    expect(
      await storeFixture.database
        .selectFrom("users")
        .select("memberKind")
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ memberKind: "full" });
  });

  it("checks matching-entry growth per pair rather than the Deployment maximum", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const first = await access.member("Already oversized");
    const second = await access.member("At capacity");
    await storeFixture.database
      .insertInto("accessEntries")
      .values(
        [first, second].flatMap((userId, index) =>
          Array.from({ length: 257 - index }, () => ({
            id: randomUUID(),
            subjectKind: "user" as const,
            subjectId: userId,
            targetKind: "project" as const,
            targetId: access.workspace.id,
            level: "use" as const,
            grantedBy: access.userId,
            revokedBy: null,
          })),
        ),
      )
      .execute();
    await expect(
      access.mutate({
        kind: "grant",
        id: randomUUID(),
        subject: { kind: "person", userId: second },
        target: { kind: "project", workspaceId: access.workspace.id },
        level: "use",
      }),
    ).rejects.toMatchObject({
      code: "resource_exhausted",
      details: { limit: "matchingEntries" },
    });
    await expect(
      access.mutate({
        kind: "member",
        userId: first,
        memberState: "suspended",
      }),
    ).resolves.toBeDefined();
  });

  it("refuses Request-scope growth but permits revocation of an oversized inherited scope", async ({
    storeFixture,
  }) => {
    const run = await storeFixture.createRunFixture("access", null, "project");
    const access = await setup(storeFixture, run);
    const userId = await access.member();
    const entryId = randomUUID();
    await access.mutate({
      kind: "grant",
      id: entryId,
      subject: { kind: "person", userId },
      target: { kind: "project", workspaceId: access.workspace.id },
      level: "use",
    });
    const turn = await storeFixture.enqueueHumanTrigger({
      content: [{ type: "text", text: "Request origin" }],
      idempotencyKey: "oversized-request-origin",
      requestedBy: userId,
      threadId: run.thread.id,
    });
    const targets = Array.from({ length: 256 }, () => createId("workspace"));
    await storeFixture.database.transaction().execute(async (transaction) => {
      await sql`insert into workspaces(id,name,color,kind,created_by,backing,status)
        select target.id, 'Retained Request scope', 'blue', 'project', ${access.userId},
          jsonb_set(backing, '{bindingId}', to_jsonb(replace(target.id, 'wsp_', 'wbd_'))), 'ready'
        from workspaces cross join unnest(${targets}::text[]) as target(id) where workspaces.id = ${access.workspace.id}`.execute(
        transaction,
      );
      await transaction
        .insertInto("workspaceMemberships")
        .values(
          targets.map((workspaceId) => ({
            id: createId("workspaceMembership"),
            workspaceId,
            userId: access.userId,
            role: "owner" as const,
            state: "active" as const,
            generation: 1,
            invitedBy: null,
          })),
        )
        .execute();
      await transaction
        .insertInto("requests")
        .values(
          targets.map((targetWorkspaceId, index) => ({
            id: createId("request"),
            callId: `inherited-${index}`,
            kind: "harness.approval" as const,
            mode: "live" as const,
            originatingRunId: turn.run.id,
            originatingOccurrenceId: null,
            originatingThreadId: run.thread.id,
            originatingWorkspaceId: access.workspace.id,
            targetWorkspaceId,
            requestedBy: userId,
            payload: sql`'{}'::jsonb`,
            presentation: sql`'{"kind":"choice","options":[],"title":"Inherited"}'::jsonb`,
            requiredActor: "requester" as const,
            status: "pending" as const,
          })),
        )
        .execute();
    });
    await expect(
      access.mutate({
        kind: "grant",
        id: randomUUID(),
        subject: { kind: "person", userId },
        target: { kind: "project", workspaceId: access.workspace.id },
        level: "use",
      }),
    ).rejects.toMatchObject({
      code: "resource_exhausted",
      details: { limit: "requestWorkspaces" },
    });
    await expect(access.mutate({ kind: "revoke", entryId })).resolves.toBeDefined();
  });

  it("atomically replaces immutable grants without interrupting an unchanged effective level", async ({
    storeFixture,
  }) => {
    const access = await setup(storeFixture);
    const userId = await access.member();
    const oldId = randomUUID();
    const replacementId = randomUUID();
    await access.mutate({
      kind: "grant",
      id: oldId,
      subject: { kind: "person", userId },
      target: { kind: "project", workspaceId: access.workspace.id },
      level: "manage",
    });
    const before = await access.membership(userId);
    const result = await mutateAccess(storeFixture.database, {
      actor: { userId: access.userId },
      commandIdentity: createId("command"),
      expectedRevision: access.revision(),
      changes: [
        { kind: "revoke", entryId: oldId },
        {
          kind: "grant",
          id: replacementId,
          subject: { kind: "person", userId },
          target: { kind: "project", workspaceId: access.workspace.id },
          level: "manage",
        },
      ],
    });
    expect(result.transitions).toEqual([]);
    expect(await access.membership(userId)).toMatchObject({
      id: before!.id,
      generation: before!.generation,
      state: "active",
    });
    expect(await access.allowed(userId, 1)).toMatchObject({ allowed: true });
    await expect(
      access.mutate([
        { kind: "revoke", entryId: replacementId },
        {
          kind: "grant",
          id: replacementId,
          subject: { kind: "person", userId },
          target: { kind: "project", workspaceId: access.workspace.id },
          level: "use",
        },
      ]),
    ).rejects.toThrow("Access entries are immutable");
    const nextUser = await access.member("Replacement subject");
    const nextProject = createId("workspace");
    const moved = await access.mutate([
      {
        kind: "create-project",
        workspaceId: nextProject,
        entryId: randomUUID(),
        name: "Replacement target",
        color: "blue",
        backing: {
          kind: "local-directory",
          generation: 1,
          bindingId: createId("workspaceBinding"),
          ownerEnvironmentId: access.environmentId,
          storageAuthorityId: createId("storageAuthority"),
        },
      },
      { kind: "revoke", entryId: replacementId },
      {
        kind: "grant",
        id: randomUUID(),
        subject: { kind: "person", userId: nextUser },
        target: { kind: "project", workspaceId: nextProject },
        level: "use",
      },
    ]);
    expect(moved.transitions).toHaveLength(3);
    expect(await access.membership(userId)).toMatchObject({
      id: before!.id,
      generation: "2",
      state: "revoked",
    });
    expect(
      await checkAccess(storeFixture.database, {
        principal: { kind: "person", userId: nextUser },
        callerKind: "person",
        target: { kind: "project", workspaceId: nextProject },
        action: "use",
      }),
    ).toMatchObject({ allowed: true, membershipGeneration: 1 });
  });

  it("matches an independent uncached graph interpreter through a seeded mutation trace", async ({
    storeFixture,
  }) => {
    const seed = Number(process.env.OPENSTEER_ACCESS_SEED ?? 0x792a51);
    const steps = Number(process.env.OPENSTEER_ACCESS_STEPS ?? 80);
    expect(Number.isSafeInteger(seed) && seed > 0 && seed <= 0xffffffff).toBe(true);
    expect(Number.isSafeInteger(steps) && steps > 0).toBe(true);
    console.info(`access trace: seed=${seed} steps=${steps}`);
    let random = seed;
    const choose = (count: number) => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return (random >>> 0) % count;
    };
    try {
      const setupStarted = performance.now();
      const access = await setup(storeFixture);
      const people = Array.from({ length: 4 }, () => createId("user"));
      await seedPeople(
        storeFixture.database,
        people.map((id, index) => ({ id, name: `Trace ${index}` })),
      );
      const kinds = new Map<UserId, "full" | "guest">();
      const active = new Map<UserId, boolean>();
      const observedPeople = [access.userId, ...people];
      kinds.set(access.userId, "full");
      active.set(access.userId, true);
      for (const userId of people) {
        kinds.set(userId, "full");
        active.set(userId, true);
      }
      const groups = Array.from({ length: 4 }, () => randomUUID());
      const children = new Map<string, Set<string>>(groups.map((group) => [group, new Set()]));
      const grants = new Map<string, { subject: string; level: "use" | "manage" }>();
      const history = new Map<
        UserId,
        { id: string; generation: number; state: string; role: string }
      >();
      const creatorEntry = randomUUID();
      await access.mutate([
        ...groups.map((id, index) => ({
          kind: "create-group" as const,
          id,
          name: `Trace group ${index}`,
          ...(index === 0 ? { builtin: "everyone" as const } : {}),
        })),
        {
          kind: "grant",
          id: creatorEntry,
          subject: { kind: "person", userId: access.userId },
          target: { kind: "project", workspaceId: access.workspace.id },
          level: "manage",
        },
      ]);
      grants.set(creatorEntry, { subject: access.userId, level: "manage" });
      const creatorMembership = (await access.membership(access.userId))!;
      history.set(access.userId, {
        id: creatorMembership.id,
        generation: Number(creatorMembership.generation),
        state: "active",
        role: "owner",
      });
      const setupMs = performance.now() - setupStarted;
      const interpret = (userId: UserId) => {
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
        const matching = [...grants.values()].filter((grant) => subjects.has(grant.subject));
        const top = matching.some((grant) => grant.level === "manage")
          ? matching.filter((grant) => grant.level === "manage")
          : matching;
        if (!top.length) return null;
        return {
          role: top[0]!.level === "manage" ? "owner" : "collaborator",
        };
      };
      const traceStarted = performance.now();
      for (let step = 0; step < steps; step++) {
        const userId = people[choose(people.length)]!;
        const groupId = groups[1 + choose(groups.length - 1)]!;
        const operation = choose(8);
        if (operation === 0) {
          const id = randomUUID();
          const subject = choose(2) ? userId : groupId;
          const level = choose(2) ? "use" : "manage";
          if (!active.get(userId) && subject === userId) continue;
          await access.mutate({
            kind: "grant",
            id,
            subject: children.has(subject)
              ? { kind: "group", groupId: subject }
              : { kind: "person", userId },
            target: { kind: "project", workspaceId: access.workspace.id },
            level,
          });
          grants.set(id, { subject, level });
        } else if (operation === 1 && grants.size > 1) {
          const removable = [...grants.keys()].filter((id) => id !== creatorEntry);
          const id = removable[choose(removable.length)]!;
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
        } else if (operation === 6 || !active.get(userId)) {
          const id = randomUUID();
          await expect(
            mutateAccess(storeFixture.database, {
              actor: { userId: access.userId },
              expectedRevision: 0,
              commandIdentity: createId("command"),
              changes: [{ kind: "create-group", id, name: `Rolled back ${step}` }],
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
                changes: Array.isArray(change) ? change : [change],
              }),
            ),
          );
          expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          for (const [index, result] of results.entries()) {
            if (result.status === "fulfilled") {
              const grant = changes[index]!;
              grants.set(grant.id, { subject: userId, level: grant.level });
            } else expect(result.reason).toMatchObject({ code: "conflict" });
          }
        }
        const rows = await storeFixture.database
          .selectFrom("workspaceMemberships")
          .selectAll()
          .where("workspaceId", "=", access.workspace.id)
          .execute();
        const memberships = new Map(rows.map((row) => [row.userId, row]));
        for (const person of observedPeople) {
          const previous = history.get(person);
          const value = interpret(person);
          const state = value ? "active" : "revoked";
          const expected =
            !previous && !value
              ? undefined
              : {
                  id: previous?.id ?? "",
                  generation: previous
                    ? previous.generation +
                      Number(previous.state !== state || (!!value && previous.role !== value.role))
                    : 1,
                  state,
                  role: value?.role ?? previous!.role,
                };
          const row = memberships.get(person);
          if (!expected) {
            expect(row).toBeUndefined();
            continue;
          }
          expect(row, `seed=${seed} step=${step} person=${person}`).toMatchObject({
            state: expected.state,
            role: expected.role,
            generation: String(expected.generation),
            ...(previous ? { id: previous.id } : {}),
          });
          history.set(person, { ...expected, id: row!.id });
        }
        expect(rows).toHaveLength(history.size);
      }
      await expect(
        access.mutate({
          kind: "delete-project",
          workspaceId: access.workspace.id,
          purgeAfter: new Date(Date.now() + 86_400_000),
        }),
      ).rejects.toThrow("workspace must retain at least one active owner");
      for (const [person, previous] of history)
        expect(await access.membership(person)).toMatchObject({
          id: previous.id,
          state: previous.state,
          role: previous.role,
          generation: String(previous.generation),
        });
      console.info(
        `access trace cost: setupMs=${setupMs.toFixed(2)} traceMs=${(performance.now() - traceStarted).toFixed(2)}`,
      );
    } catch (error) {
      throw new Error(`Access invariant seed=${seed}`, { cause: error });
    }
  });
});
