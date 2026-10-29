import type { DeploymentShape, EnvironmentId, WorkspaceBacking } from "@opensteer/core";

/**
 * A Deployment's declared backing is a default, not a capability fence. Local
 * directories are always admissible because they are owned and provisioned by
 * the machine that holds them, and a machine can be lent to any Deployment.
 * PortableFS is the one backing the Host itself has to be configured for, so it
 * stays gated on the declared default.
 */
export function assertBackingAllowedByDeployment(
  shape: DeploymentShape,
  backing: Pick<WorkspaceBacking, "kind">,
): void {
  if (backing.kind === "portablefs" && shape.defaultWorkspaceBacking !== "portablefs") {
    throw new Error(
      "This Deployment has no PortableFS storage authority, so it cannot hold portablefs Workspaces",
    );
  }
}

export function assertExecutionAllowedByDeployment(input: {
  readonly backing: WorkspaceBacking;
  readonly executionEnvironmentId: EnvironmentId;
  readonly shape: DeploymentShape;
}): void {
  assertBackingAllowedByDeployment(input.shape, input.backing);
  if (
    input.backing.kind === "local-directory" &&
    input.backing.ownerEnvironmentId !== input.executionEnvironmentId
  ) {
    throw new Error("A local-directory Workspace can run only in its owning environment");
  }
}
