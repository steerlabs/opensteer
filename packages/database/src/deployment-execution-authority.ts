import { OpensteerError } from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function readDeploymentAuthority(
  database: Kysely<DatabaseSchema>,
): Promise<{ kind: "personal" | "server"; model: 1 | 2 }> {
  const row = await database
    .selectFrom("deployments")
    .select(["authorityModelVersion", "deploymentShape"])
    .where("singletonKey", "=", "primary")
    .executeTakeFirst();
  if (!row || (row.authorityModelVersion !== 1 && row.authorityModelVersion !== 2))
    throw new OpensteerError({ code: "forbidden", message: "Deployment authority is unavailable" });
  return { kind: row.deploymentShape.kind, model: row.authorityModelVersion };
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
