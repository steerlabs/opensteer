import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpManagedHomeClient,
  ManagedHomeError,
} from "../apps/control-plane/src/cloud-computers/claim.js";
import {
  cert,
  key,
} from "../packages/browser-runtime-core/src/test-support/fixtures/passkey-provider-tls.js";
import { createId } from "../packages/core/src/index.js";
import {
  hostDiscoverySigningBytes,
  type HostDiscoveryDocument,
} from "../packages/deployment-authority/src/index.js";

/** The disposable test certificate names this host; it is dialled at loopback. */
const hostname = "rp.example.test";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/**
 * A managed Home over real TLS, at loopback. It answers discovery, then either
 * the claim or a redirect, and records every connection and request.
 */
async function home(options: { readonly redirectDiscovery?: boolean } = {}) {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const seen: { path: string; socket: Socket }[] = [];
  const connections: Socket[] = [];
  let origin = "";
  const server = createServer({ cert, key }, (request, response) => {
    seen.push({ path: request.url ?? "", socket: request.socket });
    if (options.redirectDiscovery) {
      response.writeHead(302, { location: "https://elsewhere.example.test/.well-known/opensteer" });
      response.end();
      return;
    }
    if (request.url === "/.well-known/opensteer") {
      const document: HostDiscoveryDocument = {
        canonicalOrigin: origin,
        deploymentId: createId("deployment"),
        deploymentShape: { kind: "personal" },
        hostInstanceId: createId("hostInstance"),
        hostKey: { algorithm: "Ed25519" },
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          kind: "personal",
          apiVersion: 1,
          authority: {
            document,
            publicKey: { algorithm: "Ed25519", spki },
            signature: sign(null, hostDiscoverySigningBytes(document), keys.privateKey).toString(
              "base64url",
            ),
          },
          bootstrapMethods: ["oidc"],
          capabilities: [],
        }),
      );
      return;
    }
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { reason: "managed-home-owned" } }));
  });
  server.on("secureConnection", (socket: Socket) => connections.push(socket));
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `https://${hostname}:${(server.address() as AddressInfo).port}`;
  // The production transport: public-address dialling, pinned to loopback for the test.
  const client = new HttpManagedHomeClient({
    ca: cert,
    resolve: async () => ({ address: "127.0.0.1", family: 4 }),
  });
  return { client, connections, origin, seen };
}

const request = {
  schemaVersion: 1 as const,
  setupCode: "a".repeat(43),
  assertion: "header.payload.signature",
  hostCredential: `osc_${"c".repeat(43)}`,
};

describe("the Account's claim of a managed Home", () => {
  it("reaches the Home, and sends the claim on the connection whose discovery it verified", async () => {
    const { client, connections, origin, seen } = await home();
    const claimed = client.claim(origin, async (envelope) => {
      expect(envelope.document.canonicalOrigin).toBe(origin);
      return request;
    });
    // This Home answers that it is already owned: the claim itself arrived.
    await expect(claimed).rejects.toMatchObject({ permanent: true });
    expect(seen.map(({ path }) => path)).toEqual([
      "/.well-known/opensteer",
      "/v1/managed-home/claim",
    ]);
    expect(connections).toHaveLength(1);
    expect(seen[0]!.socket).toBe(seen[1]!.socket);
  });

  it("follows no redirect and sends nothing after one", async () => {
    const { client, origin, seen } = await home({ redirectDiscovery: true });
    let prepared = false;
    const claimed = client.claim(origin, async () => {
      prepared = true;
      return request;
    });
    await expect(claimed).rejects.toBeInstanceOf(ManagedHomeError);
    await expect(claimed).rejects.toMatchObject({ permanent: false });
    expect(prepared).toBe(false);
    expect(seen.map(({ path }) => path)).toEqual(["/.well-known/opensteer"]);
  });

  it("sends no claim material when the Home that answered is not the pinned one", async () => {
    const { client, origin, seen } = await home();
    await expect(
      client.claim(origin, async () => {
        throw new ManagedHomeError("The Cloud Computer answered as a different Home", {
          permanent: true,
        });
      }),
    ).rejects.toThrow("answered as a different Home");
    expect(seen.map(({ path }) => path)).toEqual(["/.well-known/opensteer"]);
  });
});
