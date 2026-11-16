import { describe, expect, it } from "vitest";
import { authorizationDigest, authorizationDigestVersion } from "./authorization-digest.js";

describe("authorization digest", () => {
  it("is stable and changes when an auth contract changes", () => {
    const definition = {
      adapter: "openapi",
      authMethods: [{ id: "oauth", kind: "oauth", oauth: { scopes: ["one"] } }],
      config: { runtime: "ignored" },
      id: "example",
      provider: "example",
    };
    expect(authorizationDigestVersion).toBe(1);
    expect(authorizationDigest(definition)).toBe(authorizationDigest(structuredClone(definition)));
    expect(authorizationDigest({ ...definition, config: { runtime: "changed" } })).toBe(
      authorizationDigest(definition),
    );
    expect(
      authorizationDigest({
        ...definition,
        authMethods: [{ ...definition.authMethods[0], id: "other" }],
      }),
    ).not.toBe(authorizationDigest(definition));
  });

  it("does not treat a provider-facing account identifier as authority", () => {
    const definition = {
      authMethods: [
        {
          id: "oauth",
          kind: "oauth",
          oauth: {
            identity: { identityPath: "sub", source: "userinfo" },
            scopes: ["openid", "email"],
          },
        },
      ],
      hostedOAuth: { providerApplicationRevision: 1 },
      id: "google-calendar",
      provider: "google",
    };
    const withIdentifier = {
      ...definition,
      authMethods: [
        {
          ...definition.authMethods[0],
          oauth: {
            ...definition.authMethods[0]!.oauth,
            identity: {
              ...definition.authMethods[0]!.oauth.identity,
              accountIdentifierPath: "email",
            },
          },
        },
      ],
    };

    expect(authorizationDigest(withIdentifier)).toBe(authorizationDigest(definition));
    expect(
      authorizationDigest({
        ...withIdentifier,
        authMethods: [
          {
            ...withIdentifier.authMethods[0],
            oauth: {
              ...withIdentifier.authMethods[0]!.oauth,
              identity: { ...withIdentifier.authMethods[0]!.oauth.identity, identityPath: "id" },
            },
          },
        ],
      }),
    ).not.toBe(authorizationDigest(definition));
  });
});
