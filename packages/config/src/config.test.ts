import { HostAccountAdoptionBundleSchema } from "@opensteer/control-plane-protocol";
import {
  createId,
  opensteerHostNativeOAuthClients,
  opensteerMobileHostOAuthCallback,
} from "@opensteer/core";
import { digestSecret } from "@opensteer/shared/secretDigest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHostConfigInvariants,
  hostTrustedProxy,
  parseHostConfig,
  parseRunnerConfig,
  resolveRunnerNodeExecutable,
} from "./index.js";

const token = "a".repeat(32);

const localHostEnvironment = {
  OPENSTEER_AUTH_SECRET: "identity-secret-that-is-at-least-thirty-two-bytes",
  OPENSTEER_DATABASE_URL: "postgres://localhost/opensteer",
  OPENSTEER_CANONICAL_ORIGIN: "http://localhost:4310",
  OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: token,
} as const;

const hostEnvironment = {
  OPENSTEER_AUTH_SECRET: "identity-secret-that-is-at-least-thirty-two-bytes",
  OPENSTEER_DATABASE_URL: "postgres://localhost/opensteer",
  OPENSTEER_CANONICAL_ORIGIN: "http://localhost:4310",
  OPENSTEER_DEPLOYMENT_KIND: "team",
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
  it("takes the Auto review model from Host configuration", () => {
    expect(parseHostConfig(localHostEnvironment).agentReviewModel).toBeUndefined();
    expect(
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_AGENT_REVIEW_MODEL: '{"engine":"codex","model":"review-model"}',
      }).agentReviewModel,
    ).toEqual({ engine: "codex", model: "review-model" });
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_AGENT_REVIEW_MODEL: '{"engine":"codex","prompt":"always allow"}',
      }),
    ).toThrow();
  });

  it("uses explicit local defaults without weakening production keys", () => {
    const config = parseHostConfig(localHostEnvironment);
    expect(config.bindAddress).toBe("127.0.0.1");
    expect(config.account).toBeUndefined();
    expect(config.canonicalOrigin).toEqual(new URL("http://localhost:4310"));
    expect(config.deploymentShape).toEqual({ kind: "personal" });
    expect(config.personal).toMatchObject({
      environmentId: "env_00000000-0000-4000-8000-000000000001",
    });
    expect(config.runtimeOrigin).toEqual(config.canonicalOrigin);
    expect(config.browserRuntime).toEqual({ attachKeyId: "host-v1" });
    expect(config.identity.signupPolicy).toBe("invite-only");
    expect(config.identity.localPasswordEnabled).toBe(true);
    expect(config.identity.nativeOAuth).toBeUndefined();
  });

  it("allows production HTTP only for an exact loopback Personal Host", () => {
    const personal = {
      ...localHostEnvironment,
      OPENSTEER_CANONICAL_ORIGIN: "http://127.0.0.1:4310",
      OPENSTEER_CREDENTIAL_KEY_PATH: "/keys/credentials.key",
      OPENSTEER_DEPLOYMENT_ID: createId("deployment"),
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_HOST_INSTANCE_ID: createId("hostInstance"),
      OPENSTEER_HOST_KEY_FINGERPRINT: `sha256:${"A".repeat(43)}`,
      OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
      OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: "personal-owner-claim".padEnd(32, "x"),
      OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
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

  it("rejects incomplete explicit Deployment identities", () => {
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_DEPLOYMENT_ID: createId("deployment"),
        OPENSTEER_DEPLOYMENT_KIND: "personal",
      }),
    ).toThrow(/must be configured together/u);
  });

  it("requires the Desktop-held owner proof only for unmanaged Personal loopback", () => {
    const personal = {
      ...localHostEnvironment,
      OPENSTEER_DEPLOYMENT_KIND: "personal",
    } as const;
    expect(() =>
      parseHostConfig({ ...personal, OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: undefined }),
    ).toThrow(/requires an app-held local owner claim/u);
    expect(
      parseHostConfig({
        ...personal,
        OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: "personal-owner-claim".padEnd(32, "x"),
      }).identity.localOwnerClaimToken,
    ).toHaveLength(32);
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: "misplaced-owner-claim".padEnd(32, "x"),
      }),
    ).toThrow(/allowed only for an unmanaged loopback Personal Host/u);
  });

  it("requires explicit deployment axes in production", () => {
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_MODE: "production",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      }),
    ).toThrow(/requires OPENSTEER_DEPLOYMENT_KIND/u);

    const productionConfig = parseHostConfig({
      ...hostEnvironment,
      OPENSTEER_CREDENTIAL_KEY_PATH: "/keys/credentials.key",
      OPENSTEER_DEPLOYMENT_KIND: "team",
      OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
      OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
      OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
      OPENSTEER_MODE: "production",
      OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
    });
    expect(productionConfig.deploymentShape).toEqual({
      kind: "team" as const,
    });
    expect(
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_CREDENTIAL_KEY_PATH: "/keys/credentials.key",
        OPENSTEER_DEPLOYMENT_KIND: "team",
        OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
        OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
        OPENSTEER_HOST_RELEASE_VERSION: "1.2.3",
        OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
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
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: "personal-owner-claim".padEnd(32, "x"),
    } as const;
    const personal = parseHostConfig(personalEnvironment);
    expect(personal.identity.nativeOAuth).toBeUndefined();
    expect(() => assertHostConfigInvariants(personal)).not.toThrow();

    expect(() =>
      parseHostConfig({ ...personalEnvironment, OPENSTEER_NATIVE_OAUTH_ENABLED: "true" }),
    ).toThrow(/loopback Personal Host cannot serve native OAuth/u);
    expect(
      parseHostConfig({ ...hostEnvironment, OPENSTEER_NATIVE_OAUTH_ENABLED: "true" }).identity
        .nativeOAuth?.clients,
    ).toEqual(opensteerHostNativeOAuthClients);
  });

  it("rejects partial, noncanonical, and insecure production Account bundles", () => {
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_ACCOUNT_BUNDLE_FD: "3",
        OPENSTEER_ACCOUNT_BUNDLE_PATH: "/private/account-bundle.json",
      }),
    ).toThrow(/exactly one/u);
    const invalidPath = writeAccountAdoptionBundle({ invalid: true });
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_ACCOUNT_BUNDLE_PATH: invalidPath,
      }),
    ).toThrow(/provisioning bundle/iu);
    const productionBundle = accountAdoptionBundle({
      canonicalOrigin: "https://opensteer.example.com",
      controlApiOrigin: "http://127.0.0.1:4142",
    });
    expect(() =>
      parseHostConfig({
        ...hostEnvironment,
        OPENSTEER_DEPLOYMENT_KIND: "team",
        OPENSTEER_ACCOUNT_BUNDLE_PATH: writeAccountAdoptionBundle(productionBundle),
        OPENSTEER_CREDENTIAL_KEY_PATH: "/keys/credentials.key",
        OPENSTEER_FILES_SERVICE_URL: "http://files:4315",
        OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
        OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
        OPENSTEER_MODE: "production",
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
        OPENSTEER_DEPLOYMENT_KIND: "team",
        OPENSTEER_FILES_SERVICE_URL: "http://files:4315",
        OPENSTEER_MODE: "production",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
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
        OPENSTEER_NODE_EXECUTABLE: "relative-node",
      }),
    ).toThrow(/absolute path/u);
  });

  it("requires every production Runner to declare its Deployment axes", () => {
    expect(() =>
      parseRunnerConfig({
        OPENSTEER_HOST_URL: "https://host.example",
        OPENSTEER_MODE: "production",
      }),
    ).toThrow(/requires OPENSTEER_DEPLOYMENT_KIND/u);
  });

  it("allows production plaintext only on loopback", () => {
    const personal = parseRunnerConfig({
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
      OPENSTEER_MODE: "production",
    });
    expect(personal.deploymentShape).toEqual({
      kind: "personal" as const,
    });

    expect(
      parseRunnerConfig({
        OPENSTEER_DEPLOYMENT_KIND: "personal",
        OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
        OPENSTEER_MODE: "production",
      }).hostUrl,
    ).toEqual(new URL("http://127.0.0.1:4310"));
    expect(() =>
      parseRunnerConfig({
        OPENSTEER_DEPLOYMENT_KIND: "personal",
        OPENSTEER_HOST_URL: "https://personal.example",
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
    // no browser bridge or skills.
    const config = parseRunnerConfig({
      OPENSTEER_DEPLOYMENT_KIND: "personal",
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
    expect(config.browserBridge).toBeUndefined();
  });

  it("allows a browser relay without execution", () => {
    const config = parseRunnerConfig({
      OPENSTEER_HOST_URL: "https://host.example",
      OPENSTEER_RUNNER_KIND: "local",
      OPENSTEER_RUNNER_MODULES: "browser",
    });
    expect(config.modules).toEqual(["browser"]);
  });

  it("takes the computer use bridge as a loopback pair or not at all", () => {
    const base = {
      OPENSTEER_HOST_URL: "https://host.example",
      OPENSTEER_RUNNER_KIND: "local",
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
          OPENSTEER_RUNNER_MODULES: modules,
        }),
      ).toThrow(/OPENSTEER_RUNNER_MODULES|expected string to have/u);
    }
  });

  it("rejects Runner origins that cannot carry Host capability traffic", () => {
    expect(() =>
      parseRunnerConfig({
        OPENSTEER_DEPLOYMENT_KIND: "personal",
        OPENSTEER_HOST_URL: "https://host.example/path?query=true",
      }),
    ).toThrow(/HTTP\(S\) origin/u);
  });

  it("accepts self-host production axes with the private HTTPS gateway origin", () => {
    const config = parseHostConfig({
      ...hostEnvironment,
      OPENSTEER_BIND_ADDRESS: "0.0.0.0",
      OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      OPENSTEER_CREDENTIAL_KEY_PATH: "/run/secrets/credential.key",
      OPENSTEER_DEPLOYMENT_KIND: "team",
      OPENSTEER_HOST_PRIVATE_KEY_PATH: "/var/lib/opensteer/keys/host-private.pem",
      OPENSTEER_HOST_PUBLIC_KEY_PATH: "/var/lib/opensteer-public/host-public.pem",
      OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
      OPENSTEER_MODE: "production",
      OPENSTEER_RUNTIME_ORIGIN: "https://gateway:8443",
    });

    expect(config.runtimeOrigin).toEqual(new URL("https://gateway:8443"));
    expect(config.deploymentShape).toEqual({
      kind: "team" as const,
    });
  });

  it("accepts exactly the reachable deployment kind and exposure combinations", () => {
    const personal = parseHostConfig({
      ...localHostEnvironment,
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: token,
    });
    expect(personal.deploymentShape).toEqual({
      kind: "personal",
    });
    expect(personal.exposure).toBe("loopback");

    const server = parseHostConfig({
      ...hostEnvironment,
      OPENSTEER_BIND_ADDRESS: "0.0.0.0",
      OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      OPENSTEER_DEPLOYMENT_KIND: "team",
      OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
    });
    expect(server.deploymentShape).toEqual({
      kind: "team",
    });
    expect(server.exposure).toBe("networked");

    const development = parseHostConfig(localHostEnvironment);
    expect(development.deploymentShape).toEqual({ kind: "personal" });
    expect(development.exposure).toBe("loopback");

    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_BIND_ADDRESS: "0.0.0.0",
        OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
        OPENSTEER_DEPLOYMENT_KIND: "personal",
        OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: token,
        OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
      }),
    ).toThrow(/local owner claim token is allowed only for an unmanaged loopback Personal Host/u);

    const accountBundle = accountAdoptionBundle();
    expect(() =>
      parseHostConfig({
        ...networkedHostEnvironment,
        OPENSTEER_ACCOUNT_BUNDLE_PATH: writeAccountAdoptionBundle(accountBundle),
        OPENSTEER_CANONICAL_ORIGIN: accountBundle.deployment.canonicalOrigin,
        OPENSTEER_DEPLOYMENT_KIND: "personal",
      }),
    ).toThrow();
  });

  it("accepts an operator-held first-owner code only where enrollment establishes the owner", () => {
    const team = {
      ...hostEnvironment,
      OPENSTEER_BIND_ADDRESS: "0.0.0.0",
      OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
      OPENSTEER_DEPLOYMENT_KIND: "team",
    };
    const expected = { lifetimeSeconds: 24 * 60 * 60, tokenDigest: digestSecret(token) };
    expect(
      parseHostConfig({ ...team, OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: token }).identity
        .initialOwnerEnrollment,
    ).toEqual(expected);
    expect(
      parseHostConfig({
        ...team,
        OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST: digestSecret(token),
      }).identity.initialOwnerEnrollment,
    ).toEqual(expected);
    const directory = mkdtempSync(join(tmpdir(), "opensteer-config-owner-digest-"));
    temporaryDirectories.push(directory);
    const digestFile = join(directory, "digest");
    writeFileSync(digestFile, `${digestSecret(token)}\n`, { mode: 0o600 });
    expect(
      parseHostConfig({ ...team, OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST_FILE: digestFile })
        .identity.initialOwnerEnrollment,
    ).toEqual(expected);
    expect(() =>
      parseHostConfig({
        ...team,
        OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: token,
        OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST_FILE: digestFile,
      }),
    ).toThrow(/exactly one/u);
    for (const digest of [token, digestSecret(token).toUpperCase()])
      expect(() =>
        parseHostConfig({ ...team, OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST: digest }),
      ).toThrow();
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: token,
      }),
    ).toThrow(/Personal Host uses the app-held local owner claim/u);
  });

  it("bounds team file storage only on a team Host", () => {
    const team = {
      ...hostEnvironment,
      OPENSTEER_BIND_ADDRESS: "0.0.0.0",
      OPENSTEER_CANONICAL_ORIGIN: "https://opensteer.example.com",
      OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
      OPENSTEER_DEPLOYMENT_KIND: "team",
    };
    expect(
      parseHostConfig({ ...team, OPENSTEER_TEAM_STORAGE_LIMIT_BYTES: "1073741824" })
        .teamStorageLimitBytes,
    ).toBe(1_073_741_824);
    expect(parseHostConfig(team).teamStorageLimitBytes).toBeUndefined();
    for (const limit of ["0", "-1", "1.5", "lots"])
      expect(() =>
        parseHostConfig({ ...team, OPENSTEER_TEAM_STORAGE_LIMIT_BYTES: limit }),
      ).toThrow();
    expect(() =>
      parseHostConfig({ ...localHostEnvironment, OPENSTEER_TEAM_STORAGE_LIMIT_BYTES: "1024" }),
    ).toThrow(/only to a team Host/u);
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

function accountAdoptionBundle(
  input: {
    readonly canonicalOrigin?: string;
    readonly controlApiOrigin?: string;
  } = {},
) {
  const canonicalOrigin = input.canonicalOrigin ?? "https://deployment.connect.opensteer.test";
  const controlApiOrigin = input.controlApiOrigin ?? "https://accounts.opensteer.test";
  return HostAccountAdoptionBundleSchema.parse({
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

function writeAccountAdoptionBundle(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-config-account-bundle-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "account-bundle.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return path;
}

it.each([undefined, "0", "1", "false", "true"])(
  "validates the default-off passkey flag %s",
  (value) => {
    expect(parseHostConfig({ ...localHostEnvironment, OPENSTEER_PASSKEYS: value }).passkeys).toBe(
      value === "1" || value === "true",
    );
  },
);
it("rejects a malformed passkey flag", () => {
  expect(() => parseHostConfig({ ...localHostEnvironment, OPENSTEER_PASSKEYS: "enabled" })).toThrow(
    "OPENSTEER_PASSKEYS",
  );
});

describe("networked Personal Home", () => {
  const setupCode = "home-setup-code".padEnd(40, "x");
  const home = {
    OPENSTEER_AUTH_SECRET: "identity-secret-that-is-at-least-thirty-two-bytes",
    OPENSTEER_DATABASE_URL: "postgres://localhost/opensteer",
    OPENSTEER_DEPLOYMENT_KIND: "personal",
    OPENSTEER_BIND_ADDRESS: "127.0.0.1",
    OPENSTEER_CANONICAL_ORIGIN: "https://home.example.com",
    OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
    OPENSTEER_AGENT_HOME: "/srv/opensteer/agent-home",
    OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: setupCode,
  } as const;
  const production = {
    ...home,
    OPENSTEER_MODE: "production",
    OPENSTEER_HOST_PRIVATE_KEY_PATH: "/keys/host.key",
    OPENSTEER_HOST_PUBLIC_KEY_PATH: "/keys/host.pub",
    OPENSTEER_HOST_RELEASE_VERSION: "1.2.3",
    OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: "/release/web",
    OPENSTEER_WEB_DISTRIBUTION_MANIFEST: "/release/web/opensteer-web.json",
  } as const;

  it("accepts a Home behind an HTTPS reverse proxy with an operator setup code", () => {
    const config = parseHostConfig(production);
    expect(config.deploymentShape).toEqual({ kind: "personal" });
    expect(config.exposure).toBe("networked");
    expect(config.identity.initialOwnerEnrollment).toEqual({
      lifetimeSeconds: 24 * 60 * 60,
      tokenDigest: digestSecret(setupCode),
    });
    expect(config.identity.localOwnerClaimToken).toBeUndefined();
    expect(config.identity.localPasswordEnabled).toBe(true);
    expect(config.identity.nativeOAuth?.clients).toEqual(opensteerHostNativeOAuthClients);
    expect(config.webDistribution?.directory).toBe("/release/web");
    expect(config.personal?.agentHome).toBe("/srv/opensteer/agent-home");
    expect(hostTrustedProxy(config)).toBe("loopback");
    expect(parseHostConfig({ ...home, OPENSTEER_BIND_ADDRESS: "0.0.0.0" }).exposure).toBe(
      "networked",
    );
  });

  it("takes the setup code as a digest or a file, as a team does", () => {
    const { OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: _code, ...withoutCode } = home;
    const expected = { lifetimeSeconds: 24 * 60 * 60, tokenDigest: digestSecret(setupCode) };
    expect(
      parseHostConfig({
        ...withoutCode,
        OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST: digestSecret(setupCode),
      }).identity.initialOwnerEnrollment,
    ).toEqual(expected);
    const directory = mkdtempSync(join(tmpdir(), "opensteer-config-home-"));
    temporaryDirectories.push(directory);
    const codeFile = join(directory, "setup-code");
    writeFileSync(codeFile, `${setupCode}\n`, { mode: 0o600 });
    expect(
      parseHostConfig({ ...withoutCode, OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_FILE: codeFile })
        .identity.initialOwnerEnrollment,
    ).toEqual(expected);
    // A claimed Home may drop its spent code; startup refuses an unclaimed one without it.
    expect(parseHostConfig(withoutCode).identity.initialOwnerEnrollment).toBeUndefined();
  });

  it("refuses each input a networked Home must not have or cannot run without", () => {
    expect(() =>
      parseHostConfig({ ...production, OPENSTEER_CANONICAL_ORIGIN: "http://home.example.com" }),
    ).toThrow(/OPENSTEER_CANONICAL_ORIGIN must use HTTPS in production/u);
    expect(() =>
      parseHostConfig({
        ...production,
        OPENSTEER_CANONICAL_ORIGIN: "https://home.example.com",
        OPENSTEER_RUNTIME_ORIGIN: "http://home.example.com",
      }),
    ).toThrow(/OPENSTEER_RUNTIME_ORIGIN must use HTTPS in production/u);
    expect(() => parseHostConfig({ ...home, OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: token })).toThrow(
      /allowed only for an unmanaged loopback Personal Host/u,
    );
    expect(() => parseHostConfig({ ...home, OPENSTEER_SIGNUP_POLICY: "open" })).toThrow(
      /cannot allow open signup/u,
    );
    // A Mac's loopback Home has one owner too: nobody signs up to it.
    expect(() =>
      parseHostConfig({ ...localHostEnvironment, OPENSTEER_SIGNUP_POLICY: "open" }),
    ).toThrow(/cannot allow open signup/u);
    expect(() => parseHostConfig({ ...home, OPENSTEER_LOCAL_PASSWORD_ENABLED: "false" })).toThrow(
      /requires password sign-in to be claimed/u,
    );
    // Nothing would wire an OIDC provider for a Home on its own server: no way to claim it.
    expect(() =>
      parseHostConfig({
        ...home,
        OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
        OPENSTEER_OIDC_CONFIG_PATH: "/srv/opensteer/oidc.json",
      }),
    ).toThrow(/requires password sign-in to be claimed/u);
    expect(() =>
      parseHostConfig({ ...home, OPENSTEER_OIDC_CONFIG_PATH: "/srv/opensteer/oidc.json" }),
    ).toThrow(/does not support OIDC sign-in/u);
    // Development mode too: the native apps refuse a Home at plain HTTP.
    expect(() =>
      parseHostConfig({ ...home, OPENSTEER_CANONICAL_ORIGIN: "http://home.example.com" }),
    ).toThrow(/requires an https canonical origin/u);
    // Production takes these secrets from files only, never the process environment.
    expect(() =>
      parseHostConfig({
        ...production,
        OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN: "m".repeat(43),
      }),
    ).toThrow(/OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN must be delivered as .*_FILE/u);
    expect(() =>
      parseHostConfig({ ...production, OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET: "s".repeat(47) }),
    ).toThrow(/OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET must be delivered as .*_FILE/u);
    expect(() =>
      parseHostConfig({
        ...home,
        OPENSTEER_BIND_ADDRESS: "0.0.0.0",
        OPENSTEER_CANONICAL_ORIGIN: "http://localhost:4310",
      }),
    ).toThrow(/requires its public canonical origin/u);
    const {
      OPENSTEER_HOST_RELEASE_VERSION: _version,
      OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: _directory,
      OPENSTEER_WEB_DISTRIBUTION_MANIFEST: _manifest,
      ...withoutWeb
    } = production;
    let missingDistribution: unknown;
    try {
      parseHostConfig(withoutWeb);
    } catch (error) {
      missingDistribution = error;
    }
    expect(missingDistribution).toMatchObject({
      code: "packaged-personal-web-distribution-required",
    });
  });

  it("enrolls its colocated Main Runner from an operator token, only on a networked Home", () => {
    const main = "main-runner-enrollment".padEnd(48, "m");
    expect(
      parseHostConfig({ ...home, OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN: main })
        .initialMainRunnerEnrollmentToken,
    ).toBe(main);
    const directory = mkdtempSync(join(tmpdir(), "opensteer-config-main-"));
    temporaryDirectories.push(directory);
    const mainFile = join(directory, "main");
    writeFileSync(mainFile, `${main}\n`, { mode: 0o600 });
    expect(
      parseHostConfig({ ...home, OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN_FILE: mainFile })
        .initialMainRunnerEnrollmentToken,
    ).toBe(main);
    expect(() =>
      parseHostConfig({ ...home, OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN: "short" }),
    ).toThrow();
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_DEPLOYMENT_KIND: "personal",
        OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN: main,
      }),
    ).toThrow(/only for a networked Personal Host/u);
    expect(() =>
      parseHostConfig({
        ...networkedHostEnvironment,
        OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN: main,
      }),
    ).toThrow(/only for a networked Personal Host/u);
  });

  it("lets the operator turn native OAuth off, and links a Personal Account", () => {
    expect(
      parseHostConfig({ ...home, OPENSTEER_NATIVE_OAUTH_ENABLED: "false" }).identity.nativeOAuth,
    ).toBeUndefined();
    expect(
      parseHostConfig({
        ...home,
        OPENSTEER_PERSONAL_ACCOUNT_ISSUER: "https://accounts.example.com",
      }).personalAccountIssuer,
    ).toEqual(new URL("https://accounts.example.com"));
    expect(
      parseHostConfig({
        ...localHostEnvironment,
        OPENSTEER_DEPLOYMENT_KIND: "personal",
        OPENSTEER_PERSONAL_ACCOUNT_ISSUER: "https://accounts.example.com",
      }).personalAccountIssuer,
    ).toEqual(new URL("https://accounts.example.com"));
    expect(() =>
      parseHostConfig({
        ...networkedHostEnvironment,
        OPENSTEER_PERSONAL_ACCOUNT_ISSUER: "https://accounts.example.com",
      }),
    ).toThrow(/only for an unmanaged Personal Host/u);
  });

  it("boots a managed Home that is claimed and signed in to by its Account alone", () => {
    const managed = {
      ...home,
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
      OPENSTEER_MANAGED_HOME_ID: "cc_0192f4a1-1111-4000-8000-000000000001",
      OPENSTEER_MANAGED_HOME_GENERATION: "2",
      OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN: "https://accounts.example.com",
      OPENSTEER_MANAGED_HOME_OIDC_CLIENT_ID: "occ_0192f4a1-1111-4000-8000-000000000001",
      OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET: `ocs_${"s".repeat(43)}`,
    } as const;
    const config = parseHostConfig(managed);
    expect(config.managedHome).toEqual({
      accountOrigin: new URL("https://accounts.example.com"),
      cloudComputerId: "cc_0192f4a1-1111-4000-8000-000000000001",
      generation: 2,
      oidc: {
        clientId: "occ_0192f4a1-1111-4000-8000-000000000001",
        clientSecret: `ocs_${"s".repeat(43)}`,
      },
    });
    // It links to the Account that booted it, for push and the hosted OAuth broker.
    expect(config.personalAccountIssuer).toEqual(new URL("https://accounts.example.com"));
    const directory = mkdtempSync(join(tmpdir(), "opensteer-config-managed-"));
    temporaryDirectories.push(directory);
    const secretFile = join(directory, "oidc");
    writeFileSync(secretFile, `ocs_${"s".repeat(43)}\n`, { mode: 0o600 });
    const { OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET: _secret, ...withoutSecret } = managed;
    expect(
      parseHostConfig({
        ...withoutSecret,
        OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET_FILE: secretFile,
      }).managedHome?.oidc.clientSecret,
    ).toBe(`ocs_${"s".repeat(43)}`);
    // A bring-your-own Home's empty secret file is no managed Home at all.
    const empty = join(directory, "empty");
    writeFileSync(empty, "", { mode: 0o600 });
    expect(
      parseHostConfig({ ...home, OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET_FILE: empty })
        .managedHome,
    ).toBeUndefined();

    expect(() => parseHostConfig({ ...withoutSecret })).toThrow(/must be configured together/u);
    expect(() => parseHostConfig({ ...managed, OPENSTEER_LOCAL_PASSWORD_ENABLED: "true" })).toThrow(
      /Opensteer Account only/u,
    );
    expect(() =>
      parseHostConfig({
        ...managed,
        OPENSTEER_PERSONAL_ACCOUNT_ISSUER: "https://other-accounts.example.com",
      }),
    ).toThrow(/Account it was booted by/u);
    expect(() =>
      parseHostConfig({
        ...localHostEnvironment,
        ...managed,
        OPENSTEER_BIND_ADDRESS: "127.0.0.1",
        OPENSTEER_CANONICAL_ORIGIN: "http://127.0.0.1:4310",
        OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: token,
        OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: "",
      }),
    ).toThrow(/networked Personal Host/u);
  });

  it("believes forwarding headers from one configured proxy, defaulting by exposure", () => {
    expect(hostTrustedProxy(parseHostConfig({ ...home, OPENSTEER_TRUSTED_PROXY: "none" }))).toBe(
      "none",
    );
    expect(
      hostTrustedProxy(
        parseHostConfig({ ...home, OPENSTEER_TRUSTED_PROXY: "loopback-cloudflared" }),
      ),
    ).toBe("loopback-cloudflared");
    expect(() => parseHostConfig({ ...home, OPENSTEER_TRUSTED_PROXY: "anyone" })).toThrow();
    expect(
      hostTrustedProxy(
        parseHostConfig({ ...localHostEnvironment, OPENSTEER_DEPLOYMENT_KIND: "personal" }),
      ),
    ).toBe("loopback-cloudflared");
  });

  it("keeps the colocated Main Runner on loopback and lets other computers use HTTPS", () => {
    const runner = {
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_MODE: "production",
      OPENSTEER_NODE_EXECUTABLE: "/usr/bin/node",
    } as const;
    expect(
      parseRunnerConfig({ ...runner, OPENSTEER_HOST_URL: "http://127.0.0.1:4310" }).hostUrl,
    ).toEqual(new URL("http://127.0.0.1:4310"));
    expect(() =>
      parseRunnerConfig({ ...runner, OPENSTEER_HOST_URL: "https://home.example.com" }),
    ).toThrow(/requires a loopback OPENSTEER_HOST_URL/u);
    expect(
      parseRunnerConfig({
        ...runner,
        OPENSTEER_HOST_URL: "https://home.example.com",
        OPENSTEER_RUNNER_KIND: "local",
        OPENSTEER_RUNNER_MODULES: "browser",
      }).hostUrl,
    ).toEqual(new URL("https://home.example.com"));
  });
});
