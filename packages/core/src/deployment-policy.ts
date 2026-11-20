import type { HostExposure } from "./identity.js";
import type { DeploymentKind, DeploymentShape } from "./models.js";

/** What a Deployment's kind decides, whatever address it is reached at. */
export interface DeploymentPolicy {
  readonly kind: DeploymentKind;
  readonly services: { readonly personal: boolean; readonly team: boolean };
  readonly requiresAccountSignIn: boolean;
  /** The hosting Runner shares the Host's computer and reaches it over loopback. */
  readonly colocatedHostingRunner: boolean;
}

/**
 * What a Host's exposure decides on top of its kind. A Personal Host on
 * loopback is supervised by the desktop app on the same computer; a networked
 * one is a Home behind HTTPS whose canonical origin is the only route to it.
 */
export interface HostExposurePolicy extends DeploymentPolicy {
  readonly exposure: HostExposure;
  /** The desktop app claims the owner with its own token and reads `/v1/local-bootstrap`. */
  readonly localOwnerClaim: boolean;
  /** An unowned Host is claimed with an operator-delivered, single-use setup link. */
  readonly operatorOwnerSetup: boolean;
  /** Other computers and phones reach the Host over a separately signed Remote access route. */
  readonly personalRemoteAccess: boolean;
}

export function deploymentPolicy(shape: DeploymentShape): DeploymentPolicy {
  const personal = shape.kind === "personal";
  return {
    kind: shape.kind,
    services: { personal, team: !personal },
    requiresAccountSignIn: !personal,
    colocatedHostingRunner: personal,
  };
}

export function hostExposurePolicy(
  shape: DeploymentShape,
  exposure: HostExposure,
): HostExposurePolicy {
  const policy = deploymentPolicy(shape);
  const loopbackPersonal = policy.services.personal && exposure === "loopback";
  return {
    ...policy,
    exposure,
    localOwnerClaim: loopbackPersonal,
    operatorOwnerSetup: !loopbackPersonal,
    personalRemoteAccess: loopbackPersonal,
  };
}
