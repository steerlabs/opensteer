export type {
  ProjectRuntimePorts,
  ProjectAdmissionPort,
  ProjectCapabilityPort,
  ProjectDispatchPort,
  ProjectRecoveryPort,
} from "./project-runtime-ports.js";
import { deploymentPolicy, OpensteerError, type Deployment } from "@opensteer/core";
import { OpensteerStore, readDeploymentAuthority, type DatabaseSchema } from "@opensteer/database";
import type { Kysely } from "kysely";
import { isProjectDeploymentAuthority } from "@opensteer/database";
import type { ProjectRuntimeInfrastructure, ProjectRuntime } from "./project-runtime.js";

export type ExecutionRuntime =
  | { readonly kind: "person"; readonly store: OpensteerStore }
  | { readonly kind: "project"; readonly project: ProjectRuntime };

/** Selection is exclusively from durable identity; partial Project runtimes cannot be constructed. */
export async function createExecutionRuntime(
  database: Kysely<DatabaseSchema>,
  deployment: Deployment,
  dependencies: ConstructorParameters<typeof OpensteerStore>[1],
  infrastructure?: ProjectRuntimeInfrastructure,
): Promise<ExecutionRuntime> {
  const authority = await readDeploymentAuthority(database);
  if (authority.kind !== deployment.deploymentShape.kind)
    throw new OpensteerError({
      code: "conflict",
      message: "Deployment authority does not match stored identity",
    });
  if (isProjectDeploymentAuthority(authority)) {
    if (!infrastructure)
      throw new OpensteerError({
        code: "conflict",
        reason: "project-runtime-infrastructure-unavailable",
        message: "Project execution requires the Host runtime infrastructure",
      });
    const { ProjectRuntime } = await import("./project-runtime.js");
    const project = new ProjectRuntime(database, infrastructure);
    await project.start();
    return { kind: "project", project };
  }
  const policy = deploymentPolicy(deployment.deploymentShape);
  if (authority.model !== 1 || policy.executionPrincipal !== "person")
    throw new OpensteerError({
      code: "conflict",
      message: "Unsupported Deployment authority model; Project execution runtime is unavailable",
    });
  return { kind: "person", store: new OpensteerStore(database, dependencies) };
}
