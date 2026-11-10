import { OpensteerError, DeploymentShapeSchema } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { DatabaseSchema } from "./schema.js";

const storedAuthorityRow = z.object({
  deploymentShape: DeploymentShapeSchema,
  authorityModelVersion: z.union([z.literal(1), z.literal(2)]),
});
export function deploymentAuthorityFromStoredRow(row: unknown) {
  if (row === null || row === undefined) return null;
  const parsed = storedAuthorityRow.safeParse(row);
  if (!parsed.success)
    throw new OpensteerError({ code: "forbidden", message: "Deployment authority is unavailable" });
  return { kind: parsed.data.deploymentShape.kind, model: parsed.data.authorityModelVersion };
}

// Fold the stored witness into an existing read without another round trip.
export const storedDeploymentAuthority = sql<z.infer<typeof storedAuthorityRow> | null>`(
  select jsonb_build_object('deploymentShape', deployment_shape,
    'authorityModelVersion', authority_model_version)
  from public.deployments where singleton_key = 'primary'
)`;

export const storedProjectDeployment = sql<boolean>`coalesce(
  (${storedDeploymentAuthority}->'deploymentShape'->>'kind' = 'server'
   and (${storedDeploymentAuthority}->>'authorityModelVersion')::integer = 2), false)`;

export function isProjectDeploymentAuthority(
  authority: ReturnType<typeof deploymentAuthorityFromStoredRow>,
) {
  return authority?.kind === "server" && authority.model === 2;
}

export async function readInitializedDeploymentAuthority(
  database: Kysely<DatabaseSchema>,
): Promise<{ kind: "personal" | "server"; model: 1 | 2 } | null> {
  const row = await database
    .selectFrom("deployments")
    .select(["authorityModelVersion", "deploymentShape"])
    .where("singletonKey", "=", "primary")
    .executeTakeFirst();
  return deploymentAuthorityFromStoredRow(row);
}

export async function readDeploymentAuthority(
  database: Kysely<DatabaseSchema>,
): Promise<{ kind: "personal" | "server"; model: 1 | 2 }> {
  const authority = await readInitializedDeploymentAuthority(database);
  if (!authority)
    throw new OpensteerError({ code: "forbidden", message: "Deployment authority is unavailable" });
  return authority;
}

export async function assertProjectAuthority(database: Kysely<DatabaseSchema>): Promise<void> {
  const authority = await readDeploymentAuthority(database);
  if (authority.kind !== "server" || authority.model !== 2)
    throw new OpensteerError({ code: "forbidden", message: "Project authority is not activated" });
}

export function assertSupportedRuntimeAuthority(model: number): void {
  if (model !== 1)
    throw new OpensteerError({
      code: "conflict",
      message:
        "Unsupported Deployment authority model; this Host cannot start. Export this previous private-workspace Deployment, then create a new team Deployment. Nothing was converted or deleted.",
    });
}
