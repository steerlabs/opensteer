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
  OPENSTEER_MANAGED_DEPLOYMENT_DOMAIN: "connect.opensteer.com",
  OPENSTEER_CONNECT_DOMAIN: "connect-route.opensteer.com",
  OPENSTEER_CONNECT_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  OPENSTEER_CONNECT_CLOUDFLARE_API_TOKEN: "cloudflare-api-token-secret",
  OPENSTEER_CONNECT_CLOUDFLARE_ZONE_ID: "b".repeat(32),
  OPENSTEER_CONNECT_CLOUDFLARE_WORKERS_ROUTE_BYPASS: "on",
  OPENSTEER_CONNECT_CREDENTIAL_DERIVATION_SECRET: "d".repeat(32),
} satisfies NodeJS.ProcessEnv;

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

  it("enables Cloud only with its complete independent configuration", () => {
    expect(loadControlPlaneConfig(validEnvironment).cloud).toBeUndefined();
    const operationKey = Buffer.alloc(32, 9).toString("base64url");
    expect(() =>
      loadControlPlaneConfig({ ...validEnvironment, OPENSTEER_CLOUD_OPERATION_KEY: operationKey }),
    ).toThrow(/both/u);
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_CLOUD_TEMPLATE_PATH: "/run/cloud.json",
      }),
    ).toThrow(/both/u);
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_CLOUD_OPERATION_KEY: validEnvironment.OPENSTEER_ADOPTION_OPERATION_KEY,
        OPENSTEER_CLOUD_TEMPLATE_PATH: "/run/cloud.json",
      }),
    ).toThrow(/own key/u);
    expect(
      loadControlPlaneConfig({
        ...validEnvironment,
        OPENSTEER_CLOUD_OPERATION_KEY: operationKey,
        OPENSTEER_CLOUD_TEMPLATE_PATH: "/run/cloud.json",
      }).cloud,
    ).toEqual({ operationKey, templatePath: "/run/cloud.json" });
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

  it("keeps the Connect route domain independent from managed Deployment origins", () => {
    const config = loadControlPlaneConfig(validEnvironment);
    expect(config.managedDeploymentDomain).toBe("connect.opensteer.com");
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

  it("registers only completely configured hosted OAuth providers", () => {
    const broker = {
      OPENSTEER_HOSTED_OAUTH_STATE_KEY: Buffer.alloc(32, 11).toString("base64url"),
      OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY: "E".repeat(80),
    } satisfies NodeJS.ProcessEnv;
    expect(loadControlPlaneConfig({ ...validEnvironment, ...broker }).hostedOAuth).toMatchObject({
      applications: [],
    });
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...broker,
        OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_ID: "discord-client",
      }),
    ).toThrow(/Hosted Discord OAuth requires client, secret, and revision/u);
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...broker,
        OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_ID: "github-client",
      }),
    ).toThrow(/Hosted GitHub OAuth requires client, secret, revision/u);
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...broker,
        OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_ID: "Iv23lip88ORd2qUNRuId",
        OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
        OPENSTEER_HOSTED_OAUTH_GITHUB_REVISION: "1",
      }),
    ).toThrow(/installation URL/u);
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...broker,
        OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_ID: "slack-client",
      }),
    ).toThrow(/Hosted Slack OAuth requires client, secret, and revision/u);
    expect(() =>
      loadControlPlaneConfig({
        ...validEnvironment,
        ...broker,
        OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_ID: "Iv23lip88ORd2qUNRuId",
        OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
        OPENSTEER_HOSTED_OAUTH_GITHUB_INSTALLATION_URL:
          "https://github.com/apps/opensteer/installations/new",
        OPENSTEER_HOSTED_OAUTH_GITHUB_REVISION: "1",
        OPENSTEER_HOSTED_OAUTH_MICROSOFT_CLIENT_ID: "microsoft-client",
        OPENSTEER_HOSTED_OAUTH_MICROSOFT_CLIENT_SECRET: "microsoft-secret",
      }),
    ).toThrow(/Hosted Microsoft OAuth requires client, secret, and revision/u);
    expect(
      loadControlPlaneConfig({
        ...validEnvironment,
        ...broker,
        OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_ID: "discord-client",
        OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_SECRET: "discord-secret",
        OPENSTEER_HOSTED_OAUTH_DISCORD_REVISION: "1",
        OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_ID: "Iv23lip88ORd2qUNRuId",
        OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
        OPENSTEER_HOSTED_OAUTH_GITHUB_INSTALLATION_URL:
          "https://github.com/apps/opensteer/installations/new",
        OPENSTEER_HOSTED_OAUTH_GITHUB_REVISION: "1",
        OPENSTEER_HOSTED_OAUTH_MICROSOFT_CLIENT_ID: "microsoft-client",
        OPENSTEER_HOSTED_OAUTH_MICROSOFT_CLIENT_SECRET: "microsoft-secret",
        OPENSTEER_HOSTED_OAUTH_MICROSOFT_REVISION: "1",
        OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_ID: "slack-client",
        OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_SECRET: "slack-secret",
        OPENSTEER_HOSTED_OAUTH_SLACK_REVISION: "1",
      }).hostedOAuth?.applications,
    ).toEqual([
      {
        clientId: "discord-client",
        clientSecret: "discord-secret",
        provider: "discord",
        revision: 1,
      },
      {
        clientId: "Iv23lip88ORd2qUNRuId",
        clientSecret: "github-secret",
        installationUrl: "https://github.com/apps/opensteer/installations/new",
        provider: "github",
        revision: 1,
      },
      {
        clientId: "microsoft-client",
        clientSecret: "microsoft-secret",
        provider: "microsoft",
        revision: 1,
      },
      {
        clientId: "slack-client",
        clientSecret: "slack-secret",
        provider: "slack",
        revision: 1,
      },
    ]);
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

  it("requires one normalized managed Deployment DNS domain", () => {
    for (const value of [
      "https://connect.opensteer.com",
      "connect.opensteer.com/path",
      "connect.opensteer.com:443",
      "Connect.Opensteer.com",
    ]) {
      expect(() =>
        loadControlPlaneConfig({
          ...validEnvironment,
          OPENSTEER_MANAGED_DEPLOYMENT_DOMAIN: value,
        }),
      ).toThrow(/domain/iu);
    }
  });
});
