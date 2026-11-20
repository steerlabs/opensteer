import { isPersonalHost } from "@opensteer/deployment-authority/personal-access-route";
import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";
import type { CloudComputerIdentity } from "@opensteer/control-plane-protocol";

import {
  HostDiscoveryEnvelopeSchema,
  hostKeyFingerprint,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { z } from "zod";
import { json, request, RemoteRequestError, type HttpOptions } from "./http.js";

export type DiscoverHome = (
  hostname: string,
  address: string,
  signal: AbortSignal,
) => Promise<CloudComputerIdentity | "invalid" | undefined>;

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
          try {
            const { authority } = json(descriptor)(text);
            const doc = verifyHostDiscoveryEnvelope(authority);
            if (doc.canonicalOrigin !== origin || !isPersonalHost(doc)) return "invalid" as const;
            return {
              deploymentId: doc.deploymentId,
              hostKeyFingerprint: hostKeyFingerprint(authority.publicKey.spki),
            };
          } catch {
            return "invalid" as const;
          }
        },
      );
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof RemoteRequestError &&
        (error.status === 421 || (error.status >= 300 && error.status < 400))
      )
        return "invalid";
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
            if (size > 64 * 1024) {
              resolve(new Response(null, { status: 421 }));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => resolve(new Response(Buffer.concat(chunks), { status })));
        },
      );
      req.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ERR_TLS_CERT_ALTNAME_INVALID")
          resolve(new Response(null, { status: 421 }));
        else reject(error);
      });
      req.end();
    });
}
