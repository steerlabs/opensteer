import { randomBytes } from "node:crypto";
import { createId } from "@opensteer/core";
import {
  createDatabase,
  MigrationLineageError,
  migrationProvider,
  OpensteerStore,
} from "@opensteer/database";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  destroyPersistedManagedDeploymentData,
  isPristineUnmigratedDatabase,
  prepareManagedDestructionDatabase,
} from "./managed-destruction.js";

const configuredUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = configuredUrl ? describe : describe.skip;
const databaseName = `opensteer_teardown_upgrade_${randomBytes(8).toString("hex")}`;

integration("managed teardown upgrades a stopped Host database", () => {
  const url = new URL(configuredUrl ?? "postgres://unconfigured/postgres");
  url.pathname = "/postgres";
  const administrator = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
  url.pathname = `/${databaseName}`;
  const database = createDatabase({ connectionString: url.toString(), maxConnections: 1 });

  beforeAll(async () => {
    await sql.raw(`create database ${databaseName}`).execute(administrator);
  });

  afterAll(async () => {
    await database.destroy();
    await sql.raw(`drop database if exists ${databaseName}`).execute(administrator);
    await administrator.destroy();
  });

  it("leaves a pristine database untouched", async () => {
    await expect(prepareManagedDestructionDatabase(database)).resolves.toBe("pristine");
    await expect(isPristineUnmigratedDatabase(database)).resolves.toBe(true);
  });

  it("upgrades the legacy deployment shape before validating identity and destroying volumes", async () => {
    const migrator = new Migrator({ db: database, provider: migrationProvider() });
    const result = await migrator.migrateTo("0017_trigger_downstream_run_lookup");
    expect(result.error).toBeUndefined();
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    await sql`
      insert into deployments (id, singleton_key, active_host_instance_id, canonical_origin, deployment_shape)
      values (${deploymentId}, 'primary', ${hostInstanceId}, 'https://old.opensteer.test',
        '{"backing":"portablefs","kind":"server"}'::jsonb)
    `.execute(database);
    const store = new OpensteerStore(database);
    const userId = await store.createUser("Managed owner");
    // Written as the 0017 schema holds a Workspace; today's store writes columns
    // that schema does not have yet.
    const backing = {
      generation: 1,
      kind: "portablefs",
      serviceId: "managed",
      volumeId: randomBytes(16).toString("hex"),
    };
    const workspaceId = createId("workspace");
    // One transaction: the schema requires an active owner by the time it commits.
    await database.transaction().execute(async (transaction) => {
      await sql`
        insert into workspaces (id, name, status, created_by, kind, backing, capacity_policy)
        values (${workspaceId}, 'Retained workspace', 'ready', ${userId}, 'specialized',
          ${JSON.stringify(backing)}::jsonb,
          '{"blockHardLimitBytes":1024,"inodeHardLimit":10,"kind":"hard-quota"}'::jsonb)
      `.execute(transaction);
      await sql`
        insert into workspace_memberships (id, workspace_id, user_id, role, state)
        values (${createId("workspaceMembership")}, ${workspaceId}, ${userId}, 'owner', 'active')
      `.execute(transaction);
    });
    const destroy = vi.fn(async () => undefined);
    const input = { driver: { destroy }, expectedDeploymentId: deploymentId, store };
    await expect(destroyPersistedManagedDeploymentData(input)).rejects.toThrow();
    expect(destroy).not.toHaveBeenCalled();

    await expect(prepareManagedDestructionDatabase(database)).resolves.toBe("ready");
    const [workspace] = await store.listWorkspaces();
    expect(workspace).toMatchObject({ icon: null, name: "Retained workspace" });
    await expect(destroyPersistedManagedDeploymentData(input)).resolves.toEqual({
      destroyedPortableFsWorkspaces: 1,
      outstandingLocalWorkspaces: [],
    });
    expect(destroy).toHaveBeenCalledWith({ workspace });
    await expect(store.listWorkspaces()).resolves.toEqual([workspace]);
    await expect(prepareManagedDestructionDatabase(database)).resolves.toBe("ready");
  });

  it("refuses a database with an unknown migration instead of proceeding to destruction", async () => {
    await sql`insert into kysely_migration (name, timestamp) values ('9999_unknown', '2026-09-19T00:00:00Z')`.execute(
      database,
    );
    const refusal = prepareManagedDestructionDatabase(database);
    await expect(refusal).rejects.toBeInstanceOf(MigrationLineageError);
    await expect(refusal).rejects.toThrow("9999_unknown");
  });
});
