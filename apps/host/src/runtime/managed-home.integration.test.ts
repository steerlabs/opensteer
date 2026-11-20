import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportJWK, SignJWT } from "jose";
import { expect, it } from "vitest";
import { parseHostConfig, type HostConfig } from "@opensteer/config";
import {
  ManagedHomeClaimReceiptSchema,
  managedHomeClaimPath,
  managedHomeClaimReceiptSigningBytes,
  type ManagedHomeClaimClaims,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { apiVersionHeaders, hostKeyFingerprint } from "@opensteer/deployment-authority";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { createHostRuntime, type PersonalHostRuntime } from "./runtime.js";

const home = "https://cc-home.example.test";
const accountOrigin = "https://accounts.example.test";
const cloudComputerId = "cc_0192f4a1-1111-4000-8000-000000000001";
const generation = 3;
const setupCode = randomBytes(32).toString("base64url");
const hostCredential = `osc_${randomBytes(32).toString("base64url")}`;
const linkGeneration = randomBytes(32).toString("base64url");
const accountKeys = generateKeyPairSync("ed25519");

/** The Account's JWKS, the only thing the Home fetches from it to verify a claim. */
const accountFetch: typeof globalThis.fetch = async (input) => {
  if (String(input) !== `${accountOrigin}/api/auth/jwks`) throw new Error(`Unexpected ${input}`);
  return Response.json({
    keys: [{ ...(await exportJWK(accountKeys.publicKey)), alg: "EdDSA", kid: "account-key" }],
  });
};

function managedConfig(databaseUrl: string, directory: string, port: number): HostConfig {
  return parseHostConfig({
    OPENSTEER_MODE: "development",
    OPENSTEER_DEPLOYMENT_KIND: "personal",
    OPENSTEER_DATABASE_URL: databaseUrl,
    OPENSTEER_AUTH_SECRET: "managed-home-auth-secret".padEnd(48, "s"),
    OPENSTEER_HOST_DATA_DIR: join(directory, "host"),
    OPENSTEER_PORT: String(port),
    OPENSTEER_BIND_ADDRESS: "127.0.0.1",
    OPENSTEER_CANONICAL_ORIGIN: home,
    OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
    OPENSTEER_AGENT_HOME: join(directory, "agent-home"),
    OPENSTEER_NATIVE_FS_HELPER: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
    OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: setupCode,
    OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
    OPENSTEER_SIGNUP_POLICY: "closed",
    OPENSTEER_MANAGED_HOME_ID: cloudComputerId,
    OPENSTEER_MANAGED_HOME_GENERATION: String(generation),
    OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN: accountOrigin,
    OPENSTEER_MANAGED_HOME_OIDC_CLIENT_ID: "occ_0192f4a1-1111-4000-8000-000000000001",
    OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET: `ocs_${randomBytes(32).toString("base64url")}`,
  });
}

async function assertion(
  identity: { readonly deploymentId: string; readonly hostKeyFingerprint: string },
  overrides: {
    readonly subject?: string;
    readonly authority?: Partial<ManagedHomeClaimClaims["authority"]>;
    readonly generation?: number;
    readonly credential?: string;
    readonly issuedAt?: number;
  } = {},
) {
  const issuedAt = overrides.issuedAt ?? Math.floor(Date.now() / 1_000);
  return new SignJWT({
    tokenUse: "opensteer-managed-home-claim",
    authority: { canonicalOrigin: home, ...identity, ...overrides.authority },
    claim: { cloudComputerId, generation: overrides.generation ?? generation },
    owner: { displayName: "Pat Owner", email: "pat@example.test", emailVerified: true },
    link: {
      generation: linkGeneration,
      hostCredentialSha256: createHash("sha256")
        .update(overrides.credential ?? hostCredential)
        .digest("base64url"),
    },
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "account-key" })
    .setIssuer(accountOrigin)
    .setAudience(home)
    .setSubject(overrides.subject ?? "acct_0192f4a1-2222-4000-8000-000000000002")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 120)
    .setJti(`mhc_${crypto.randomUUID()}`)
    .sign(accountKeys.privateKey);
}

function claim(host: PersonalHostRuntime, token: string, code = setupCode) {
  return host.app.inject({
    method: "POST",
    url: managedHomeClaimPath,
    headers: { host: "cc-home.example.test", "x-forwarded-proto": "https" },
    payload: { schemaVersion: 1, setupCode: code, assertion: token, hostCredential },
  });
}

it("is claimed once by its Account's signed assertion, and by nothing else", async () => {
  const database = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-managed-home-"));
  const config = managedConfig(database.url, directory, await freePort());
  try {
    const { host } = await ownTestDatabaseProducer(database.url, async () => {
      const runtime = await createHostRuntime(config, { personalAccountGrantFetch: accountFetch });
      if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
      return { host: runtime, close: () => runtime.close() };
    });

    const descriptor = await host.app.inject({ method: "GET", url: "/.well-known/opensteer" });
    const discovery = descriptor.json<{
      authority: { document: { deploymentId: string }; publicKey: { spki: string } };
      bootstrapMethods: string[];
    }>();
    // Its owner signs in with the Opensteer Account; there is no password to set.
    expect(discovery.bootstrapMethods).toEqual(["oidc"]);
    const identity = {
      deploymentId: discovery.authority.document.deploymentId,
      hostKeyFingerprint: hostKeyFingerprint(discovery.authority.publicKey.spki),
    };
    const exchange = await host.app.inject({
      method: "POST",
      url: "/v1/rpc/auth.setup.exchange",
      headers: { origin: home, ...apiVersionHeaders("personal") },
      payload: { token: setupCode },
    });
    expect(exchange.json()).toMatchObject({
      error: { reason: "managed-home-setup-link-refused" },
    });

    const refusals: [Promise<string>, string | undefined, number][] = [
      [
        assertion(identity, { authority: { deploymentId: createId("deployment") } }),
        undefined,
        403,
      ],
      [
        assertion(identity, { authority: { hostKeyFingerprint: `sha256:${"b".repeat(43)}` } }),
        undefined,
        403,
      ],
      [assertion(identity, { generation: generation - 1 }), undefined, 409],
      [assertion(identity, { credential: `osc_${"x".repeat(43)}` }), undefined, 403],
      [assertion(identity, { issuedAt: Math.floor(Date.now() / 1_000) - 600 }), undefined, 403],
      [assertion(identity), randomBytes(32).toString("base64url"), 403],
    ];
    for (const [token, code, status] of refusals)
      expect((await claim(host, await token, code)).statusCode).toBe(status);
    expect(await host.store.database.selectFrom("users").select("id").execute()).toEqual([]);

    // Two Accounts race for the same code: exactly one becomes the owner.
    const subjects = [
      "acct_0192f4a1-2222-4000-8000-000000000002",
      "acct_0192f4a1-3333-4000-8000-000000000003",
    ];
    const raced = await Promise.all(
      subjects.map(async (subject) => claim(host, await assertion(identity, { subject }))),
    );
    expect(raced.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = raced.findIndex((response) => response.statusCode === 200);
    const receipt = ManagedHomeClaimReceiptSchema.parse(raced[winner]!.json());
    expect(receipt.document).toMatchObject({
      account: { issuer: accountOrigin, subject: subjects[winner] },
      authority: { canonicalOrigin: home, ...identity },
      claim: { cloudComputerId, generation },
      linkGeneration,
    });
    // Signed by the Home's own key, so the Account can trust it read back later.
    expect(receipt.publicKey.spki).toBe(discovery.authority.publicKey.spki);
    expect(
      verify(
        null,
        managedHomeClaimReceiptSigningBytes(receipt.document),
        createPublicKey({
          key: Buffer.from(receipt.publicKey.spki, "base64url"),
          format: "der",
          type: "spki",
        }),
        Buffer.from(receipt.signature, "base64url"),
      ),
    ).toBe(true);

    // The same claim again, with a fresh assertion, answers the first receipt.
    const replay = await claim(host, await assertion(identity, { subject: subjects[winner]! }));
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(receipt);
    expect(
      (await claim(host, await assertion(identity, { subject: subjects[1 - winner]! }))).statusCode,
    ).toBe(409);

    // One owner, linked to that Account for sign-in and for push.
    await expect(
      host.store.database.selectFrom("users").select(["email", "emailVerified"]).execute(),
    ).resolves.toEqual([{ email: "pat@example.test", emailVerified: true }]);
    await expect(
      host.store.database
        .selectFrom("personalRemoteAccountLink")
        .select(["hostCredential", "issuer", "linkGeneration", "state", "subject"])
        .execute(),
    ).resolves.toEqual([
      {
        hostCredential,
        issuer: accountOrigin,
        linkGeneration,
        state: "active",
        subject: subjects[winner],
      },
    ]);
    const configured = await host.app.inject({
      method: "GET",
      url: "/v1/rpc/auth.config?input=%7B%7D",
      headers: { origin: home, ...apiVersionHeaders("personal") },
    });
    expect(configured.json()).toMatchObject({
      data: {
        localPasswordEnabled: false,
        oidcProviders: [{ id: "opensteer-account" }],
        setupState: "complete",
      },
    });
  } finally {
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  }
});
