import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createId } from "../../packages/core/src/index.js";
import { parseHostConfig } from "../../packages/config/src/config.js";
import { loadControlPlaneConfig } from "../../apps/control-plane/src/config.js";
import { readDesktopConfiguration } from "../../apps/desktop/src/config.js";
import { hostSpec } from "../../apps/desktop/src/supervisor/personal-deployment-supervisor.js";
import { accountServiceEnvironment } from "./account-service.js";
import { journeyAppEnvironment } from "./app-environment.js";

/*
 * Everything the first-run journey hands the product, read by the product's own configuration
 * readers on this Mac before a VM runs it: the account service's configuration as the journey
 * starts it, the Mac app's environment as the journey launches it, and the Host's environment as
 * the app's supervisor would start it from that (`hostSpec`). A value the product refuses fails
 * here; run 20261122T191206Z-10329791 found the Host refusing the issuer only in the VM.
 */

const root = mkdtempSync(path.join(tmpdir(), "first-run-configuration-"));

/** The account service exactly as `startJourneyAccountService` configures it. */
function accountService() {
  return loadControlPlaneConfig(
    accountServiceEnvironment({
      databaseUrl: "postgresql://opensteer@127.0.0.1:5432/first_run_settled",
      port: 45_210,
    }),
  );
}

/** The Mac app's configuration as the journey launches it. */
function desktop() {
  const account = accountService();
  return readDesktopConfiguration({
    appDataDirectory: path.join(root, "app-data"),
    defaultMode: "development",
    environment: journeyAppEnvironment({
      accountOrigin: account.publicOrigin.origin,
      dataDirectory: path.join(root, "data"),
      portalOrigin: account.portalOrigin.origin,
      runtime: path.join(root, "runtime"),
    }),
    packaged: false,
    resourcesDirectory: path.join(root, "resources"),
  });
}

/** The Host's environment as the supervisor starts it, for the issuer and portal it is given. */
function hostEnvironment(accountIssuer: string | null, portalOrigin: string | null) {
  const spec = hostSpec(
    {
      assets: {
        webDistribution: {
          directory: path.join(root, "web"),
          hostVersion: "0.1.219",
          manifestPath: path.join(root, "web", "manifest.json"),
        },
      },
      entrypoints: { host: path.join(root, "host") },
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
      credentialKeyPath: path.join(root, "credential.key"),
      hostDataDirectory: path.join(root, "host-data"),
      hostPrivateKeyPath: path.join(root, "host.key"),
      hostPublicKeyPath: path.join(root, "host.pub"),
    } as never,
    {
      databasePassword: "first-run-journey-database",
      hostAuthSecret: "first-run-journey-auth-secret-0123456789abcdef",
      messagingEnrollmentToken: "first-run-journey-messaging-enrollment-token",
    } as never,
    "first-run-journey-owner-claim-token-0123456789",
    accountIssuer,
    portalOrigin,
    false,
    null,
    null,
  );
  return { ...spec.environment, ...spec.secretEnvironment };
}

describe("what the first-run journey hands the product", () => {
  it("is an account service configuration the account service accepts", () => {
    expect(() => accountService()).not.toThrow();
  });

  it("is a Mac app environment the Mac app accepts", () => {
    const loaded = desktop();
    expect(loaded.config.accountUrl).not.toBeNull();
    expect(loaded.config.portalUrl).not.toBeNull();
  });

  it("is, but for the issuer, a Host environment the Host accepts", () => {
    // The same environment with an issuer the rule admits: everything else the journey causes is
    // accepted, so the issuer is the one value in question.
    const portal = new URL(String(desktop().config.portalUrl)).origin;
    expect(() =>
      parseHostConfig(hostEnvironment("https://account.opensteer.example", portal)),
    ).not.toThrow();
  });

  // J5: the journey's account service is a loopback HTTP origin, which the Host refuses as its
  // Personal Account issuer ("must be a bare public HTTPS origin", packages/config/src/config.ts).
  // This fails today, as the VM run did; it turns red here the day the journey meets the rule,
  // and is then made an ordinary `it`.
  it.fails("gives the Host an issuer the Host accepts", () => {
    const loaded = desktop();
    // As the supervisor takes it (`personal-deployment-supervisor.ts`: `new URL(...).origin`).
    const issuer = new URL(String(loaded.config.accountUrl)).origin;
    const portal = new URL(String(loaded.config.portalUrl)).origin;
    expect(() => parseHostConfig(hostEnvironment(issuer, portal))).not.toThrow();
  });
});
