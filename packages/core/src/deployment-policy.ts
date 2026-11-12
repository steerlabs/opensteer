import type { DeploymentKind, DeploymentShape } from "./models.js";

export interface DeploymentPolicy {
  readonly kind: DeploymentKind;
  readonly services: { readonly personal: boolean; readonly team: boolean };
  readonly localOwnerClaim: boolean;
  readonly requiresAccountSignIn: boolean;
  readonly loopbackOnly: boolean;
  readonly personalRemoteAccess: boolean;
}
export function deploymentPolicy(shape: DeploymentShape): DeploymentPolicy {
  const personal = shape.kind === "personal";
  return {
    kind: shape.kind,
    services: { personal, team: !personal },
    localOwnerClaim: personal,
    requiresAccountSignIn: !personal,
    loopbackOnly: personal,
    personalRemoteAccess: personal,
  };
}
