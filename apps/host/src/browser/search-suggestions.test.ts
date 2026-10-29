import { generateKeyPairSync } from "node:crypto";
import { createId, OpensteerError } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { hostApiVersionHeader } from "@opensteer/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signHostDiscovery } from "../identity/host-keys.js";
import { createHostServer, type HostServerDependencies } from "../server.js";
import { hostServerTestDependencies } from "../server/host-server-test-harness.js";

/** HTTP through the production registration, authentication scope, handler and bounded reader. */
describe("browser.searchSuggestions.get over the Host's HTTP API", () => {
  let mode = "valid";
  const requests: { url: string; redirect: RequestInit["redirect"]; deadline: boolean }[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      redirect: init?.redirect,
      deadline: init?.signal instanceof AbortSignal,
    });
    if (mode === "http") return new Response("unavailable", { status: 503 });
    if (mode === "malformed") return Response.json(["weath", [23]]);
    if (mode === "oversize") return Response.json(["weath", ["a".repeat(65536)]]);
    if (mode === "timeout")
      return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }),
      );
    return Response.json([
      "weath",
      [
        "weather tomorrow",
        "weather tomorrow",
        "",
        "x".repeat(201),
        ...Array.from({ length: 12 }, (_, i) => `weather ${i}`),
      ],
      [],
      { extra: true },
    ]);
  };
  const authenticator = {
    identity: {
      nativeOpenIdConfiguration: () => undefined,
      configuration: async () => ({ localPasswordEnabled: true, oidcProviders: [] }),
    },
    authenticateSessionContext: async (headers: Readonly<Record<string, unknown>>) => {
      if (headers.cookie !== "journey=person")
        throw new OpensteerError({ code: "unauthorized", message: "Sign in" });
      return {
        credentialKind: "browser-cookie",
        surface: "canonical",
        session: { user: { id: createId("user") } },
      };
    },
  } as unknown as HostServerDependencies["authenticator"];
  let app: Awaited<ReturnType<typeof createHostServer>>;
  let origin = "";
  const read = (query: string, authenticated = true) =>
    fetch(
      `${origin}/v1/rpc/browser.searchSuggestions.get?input=${encodeURIComponent(JSON.stringify({ query }))}`,
      {
        headers: {
          [hostApiVersionHeader]: String(hostApiVersion),
          ...(authenticated ? { cookie: "journey=person" } : {}),
        },
      },
    );

  beforeAll(async () => {
    const discovery = signHostDiscovery(generateKeyPairSync("ed25519"), {
      canonicalOrigin: "https://opensteer.example",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
    });
    app = await createHostServer(
      hostServerTestDependencies({ discovery, authenticator, fetch: providerFetch }),
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Host has no address");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("advertises suggestions; an authenticated read validates, dedupes and caps the provider tuple", async () => {
    const descriptor = (await (await fetch(`${origin}/.well-known/opensteer`)).json()) as {
      capabilities: string[];
    };
    const refused = await read("weath", false);
    const invalid = await read("x".repeat(201));
    const response = await read("weath");
    const result = (await response.json()) as { ok: boolean; data: string[] };
    expect(descriptor.capabilities).toContain("browser-search-suggestions-v1");
    expect(refused.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(8);
    expect(new Set(result.data).size).toBe(8);
    expect(result.data[0]).toBe("weather tomorrow");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: "https://www.google.com/complete/search?client=firefox&q=weath",
      redirect: "error",
      deadline: true,
    });
  });

  it("returns no suggestions for provider HTTP, malformed, oversized and 1500ms timeout failures", async () => {
    for (const next of ["http", "malformed", "oversize", "timeout"]) {
      mode = next;
      const start = performance.now();
      const response = await read("weath");
      const result = (await response.json()) as { ok: boolean; data: string[] };
      const elapsed = performance.now() - start;
      expect({ mode, status: response.status, ok: result.ok, data: result.data }).toEqual({
        mode,
        status: 200,
        ok: true,
        data: [],
      });
      if (mode === "timeout") {
        expect(elapsed).toBeGreaterThanOrEqual(1400);
        expect(elapsed).toBeLessThan(2500);
      }
    }
  });
});
