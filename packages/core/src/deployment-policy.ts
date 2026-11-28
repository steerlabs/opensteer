import type { HostExposure } from "./identity.js";

/**
 * What a Host's exposure decides. A Home on loopback is supervised by the
 * desktop app on the same computer; a networked one is a Home behind HTTPS
 * whose canonical origin is the only route to it.
 */
export interface HostExposurePolicy {
  readonly exposure: HostExposure;
  /** The desktop app claims the owner with its own token and reads `/v1/local-bootstrap`. */
  readonly localOwnerClaim: boolean;
  /** An unowned Host is claimed with an operator-delivered, single-use setup link. */
  readonly operatorOwnerSetup: boolean;
  /** Other computers and phones reach the Host over a separately signed Remote access route. */
  readonly personalRemoteAccess: boolean;
}

export function hostExposurePolicy(exposure: HostExposure): HostExposurePolicy {
  const loopback = exposure === "loopback";
  return {
    exposure,
    localOwnerClaim: loopback,
    operatorOwnerSetup: !loopback,
    personalRemoteAccess: loopback,
  };
}
