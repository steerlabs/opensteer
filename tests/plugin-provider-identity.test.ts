import { Effect, Schema } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { expect, test } from "vitest";
import { hostCrypto } from "../packages/plugin-engine/sdk/src/implementation/host-crypto.ts";
import { oauth2 } from "../packages/plugin-engine/apps/src/implementation/provider.ts";
import { identifyProvider } from "../packages/plugin-engine/sdk/src/implementation/provider.ts";

const identify = (definition: Parameters<typeof identifyProvider>[0]) =>
  Effect.runPromise(
    hostCrypto.pipe(
      Effect.flatMap((crypto) => identifyProvider(definition, crypto)),
      Effect.map(({ id }) => id),
      Effect.provide(Digest.layerWebCrypto),
      Effect.provide(SecureRandom.layerWebCrypto),
    ),
  );

// Accounts belong to a provider by this content-derived ID, so a change to how OAuth declarations
// are read must leave the ID of every definition that does not use the change as it was.
test("an OAuth provider keeps its ID whether its endpoints are discovered or declared", async () => {
  expect(
    await identify({
      name: "Discovered",
      auth: {
        oauth: {
          type: "oauth2",
          discover: "https://mcp.example.com/mcp",
          scopes: ["read"],
          response: {},
        },
      },
    } as Parameters<typeof identifyProvider>[0]),
  ).toBe("prv_3d5a63c145a5d9beeb47c24f0c8a69b753167e69d659e7e5f548a555ab3cc11f");
  expect(
    await identify({
      name: "Declared",
      auth: {
        oauth: {
          type: "oauth2",
          authorizationUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          scopes: ["read"],
          response: {},
        },
      },
    } as Parameters<typeof identifyProvider>[0]),
  ).toBe("prv_af393004b6634c5893bb255b5b36e29cd9e251acd4737b07d121b53b907c1ff7");
});

test("a discovered OAuth declaration that turns PKCE off does not build", async () => {
  const declared = await Effect.runPromiseExit(
    oauth2(
      {
        discover: "https://mcp.example.com/mcp",
        pkce: false,
        tokenEndpointAuthMethod: "client_secret_post",
      } as unknown as Parameters<typeof oauth2>[0],
      Schema.Struct({ access_token: Schema.String }),
    ),
  );
  expect(JSON.stringify(declared)).toContain("pkce: false applies only to declared endpoints");
});

test("a client_credentials OAuth declaration that sets PKCE does not build", async () => {
  for (const config of [
    { discover: "https://mcp.example.com/mcp" },
    { tokenUrl: "https://example.com/token", scopes: ["read"] },
  ]) {
    const declared = await Effect.runPromiseExit(
      oauth2(
        {
          ...config,
          grant: "client_credentials",
          pkce: false,
          tokenEndpointAuthMethod: "client_secret_basic",
        } as unknown as Parameters<typeof oauth2>[0],
        Schema.Struct({ access_token: Schema.String }),
      ),
    );
    expect(JSON.stringify(declared)).toContain("pkce applies only to the authorization_code grant");
  }
});
