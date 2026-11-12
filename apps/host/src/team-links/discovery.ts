import {
  type HostDescriptor,
  HostDescriptorSchema,
  hostKeyFingerprint,
  teamApiCompatibility,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { OpensteerError } from "@opensteer/core";
import type { TeamLinkOffer } from "@opensteer/protocol";
import { linkError } from "../team-link-endpoint/contracts.js";

export function teamLinkUpdateSide(
  advertised: number,
  advertisedMinimum?: number,
): "personal" | "team" | null {
  const compatibility = teamApiCompatibility(advertised, advertisedMinimum);
  return compatibility === "compatible"
    ? null
    : compatibility === "host-too-old"
      ? "team"
      : "personal";
}

/** A team server that refused this Host's version names the version it speaks. */
export function teamLinkVersionError(
  advertised: number,
  advertisedMinimum?: number,
): OpensteerError {
  const behind = teamLinkUpdateSide(advertised, advertisedMinimum) ?? "personal";
  return new OpensteerError({
    code: "bad_request",
    reason: "unsupported-version",
    message: behind === "personal" ? "Update Opensteer" : "The team server needs an update",
    details: { behind },
  });
}

export function verifiedTeamDiscovery(
  value: unknown,
  offer: Pick<TeamLinkOffer, "teamId" | "hostKeyFingerprint" | "origin">,
  hostInstanceId?: string,
): HostDescriptor {
  const descriptor = HostDescriptorSchema.parse(value);
  const document = verifyHostDiscoveryEnvelope(descriptor.authority);
  if (
    descriptor.kind !== "team" ||
    document.deploymentShape.kind !== "team" ||
    document.deploymentId !== offer.teamId ||
    document.canonicalOrigin !== offer.origin ||
    hostKeyFingerprint(descriptor.authority.publicKey.spki) !== offer.hostKeyFingerprint ||
    (hostInstanceId !== undefined && document.hostInstanceId !== hostInstanceId)
  )
    throw linkError();
  if (teamLinkUpdateSide(descriptor.apiVersion, descriptor.minimumApiVersion) !== null)
    throw teamLinkVersionError(descriptor.apiVersion, descriptor.minimumApiVersion);
  return descriptor;
}
