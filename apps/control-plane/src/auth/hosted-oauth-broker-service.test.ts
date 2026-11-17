import { brokerProviderFixture } from "./hosted-oauth-broker.test-support.js";
import {
  ControlPlaneAccountIdSchema,
  HostedOAuthAttemptIdSchema,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  assertHostedOAuthAccountLink,
  HostedOAuthBrokerService,
  scopeDigest,
} from "./hosted-oauth-broker-service.js";

describe("HostedOAuthBrokerService authority", () => {
  it("publishes the configured install page for the exact hosted GitHub App", () => {
    const broker = new HostedOAuthBrokerService({
      applications: [
        {
          ...brokerProviderFixture("github"),
          clientId: "github-client",
          clientSecret: "github-secret",
          installationUrl: "https://github.com/apps/opensteer/installations/new",
          provider: "github",
          revision: 1,
        },
      ],
      attemptContextEncryptionKey: Buffer.alloc(32, 6).toString("base64url"),
      issuer: new URL("https://accounts.opensteer.test"),
      store: {} as never,
    });

    expect(broker.metadata()).toMatchObject({
      installationUrls: {
        github: "https://github.com/apps/opensteer/installations/new",
      },
      providerRevisions: { github: 1 },
    });
    expect(broker.metadata(false)).not.toHaveProperty("installationUrls");
  });

  it.each(["provider", "mcp"] as const)(
    "rejects app finish from a web %s relay before accessing a Deployment",
    async (mode) => {
      const broker = new HostedOAuthBrokerService({
        applications: [],
        attemptContextEncryptionKey: Buffer.alloc(32, 6).toString("base64url"),
        issuer: new URL("https://accounts.opensteer.test"),
        store: {} as never,
      });
      const serverId = `isv_${crypto.randomUUID()}`;
      await expect(
        broker.createCallbackRelay(
          {
            credentialHash: "unused",
            deploymentId: createId("deployment"),
            hostInstanceId: createId("hostInstance"),
          },
          {
            accountSubject: {
              issuer: "https://accounts.opensteer.test",
              subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
            },
            attemptId: HostedOAuthAttemptIdSchema.parse(`hoa_${crypto.randomUUID()}`),
            authorizationDigest: "d".repeat(43),
            authorizationUrl: "https://provider.example.test/authorize",
            clientId: "client",
            clientSurface: "web",
            finish: "app",
            definitionId: mode === "mcp" ? serverId : "slack",
            deploymentAuthorityDigest: "d".repeat(43),
            expiresAt: "2026-11-04T18:00:00Z",
            hostPublicKey: "k".repeat(43),
            provider: mode === "mcp" ? "mcp" : "slack",
            providerApplicationRevision: 1,
            ...(mode === "mcp"
              ? {
                  mcp: {
                    serverId,
                    issuer: "https://provider.example.test",
                    authorizationEndpoint: "https://provider.example.test/authorize",
                    authorizationResponseIssuerParameterSupported: false,
                  },
                }
              : { providerApplicationId: `ipa_${crypto.randomUUID()}` }),
          },
        ),
      ).rejects.toMatchObject({ code: "bad_request" });
    },
  );

  it("rejects link mismatch even when an email could be equal", () => {
    const presentedAccount = {
      email: "same-person@example.test",
      issuer: "https://accounts.opensteer.test",
      subject: `acct_${crypto.randomUUID()}`,
    };
    expect(() =>
      assertHostedOAuthAccountLink(
        presentedAccount,
        "https://accounts.opensteer.test",
        `acct_${crypto.randomUUID()}`,
      ),
    ).toThrow("Account link does not match");
  });

  it("uses an order-independent exact scope digest", () => {
    expect(scopeDigest(["openid", "email", "profile"])).toBe(
      scopeDigest(["profile", "openid", "email", "email"]),
    );
    expect(scopeDigest(["openid", "email"])).not.toBe(scopeDigest(["openid", "email", "profile"]));
  });
});

describe("HostedOAuthBrokerService authorization session", () => {
});

describe("HostedOAuthBrokerService Microsoft authorization", () => {
});

describe("HostedOAuthBrokerService Discord tokens", () => {
});
