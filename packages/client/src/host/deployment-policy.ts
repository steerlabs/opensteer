import {
  deploymentClientPolicy,
  deploymentPolicy,
  type DeploymentClientPolicy,
  type DeploymentShape,
} from "@opensteer/core";

// Hosts that predate the projection send only their Deployment shape.
export function hostDeploymentPolicy(
  bootstrap:
    | {
        readonly deploymentPolicy?: DeploymentClientPolicy | undefined;
        readonly deploymentShape?: Pick<DeploymentShape, "kind"> | null | undefined;
      }
    | null
    | undefined,
): DeploymentClientPolicy | undefined {
  if (bootstrap?.deploymentPolicy !== undefined) return bootstrap.deploymentPolicy;
  return bootstrap?.deploymentShape
    ? deploymentClientPolicy(
        deploymentPolicy({
          ...bootstrap.deploymentShape,
          defaultWorkspaceBacking: "local-directory",
        }),
      )
    : undefined;
}
