import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOidcProvidersFromFile } from "./oidc-config.js";

describe("OIDC operator configuration", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("loads bounded file-backed HTTPS providers without exposing the secret path", async () => {
    const paths = await fixture([
      {
        allowPrivateNetwork: false,
        clientId: "opensteer",
        clientSecretPath: "client.secret",
        issuer: "https://identity.example.com/tenant",
        label: "Company account",
        providerId: "company",
      },
    ]);
    const providers = await loadOidcProvidersFromFile(paths.config, {
      requireSecureTransport: true,
    });

    expect(providers).toEqual([
      expect.objectContaining({
        allowPrivateNetwork: false,
        clientId: "opensteer",
        clientSecret: "test-client-secret",
        issuer: "https://identity.example.com/tenant",
        providerId: "company",
      }),
    ]);
    expect(JSON.stringify(providers)).not.toContain(paths.secret);
  });

  it("requires an explicit private-network flag before adding trusted IdP origins", async () => {
    const unsafe = await fixture([
      {
        allowPrivateNetwork: false,
        clientId: "opensteer",
        clientSecretPath: "client.secret",
        issuer: "https://idp.internal",
        label: "Internal account",
        providerId: "internal",
        trustedOrigins: ["https://idp.internal"],
      },
    ]);
    await expect(loadOidcProvidersFromFile(unsafe.config)).rejects.toThrow(
      "trusted origins require allowPrivateNetwork",
    );

    await writeFile(
      unsafe.config,
      JSON.stringify([
        {
          allowPrivateNetwork: true,
          clientId: "opensteer",
          clientSecretPath: "client.secret",
          issuer: "https://idp.internal",
          label: "Internal account",
          providerId: "internal",
          trustedOrigins: ["https://idp.internal"],
        },
      ]),
      { mode: 0o600 },
    );
    await expect(loadOidcProvidersFromFile(unsafe.config)).resolves.toEqual([
      expect.objectContaining({
        allowPrivateNetwork: true,
        trustedOrigins: ["https://idp.internal"],
      }),
    ]);
  });

  it("rejects plaintext production providers and symlinked configuration", async () => {
    const paths = await fixture([
      {
        allowPrivateNetwork: true,
        clientId: "opensteer",
        clientSecretPath: "client.secret",
        issuer: "http://127.0.0.1:5556",
        label: "Development IdP",
        providerId: "development",
        trustedOrigins: ["http://127.0.0.1:5556"],
      },
    ]);
    await expect(
      loadOidcProvidersFromFile(paths.config, { requireSecureTransport: true }),
    ).rejects.toThrow("must use HTTPS");

    const linked = join(directory!, "linked.json");
    await symlink(paths.config, linked);
    await expect(loadOidcProvidersFromFile(linked)).rejects.toThrow("bounded regular file");
  });

  async function fixture(providers: readonly Record<string, unknown>[]) {
    directory = await mkdtemp(join(tmpdir(), "opensteer-oidc-config-"));
    const secret = join(directory, "client.secret");
    const config = join(directory, "providers.json");
    await writeFile(secret, "test-client-secret\n", { mode: 0o600 });
    await writeFile(config, JSON.stringify(providers), { mode: 0o600 });
    return { config, secret };
  }
});
