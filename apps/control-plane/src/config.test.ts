import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerProviderFixture } from "./auth/hosted-oauth-broker.test-support.js";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { opensteerAccountNativeOAuthClients } from "@opensteer/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertNativeOAuthConfig,
  loadControlPlaneConfig,
  loadControlPlaneMigrationConfig,
} from "./config.js";

const validEnvironment = {
  NODE_ENV: "production",
  OPENSTEER_CONTROL_PLANE_DATABASE_URL: "postgresql://db.example/opensteer",
  OPENSTEER_CONTROL_PLANE_PUBLIC_URL: "https://accounts.opensteer.com",
  OPENSTEER_CONTROL_PLANE_AUTH_SECRET: "a".repeat(32),
  OPENSTEER_ADOPTION_OPERATION_KEY: "A".repeat(43),
  OPENSTEER_PERSONAL_ACCOUNT_LINK_OPERATION_KEY: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
  OPENSTEER_GOOGLE_CLIENT_ID: "google-client",
  OPENSTEER_GOOGLE_CLIENT_SECRET: "google-secret",
  OPENSTEER_PORTAL_ORIGIN: "https://app.opensteer.com",
  OPENSTEER_CONNECT_DOMAIN: "connect-route.opensteer.com",
  OPENSTEER_CONNECT_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  OPENSTEER_CONNECT_CLOUDFLARE_API_TOKEN: "cloudflare-api-token-secret",
  OPENSTEER_CONNECT_CLOUDFLARE_ZONE_ID: "b".repeat(32),
  OPENSTEER_CONNECT_CLOUDFLARE_WORKERS_ROUTE_BYPASS: "on",
  OPENSTEER_CONNECT_CREDENTIAL_DERIVATION_SECRET: "d".repeat(32),
} satisfies NodeJS.ProcessEnv;

it("loads optional managed Home settings from the Account runtime directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "managed-home-config-"));
  const environment = { ...validEnvironment, OPENSTEER_MANAGED_HOME_CONFIG_DIRECTORY: directory };
  try {
    expect(loadControlPlaneConfig(environment).cloudComputers).toBeUndefined();
    const files = {
      OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL: "home@example.iam.gserviceaccount.com",
      OPENSTEER_CLOUD_COMPUTER_DOMAIN: "homes.example.com",
      OPENSTEER_CLOUD_COMPUTER_REGION: "us-central1-a",
      OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE: "e2-standard-4",
      OPENSTEER_CLOUD_COMPUTER_RELEASE_JSON: JSON.stringify({
        version: "1.0.0",
        installerUrl: "https://releases.example.com/install",
        installerSha256: "a".repeat(64),
        images: Object.fromEntries(
          ["host", "runner", "browser-runtime", "browser-egress", "channel-runtime", "gateway"].map(
            (name) => [name, `registry.example.com/${name}@sha256:${"b".repeat(64)}`],
          ),
        ),
      }),
      OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL: "https://releases.example.com/managed.json",
      OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY: "sk_test_123456789",
      OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET: "whsec_123456789",
      OPENSTEER_CLOUD_COMPUTER_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_personal",
      OPENSTEER_CLOUD_COMPUTER_STRIPE_PRICE_ID: "price_personal",
      OPENSTEER_CLOUD_COMPUTER_PLAN_NAME: "Personal",
      OPENSTEER_CLOUD_COMPUTER_CURRENCY: "usd",
      OPENSTEER_CLOUD_COMPUTER_PRICE_MINOR: "2900",
    };
    for (const [name, value] of Object.entries(files)) {
      writeFileSync(join(directory, name), value + "\n", { mode: 0o600 });
    }
    const config = loadControlPlaneConfig({
      ...environment,
      OPENSTEER_CLOUD_COMPUTER_REGION: "europe-west3-a",
    });
    expect(config.cloudComputers).toMatchObject({
      stripeKey: files.OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY,
      stripeWebhookSecret: files.OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET,
      releaseManifestUrl: files.OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL,
      region: "europe-west3-a",
      notReadyAfterMinutes: 30,
    });
    expect(config.cloudComputers?.heartbeatUrl).toBeUndefined();
    const watched = loadControlPlaneConfig({
      ...environment,
      OPENSTEER_CLOUD_COMPUTER_NOT_READY_MINUTES: "45",
      OPENSTEER_CLOUD_COMPUTER_HEARTBEAT_URL: "https://hc.example.com/ping/billing",
    }).cloudComputers;
    expect(watched?.notReadyAfterMinutes).toBe(45);
    expect(watched?.heartbeatUrl?.href).toBe("https://hc.example.com/ping/billing");
    for (const [name, value] of [
      ["OPENSTEER_CLOUD_COMPUTER_NOT_READY_MINUTES", "2"],
      // Below the provisioner's own readiness deadline and a normal first set-up's margin.
      ["OPENSTEER_CLOUD_COMPUTER_NOT_READY_MINUTES", "14"],
      ["OPENSTEER_CLOUD_COMPUTER_HEARTBEAT_URL", "http://hc.example.com/ping/billing"],
    ] as const)
      expect(() => loadControlPlaneConfig({ ...environment, [name]: value })).toThrow(
        `Missing or invalid ${name}`,
      );
    expect(() =>
      loadControlPlaneConfig({
        ...environment,
        OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL:
          "https://user:password@releases.example.com/feed",
      }),
    ).toThrow("Missing or invalid OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL");
    // The synthetic purchase's sign-in opens only beside a test-mode Stripe key (U6).
    const synthetic = {
      OPENSTEER_SYNTHETIC_SIGN_IN_EMAIL: "synthetic@example.com",
      OPENSTEER_SYNTHETIC_SIGN_IN_PASSWORD: "s".repeat(24),
    };
    expect(loadControlPlaneConfig({ ...environment, ...synthetic }).syntheticSignIn).toBeDefined();
    for (const key of ["sk_live_123456789", "rk_live_123456789"])
      expect(() =>
        loadControlPlaneConfig({
          ...environment,
          ...synthetic,
          OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY: key,
        }),
      ).toThrow("refused beside a live Stripe key");
  } finally {
    rmSync(directory, { recursive: true });
  }
});

let apnsPrivateKey: string;
let fcmPrivateKey: string;
let weakRsaPrivateKey: string;
let wrongCurvePrivateKey: string;

function privateKeyPem(key: KeyObject): string {
  return key.export({ format: "pem", type: "pkcs8" }).toString();
}

describe("control-plane configuration", () => {
  beforeAll(() => {
    apnsPrivateKey = privateKeyPem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
    wrongCurvePrivateKey = privateKeyPem(
      generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey,
    );
    fcmPrivateKey = privateKeyPem(generateKeyPairSync("rsa", { modulusLength: 2_048 }).privateKey);
    weakRsaPrivateKey = privateKeyPem(
      generateKeyPairSync("rsa", { modulusLength: 1_024 }).privateKey,
    );
  });

  it("loads a migration-only database configuration", () => {
    expect(
      loadControlPlaneMigrationConfig({
        OPENSTEER_CONTROL_PLANE_DATABASE_URL: "postgresql://db.example/opensteer",
      }),
    ).toEqual({ databaseUrl: "postgresql://db.example/opensteer" });
    expect(() =>
      loadControlPlaneMigrationConfig({
        OPENSTEER_CONTROL_PLANE_DATABASE_URL: "https://db.example/opensteer",
      }),
    ).toThrow(/PostgreSQL/u);
  });

  it("gives the synthetic purchase its own sign-in, never the App Review account (S7)", () => {
    expect(loadControlPlaneConfig(validEnvironment).syntheticSignIn).toBeUndefined();
    const synthetic = {
      OPENSTEER_SYNTHETIC_SIGN_IN_EMAIL: "Synthetic@Example.com",
      OPENSTEER_SYNTHETIC_SIGN_IN_PASSWORD: "s".repeat(24),
    };
    expect(loadControlPlaneConfig({ ...validEnvironment, ...synthetic }).syntheticSignIn).toEqual({
      email: "synthetic@example.com",
      password: "s".repeat(24),
    });
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_SYNTHETIC_SIGN_IN_EMAIL: "synthetic@example.com",
      }),
    ).toThrow("email and password together");
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...synthetic,
        OPENSTEER_APP_REVIEW_EMAIL: "synthetic@example.com",
        OPENSTEER_APP_REVIEW_PASSWORD: "r".repeat(24),
      }),
    ).toThrow("must not be the App Review account");
  });

  it("enables App Review sign-in only with a valid email and a long password together", () => {
    const review = {
      OPENSTEER_APP_REVIEW_EMAIL: " APPREVIEW@OPENSTEER.COM ",
      OPENSTEER_APP_REVIEW_PASSWORD: "r".repeat(24),
    };
    expect(loadControlPlaneConfig(validEnvironment).appReview).toBeUndefined();
    expect(
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_APP_REVIEW_EMAIL: review.OPENSTEER_APP_REVIEW_EMAIL,
      }).appReview,
    ).toBeUndefined();
    expect(
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_APP_REVIEW_PASSWORD: review.OPENSTEER_APP_REVIEW_PASSWORD,
      }).appReview,
    ).toBeUndefined();
    expect(loadControlPlaneConfig({ ...validEnvironment, ...review }).appReview).toEqual({
      email: "appreview@opensteer.com",
      password: review.OPENSTEER_APP_REVIEW_PASSWORD,
    });
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...review,
        OPENSTEER_APP_REVIEW_EMAIL: "invalid",
      }),
    ).toThrow();
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...review,
        OPENSTEER_APP_REVIEW_PASSWORD: "r".repeat(23),
      }),
    ).toThrow();
  });

  it("requires server-side Cloudflare credentials and a separate derivation secret", () => {
    const missingToken: NodeJS.ProcessEnv = { ...validEnvironment };
    delete missingToken.OPENSTEER_CONNECT_CLOUDFLARE_API_TOKEN;
    expect(() => loadControlPlaneConfig(missingToken)).toThrow();

    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_CONNECT_CREDENTIAL_DERIVATION_SECRET: "too-short",
      }),
    ).toThrow();
  });

  it("keeps the Connect route domain independent from the portal origin", () => {
    const config = loadControlPlaneConfig(validEnvironment);
    expect(config.portalOrigin.origin).toBe("https://app.opensteer.com");
    expect(config.connectDomain).toBe("connect-route.opensteer.com");
    expect(config.connectCloudflare.workersRouteBypass).toBe(true);

    const missingDomain: NodeJS.ProcessEnv = { ...validEnvironment };
    delete missingDomain.OPENSTEER_CONNECT_DOMAIN;
    expect(() => loadControlPlaneConfig(missingDomain)).toThrow();
  });

  it("requires an independent Personal Account-link operation key", () => {
    const missingKey: NodeJS.ProcessEnv = { ...validEnvironment };
    delete missingKey.OPENSTEER_PERSONAL_ACCOUNT_LINK_OPERATION_KEY;
    expect(() => loadControlPlaneConfig(missingKey)).toThrow();
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_PERSONAL_ACCOUNT_LINK_OPERATION_KEY:
          validEnvironment.OPENSTEER_ADOPTION_OPERATION_KEY,
      }),
    ).toThrow(/different/u);
  });

  it("requires an HTTPS production origin", () => {
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_CONTROL_PLANE_PUBLIC_URL: "http://127.0.0.1:4142",
      }),
    ).toThrow(/HTTPS/u);
  });

  it("allows loopback only outside production", () => {
    const config = loadControlPlaneConfig({
      ...validEnvironment,
      NODE_ENV: "development",
      OPENSTEER_CONTROL_PLANE_PUBLIC_URL: "http://127.0.0.1:4142",
    });
    expect(config.publicOrigin.origin).toBe("http://127.0.0.1:4142");
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        NODE_ENV: "development",
        OPENSTEER_CONTROL_PLANE_PUBLIC_URL: "http://accounts.internal:4142",
      }),
    ).toThrow(/loopback/u);
  });

  it("uses the closed Account registry and rejects direct runtime drift", () => {
    const config = loadControlPlaneConfig({
      ...validEnvironment,
      OPENSTEER_NATIVE_OAUTH_CLIENT_ID: "operator-client",
      OPENSTEER_NATIVE_OAUTH_REDIRECT_URIS: "com.operator.client:/callback",
    });
    expect(config.nativeOAuthClients).toEqual(opensteerAccountNativeOAuthClients);
    expect(() => assertNativeOAuthConfig({ ...config, nativeOAuthClients: [] })).toThrow();
    expect(() =>
      assertNativeOAuthConfig({
        ...config,
        nativeOAuthClients: [
          { ...opensteerAccountNativeOAuthClients[0]!, clientId: "operator-client" },
        ],
      }),
    ).toThrow(/signed first-party Account registry/u);
  });

  it("loads and validates the broker's provider registry without exposing configuration in errors", () => {
    const broker = {
      OPENSTEER_HOSTED_OAUTH_STATE_KEY: Buffer.alloc(32, 11).toString("base64url"),
      OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY: "E".repeat(80),
    } satisfies NodeJS.ProcessEnv;
    expect(loadControlPlaneConfig({ ...validEnvironment, ...broker }).hostedOAuth).toMatchObject({
      applications: [],
    });
    const provider = {
      ...brokerProviderFixture("google"),
      provider: "google",
      clientId: "client",
      clientSecret: "secret",
      revision: 7,
    };
    const configured = {
      ...validEnvironment,
      ...broker,
      OPENSTEER_HOSTED_OAUTH_PROVIDERS: JSON.stringify([provider]),
    };
    expect(loadControlPlaneConfig(configured).hostedOAuth?.applications).toEqual([provider]);
    expect(() =>
      loadControlPlaneConfig({ ...configured, OPENSTEER_HOSTED_OAUTH_PROVIDERS: "{" }),
    ).toThrow("must be JSON");
    expect(() =>
      loadControlPlaneConfig({
        ...configured,
        OPENSTEER_HOSTED_OAUTH_PROVIDERS: JSON.stringify([{ ...provider, clientSecret: "" }]),
      }),
    ).toThrow("registry is invalid");
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_HOSTED_OAUTH_PROVIDERS: JSON.stringify([provider]),
      }),
    ).toThrow("require attempt-context");
  });

  it("enables Sign in with Apple only when completely configured with a usable key", () => {
    const apple = {
      OPENSTEER_APPLE_SIGN_IN_CLIENT_ID: "com.opensteer.account",
      OPENSTEER_APPLE_SIGN_IN_KEY_ID: "ABCDE12345",
      OPENSTEER_APPLE_SIGN_IN_PRIVATE_KEY: apnsPrivateKey,
      OPENSTEER_APPLE_SIGN_IN_TEAM_ID: "TEAM123456",
    };
    expect(loadControlPlaneConfig(validEnvironment).appleSignIn).toBeUndefined();
    expect(loadControlPlaneConfig({ ...validEnvironment, ...apple }).appleSignIn).toEqual({
      clientId: apple.OPENSTEER_APPLE_SIGN_IN_CLIENT_ID,
      keyId: apple.OPENSTEER_APPLE_SIGN_IN_KEY_ID,
      privateKeyPem: apnsPrivateKey,
      teamId: apple.OPENSTEER_APPLE_SIGN_IN_TEAM_ID,
    });
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_APPLE_SIGN_IN_CLIENT_ID: apple.OPENSTEER_APPLE_SIGN_IN_CLIENT_ID,
      }),
    ).toThrow("Sign in with Apple requires");
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...apple,
        OPENSTEER_APPLE_SIGN_IN_PRIVATE_KEY: wrongCurvePrivateKey,
      }),
    ).toThrow("OPENSTEER_APPLE_SIGN_IN_PRIVATE_KEY");
  });

  it("enables either push provider independently with usable keys", () => {
    expect(loadControlPlaneConfig(validEnvironment).push).toBeUndefined();

    const push = {
      OPENSTEER_APNS_KEY_ID: "ABCDE12345",
      OPENSTEER_APNS_PRIVATE_KEY: apnsPrivateKey,
      OPENSTEER_APNS_TEAM_ID: "TEAM123456",
      OPENSTEER_APNS_TOPIC: "com.opensteer.mobile",
      OPENSTEER_FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: "push@example-project.iam.gserviceaccount.com",
        private_key: fcmPrivateKey,
        project_id: "example-project",
      }),
    } satisfies NodeJS.ProcessEnv;

    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_APNS_KEY_ID: push.OPENSTEER_APNS_KEY_ID,
      }),
    ).toThrow(/Push delivery requires/u);
    expect(
      loadControlPlaneConfig({
        ...validEnvironment,
        ...push,
        OPENSTEER_FCM_SERVICE_ACCOUNT_JSON: undefined,
      }).push,
    ).toMatchObject({ apns: { topic: "com.opensteer.mobile" } });
    expect(
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_FCM_SERVICE_ACCOUNT_JSON: push.OPENSTEER_FCM_SERVICE_ACCOUNT_JSON,
      }).push,
    ).toMatchObject({ fcm: { projectId: "example-project" } });
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...push,
        OPENSTEER_FCM_SERVICE_ACCOUNT_JSON: "{",
      }),
    ).toThrow(/service-account JSON document/u);

    expect(loadControlPlaneConfig({ ...validEnvironment, ...push }).push).toEqual({
      apns: {
        keyId: "ABCDE12345",
        privateKeyPem: apnsPrivateKey,
        teamId: "TEAM123456",
        topic: "com.opensteer.mobile",
      },
      fcm: {
        clientEmail: "push@example-project.iam.gserviceaccount.com",
        privateKeyPem: fcmPrivateKey,
        projectId: "example-project",
        tokenUri: "https://oauth2.googleapis.com/token",
      },
    });

    // A key that only fails when the first push is sent is a notification
    // nobody gets and nobody is told about, so every refusal below is a
    // startup error rather than a delivery-time one.
    const fabricated = `-----BEGIN PRIVATE KEY-----\n${"k".repeat(120)}\n-----END PRIVATE KEY-----\n`;
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...push,
        OPENSTEER_APNS_PRIVATE_KEY: fabricated,
      }),
    ).toThrow();
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...push,
        OPENSTEER_APNS_PRIVATE_KEY: wrongCurvePrivateKey,
      }),
    ).toThrow();
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...push,
        OPENSTEER_APNS_PRIVATE_KEY: fcmPrivateKey,
      }),
    ).toThrow();
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...push,
        OPENSTEER_FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: "push@example-project.iam.gserviceaccount.com",
          private_key: fabricated,
          project_id: "example-project",
        }),
      }),
    ).toThrow();
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...push,
        OPENSTEER_FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: "push@example-project.iam.gserviceaccount.com",
          private_key: weakRsaPrivateKey,
          project_id: "example-project",
        }),
      }),
    ).toThrow();
  });

  it("requires an explicit bare secure portal origin", () => {
    for (const value of [
      undefined,
      "https://app.opensteer.com/path",
      "https://app.opensteer.com?x=1",
      "https://user@app.opensteer.com",
      "http://app.opensteer.com",
      "http://localhost:4143",
      validEnvironment.OPENSTEER_CONTROL_PLANE_PUBLIC_URL,
    ]) {
      expect(() =>
        loadControlPlaneConfig({ ...validEnvironment, OPENSTEER_PORTAL_ORIGIN: value }),
      ).toThrow();
    }
    expect(
      loadControlPlaneConfig({
        ...validEnvironment,
        NODE_ENV: "development",
        OPENSTEER_PORTAL_ORIGIN: "http://localhost:4143",
      }).portalOrigin.origin,
    ).toBe("http://localhost:4143");
  });
});
