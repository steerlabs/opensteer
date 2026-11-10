import {
  DeploymentShapeSchema,
  type DeploymentPolicy,
  type DeploymentShape,
  OpensteerError,
  deploymentPolicy,
} from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { sql, type Kysely } from "kysely";

function refuse(reason: string): never {
  throw new OpensteerError({
    code: "conflict",
    message: `Unsupported Deployment authority model: ${reason}. This database was not migrated. Stop the previous Host and export its content before creating a new team Deployment. Nothing was converted or deleted.`,
  });
}

export type StoredAuthority =
  { state: "uninitialized" } | { state: "existing"; model: number } | { state: "unknown" };

export function authorityPreflightDecision(
  stored: StoredAuthority,
  policy: Pick<DeploymentPolicy, "executionPrincipal">,
): { state: "initialize" | "start"; model: 1 | 2 } | { state: "refuse" } {
  const model = policy.executionPrincipal === "person" ? 1 : 2;
  if (stored.state === "unknown" || (stored.state === "existing" && stored.model !== model))
    return { state: "refuse" };
  return { state: stored.state === "uninitialized" ? "initialize" : "start", model };
}

/** Must run under the Host authority lease, before even the migration metadata is created. */
export async function authorityPreflight(
  database: Kysely<DatabaseSchema>,
  configuredShape: DeploymentShape,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await sql`set transaction read only`.execute(transaction);
    const relations = await sql<{ name: string }>`
      select c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    `.execute(transaction);
    if (relations.rows.length === 0) {
      authorityPreflightDecision({ state: "uninitialized" }, deploymentPolicy(configuredShape));
      return;
    }
    if (!relations.rows.some((row) => row.name === "deployments"))
      refuse("unrecognized existing schema");
    const columns = await sql<{ name: string }>`
      select column_name as name from information_schema.columns
      where table_schema = 'public' and table_name = 'deployments'
    `.execute(transaction);
    if (!columns.rows.some((row) => row.name === "deployment_shape"))
      refuse("unrecognized Deployment schema");
    const required = [
      "id",
      "singleton_key",
      "active_host_instance_id",
      "canonical_origin",
      "lifecycle",
      "created_at",
      "updated_at",
    ];
    if (!required.every((name) => columns.rows.some((column) => column.name === name)))
      refuse("inconsistent Deployment schema");
    const hasModel = columns.rows.some((row) => row.name === "authority_model_version");
    const rows = await sql<{ shape: unknown; model: number }>`
      select deployment_shape as shape,
        ${hasModel ? sql`authority_model_version` : sql`1`} as model
      from public.deployments
    `.execute(transaction);
    if (rows.rows.length === 0) return;
    if (rows.rows.length !== 1) refuse("existing schema has no unique Deployment identity");
    const row = rows.rows[0]!;
    const shape = DeploymentShapeSchema.safeParse(row.shape);
    if (!shape.success) refuse("unrecognized Deployment shape");
    if (
      authorityPreflightDecision(
        { state: "existing", model: row.model },
        deploymentPolicy(shape.data),
      ).state === "refuse"
    )
      refuse("stored model disagrees with Deployment policy");
  });
}
