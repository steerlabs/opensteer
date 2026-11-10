import { deploymentPolicy, OpensteerError, type Deployment } from "@opensteer/core";
import { OpensteerStore, readDeploymentAuthority, type DatabaseSchema } from "@opensteer/database";
import type { Kysely } from "kysely";

export interface ExecutionRuntime {
  readonly store: OpensteerStore;
}

/** Selection is exclusively from durable identity; partial Project runtimes cannot be constructed. */
export async function createExecutionRuntime(
  database: Kysely<DatabaseSchema>,
  deployment: Deployment,
  dependencies: ConstructorParameters<typeof OpensteerStore>[1],
): Promise<ExecutionRuntime> {
  const authority = await readDeploymentAuthority(database);
  const policy = deploymentPolicy(deployment.deploymentShape);
  if (
    authority.kind !== deployment.deploymentShape.kind ||
    authority.model !== 1 ||
    policy.executionPrincipal !== "person"
  )
    throw new OpensteerError({
      code: "conflict",
      message: "Unsupported Deployment authority model; Project execution runtime is unavailable",
    });
  return { store: new OpensteerStore(database, dependencies) };
}
