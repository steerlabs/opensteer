import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createId,
  opensteerHostNativeOAuthClients,
  opensteerMobileHostOAuthCallback,
} from "@opensteer/core";
import { ManagedHostProvisioningBundleSchema } from "@opensteer/control-plane-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHostConfigInvariants,
  parseHostConfig,
  parseRunnerConfig,
  resolveRunnerNodeExecutable,
} from "./index.js";

const token = "a".repeat(32);

const localHostEnvironment = {
  OPENSTEER_AUTH_SECRET: "identity-secret-that-is-at-least-thirty-two-bytes",
  OPENSTEER_DATABASE_URL: "postgres://localhost/opensteer",
  OPENSTEER_CANONICAL_ORIGIN: "http://localhost:4310",
} as const;

const hostEnvironment = {
  OPENSTEER_AUTH_SECRET: "identity-secret-that-is-at-least-thirty-two-bytes",
  OPENSTEER_DATABASE_URL: "postgres://localhost/opensteer",
  OPENSTEER_CANONICAL_ORIGIN: "http://localhost:4310",
  OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
  OPENSTEER_DEPLOYMENT_KIND: "server",
  OPENSTEER_PORTABLEFS_SERVICE_ID: "test-portablefs",
  OPENSTEER_PORTABLEFS_MANAGER_URL: "http://localhost:4314",
} as const;

/** The axes a Host that anything on the network can reach has to declare. */
const networkedHostEnvironment = {
  ...hostEnvironment,
  OPENSTEER_BIND_ADDRESS: "0.0.0.0",
  OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
} as const;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("configuration", () => {
  it("uses explicit local defaults without weakening production keys", () => {
    const config = parseHostConfig(localHostEnvironment);
    expect(config.bindAddress).toBe("127.0.0.1");
    expect(config.account).toBeUndefined();
    expect(config.canonicalOrigin).toEqual(new URL("http://localhost:4310"));
    expect(config.workspace).toEqual({
      deletionRetentionDays: 14,
      shape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "server" as const,
      },
      storage: {
        kind: "local-directory",
        ownerEnvironmentId: "env_00000000-0000-4000-8000-000000000001",
      },
    });
    expect(config.runtimeOrigin).toEqual(config.canonicalOrigin);
    expect(config.browserRuntime).toEqual({ attachKeyId: "host-v1" });
    expect(config.identity.signupPolicy).toBe("invite-only");
    expect(config.identity.localPasswordEnabled).toBe(true);
    expect(config.identity.nativeOAuth?.clients).toEqual(opensteerHostNativeOAuthClients);
  });

  it("allows production HTTP only for an exact loopback Personal Host", () => {
    const personal = {
      ...localHostEnvironment,
      OPENSTEER_BROWSER_PROFILE_KEY_PATH: "/keys/browser-profiles.key",
      OPENSTEER_CANONICAL_ORIGIN: "http://127.0.0.1:4310",
      OPENSTEER_CREDENTIAL_KEY_PATH: "/keys/credentials.key",
      OPENSTEER_DEPLOYMENT_ID: createId("deployment"),
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_HOST_INSTANCE_ID: createId("hostInstance"),
      OPENSTEER_HOST_KEY_FINGERPRINT: `sha256:${"A".repeat(43)}`,
      OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
      OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: "personal-owner-claim".padEnd(32, "x"),
      OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: createId("environment"),
      OPENSTEER_MODE: "production",
      OPENSTEER_RUNTIME_ORIGIN: "http://localhost:4310",
    } as const;

    let missingDistribution: unknown;
    try {
      parseHostConfig(personal);
    } catch (error) {
      missingDistribution = error;
    }
    expect(missingDistribution).toMatchObject({
      code: "packaged-personal-web-distribution-required",
    });
    expect(
      parseHostConfig({
        ...personal,
        OPENSTEER_HOST_RELEASE_VERSION: "1.2.3",
        OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: "/release/web",
        OPENSTEER_WEB_DISTRIBUTION_MANIFEST: "/release/web/opensteer-web.json",
      }).webDistribution,
    ).toEqual({
      directory: "/release/web",
      expectedHostVersion: "1.2.3",
      manifestPath: "/release/web/opensteer-web.json",
    });
    expect(() =>
      parseHostConfig({
        ...personal,
        OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: "/release/web",
      }),
    ).toThrow(/must be configured together/u);
    expect(() =>
      parseHostConfig({
        ...personal,
        OPENSTEER_HOST_RELEASE_VERSION: "1.2.3",
        OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: "relative/web",
        OPENSTEER_WEB_DISTRIBUTION_MANIFEST: "/release/web/opensteer-web.json",
      }),
    ).toThrow(/absolute paths/u);
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_HOST_RELEASE_VERSION: "1.2.3",
        OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: "/release/web",
        OPENSTEER_WEB_DISTRIBUTION_MANIFEST: "/release/web/opensteer-web.json",
      }),
    ).toThrow(/production Host/u);
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_HOST_RELEASE_VERSION: "1.2.3",
        OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: "relative/web",
        OPENSTEER_WEB_DISTRIBUTION_MANIFEST: "relative/web/opensteer-web.json",
      }),
    ).toThrow(/production Host with absolute paths/u);
    expect(() =>
      parseHostConfig({
        ...personal,
        OPENSTEER_BIND_ADDRESS: "0.0.0.0",
        OPENSTEER_CANONICAL_ORIGIN: "http://opensteer.internal:4310",
        OPENSTEER_RUNTIME_ORIGIN: "http://opensteer.internal:4310",
      }),
    ).toThrow(/must use HTTPS in production/u);
  });

  it("rejects incomplete or non-Personal explicit Deployment identities", () => {
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_DEPLOYMENT_ID: createId("deployment"),
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
        OPENSTEER_DEPLOYMENT_KIND: "personal",
      }),
    ).toThrow(/must be configured together/u);

    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_DEPLOYMENT_ID: createId("deployment"),
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_HOST_INSTANCE_ID: createId("hostInstance"),
        OPENSTEER_HOST_KEY_FINGERPRINT: `sha256:${"A".repeat(43)}`,
      }),
    ).toThrow(/only for a loopback Personal Host/u);
  });

  it("requires the Desktop-held owner proof only for unmanaged Personal loopback", () => {
    const personal = {
      ...localHostEnvironment,
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
    } as const;
    expect(() => parseHostConfig(personal)).toThrow(/requires an app-held local owner claim/u);
    expect(
      parseHostConfig({
        ...personal,
        OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: "personal-owner-claim".padEnd(32, "x"),
      }).identity.localOwnerClaimToken,
    ).toHaveLength(32);
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: "misplaced-owner-claim".padEnd(32, "x"),
      }),
    ).toThrow(/allowed only for an unmanaged loopback Personal Host/u);
  });

  it.each([
    ["OPENSTEER_FILES_SERVICE_URL", "http://localhost:4315"],
    ["OPENSTEER_PORTABLEFS_AUTHORIZATION_DOMAIN", "opensteer"],
    ["OPENSTEER_PORTABLEFS_MANAGER_CA_PATH", "/keys/ca.pem"],
    ["OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH", "/keys/client.pem"],
    ["OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH", "/keys/client.key"],
    ["OPENSTEER_PORTABLEFS_MANAGER_SERVER_NAME", "portablefs.internal"],
    ["OPENSTEER_PORTABLEFS_MANAGER_URL", "http://localhost:4314"],
    ["OPENSTEER_PORTABLEFS_PRODUCT_ISSUER", "opensteer"],
    ["OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH", "/keys/product.key"],
    ["OPENSTEER_PORTABLEFS_SERVICE_ID", "portablefs"],
    ["OPENSTEER_WORKSPACE_ARCHIVE_AFTER_DAYS", "7"],
    ["OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES", "10737418240"],
    ["OPENSTEER_WORKSPACE_DEFAULT_INODE_LIMIT", "1000000"],
    ["OPENSTEER_WORKSPACE_MAX_BLOCK_LIMIT_BYTES", "107374182400"],
    ["OPENSTEER_WORKSPACE_MAX_INODE_LIMIT", "10000000"],
  ] as const)("rejects PortableFS-only variable %s for local storage", (name, value) => {
    expect(() => parseHostConfig({ ...localHostEnvironment, [name]: value })).toThrow(name);
  });

  it("rejects a local default owner environment for PortableFS storage", () => {
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: "env_00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow("OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID");
  });

  it("requires explicit deployment axes in production", () => {
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_MODE: "production",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      }),
    ).toThrow(/requires OPENSTEER_DEFAULT_WORKSPACE_BACKING/u);

    const productionConfig = parseHostConfig({
      ...localHostEnvironment,
      OPENSTEER_BROWSER_PROFILE_KEY_PATH: "/keys/browser-profiles.key",
      OPENSTEER_CREDENTIAL_KEY_PATH: "/keys/credentials.key",
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "server",
      OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
      OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
      OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: createId("environment"),
      OPENSTEER_MODE: "production",
      OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
    });
    expect(productionConfig.workspace.shape).toEqual({
      defaultWorkspaceBacking: "local-directory",
      kind: "server" as const,
    });
    expect(
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_BROWSER_PROFILE_KEY_PATH: "/keys/browser-profiles.key",
        OPENSTEER_CREDENTIAL_KEY_PATH: "/keys/credentials.key",
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
        OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
        OPENSTEER_HOST_RELEASE_VERSION: "1.2.3",
        OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: createId("environment"),
        OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/data/workspace-bindings.json",
        OPENSTEER_LOCAL_WORKSPACE_ROOT: "/data/workspaces",
        OPENSTEER_MODE: "production",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
        OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: "/release/web",
        OPENSTEER_WEB_DISTRIBUTION_MANIFEST: "/release/web/opensteer-web.json",
      }).webDistribution,
    ).toEqual({
      directory: "/release/web",
      expectedHostVersion: "1.2.3",
      manifestPath: "/release/web/opensteer-web.json",
    });
  });

  it("rejects deployment backing that disagrees with its configured driver", () => {
    const local = parseHostConfig(localHostEnvironment);
    const portableFs = parseHostConfig(hostEnvironment);
    expect(() =>
      assertHostConfigInvariants({
        ...local,
        workspace: { ...local.workspace, storage: portableFs.workspace.storage },
      }),
    ).toThrow(/Deployment backing and storage configuration do not match/u);
  });

  it("validates the Host-level default Workspace quota policy", () => {
    const configured = parseHostConfig({
      ...hostEnvironment,
      OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES: String(2 * 1_024 * 1_024 * 1_024),
      OPENSTEER_WORKSPACE_DEFAULT_INODE_LIMIT: "250000",
      OPENSTEER_WORKSPACE_MAX_BLOCK_LIMIT_BYTES: String(20 * 1_024 * 1_024 * 1_024),
      OPENSTEER_WORKSPACE_MAX_INODE_LIMIT: "2000000",
    });
    expect(configured.workspace.storage).toMatchObject({
      defaultBlockLimitBytes: 2 * 1_024 * 1_024 * 1_024,
      defaultInodeLimit: 250_000,
      maxBlockLimitBytes: 20 * 1_024 * 1_024 * 1_024,
      maxInodeLimit: 2_000_000,
    });
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES: "12345",
      }),
    ).toThrow(/multiple of 1024/);
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_WORKSPACE_MAX_BLOCK_LIMIT_BYTES: "12345",
      }),
    ).toThrow(/multiple of 1024/);
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_WORKSPACE_DEFAULT_INODE_LIMIT: "2000000",
        OPENSTEER_WORKSPACE_MAX_INODE_LIMIT: "1000000",
      }),
    ).toThrow(/must not exceed/u);
  });

  it("lets a browser-only self-host disable the native app authorization surface", () => {
    const config = parseHostConfig({
      ...hostEnvironment,
      OPENSTEER_NATIVE_OAUTH_ENABLED: "false",
    });
    expect(config.identity.nativeOAuth).toBeUndefined();
  });

  it("always registers the closed first-party native OAuth allowlist", () => {
    expect(
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_NATIVE_OAUTH_CLIENTS: JSON.stringify([
          {
            application: "mobile",
            clientId: "operator-invented-client",
            displayName: "Operator client",
            redirectUris: [opensteerMobileHostOAuthCallback],
            softwareId: "operator-client",
          },
        ]),
      }).identity.nativeOAuth?.clients,
    ).toEqual(opensteerHostNativeOAuthClients);
  });

  it("keeps a Personal Deployment off its own OAuth authorization server", () => {
    const personalEnvironment = {
      ...localHostEnvironment,
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: "personal-owner-claim".padEnd(32, "x"),
    } as const;
    const personal = parseHostConfig(personalEnvironment);
    expect(personal.identity.nativeOAuth).toBeUndefined();
    expect(() => assertHostConfigInvariants(personal)).not.toThrow();

    expect(() =>
      parseHostConfig({ ...personalEnvironment, OPENSTEER_NATIVE_OAUTH_ENABLED: "true" }),
    ).toThrow(/Personal Deployment cannot serve native OAuth/u);
    expect(
      parseHostConfig({ ...hostEnvironment, OPENSTEER_NATIVE_OAUTH_ENABLED: "true" }).identity
        .nativeOAuth?.clients,
    ).toEqual(opensteerHostNativeOAuthClients);
  });

  it("loads managed provisioning with an exact Account owner and no public owner bootstrap", () => {
    const canonicalOrigin = "https://managed.example.test";
    const adoption = managedAccountBundle({ canonicalOrigin });
    const owner = {
      displayName: "Account Owner",
      email: "owner@example.test",
      subject: `acct_${crypto.randomUUID()}`,
    };
    const bundle = ManagedHostProvisioningBundleSchema.parse({
      ...adoption,
      initialRunnerEnrollmentToken: "provider-held-runner-enrollment-token",
      owner,
      provisioningMode: "managed",
    });
    const config = parseHostConfig({
      ...hostEnvironment,
      OPENSTEER_ACCOUNT_BUNDLE_PATH: writeManagedAccountBundle(bundle),
      OPENSTEER_BIND_ADDRESS: "0.0.0.0",
      OPENSTEER_CANONICAL_ORIGIN: canonicalOrigin,
      OPENSTEER_DEPLOYMENT_KIND: "server",
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
    });

    expect(config.account).toMatchObject({
      initialRunnerEnrollmentToken: "provider-held-runner-enrollment-token",
      owner,
      provisioningMode: "managed",
    });
    expect(config.identity.localPasswordEnabled).toBe(false);
    expect(config.identity.initialOwnerEnrollment).toBeUndefined();
  });

  it("rejects partial, noncanonical, and insecure production Account bundles", () => {
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_ACCOUNT_BUNDLE_FD: "3",
        OPENSTEER_ACCOUNT_BUNDLE_PATH: "/private/account-bundle.json",
      }),
    ).toThrow(/exactly one/u);
    const invalidPath = writeManagedAccountBundle({ invalid: true });
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_ACCOUNT_BUNDLE_PATH: invalidPath,
      }),
    ).toThrow(/provisioning bundle/iu);
    const productionBundle = managedAccountBundle({
      canonicalOrigin: "https://opensteer.example.com",
      controlApiOrigin: "http://127.0.0.1:4142",
    });
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_ACCOUNT_BUNDLE_PATH: writeManagedAccountBundle(productionBundle),
        OPENSTEER_BROWSER_PROFILE_KEY_PATH: "/keys/browser-profiles.key",
        OPENSTEER_CREDENTIAL_KEY_PATH: "/keys/credentials.key",
        OPENSTEER_FILES_SERVICE_URL: "http://files:4315",
        OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
        OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
        OPENSTEER_MODE: "production",
        OPENSTEER_PORTABLEFS_MANAGER_CA_PATH: "/keys/control-ca.pem",
        OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH: "/keys/product.cert",
        OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH: "/keys/product.key",
        OPENSTEER_PORTABLEFS_MANAGER_URL: "https://portablefs.example.com",
        OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH: "/keys/product-signing.key",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      }),
    ).toThrow(/control API must use HTTPS/);
  });

  it("rejects undersized identity and setup secrets", () => {
    expect(() =>
      parseHostConfig({ ...hostEnvironment, OPENSTEER_AUTH_SECRET: "too-short" }),
    ).toThrow();
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: "too-short",
      }),
    ).toThrow();
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_INITIAL_BROWSER_RUNNER_ENROLLMENT_TOKEN: "too-short",
      }),
    ).toThrow();
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN: "too-short",
      }),
    ).toThrow();
  });

  it("rejects shipped placeholders instead of treating them as secrets", () => {
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_AUTH_SECRET: "replace-with-at-least-32-random-characters",
      }),
    ).toThrow(/setup:local/);
  });

  it("requires an asymmetric host key pair in production", () => {
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_FILES_SERVICE_URL: "http://files:4315",
        OPENSTEER_MODE: "production",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
        OPENSTEER_PORTABLEFS_MANAGER_CA_PATH: "/keys/control-ca.pem",
        OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH: "/keys/product.cert",
        OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH: "/keys/product.key",
        OPENSTEER_PORTABLEFS_MANAGER_URL: "https://portablefs.example.com",
      }),
    ).toThrow(/requires OPENSTEER_HOST_PRIVATE_KEY_PATH/);
  });

  it("resolves one explicit Node executable and never falls back from Electron", () => {
    expect(
      resolveRunnerNodeExecutable("/opt/opensteer/node", {
        electronVersion: "43.3.0",
        execPath: "/Applications/Opensteer.app/Contents/MacOS/Opensteer",
      }),
    ).toBe("/opt/opensteer/node");
    expect(
      resolveRunnerNodeExecutable(undefined, {
        electronVersion: undefined,
        execPath: "/usr/local/bin/node",
      }),
    ).toBe("/usr/local/bin/node");
    expect(() =>
      resolveRunnerNodeExecutable(undefined, {
        electronVersion: "43.3.0",
        execPath: "/Applications/Opensteer.app/Contents/MacOS/Opensteer",
      }),
    ).toThrow(/OPENSTEER_NODE_EXECUTABLE/u);
    expect(() =>
      parseRunnerConfig({
        OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
        OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: ".opensteer/registry.json",
        OPENSTEER_LOCAL_WORKSPACE_ROOT: ".opensteer/workspaces",
        OPENSTEER_NODE_EXECUTABLE: "relative-node",
      }),
    ).toThrow(/absolute path/u);
  });

  it.each([
    ["local-directory", "personal", "main", "single-owner"],
    ["local-directory", "server", "main", "owner-scoped"],
    ["portablefs", "server", "main", "owner-scoped"],
    ["portablefs", "server", "managed", "owner-scoped"],
    ["portablefs", "server", "local", "owner-scoped"],
  ] as const)(
    "derives the %s/%s %s Runner Workspace namespace as %s",
    (backing, kind, runnerKind, expectedNamespace) => {
      const storage =
        backing === "local-directory"
          ? {
              OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: ".opensteer/registry.json",
              OPENSTEER_LOCAL_WORKSPACE_ROOT: ".opensteer/workspaces",
            }
          : {
              OPENSTEER_PORTABLEFS_MOUNT_BINARY: "/opt/portablefs",
              OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "portablefs",
            };
      const config = parseRunnerConfig({
        ...storage,
        OPENSTEER_DEPLOYMENT_KIND: kind,
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: backing,
        OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
        OPENSTEER_RUNNER_KIND: runnerKind,
      });

      expect(config.workspaceNamespace).toBe(expectedNamespace);
    },
  );

  it("derives an absolute PortableFS root for non-managed Runners and rejects relative overrides", () => {
    const environment = {
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
      OPENSTEER_DEPLOYMENT_KIND: "server",
      OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
      OPENSTEER_PORTABLEFS_MOUNT_BINARY: "/opt/portablefs",
      OPENSTEER_RUNNER_DATA_DIR: ".opensteer/custom-runner",
      OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "portablefs",
    } as const;
    expect(parseRunnerConfig(environment).workspaceRoot).toBe(
      resolve(".opensteer/custom-runner/workspaces"),
    );
    expect(() =>
      parseRunnerConfig({ ...environment, OPENSTEER_RUNNER_WORKSPACE_ROOT: "relative" }),
    ).toThrow(/OPENSTEER_RUNNER_WORKSPACE_ROOT must be an absolute path/u);
  });

  it("requires every production Runner to declare its Deployment axes", () => {
    expect(() =>
      parseRunnerConfig({
        OPENSTEER_HOST_URL: "https://host.example",
        OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/var/lib/opensteer/registry.json",
        OPENSTEER_LOCAL_WORKSPACE_ROOT: "/var/lib/opensteer/workspaces",
        OPENSTEER_MODE: "production",
      }),
    ).toThrow(/requires OPENSTEER_DEFAULT_WORKSPACE_BACKING/u);
  });

  it("allows production plaintext only on loopback", () => {
    const personal = parseRunnerConfig({
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
      OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/var/lib/opensteer/registry.json",
      OPENSTEER_LOCAL_WORKSPACE_ROOT: "/var/lib/opensteer/workspaces",
      OPENSTEER_MODE: "production",
    });
    expect(personal.deploymentShape).toEqual({
      defaultWorkspaceBacking: "local-directory",
      kind: "personal" as const,
    });

    expect(
      parseRunnerConfig({
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
        OPENSTEER_MODE: "production",
        OPENSTEER_PORTABLEFS_MOUNT_BINARY: "/opt/portablefs",
        OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "portablefs",
      }).hostUrl,
    ).toEqual(new URL("http://127.0.0.1:4310"));
    expect(() =>
      parseRunnerConfig({
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
        OPENSTEER_DEPLOYMENT_KIND: "personal",
        OPENSTEER_HOST_URL: "https://personal.example",
        OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/var/lib/opensteer/registry.json",
        OPENSTEER_LOCAL_WORKSPACE_ROOT: "/var/lib/opensteer/workspaces",
        OPENSTEER_MODE: "production",
      }),
    ).toThrow(/requires a loopback OPENSTEER_HOST_URL/u);
  });

  it("keeps the Personal loopback rule on the Main Runner alone", () => {
    // Every other computer on a Personal Deployment is reachable-only and
    // connects to the signed access route, which is an HTTPS origin.
    for (const runnerKind of ["local", "managed"] as const) {
      expect(
        parseRunnerConfig({
          OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
          OPENSTEER_DEPLOYMENT_KIND: "personal",
          OPENSTEER_HOST_URL: "https://personal.example",
          OPENSTEER_MODE: "production",
          OPENSTEER_RUNNER_KIND: runnerKind,
          OPENSTEER_RUNNER_MODULES: "shell",
        }).hostUrl,
      ).toEqual(new URL("https://personal.example"));
    }
    expect(() =>
      parseRunnerConfig({
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
        OPENSTEER_DEPLOYMENT_KIND: "personal",
        OPENSTEER_HOST_URL: "https://personal.example",
        OPENSTEER_MODE: "production",
        OPENSTEER_RUNNER_KIND: "main",
        OPENSTEER_RUNNER_MODULES: "shell",
      }),
    ).toThrow(/requires a loopback OPENSTEER_HOST_URL/u);
  });

  it("runs every module by default and narrows to the declared list", () => {
    const agentsEnvironment = {
      OPENSTEER_BROWSER_BRIDGE_TOKEN: "b".repeat(32),
      OPENSTEER_BROWSER_BRIDGE_URL: "http://127.0.0.1:4320",
      OPENSTEER_BROWSER_RUNTIME_ID: "browser-runtime-1",
      OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
      OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/var/lib/opensteer/registry.json",
      OPENSTEER_LOCAL_WORKSPACE_ROOT: "/var/lib/opensteer/workspaces",
    } as const;

    const everything = parseRunnerConfig(agentsEnvironment);
    expect(everything.modules).toEqual(["agents", "browser", "integrations", "shell"]);
    expect(everything.browserBridge?.runtimeId).toBe("browser-runtime-1");

    // Order in the variable says nothing; the Runner runs the same two modules.
    const withoutBrowser = parseRunnerConfig({
      ...agentsEnvironment,
      OPENSTEER_RUNNER_MODULES: "shell, agents",
    });
    expect(withoutBrowser.modules).toEqual(["agents", "shell"]);
    expect(withoutBrowser.browserBridge).toBeUndefined();
  });

  it("starts a reach-only Runner from the settings the desktop actually sends", () => {
    // A computer that only offers shell receives no execution inputs at all:
    // no Workspace roots, no PortableFS, no browser bridge, no skills.
    const config = parseRunnerConfig({
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "server",
      OPENSTEER_HOST_URL: "https://host.example",
      OPENSTEER_MODE: "production",
      OPENSTEER_NATIVE_FS_HELPER: "/Applications/Opensteer.app/helpers/opensteer-native-fs",
      OPENSTEER_NODE_EXECUTABLE: "/Applications/Opensteer.app/helpers/node",
      OPENSTEER_RUNNER_DATA_DIR: "/Users/person/Library/Application Support/Opensteer/runner",
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: token,
      OPENSTEER_RUNNER_KIND: "local",
      OPENSTEER_RUNNER_MODULES: "shell",
      OPENSTEER_RUNNER_NAME: "Alex's Mac mini",
    });

    expect(config.modules).toEqual(["shell"]);
    expect(config.enrollmentToken).toBe(token);
    expect(config.workspaceBackings).toEqual([]);
    expect(config.browserBridge).toBeUndefined();
  });

  it("parses a reach-only Runner with no Workspace storage of its own", () => {
    const config = parseRunnerConfig({
      OPENSTEER_HOST_URL: "https://host.example",
      OPENSTEER_RUNNER_KIND: "local",
      OPENSTEER_RUNNER_MODULES: "shell",
    });

    expect(config.modules).toEqual(["shell"]);
    expect(config.workspaceBackings).toEqual([]);
    expect(config.localWorkspaceRoot).toBeUndefined();
    expect(config.localWorkspaceRegistryPath).toBeUndefined();
    expect(config.workspaceRoot).toBeUndefined();
    expect(config.mountBinary).toBeUndefined();

    // The desktop restarts the same computer with the other module set from the
    // environment it already built, so leftover storage settings are inert.
    expect(
      parseRunnerConfig({
        OPENSTEER_HOST_URL: "https://host.example",
        OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/var/lib/opensteer/registry.json",
        OPENSTEER_LOCAL_WORKSPACE_ROOT: "/var/lib/opensteer/workspaces",
        OPENSTEER_RUNNER_KIND: "local",
        OPENSTEER_RUNNER_MODULES: "shell",
      }).localWorkspaceRoot,
    ).toBeUndefined();
  });

  it("refuses a browser relay on a computer that runs no agents", () => {
    expect(() =>
      parseRunnerConfig({
        OPENSTEER_HOST_URL: "https://host.example",
        OPENSTEER_RUNNER_MODULES: "browser,shell",
      }),
    ).toThrow("browser relay belongs to a computer that runs agents");
  });

  it("takes the computer use bridge as a loopback pair or not at all", () => {
    const base = {
      OPENSTEER_HOST_URL: "https://host.example",
      OPENSTEER_RUNNER_MODULES: "integrations",
    } as const;
    const token = "c".repeat(32);

    expect(parseRunnerConfig(base).computerUseBridge).toBeUndefined();
    expect(
      parseRunnerConfig({
        ...base,
        OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: token,
        OPENSTEER_COMPUTER_USE_BRIDGE_URL: "ws://127.0.0.1:4322/",
      }).computerUseBridge,
    ).toEqual({ token, url: new URL("ws://127.0.0.1:4322/") });
    // The desktop mints whichever spelling its own server speaks.
    expect(
      parseRunnerConfig({
        ...base,
        OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: token,
        OPENSTEER_COMPUTER_USE_BRIDGE_URL: "http://localhost:4322",
      }).computerUseBridge?.url,
    ).toEqual(new URL("http://localhost:4322"));

    for (const environment of [
      { OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: token },
      { OPENSTEER_COMPUTER_USE_BRIDGE_URL: "ws://127.0.0.1:4322/" },
    ]) {
      expect(() => parseRunnerConfig({ ...base, ...environment })).toThrow(
        /OPENSTEER_COMPUTER_USE_BRIDGE_URL and OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN together/u,
      );
    }
    // A helper on another computer is a Mac nobody approved, and a credential
    // in a query string is a credential in every log between here and there.
    for (const url of [
      "ws://10.0.0.4:4322/",
      "wss://desktop.example/",
      "ws://127.0.0.1:4322/?token=x",
      "ws://user:secret@127.0.0.1:4322/",
    ]) {
      expect(() =>
        parseRunnerConfig({
          ...base,
          OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: token,
          OPENSTEER_COMPUTER_USE_BRIDGE_URL: url,
        }),
      ).toThrow(/OPENSTEER_COMPUTER_USE_BRIDGE_URL must be an uncredentialed loopback/u);
    }
  });

  it("refuses module lists that are not a unique subset", () => {
    for (const modules of ["", "agents,messaging", "agents,agents", "Agents", "agents shell"]) {
      expect(() =>
        parseRunnerConfig({
          OPENSTEER_HOST_URL: "https://host.example",
          OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/var/lib/opensteer/registry.json",
          OPENSTEER_LOCAL_WORKSPACE_ROOT: "/var/lib/opensteer/workspaces",
          OPENSTEER_RUNNER_MODULES: modules,
        }),
      ).toThrow(/OPENSTEER_RUNNER_MODULES|expected string to have/u);
    }
  });

  it("rejects Runner origins that cannot carry Host capability traffic", () => {
    expect(() =>
      parseRunnerConfig({
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_HOST_URL: "https://host.example/path?query=true",
        OPENSTEER_PORTABLEFS_MOUNT_BINARY: "/opt/portablefs",
        OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "portablefs",
      }),
    ).toThrow(/HTTP\(S\) origin/u);
  });

  it("drops PortableFS rather than refusing to start when its mount binary is absent", () => {
    const config = parseRunnerConfig({
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
      OPENSTEER_DEPLOYMENT_KIND: "server",
      OPENSTEER_HOST_URL: "https://host.example",
      OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/var/lib/opensteer/registry.json",
      OPENSTEER_LOCAL_WORKSPACE_ROOT: "/var/lib/opensteer/workspaces",
      OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "local-directory,portablefs",
    });

    expect(config.workspaceBackings).toEqual(["local-directory"]);
    expect(config.portableFsUnavailableReason).toMatch(/only its own directories/u);
  });

  it("still refuses a PortableFS-only Runner with no mount binary", () => {
    expect(() =>
      parseRunnerConfig({
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_HOST_URL: "https://host.example",
        OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "portablefs",
      }),
    ).toThrow(/requires OPENSTEER_PORTABLEFS_MOUNT_BINARY/u);
  });

  it("rejects cleartext control-plane transport in production", () => {
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
        OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
        OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH: "/keys/product-signing.key",
        OPENSTEER_CREDENTIAL_KEY_PATH: "/keys/credentials.key",
        OPENSTEER_FILES_SERVICE_URL: "http://files:4315",
        OPENSTEER_BROWSER_PROFILE_KEY_PATH: "/keys/browser-profiles.key",
        OPENSTEER_MODE: "production",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      }),
    ).toThrow(/must use HTTPS/);
  });

  it("requires one origin-only Manager URL that Runners can use for renewal", () => {
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_PORTABLEFS_MANAGER_URL: "http://localhost:4314/private/control",
      }),
    ).toThrow(/origin-only/);
  });

  it("accepts only an origin-only HTTP Files service URL", () => {
    expect(
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_FILES_SERVICE_URL: "http://files.internal:4315",
      }).workspace.storage,
    ).toMatchObject({ filesServiceUrl: new URL("http://files.internal:4315") });
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_FILES_SERVICE_URL: "http://files.internal:4315/private",
      }),
    ).toThrow(/origin/i);
    expect(() =>
      parseHostConfig({ ...hostEnvironment, OPENSTEER_FILES_SERVICE_URL: "ftp://files.internal" }),
    ).toThrow(/HTTP/);
  });

  it("requires an explicit Files service origin in production", () => {
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_BROWSER_PROFILE_KEY_PATH: "/keys/browser-profiles.key",
        OPENSTEER_CREDENTIAL_KEY_PATH: "/keys/credentials.key",
        OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
        OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
        OPENSTEER_MODE: "production",
        OPENSTEER_PORTABLEFS_MANAGER_CA_PATH: "/keys/control-ca.pem",
        OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH: "/keys/product.cert",
        OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH: "/keys/product.key",
        OPENSTEER_PORTABLEFS_MANAGER_URL: "https://portablefs.example.com",
        OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH: "/keys/product-signing.key",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      }),
    ).toThrow(/requires OPENSTEER_FILES_SERVICE_URL/);
  });

  it("accepts self-host production axes with the private HTTPS gateway origin", () => {
    const config = parseHostConfig({
      ...localHostEnvironment,
      OPENSTEER_BIND_ADDRESS: "0.0.0.0",
      OPENSTEER_BROWSER_PROFILE_KEY_PATH: "/run/secrets/browser-profile.key",
      OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      OPENSTEER_CREDENTIAL_KEY_PATH: "/run/secrets/credential.key",
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "server",
      OPENSTEER_HOST_PRIVATE_KEY_PATH: "/var/lib/opensteer/keys/host-private.pem",
      OPENSTEER_HOST_PUBLIC_KEY_PATH: "/var/lib/opensteer-public/host-public.pem",
      OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: createId("environment"),
      OPENSTEER_MODE: "production",
      OPENSTEER_RUNTIME_ORIGIN: "https://gateway:8443",
    });

    expect(config.runtimeOrigin).toEqual(new URL("https://gateway:8443"));
    expect(config.workspace.shape).toEqual({
      defaultWorkspaceBacking: "local-directory",
      kind: "server" as const,
    });
    expect(config.acceptsExternalRunners).toBe(false);
  });

  it("refuses a private runtime origin once a Deployment accepts lent machines", () => {
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_ACCEPTS_EXTERNAL_RUNNERS: "true",
        OPENSTEER_BIND_ADDRESS: "0.0.0.0",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: createId("environment"),
        OPENSTEER_RUNTIME_ORIGIN: "https://gateway:8443",
      }),
    ).toThrow(/accepts external Runners requires OPENSTEER_RUNTIME_ORIGIN/u);
  });

  it("refuses a private runtime origin for a PortableFS Deployment", () => {
    const networked = {
      ...hostEnvironment,
      OPENSTEER_BIND_ADDRESS: "0.0.0.0",
      OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
      OPENSTEER_DEPLOYMENT_KIND: "server",
    } as const;

    expect(() =>
      parseHostConfig({ ...networked, OPENSTEER_RUNTIME_ORIGIN: "https://gateway:8443" }),
    ).toThrow(/OPENSTEER_RUNTIME_ORIGIN to equal OPENSTEER_CANONICAL_ORIGIN/u);

    const config = parseHostConfig({
      ...networked,
      OPENSTEER_RUNTIME_ORIGIN: "https://opensteer.example.com",
    });
    expect(config.runtimeOrigin).toEqual(new URL("https://opensteer.example.com"));
    expect(config.workspace.shape).toEqual({
      defaultWorkspaceBacking: "portablefs",
      kind: "server" as const,
    });
  });

  it("accepts exactly the reachable deployment kind and exposure combinations", () => {
    const personal = parseHostConfig({
      ...localHostEnvironment,
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: token,
    });
    expect(personal.workspace.shape).toEqual({
      defaultWorkspaceBacking: "local-directory",
      kind: "personal",
    });
    expect(personal.exposure).toBe("loopback");

    const server = parseHostConfig({
      ...localHostEnvironment,
      OPENSTEER_BIND_ADDRESS: "0.0.0.0",
      OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      OPENSTEER_DEPLOYMENT_KIND: "server",
      OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: createId("environment"),
    });
    expect(server.workspace.shape).toEqual({
      defaultWorkspaceBacking: "local-directory",
      kind: "server",
    });
    expect(server.exposure).toBe("networked");

    const development = parseHostConfig(localHostEnvironment);
    expect(development.workspace.shape).toEqual({
      defaultWorkspaceBacking: "local-directory",
      kind: "server",
    });
    expect(development.exposure).toBe("loopback");

    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_BIND_ADDRESS: "0.0.0.0",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
        OPENSTEER_DEPLOYMENT_KIND: "personal",
        OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: token,
        OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: createId("environment"),
      }),
    ).toThrow(/Personal Deployment must be confined to loopback/u);

    const accountBundle = managedAccountBundle();
    expect(() =>
      parseHostConfig({
        ...networkedHostEnvironment,
        OPENSTEER_ACCOUNT_BUNDLE_PATH: writeManagedAccountBundle(accountBundle),
        OPENSTEER_CANONICAL_ORIGIN: accountBundle.deployment.canonicalOrigin,
        OPENSTEER_DEPLOYMENT_KIND: "personal",
      }),
    ).toThrow();
  });

  it("accepts an operator-held first-owner code only where enrollment establishes the owner", () => {
    expect(
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_BIND_ADDRESS: "0.0.0.0",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
        OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: token,
        OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: createId("environment"),
        OPENSTEER_DEPLOYMENT_KIND: "server",
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      }).identity.initialOwnerEnrollment,
    ).toEqual({ lifetimeSeconds: 24 * 60 * 60, token });
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: token,
      }),
    ).toThrow(/allowed only for a networked Deployment/u);
  });

  it("rejects a portal origin that is not a bare, secure origin", () => {
    for (const value of [
      "https://beta.opensteer.com/portal",
      "https://beta.opensteer.com/?next=/",
      "https://user:password@beta.opensteer.com",
      "http://beta.opensteer.com",
    ]) {
      expect(() => parseHostConfig({ ...hostEnvironment, OPENSTEER_PORTAL_ORIGIN: value })).toThrow(
        /OPENSTEER_PORTAL_ORIGIN/u,
      );
    }
    expect(
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_PORTAL_ORIGIN: "http://localhost:43100",
      }).portalOrigin,
    ).toEqual(new URL("http://localhost:43100"));
  });

  it("requires normalized HTTP origins for canonical and runtime identity", () => {
    for (const [name, value] of [
      ["OPENSTEER_CANONICAL_ORIGIN", "https://host.example/path"],
      ["OPENSTEER_RUNTIME_ORIGIN", "https://user:password@host.example"],
    ] as const) {
      expect(() => parseHostConfig({ ...hostEnvironment, [name]: value })).toThrow(/origin/i);
    }
  });
});

describe("Host exposure", () => {
  it("treats a loopback origin on a loopback listener as loopback-only", () => {
    for (const canonicalOrigin of [
      "http://localhost:43100",
      "http://127.0.0.1:4310",
      "http://127.5.5.5:4310",
      "http://[::1]:4310",
    ]) {
      expect(
        parseHostConfig({ ...hostEnvironment, OPENSTEER_CANONICAL_ORIGIN: canonicalOrigin })
          .exposure,
      ).toBe("loopback");
    }
  });

  it("treats a reachable origin as networked", () => {
    expect(
      parseHostConfig({
        ...networkedHostEnvironment,
        OPENSTEER_CANONICAL_ORIGIN: "http://opensteer.example.com",
      }).exposure,
    ).toBe("networked");
  });

  it("refuses loopback exposure when the listener accepts every interface", () => {
    // Declaring a loopback public origin must not relax a Host that anything on
    // the network can still reach directly.
    for (const bindAddress of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "192.168.1.10"]) {
      expect(
        parseHostConfig({
          ...networkedHostEnvironment,
          OPENSTEER_BIND_ADDRESS: bindAddress,
          OPENSTEER_CANONICAL_ORIGIN: "http://localhost:43100",
        }).exposure,
      ).toBe("networked");
    }
  });

  it("treats a public origin behind a loopback listener as networked", () => {
    // The reverse-proxy placement: the listener is private, but the browser
    // reaches this Deployment at a public name, so nothing about it is
    // loopback-only.
    for (const bindAddress of ["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]) {
      expect(
        parseHostConfig({
          ...networkedHostEnvironment,
          OPENSTEER_BIND_ADDRESS: bindAddress,
        }).exposure,
      ).toBe("networked");
    }
  });

  it("reads an expanded IPv6 loopback listener as loopback", () => {
    expect(
      parseHostConfig({ ...hostEnvironment, OPENSTEER_BIND_ADDRESS: "0:0:0:0:0:0:0:1" }).exposure,
    ).toBe("loopback");
  });
});

describe("Runner enrollment token delivery", () => {
  const runnerEnvironment = {
    OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
    OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: ".opensteer/host/workspace-bindings.v1.json",
    OPENSTEER_LOCAL_WORKSPACE_ROOT: ".opensteer/workspaces",
  } as const;

  it("prefers an inherited file descriptor over the environment", async () => {
    const { mkdtemp, writeFile, open } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-fd-"));
    const path = join(directory, "token");
    const descriptorToken = "d".repeat(48);
    await writeFile(path, `${descriptorToken}\n`, "utf8");
    const handle = await open(path, "r");
    try {
      const config = parseRunnerConfig({
        ...runnerEnvironment,
        OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "e".repeat(48),
        OPENSTEER_RUNNER_ENROLLMENT_TOKEN_FD: String(handle.fd),
      });
      expect(config.enrollmentToken).toBe(descriptorToken);
    } finally {
      await handle.close();
    }
  });

  it("reports an unreadable descriptor rather than starting unenrolled", () => {
    expect(() =>
      parseRunnerConfig({
        ...runnerEnvironment,
        OPENSTEER_RUNNER_ENROLLMENT_TOKEN_FD: "1024",
      }),
    ).toThrow(/could not be read/);
  });
});

function managedAccountBundle(
  input: {
    readonly canonicalOrigin?: string;
    readonly controlApiOrigin?: string;
  } = {},
) {
  const canonicalOrigin = input.canonicalOrigin ?? "https://deployment.connect.opensteer.test";
  const controlApiOrigin = input.controlApiOrigin ?? "https://accounts.opensteer.test";
  return ManagedHostProvisioningBundleSchema.parse({
    provisioningMode: "adoption",
    controlApiOrigin,
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
      issuer: controlApiOrigin,
      redirectUri: `${canonicalOrigin}/v1/auth/oidc/callback`,
      requirePkce: true,
      scopes: ["openid", "profile", "email"],
      tokenEndpointAuthMethod: "client_secret_basic",
    },
    oidcClientSecret: `ocs_${"b".repeat(43)}`,
  });
}

function writeManagedAccountBundle(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-config-account-bundle-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "account-bundle.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return path;
}
