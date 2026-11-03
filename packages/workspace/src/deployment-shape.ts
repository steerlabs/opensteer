import type { DeploymentShape, EnvironmentId, WorkspaceBacking } from "@opensteer/core";

export function assertExecutionAllowedByDeployment(input: {
  readonly backing: WorkspaceBacking;
  readonly executionEnvironmentId: EnvironmentId;
  readonly shape: DeploymentShape;
}): void {
  if (
    input.backing.kind === "local-directory" &&
    input.backing.ownerEnvironmentId !== input.executionEnvironmentId
  ) {
    throw new Error("A local-directory Workspace can run only in its owning environment");
  }
}
