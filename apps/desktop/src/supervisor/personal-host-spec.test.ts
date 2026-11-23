import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { hostSpec } from "./personal-deployment-supervisor.js";

/*
 * The Host's environment is built from nothing: only what the supervisor names reaches it. The
 * authorities a person added for Node (`NODE_EXTRA_CA_CERTS`) are one such name, passed only when
 * the app's own environment carried them, so a Home behind a company's TLS inspection can reach
 * its account service; nothing else from the app's environment follows.
 */

function spec(extraCertificateAuthorities?: string | null) {
  return hostSpec(
    {
      assets: {
        webDistribution: {
          directory: "/runtime/web",
          hostVersion: "0.1.219",
          manifestPath: "/runtime/web/manifest.json",
        },
      },
      entrypoints: { host: "/runtime/host" },
    } as never,
    {
      deploymentId: createId("deployment"),
      environmentId: createId("environment"),
      hostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      hostPort: 45_211,
      name: "Studio Mac",
      postgresPort: 45_212,
    } as never,
    {
      credentialKeyPath: "/data/credential.key",
      hostDataDirectory: "/data/host",
      hostPrivateKeyPath: "/data/host.key",
      hostPublicKeyPath: "/data/host.pub",
    } as never,
    {
      databasePassword: "database",
      hostAuthSecret: "auth-secret",
      messagingEnrollmentToken: "messaging-enrollment",
    } as never,
    "owner-claim",
    "https://account.opensteer.example",
    null,
    false,
    null,
    null,
    ...(extraCertificateAuthorities === undefined ? [] : [extraCertificateAuthorities]),
  );
}

describe("the Host's environment", () => {
  it("carries the authorities added for Node when the app's environment did", () => {
    expect(spec("/etc/company/roots.pem").environment["NODE_EXTRA_CA_CERTS"]).toBe(
      "/etc/company/roots.pem",
    );
  });

  it("carries none when the app's did not", () => {
    expect(spec().environment).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    expect(spec(null).environment).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
  });

  it("takes nothing else from the app's own environment", () => {
    const before = process.env["NODE_OPTIONS"];
    process.env["NODE_OPTIONS"] = "--require /tmp/anything.js";
    try {
      const { environment, secretEnvironment } = spec("/etc/company/roots.pem");
      expect({ ...environment, ...secretEnvironment }).not.toHaveProperty("NODE_OPTIONS");
    } finally {
      if (before === undefined) delete process.env["NODE_OPTIONS"];
      else process.env["NODE_OPTIONS"] = before;
    }
  });
});
