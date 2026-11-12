import {
  type HostDescriptor,
  HostDescriptorSchema,
  hostKeyFingerprint,
  teamApiVersion,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { OpensteerError } from "@opensteer/core";
import type { TeamLinkOffer } from "@opensteer/protocol";
import { linkError } from "../team-link-endpoint/contracts.js";

export function teamLinkUpdateSide(
  advertised: number,
  local = teamApiVersion,
): "personal" | "team" | null {
  return advertised === local ? null : advertised > local ? "personal" : "team";
}

export function teamLinkVersionError(advertised: number): OpensteerError {
  const behind = teamLinkUpdateSide(advertised) ?? "team";
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
  const behind = teamLinkUpdateSide(descriptor.apiVersion);
  if (behind !== null) throw teamLinkVersionError(descriptor.apiVersion);
  return descriptor;
}
