import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedHostProvisioningBundleSchema } from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const openedFileState = vi.hoisted(() => ({ exposeGroupReadPermission: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fstatSync(descriptor: number) {
      const statistics = actual.fstatSync(descriptor);
      if (openedFileState.exposeGroupReadPermission) {
        Object.defineProperty(statistics, "mode", {
          configurable: true,
          value: statistics.mode | 0o040,
        });
      }
      return statistics;
    },
  };
});

import { parseHostConfig } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  openedFileState.exposeGroupReadPermission = false;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("managed Account bundle file", () => {
  it("rechecks permissions on the descriptor after opening the path", () => {
    const canonicalOrigin = "https://deployment.connect.opensteer.test";
    const directory = mkdtempSync(join(tmpdir(), "opensteer-account-bundle-race-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "bundle.json");
    writeFileSync(
      path,
      JSON.stringify(
        ManagedHostProvisioningBundleSchema.parse({
          provisioningMode: "adoption",
          controlApiOrigin: "https://accounts.opensteer.test",
          deployment: {
            canonicalOrigin,
            deploymentId: createId("deployment"),
            hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
            hostInstanceId: createId("hostInstance"),
            reachability: "canonical",
          },
          hostCredential: `osc_${"a".repeat(43)}`,
          oidc: {
            clientId: "opensteer-host-deployment",
            issuer: "https://accounts.opensteer.test",
            redirectUri: `${canonicalOrigin}/v1/auth/oidc/callback`,
            requirePkce: true,
            scopes: ["openid", "profile", "email"],
            tokenEndpointAuthMethod: "client_secret_basic",
          },
          oidcClientSecret: `ocs_${"b".repeat(43)}`,
        }),
      ),
      { mode: 0o600 },
    );

    openedFileState.exposeGroupReadPermission = true;
    let failure: unknown;
    try {
      parseHostConfig({
        OPENSTEER_ACCOUNT_BUNDLE_PATH: path,
        OPENSTEER_AUTH_SECRET: "identity-secret-that-is-at-least-thirty-two-bytes",
        OPENSTEER_CANONICAL_ORIGIN: canonicalOrigin,
        OPENSTEER_DATABASE_URL: "postgres://localhost/opensteer",
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_PORTABLEFS_MANAGER_URL: "https://portablefs.example.test",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toMatch(
      /must not be readable by group or other users/u,
    );
  });
});
