import { describe, expect, it } from "vitest";
import { HostedOAuthBrokerService } from "./hosted-oauth-broker-service.js";
import {
  HostedOAuthProviderRegistrySchema,
  registryOAuthConfig,
} from "./hosted-oauth-provider-registry.js";
import { brokerProviderFixture } from "./hosted-oauth-broker.test-support.js";

const application = {
  ...brokerProviderFixture("google"),
  provider: "independent-provider",
  revision: 73,
  clientId: "fixture-client",
  clientSecret: "fixture-secret",
};

describe("broker provider registry", () => {
  it("boots a provider without a compiled catalog and publishes only its public configuration", () => {
    const broker = new HostedOAuthBrokerService({
      applications: [{ ...application, placement: { hosts: ["api.example.test"] } }],
      issuer: new URL("https://accounts.example.test"),
      attemptContextEncryptionKey: Buffer.alloc(32, 4).toString("base64url"),
      store: {} as never,
    });
    expect(broker.metadata()).toMatchObject({
      pluginProviders: { [application.provider]: { placement: { hosts: ["api.example.test"] } } },
      pluginOAuth: 1,
      pluginCallbackRelay: 1,
    });
    expect(registryOAuthConfig(application, [application.allowedScopes[0]!]).scopes).toEqual([
      application.allowedScopes[0],
    ]);
    expect(() => registryOAuthConfig(application, ["outside-registry"])).toThrow("exceed");
  });

  it("does not require a managed registration for plugin callback relay", () => {
    const broker = new HostedOAuthBrokerService({
      applications: [],
      issuer: new URL("https://accounts.example.test"),
      attemptContextEncryptionKey: Buffer.alloc(32, 4).toString("base64url"),
      store: {} as never,
    });
    expect(broker.metadata()).toMatchObject({ pluginCallbackRelay: 1, pluginProviders: {} });
    expect(
      HostedOAuthProviderRegistrySchema.safeParse([{ ...application, relayOnly: true }]).success,
    ).toBe(false);
    expect(JSON.stringify(broker.metadata())).not.toContain("fixture-secret");
  });

  it.each([
    { revision: 0 },
    { placement: { hosts: [] } },
    { placement: { hosts: ["https://api.example.test"] } },
    { placement: { hosts: ["api.example.test"], header: "authorization\r\nX-Secret" } },
    { oauth: { ...application.oauth, extraAuthorizeParams: { scope: "admin" } } },
    { clientSecret: "" },
    { allowedScopes: [] },
    { allowedScopes: ["read", "read"] },
    { oauth: { ...application.oauth, tokenUrl: "http://provider.example.test/token" } },
    {
      oauth: {
        ...application.oauth,
        authorizationUrl: "https://user:secret@provider.example.test/auth",
      },
    },
  ])("rejects malformed or unsafe configuration (%j)", (change) => {
    expect(
      HostedOAuthProviderRegistrySchema.safeParse([{ ...application, ...change }]).success,
    ).toBe(false);
  });

  it("rejects duplicate providers and enforces provider grant behavior", () => {
    expect(HostedOAuthProviderRegistrySchema.safeParse([application, application]).success).toBe(
      false,
    );
    const slack = {
      ...brokerProviderFixture("slack"),
      provider: "slack",
      revision: 1,
      clientId: "client",
      clientSecret: "secret",
    };
    expect(
      HostedOAuthProviderRegistrySchema.safeParse([
        { ...slack, oauth: { ...slack.oauth, tokenResponseProfile: "standard" } },
      ]).success,
    ).toBe(false);
    const microsoft = {
      ...brokerProviderFixture("microsoft"),
      provider: "microsoft",
      revision: 1,
      clientId: "client",
      clientSecret: "secret",
    };
    expect(
      HostedOAuthProviderRegistrySchema.safeParse([
        { ...microsoft, oauth: { ...microsoft.oauth, idTokenValidation: "issuer" } },
      ]).success,
    ).toBe(false);
    expect(
      HostedOAuthProviderRegistrySchema.safeParse([{ ...application, provider: "github" }]).success,
    ).toBe(false);
  });
});
