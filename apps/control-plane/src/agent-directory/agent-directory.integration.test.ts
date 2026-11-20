import {
  AgentDirectoryClaimsSchema,
  AgentDirectoryResponseSchema,
  agentDirectoryJwtTyp,
  agentDirectoryPath,
  agentDirectoryTokenUse,
} from "@opensteer/control-plane-protocol";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, type JSONWebKeySet } from "jose";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { ControlPlaneAuthenticator, createControlPlaneAuth } from "../auth/auth.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { ControlPlaneStore } from "../database/store.js";
import { createControlPlaneServer } from "../server/server.js";
import { agentDirectoryCacheControl } from "./routes.js";
import { AgentDirectoryStore } from "./store.js";

const url = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
// The focused integration launcher supplies a disposable Account database.
const integration = url ? describe : describe.skip;
const publicOrigin = new URL("https://account.agent-directory.example.test");
const portalOrigin = new URL("https://portal.agent-directory.example.test");
const authSecret = "test-auth-secret-for-agent-directory-32";

integration("AgentDirectoryStore and signed GET route integration", () => {
  const database = createControlPlaneDatabase({ connectionString: url! });
  const directoryStore = new AgentDirectoryStore(database);
  let server: Awaited<ReturnType<typeof createControlPlaneServer>>;

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
    const store = new ControlPlaneStore(database, publicOrigin, { portalOrigin });
    const auth = createControlPlaneAuth(database, {
      authSecret,
      publicOrigin,
      googleClientId: "test-google-client",
      googleClientSecret: "test-google-secret",
    });
    server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle: new ConnectLifecycleService(database, {
        delete: async () => undefined,
        ensure: async () => {
          throw new Error("unused");
        },
        readConnectorToken: async () => {
          throw new Error("unused");
        },
        rotateConnectorToken: async () => {
          throw new Error("unused");
        },
      }),
      agentDirectory: directoryStore,
      portalOrigin,
      publicOrigin,
      store,
    });
  });

  beforeEach(async () => {
    await sql`delete from public.agent_directory_entries`.execute(database);
    await sql`update public.agent_directory_state set revision = 1, updated_at = now() where id = 1`.execute(
      database,
    );
  });

  afterAll(async () => {
    await server.close();
    await database.destroy();
  });

  it("persists entries, bumps revision monotonically, and serves a document signed by Account JWKS", async () => {
    const { publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const raw = await exportJWK(publicKey);

    const addedPlatform = await directoryStore.add({
      id: "agentpay",
      displayName: "AgentPay",
      origins: ["https://agentpay.example"],
    });
    expect(addedPlatform.revision).toBe(2);

    const addedEmbedder = await directoryStore.add({
      id: "errand",
      displayName: "Errand",
      origins: ["https://errand.example"],
      keys: {
        keys: [
          { kty: "OKP", crv: "Ed25519", x: raw.x!, kid: "errand-1", use: "sig", alg: "EdDSA" },
        ],
      },
      embedsVia: ["agentpay"],
    });
    expect(addedEmbedder.revision).toBe(3);

    const updated = await directoryStore.update("errand", {
      displayName: "Errand Assistant",
      origins: ["https://errand.example"],
      keys: {
        keys: [
          { kty: "OKP", crv: "Ed25519", x: raw.x!, kid: "errand-1", use: "sig", alg: "EdDSA" },
        ],
      },
      embedsVia: ["agentpay"],
    });
    expect(updated.revision).toBe(4);

    const response = await server.inject({ method: "GET", url: agentDirectoryPath });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(agentDirectoryCacheControl);
    const { assertion } = AgentDirectoryResponseSchema.parse(response.json());

    const jwksResponse = await server.inject({
      method: "GET",
      url: "/api/auth/jwks",
      headers: { host: publicOrigin.host },
    });
    expect(jwksResponse.statusCode).toBe(200);
    const jwks = jwksResponse.json() as JSONWebKeySet;

    const verified = await jwtVerify(assertion, createLocalJWKSet(jwks), {
      algorithms: ["EdDSA"],
      issuer: publicOrigin.origin,
      typ: agentDirectoryJwtTyp,
    });
    const claims = AgentDirectoryClaimsSchema.parse(verified.payload);
    expect(claims.tokenUse).toBe(agentDirectoryTokenUse);
    expect(claims.revision).toBe(4);
    expect(claims.entries.map((entry) => entry.id)).toEqual(["agentpay", "errand"]);

    const removed = await directoryStore.remove("errand");
    expect(removed.revision).toBe(5);
    const listed = await directoryStore.list();
    expect(listed.revision).toBe(5);
    expect(listed.entries.map((entry) => entry.id)).toEqual(["agentpay"]);
  });
});
