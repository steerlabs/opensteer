import { createPublicHttpsFetch } from "@opensteer/access/host";
import {
  HostDescriptorSchema,
  hostApiCompatibility,
  hostDiscoveryDefaultWorkspaceBacking,
  isSameHost,
  verifyHostDiscoveryEnvelope,
  type HostIdentityReference,
} from "@opensteer/deployment-authority";
import { readBoundedJson } from "@opensteer/shared/boundedJson";

const publicFetch = createPublicHttpsFetch({ maxResponseBytes: 64 * 1_024, timeoutMs: 5_000 });

/** Workload readiness does not prove DNS, TLS, ingress, or the identity served at the public URL. */
export async function cloudHostReady(
  origin: string,
  expected: HostIdentityReference,
  fetch: typeof globalThis.fetch = publicFetch,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(new URL("/.well-known/opensteer", origin), {
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
  } catch {
    return false;
  }
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  const served: unknown = await readBoundedJson(response, { maximumBytes: 64 * 1_024 });
  // This control plane deploys the Host image it is waiting on, so an epoch it
  // cannot speak means the wrong image is running, not that setup is still
  // finishing. Asked before the descriptor is parsed because a Host predating
  // negotiation serves no epoch at all, and the operator reading the log is
  // better served by which side is behind than by a missing-field complaint.
  const compatibility = hostApiCompatibility(served);
  if (compatibility !== "compatible") {
    throw new Error(
      compatibility === "host-too-old"
        ? "The public cloud URL served a Host older than the protocol this control plane speaks"
        : "The public cloud URL served a Host newer than the protocol this control plane speaks",
    );
  }
  const descriptor = HostDescriptorSchema.parse(served);
  const envelope = descriptor.authority;
  const document = verifyHostDiscoveryEnvelope(envelope);
  if (
    !isSameHost(envelope, expected) ||
    document.canonicalOrigin !== origin ||
    document.deploymentShape.kind !== "server" ||
    hostDiscoveryDefaultWorkspaceBacking(document.deploymentShape) !== "portablefs"
  ) {
    throw new Error("The public cloud URL did not serve its provisioned Host identity");
  }
  return true;
}
