import type { Deployment, DeploymentId, Workspace } from "@opensteer/core";
import type { HostConfig } from "@opensteer/config";
import { migrateToLatest, type DatabaseSchema } from "@opensteer/database";
import { sql, type Kysely } from "kysely";

interface ManagedDestructionStore {
  getDeployment(): Promise<Deployment | null>;
  listWorkspaces(): Promise<readonly Workspace[]>;
}

interface ManagedDestructionDriver {
  destroy(input: {
    readonly workspace: Workspace & { readonly backing: { readonly kind: "portablefs" } };
  }): Promise<void>;
}

/** Teardown uses the current Host image even when the stopped Host never upgraded. */
export async function prepareManagedDestructionDatabase(
  database: Kysely<DatabaseSchema>,
): Promise<"pristine" | "ready"> {
  if (await isPristineUnmigratedDatabase(database)) return "pristine";
  await migrateToLatest(database);
  return "ready";
}

export async function isPristineUnmigratedDatabase(
  database: Kysely<DatabaseSchema>,
): Promise<boolean> {
  const schemas = await sql<{ readonly schemaName: string }>`
    select nspname as "schemaName"
    from pg_catalog.pg_namespace
    where nspname <> 'information_schema'
      and nspname !~ '^pg_'
    order by nspname
  `.execute(database);
  if (schemas.rows.some(({ schemaName }) => schemaName !== "public")) return false;
  const tables = await sql<{ readonly schemaName: string; readonly tableName: string }>`
    select n.nspname as "schemaName", c.relname as "tableName"
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    order by n.nspname, c.relname
  `.execute(database);
  const bookkeeping = tables.rows.filter(
    ({ schemaName, tableName }) =>
      schemaName === "public" &&
      (tableName === "kysely_migration" || tableName === "kysely_migration_lock"),
  );
  if (tables.rows.length !== bookkeeping.length) return false;
  const migrationTable = bookkeeping.find(({ tableName }) => tableName === "kysely_migration");
  if (!migrationTable) return true;
  const recorded = await sql<{ readonly count: string }>`
    select count(*)::text as count from public.kysely_migration
  `.execute(database);
  return recorded.rows.length === 1 && recorded.rows[0]?.count === "0";
}

export function assertManagedDestructionConfig(
  config: HostConfig,
  expectedDeploymentId: DeploymentId,
): asserts config is HostConfig & {
  readonly account: { readonly provisioningMode: "managed" };
  readonly deploymentIdentity: { readonly deploymentId: DeploymentId };
  readonly workspace: {
    readonly shape: { readonly defaultWorkspaceBacking: "portablefs"; readonly kind: "server" };
    readonly storage: { readonly kind: "portablefs" };
  };
} {
  if (config.account?.provisioningMode !== "managed") {
    throw new Error("Managed data destruction requires a managed Account deployment");
  }
  if (config.workspace.shape.kind !== "server") {
    throw new Error("Managed data destruction refuses a Personal deployment");
  }
  if (
    config.workspace.shape.defaultWorkspaceBacking !== "portablefs" ||
    config.workspace.storage.kind !== "portablefs"
  ) {
    throw new Error("Managed data destruction requires PortableFS storage");
  }
  if (config.deploymentIdentity?.deploymentId !== expectedDeploymentId) {
    throw new Error("Expected deployment does not match the pinned Host identity");
  }
}

export async function destroyManagedDeploymentData(input: {
  readonly config: HostConfig;
  readonly expectedDeploymentId: DeploymentId;
  readonly store: ManagedDestructionStore;
  readonly driver: ManagedDestructionDriver;
}): Promise<ManagedDestructionOutcome> {
  assertManagedDestructionConfig(input.config, input.expectedDeploymentId);
  return destroyPersistedManagedDeploymentData(input);
}

/**
 * What a central erase actually accomplished. Shared storage is destroyed here;
 * a Workspace on somebody's own computer is not this Host's to erase, so it is
 * reported rather than quietly counted as destroyed.
 */
export interface ManagedDestructionOutcome {
  readonly destroyedPortableFsWorkspaces: number;
  readonly outstandingLocalWorkspaces: readonly {
    readonly ownerEnvironmentId: string;
    readonly workspaceId: Workspace["id"];
  }[];
}

export async function destroyPersistedManagedDeploymentData(input: {
  readonly expectedDeploymentId: DeploymentId;
  readonly store: ManagedDestructionStore;
  readonly driver: ManagedDestructionDriver;
}): Promise<ManagedDestructionOutcome> {
  const deployment = await input.store.getDeployment();
  if (!deployment) {
    const workspaces = await input.store.listWorkspaces();
    if (workspaces.length !== 0) {
      throw new Error("Persisted workspaces exist without a deployment identity");
    }
    return { destroyedPortableFsWorkspaces: 0, outstandingLocalWorkspaces: [] };
  }
  if (deployment.id !== input.expectedDeploymentId) {
    throw new Error("Expected deployment does not match the persisted deployment identity");
  }
  if (
    deployment.deploymentShape.kind !== "server" ||
    deployment.deploymentShape.defaultWorkspaceBacking !== "portablefs"
  ) {
    throw new Error("Persisted deployment is not a managed PortableFS server");
  }

  const workspaces = await input.store.listWorkspaces();
  const outstandingLocalWorkspaces: {
    readonly ownerEnvironmentId: string;
    readonly workspaceId: Workspace["id"];
  }[] = [];
  let destroyedPortableFsWorkspaces = 0;
  for (const workspace of workspaces) {
    if (isPortableFsWorkspace(workspace)) {
      await input.driver.destroy({ workspace });
      destroyedPortableFsWorkspaces += 1;
      continue;
    }
    if (workspace.backing.kind !== "local-directory") {
      throw new Error(`Workspace ${workspace.id} has an unknown storage backing`);
    }
    // The files live on a machine somebody lent this Deployment. Erasing the
    // Deployment does not reach them, and saying otherwise would be a lie about
    // where a person's data still is.
    outstandingLocalWorkspaces.push({
      ownerEnvironmentId: workspace.backing.ownerEnvironmentId,
      workspaceId: workspace.id,
    });
  }
  return { destroyedPortableFsWorkspaces, outstandingLocalWorkspaces };
}

function isPortableFsWorkspace(
  workspace: Workspace,
): workspace is Workspace & { readonly backing: { readonly kind: "portablefs" } } {
  return workspace.backing.kind === "portablefs";
}
