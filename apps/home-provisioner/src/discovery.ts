import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";
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
  address: string,
  signal: AbortSignal,
) => Promise<CloudComputerIdentity | undefined>;

const descriptor = z.object({
  kind: z.literal("personal"),
  authority: HostDiscoveryEnvelopeSchema,
});

export function discoverHome(http: HttpOptions): DiscoverHome {
  return async (hostname, address, signal) => {
    const origin = `https://${hostname}`;
    try {
      return await request(
        "Home",
        new URL("/.well-known/opensteer", origin),
        { ...http, fetch: http.fetch ?? pinnedFetch(hostname, address) },
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

export function homeTlsOptions(hostname: string, address: string): RequestOptions {
  return {
    hostname: address,
    port: 443,
    servername: hostname,
    headers: { host: hostname, accept: "application/json" },
    path: "/.well-known/opensteer",
    rejectUnauthorized: true,
    agent: false,
  };
}

function pinnedFetch(hostname: string, address: string): typeof fetch {
  return (_input, init) =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        { ...homeTlsOptions(hostname, address), signal: init?.signal ?? undefined },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status !== 200) {
            response.destroy();
            resolve(new Response(null, { status }));
            return;
          }
          const chunks: Uint8Array[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > 64 * 1024) response.destroy(new Error("Home discovery is too large"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => resolve(new Response(Buffer.concat(chunks), { status })));
        },
      );
      req.once("error", reject);
      req.end();
    });
}
