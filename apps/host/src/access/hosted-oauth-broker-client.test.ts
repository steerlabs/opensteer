import { OpensteerError } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { HostedOAuthBrokerClient } from "./hosted-oauth-broker-client.js";

function client(respond: () => Response) {
  return new HostedOAuthBrokerClient({
    fetch: async () => respond(),
    hostCredential: "osc_test-credential",
    issuer: new URL("https://accounts.example.test"),
  });
}

describe("HostedOAuthBrokerClient refusals", () => {
  it("authenticates and validates hosted revocation requests and responses", async () => {
    const transactionId = `hov_${crypto.randomUUID()}`;
    const request = {
      accountSubject: {
        issuer: "https://accounts.example.test",
        subject: `acct_${crypto.randomUUID()}`,
      },
      authorizationDigest: "c".repeat(43),
      brokerSealedCredential: {
        ciphertext: "Y2lwaGVydGV4dA",
        ephemeralPublicKey: "A".repeat(43),
        nonce: "B".repeat(16),
        tag: "C".repeat(22),
        version: 1 as const,
      },
      definitionId: "discord",
      deploymentAuthorityDigest: "d".repeat(43),
      expiresAt: "2030-01-01T00:00:00.000Z",
      provider: "discord",
      providerApplicationRevision: 1,
      transactionId,
    };
    let calls = 0;
    const broker = new HostedOAuthBrokerClient({
      fetch: async (input, init) => {
        calls += 1;
        expect(input.toString()).toBe(
          "https://accounts.example.test/v1/host/oauth-broker/revocations",
        );
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers)).toMatchObject(
          new Headers({
            accept: "application/json",
            authorization: "Bearer osc_test-credential",
            "content-type": "application/json",
          }),
        );
        expect(JSON.parse(String(init?.body))).toEqual(request);
        return Response.json({ revoked: true, transactionId });
      },
      hostCredential: "osc_test-credential",
      issuer: new URL("https://accounts.example.test"),
    });

    await expect(broker.revoke(request)).resolves.toEqual({ revoked: true, transactionId });
    await expect(broker.revoke({ ...request, untrusted: true })).rejects.toThrow();
    expect(calls).toBe(1);

    const invalidResponse = client(() => Response.json({ revoked: false, transactionId }));
    await expect(invalidResponse.revoke(request)).rejects.toThrow();
  });

  it("keeps the public issuer in bindings while using the configured control API transport", async () => {
    let requestedOrigin = "";
    let requestedPath = "";
    const broker = new HostedOAuthBrokerClient({
      fetch: async (input) => {
        const requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
        requestedOrigin = requestedUrl.origin;
        requestedPath = `${requestedUrl.pathname}${requestedUrl.search}`;
        return Response.json({
          callbackRelayProviders: ["slack"],
          encryptionPublicKey: "A".repeat(43),
          issuer: "https://accounts.example.test",
          providerRevisions: {},
        });
      },
      hostCredential: "osc_test-credential",
      issuer: new URL("https://accounts.example.test"),
      serviceOrigin: new URL("https://account-control.internal.test"),
    });
    await expect(broker.metadata()).resolves.toMatchObject({
      issuer: "https://accounts.example.test",
    });
    expect(requestedOrigin).toBe("https://account-control.internal.test");
    expect(requestedPath).toBe("/v1/oauth-broker/metadata?version=2");
    expect(broker.callbackUrl("slack")).toBe(
      "https://accounts.example.test/v1/oauth-broker/callback/slack",
    );
  });

  it("surfaces the Account service's code and sentence instead of a 500", async () => {
    const broker = client(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "forbidden", message: "Hosted OAuth deployment authority changed" },
          }),
          { headers: { "content-type": "application/json" }, status: 403 },
        ),
    );
    const error = await broker.metadata().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(OpensteerError);
    expect(error).toMatchObject({
      code: "forbidden",
      message:
        "Opensteer Account refused the hosted OAuth request: Hosted OAuth deployment authority changed",
      retryable: false,
    });
  });

  it("keeps an unrecognised refusal actionable and marks server faults retryable", async () => {
    const broker = client(() => new Response("upstream down", { status: 503 }));
    const error = await broker.metadata().catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "conflict", retryable: true });
    expect((error as Error).message).toContain("HTTP 503");
  });
});
