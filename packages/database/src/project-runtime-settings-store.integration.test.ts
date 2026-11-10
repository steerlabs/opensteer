import { createId, HarnessIdSchema, ModelSelectionSchema } from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect } from "vitest";
import { migrationProvider } from "./migrations.js";
import {
  getProjectRuntimeSettings,
  resolveProjectRuntime,
  setProjectRuntimeSettings,
} from "./project-runtime-settings-store.js";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";
import { jsonValue } from "./store-primitives.js";

async function setup(fixture: StoreFixture) {
  const run = await fixture.createRunFixture("project-settings", null, "project");
  const instance = await fixture.store.createHarnessInstance({
    driverKind: HarnessIdSchema.parse("codex"),
    config: {},
    environmentId: run.environmentId,
    name: "Project Codex",
    stateKind: "isolated",
    sourceId: "openai",
  });
  const catalog = HarnessInstanceCatalogSchema.parse({
    driverKind: "codex",
    harnessInstanceId: instance.id,
    status: "ready",
    continuationIdentity: {
      driverKind: "codex",
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
    },
    models: [
      {
        displayName: "Project model",
        isDefault: true,
        providerId: "openai",
        modelId: "project-model",
        nativeModelId: "endpoint-project-model",
        options: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            values: [{ value: "low", label: "Low" }],
          },
        ],
      },
    ],
  });
  await fixture.database
    .insertInto("harnessCatalogs")
    .values({
      environmentId: run.environmentId,
      harnessInstanceId: instance.id,
      catalog: jsonValue(catalog),
      capturedAt: new Date(),
    })
    .execute();
  const input = {
    workspaceId: run.workspace.id,
    expectedAccessRevision: 1,
    expectedSettingsRevision: null,
    commandIdentity: createId("command"),
    harnessInstanceId: instance.id,
    modelSelection: ModelSelectionSchema.omit({ nativeModelId: true }).parse({
      modelId: "project-model",
      providerId: "openai",
      options: { effort: "low" },
    }),
    accessMode: "approval-required" as const,
    instructions: "Project instructions",
    timeZone: "America/New_York",
  };
  const actor = { userId: run.userId, authorityGeneration: 1 };
  const activate = async () => {
    await fixture.database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    await fixture.database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", run.userId)
      .execute();
  };
  return { ...run, input, actor, instance, catalog, activate };
}

describeStore("Project runtime settings", (it) => {
  it("refuses every model-1 API and SQL write, including Project-shaped input without a user fallback", async ({
    storeFixture,
  }) => {
    const prepared = await setup(storeFixture);
    await expect(
      getProjectRuntimeSettings(storeFixture.database, prepared.workspace.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      resolveProjectRuntime(storeFixture.database, prepared.workspace.id, () => true),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      setProjectRuntimeSettings(storeFixture.database, prepared.actor, prepared.input),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      storeFixture.database
        .insertInto("projectRuntimeSettings")
        .values({
          workspaceId: prepared.workspace.id,
          harnessInstanceId: prepared.instance.id,
          modelSelection: jsonValue(prepared.input.modelSelection),
          accessMode: "auto",
          updatedBy: prepared.userId,
        })
        .execute(),
    ).rejects.toThrow(/authority model 2/);
    expect(
      await storeFixture.database.selectFrom("projectRuntimeSettings").selectAll().execute(),
    ).toEqual([]);
  });

  it("uses effective manager access and both revisions, deriving native model identity and recording only metadata", async ({
    storeFixture,
  }) => {
    const prepared = await setup(storeFixture);
    await prepared.activate();
    expect(
      await resolveProjectRuntime(storeFixture.database, prepared.workspace.id, () => true),
    ).toEqual({ state: "unavailable", reason: "not-configured" });
    const first = await setProjectRuntimeSettings(
      storeFixture.database,
      prepared.actor,
      prepared.input,
    );
    expect(first).toMatchObject({
      revision: 1,
      updatedBy: prepared.userId,
      modelSelection: { nativeModelId: "endpoint-project-model" },
    });
    expect(
      await setProjectRuntimeSettings(storeFixture.database, prepared.actor, prepared.input),
    ).toEqual(first);
    await expect(
      setProjectRuntimeSettings(storeFixture.database, prepared.actor, {
        ...prepared.input,
        instructions: "changed",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      setProjectRuntimeSettings(storeFixture.database, prepared.actor, {
        ...prepared.input,
        commandIdentity: createId("command"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      setProjectRuntimeSettings(storeFixture.database, prepared.actor, {
        ...prepared.input,
        expectedAccessRevision: 2,
        expectedSettingsRevision: 1,
        commandIdentity: createId("command"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const next = await setProjectRuntimeSettings(storeFixture.database, prepared.actor, {
      ...prepared.input,
      commandIdentity: createId("command"),
      expectedSettingsRevision: 1,
      instructions: "updated",
    });
    expect(next.revision).toBe(2);
    const administrator = await storeFixture.store.createUser("Metadata-only admin");
    await storeFixture.database
      .updateTable("users")
      .set({ instanceRole: "administrator", admittedAt: new Date() })
      .where("id", "=", administrator)
      .execute();
    await expect(
      setProjectRuntimeSettings(
        storeFixture.database,
        { userId: administrator },
        { ...prepared.input, expectedSettingsRevision: 2 },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      setProjectRuntimeSettings(
        storeFixture.database,
        { ...prepared.actor, authorityGeneration: 2 },
        { ...prepared.input, expectedSettingsRevision: 2 },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await storeFixture.database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: prepared.workspace.id,
        userId: administrator,
        role: "owner",
        state: "active",
        generation: 1,
        invitedBy: null,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    await storeFixture.database
      .updateTable("workspaceMemberships")
      .set({ role: "collaborator" })
      .where("workspaceId", "=", prepared.workspace.id)
      .where("userId", "=", prepared.userId)
      .execute();
    await expect(
      setProjectRuntimeSettings(storeFixture.database, prepared.actor, {
        ...prepared.input,
        expectedSettingsRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const audits = await storeFixture.database
      .selectFrom("securityAudit")
      .select("metadata")
      .where("action", "=", "project-runtime-settings.updated")
      .execute();
    expect(audits).toHaveLength(2);
    for (const audit of audits)
      expect(Object.keys(audit.metadata).sort()).toEqual(["fingerprint", "revision"]);
  });

  it("rejects mismatched environments, engines, model/provider/options, forged native IDs and invalid Host settings", async ({
    storeFixture,
  }) => {
    const prepared = await setup(storeFixture);
    const otherEnvironmentId = createId("environment");
    await storeFixture.database
      .insertInto("executionEnvironments")
      .values({
        id: otherEnvironmentId,
        name: "Other environment",
        kind: "managed",
        runnerId: prepared.runnerId,
        capabilities: jsonValue([]),
        createdAt: new Date(),
      })
      .execute();
    const other = await storeFixture.store.createHarnessInstance({
      driverKind: HarnessIdSchema.parse("codex"),
      environmentId: otherEnvironmentId,
      config: {},
      name: "Wrong environment",
      stateKind: "isolated",
    });
    await prepared.activate();
    for (const change of [
      { harnessInstanceId: other.id },
      { harnessInstanceId: prepared.harnessInstance.id },
      { modelSelection: { ...prepared.input.modelSelection, providerId: "anthropic" } },
      { modelSelection: { ...prepared.input.modelSelection, modelId: "not-offered" } },
      { modelSelection: { ...prepared.input.modelSelection, options: { effort: "high" } } },
      { modelSelection: { ...prepared.input.modelSelection, options: { unknown: true } } },
      { modelSelection: { ...prepared.input.modelSelection, nativeModelId: "forged" } },
      { instructions: "é".repeat(32_769) },
      { timeZone: "Invalid/Time_Zone" },
    ])
      await expect(
        setProjectRuntimeSettings(storeFixture.database, prepared.actor, {
          ...prepared.input,
          ...change,
          commandIdentity: createId("command"),
        }),
      ).rejects.toThrow();
    expect(
      await getProjectRuntimeSettings(storeFixture.database, prepared.workspace.id),
    ).toBeNull();
    await expect(
      storeFixture.database
        .insertInto("projectRuntimeSettings")
        .values({
          workspaceId: prepared.workspace.id,
          harnessInstanceId: other.id,
          modelSelection: jsonValue(prepared.input.modelSelection),
          accessMode: "auto",
          updatedBy: prepared.userId,
        })
        .execute(),
    ).rejects.toThrow(/deployment-owned environment/);
  });

  it("never borrows a creator's runtime when a computer, engine, catalog or model becomes unavailable", async ({
    storeFixture,
  }) => {
    const prepared = await setup(storeFixture);
    await prepared.activate();
    await setProjectRuntimeSettings(storeFixture.database, prepared.actor, prepared.input);
    expect(
      await resolveProjectRuntime(storeFixture.database, prepared.workspace.id, () => false),
    ).toEqual({ state: "unavailable", reason: "computer-offline" });
    expect(
      await resolveProjectRuntime(storeFixture.database, prepared.workspace.id, () => true),
    ).toEqual({ state: "unavailable", reason: "runner-update-required" });
    await storeFixture.database
      .updateTable("runners")
      .set({ capabilities: jsonValue(["project-authority-v1"]) })
      .where("id", "=", prepared.runnerId)
      .execute();
    expect(
      await resolveProjectRuntime(storeFixture.database, prepared.workspace.id, () => true),
    ).toMatchObject({
      state: "ready",
      environmentId: prepared.environmentId,
      settings: { harnessInstanceId: prepared.instance.id },
    });
    await storeFixture.database
      .updateTable("harnessCatalogs")
      .set({
        catalog: jsonValue(
          HarnessInstanceCatalogSchema.parse({
            ...prepared.catalog,
            models:
              prepared.catalog.status === "ready"
                ? prepared.catalog.models.map((model) => ({ ...model, modelId: "replacement" }))
                : [],
          }),
        ),
      })
      .where("harnessInstanceId", "=", prepared.instance.id)
      .execute();
    expect(
      await resolveProjectRuntime(storeFixture.database, prepared.workspace.id, () => true),
    ).toEqual({ state: "unavailable", reason: "model-unavailable" });
    await storeFixture.database
      .deleteFrom("harnessCatalogs")
      .where("harnessInstanceId", "=", prepared.instance.id)
      .execute();
    expect(
      await resolveProjectRuntime(storeFixture.database, prepared.workspace.id, () => true),
    ).toEqual({ state: "unavailable", reason: "engine-unavailable" });
    await storeFixture.database
      .updateTable("harnessInstances")
      .set({ removedAt: new Date(), enabled: false, isDefault: false })
      .where("id", "=", prepared.instance.id)
      .execute();
    expect(
      await resolveProjectRuntime(storeFixture.database, prepared.workspace.id, () => true),
    ).toEqual({ state: "unavailable", reason: "engine-unavailable" });
    expect(
      (await getProjectRuntimeSettings(storeFixture.database, prepared.workspace.id))?.revision,
    ).toBe(1);
  });

  it("serializes competing settings CAS writers and refuses the same writes after authority is revoked", async ({
    storeFixture,
  }) => {
    const prepared = await setup(storeFixture);
    await prepared.activate();
    const results = await Promise.allSettled(
      ["one", "two"].map((instructions) =>
        setProjectRuntimeSettings(storeFixture.database, prepared.actor, {
          ...prepared.input,
          instructions,
          commandIdentity: createId("command"),
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await storeFixture.database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", prepared.userId)
      .execute();
    await storeFixture.database
      .updateTable("users")
      .set({ memberState: "suspended", authorityGeneration: 2 })
      .where("id", "=", prepared.userId)
      .execute();
    await expect(
      setProjectRuntimeSettings(storeFixture.database, prepared.actor, {
        ...prepared.input,
        expectedAccessRevision: 2,
        expectedSettingsRevision: 1,
        commandIdentity: createId("command"),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("adds exactly its new table and preserves existing legacy rows, functions, triggers, constraints and indexes", async ({
    storeFixture,
  }) => {
    const prepared = await storeFixture.createRunFixture("settings-migration", null, "project");
    await sql`drop table public.team_invitations;
      alter table public.auth_sessions drop column member_generation;
      alter table public.agent_connections drop column member_generation, drop column membership_generation;
      drop table public.project_runtime_settings; drop function public.opensteer_project_runtime_settings_scope();
      delete from kysely_migration where name >= '0170_project_execution_preparation'`.execute(
      storeFixture.database,
    );
    const objects = () =>
      sql<{ name: string; definition: string }>`
      select 'function:' || oid::regprocedure::text as name, pg_get_functiondef(oid) as definition from pg_proc where pronamespace = 'public'::regnamespace and proname like 'opensteer_%'
      union all select 'index:' || indexname, indexdef from pg_indexes where schemaname = 'public'
      union all select 'trigger:' || tgrelid::regclass::text || ':' || tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace) and not tgisinternal
      union all select 'constraint:' || conrelid::regclass::text || ':' || conname, pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace order by name`.execute(
        storeFixture.database,
      );
    const before = (await objects()).rows;
    const tables = () =>
      sql<{
        name: string;
      }>`select tablename as name from pg_tables where schemaname = 'public' order by tablename`.execute(
        storeFixture.database,
      );
    const previousTables = (await tables()).rows;
    const workspace = await storeFixture.database
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", prepared.workspace.id)
      .executeTakeFirstOrThrow();
    const result = await new Migrator({
      db: storeFixture.database,
      provider: migrationProvider(),
    }).migrateTo("0170_project_execution_preparation");
    if (result.error) throw result.error;
    expect(
      (await objects()).rows.filter((row) => before.some((previous) => previous.name === row.name)),
    ).toEqual(before);
    expect(
      (await tables()).rows.filter(
        (row) => !previousTables.some((previous) => previous.name === row.name),
      ),
    ).toEqual([{ name: "project_runtime_settings" }]);
    expect(
      await storeFixture.database
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", workspace.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(workspace);
    expect(
      await storeFixture.database.selectFrom("projectRuntimeSettings").selectAll().execute(),
    ).toEqual([]);
  });
});
