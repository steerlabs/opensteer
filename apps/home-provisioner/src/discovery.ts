import type { CloudComputerIdentity } from "@opensteer/control-plane-protocol";
import { refused } from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  hostKeyFingerprint,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { z } from "zod";
import { json, request, type HttpOptions } from "./http.js";

export type DiscoverHome = (
  hostname: string,
  signal: AbortSignal,
) => Promise<CloudComputerIdentity | undefined>;

const descriptor = z.object({
  kind: z.literal("personal"),
  authority: HostDiscoveryEnvelopeSchema,
});

export function discoverHome(http: HttpOptions): DiscoverHome {
  return async (hostname, signal) => {
    const origin = `https://${hostname}`;
    try {
      return await request(
        "Home",
        new URL("/.well-known/opensteer", origin),
        http,
        signal,
        (text) => {
          const { authority } = json(descriptor)(text);
          const doc = verifyHostDiscoveryEnvelope(authority);
          if (doc.canonicalOrigin !== origin || doc.deploymentShape.kind !== "personal") {
            throw refused("conflict", "Home discovery does not match its public origin");
          }
          return {
            deploymentId: doc.deploymentId,
            hostKeyFingerprint: hostKeyFingerprint(authority.publicKey.spki),
          };
        },
      );
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  };
}
