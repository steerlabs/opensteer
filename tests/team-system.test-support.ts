import { digestSecret } from "@opensteer/shared/secretDigest";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createId, HostKeyFingerprintSchema, type UserId } from "../packages/core/src/index.js";
import { parseHostConfig } from "../packages/config/src/index.js";
import {
  teamApiVersion,
  teamApiVersionHeader,
} from "../packages/deployment-authority/src/index.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import {
  IdentityService,
  TeamIdentityAdmission,
  type VerifiedAccountAdoptionGrant,
} from "../packages/identity/src/index.js";
import { createHttpHostApiClient } from "../packages/client/src/host/host-api-client.js";
import {
  TeamSessionClient,
  createMemoryTeamPersistence,
} from "../packages/client/src/team/index.js";
import type { WebSocketClient } from "../packages/client/src/host/host-session-client.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { freePort } from "../packages/shared/src/loopbackPort.test-support.js";
import { sql } from "kysely";
import { createHostRuntime, type HostRuntimeOptions } from "../apps/host/src/runtime/runtime.js";

export async function startTeamSystem(name = "Acme", options: HostRuntimeOptions = {}) {
  console.info("team-system: cloning");
  const clone = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "team-system-"));
  const secret = randomBytes(48).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const port = await freePort();
  const canonicalOrigin = `https://${name.toLowerCase()}.example.invalid`;
  let closeHost: (() => Promise<void>) | undefined;
  try {
    const { host } = await ownTestDatabaseProducer(clone.url, async () => {
      console.info("team-system: constructing");
      const host = await createHostRuntime(
        parseHostConfig({
          OPENSTEER_MODE: "development",
          OPENSTEER_DEPLOYMENT_KIND: "team",
          OPENSTEER_DEPLOYMENT_NAME: name,
          OPENSTEER_DATABASE_URL: clone.url,
          OPENSTEER_AUTH_SECRET: secret,
          OPENSTEER_HOST_DATA_DIR: directory,
          OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: token,
          OPENSTEER_CANONICAL_ORIGIN: canonicalOrigin,
          OPENSTEER_BIND_ADDRESS: "127.0.0.1",
          OPENSTEER_PORT: String(port),
        }),
        options,
      );
      return { host, close: () => host.close() };
    });
    console.info("team-system: constructed");
    closeHost = () => host.close();
    if (host.kind !== "team") throw new Error("Expected a team Host");
    const origin = new URL(await host.listen());
    const database = host.team.access.database;
    const descriptor = (await host.app.inject({ url: "/.well-known/opensteer" })).json();
    const authority = {
      canonicalOrigin,
      deploymentId: host.deployment.id,
      hostInstanceId: host.deployment.activeHostInstanceId,
      hostKeyFingerprint: HostKeyFingerprintSchema.parse(
        (await import("../packages/deployment-authority/src/index.js")).hostKeyFingerprint(
          descriptor.authority.publicKey.spki,
        ),
      ),
    };
    let verified: VerifiedAccountAdoptionGrant | undefined;
    // Account is the external collaborator: signature verification and OIDC callback only.
    const admission = new TeamIdentityAdmission({
      access: host.team.access,
      invites: host.team.invites,
      authority,
      grantVerifier: {
        async verify() {
          if (!verified) throw new Error("No Account grant");
          return verified;
        },
      },
      installAccountBundle: async () => {},
    });
    const identity = new IdentityService(database, {
      team: admission,
      deployment: { kind: "team", name },
      exposure: "networked",
      localPasswordEnabled: false,
      oidcProviders: [],
      publicOrigin: new URL(canonicalOrigin),
      secret,
      signupPolicy: "invite-only",
      initialOwnerEnrollment: {
        tokenDigest: digestSecret(token),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    const clients: TeamSessionClient[] = [];
    const webSockets = new Set<WebSocket>();
    async function user(displayName: string) {
      const id = createId("user");
      await sql`insert into users(id,display_name,email,email_verified) values(${id},${displayName},${`${displayName}@example.invalid`},true)`.execute(
        database,
      );
      return id;
    }
    async function account(userId: UserId, subject: string) {
      const provider = await database
        .selectFrom("accountDirectoryProvider")
        .selectAll()
        .executeTakeFirstOrThrow();
      await sql`insert into auth_accounts(id,account_id,provider_id,user_id) values(${createId("authAccount")},${subject},${provider.providerId},${userId})`.execute(
        database,
      );
    }
    async function setup() {
      console.info("team-system: setup exchange");
      const exchanged = await host.app.inject({
        method: "POST",
        url: "/v1/team/setup/exchange",
        headers: { origin: canonicalOrigin, [teamApiVersionHeader]: String(teamApiVersion) },
        payload: { token },
      });
      console.info("team-system: exchanged", exchanged.statusCode);
      if (exchanged.statusCode !== 200) throw new Error(`Setup exchange: ${exchanged.body}`);
      const proof = await database
        .selectFrom("authAdmissions")
        .selectAll()
        .where("purpose", "=", "setup")
        .executeTakeFirstOrThrow();
      const maya = await user("Maya");
      const identityAccount = {
        issuer: "https://account.example.invalid",
        subject: `acct_${crypto.randomUUID()}`,
      };
      console.info("team-system: adopting");
      const issued = await admission.issueAdoption(proof, identityAccount);
      const consumed = await admission.consumeAdoption({
        expectedAccount: identityAccount,
        expectedDeployment: authority,
        proofId: issued.proofId,
        proofCredential: issued.proofCredential,
      });
      if (!consumed) throw new Error("Account did not consume setup proof");
      verified = {
        ...consumed,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 300000),
        grantId: `hag_${crypto.randomUUID()}`,
      };
      await admission.completeAdoption(proof, "verified-account-grant", {
        provisioningMode: "adoption",
        controlApiOrigin: identityAccount.issuer,
        deployment: { ...authority, reachability: "canonical" },
        hostCredential: `osc_${"a".repeat(43)}`,
        oidc: {
          issuer: identityAccount.issuer,
          clientId: "team-system",
          redirectUri: `${canonicalOrigin}/v1/auth/oidc/callback`,
          scopes: ["openid", "profile", "email"],
          tokenEndpointAuthMethod: "client_secret_basic",
          requirePkce: true,
        },
        oidcClientSecret: `ocs_${"b".repeat(43)}`,
      });
      console.info("team-system: adopted");
      await account(maya, identityAccount.subject);
      await admission.admit(maya, proof);
      console.info("team-system: owner admitted");
      return maya;
    }
    async function acceptInvite(url: string, displayName: string) {
      const link = new URL(url);
      await identity.exchangeTeamInvitation(
        link.pathname.split("/").at(-1)!,
        link.hash.slice(1),
        new Headers({ origin: canonicalOrigin }),
      );
      const proof = await database
        .selectFrom("authAdmissions")
        .selectAll()
        .where("purpose", "=", "invitation")
        .where("consumedAt", "is", null)
        .executeTakeFirstOrThrow();
      const id = await user(displayName);
      await account(id, `acct_${crypto.randomUUID()}`);
      await admission.admit(id, proof);
      return id;
    }
    async function session(
      userId: UserId,
      label: string,
      via = origin,
      observe?: (path: string, body: Uint8Array) => void,
    ) {
      const member = await database
        .selectFrom("teamMembers")
        .selectAll()
        .where("userId", "=", userId)
        .executeTakeFirstOrThrow();
      const raw = randomBytes(32).toString("base64url");
      await database
        .insertInto("authSessions")
        .values({
          id: createId("authSession"),
          userId,
          token: raw,
          memberGeneration: member.generation,
          deviceLabel: label,
          expiresAt: new Date(Date.now() + 3600000),
          absoluteExpiresAt: new Date(Date.now() + 3600000),
        })
        .execute();
      const cookie = `__Host-opensteer.session=${encodeURIComponent(`${raw}.${createHmac("sha256", secret).update(raw).digest("base64")}`)}`;
      const headers = { origin: canonicalOrigin, cookie };
      const rpc = createHttpHostApiClient({
        baseUrl: via,
        kind: "team",
        fetch: async (url, init) => {
          const response = await fetch(url, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers },
          });
          const bytes = new Uint8Array(await response.arrayBuffer());
          observe?.(new URL(String(url)).pathname, bytes);
          return new Response(bytes, { status: response.status, headers: response.headers });
        },
        onAuthenticationRequired: () => {},
      });
      const sockets = new Set<WebSocket>();
      const client = new TeamSessionClient({
        scope: { teamDeploymentId: host.deployment.id, userId },
        rpc,
        persistence: createMemoryTeamPersistence(),
        readFile: async (file, part) => {
          const path = `/v1/team/files/${file.id}/${part}`;
          const response = await fetch(new URL(path, via), {
            headers: { ...headers, [teamApiVersionHeader]: String(teamApiVersion) },
          });
          if (!response.ok) throw new Error(`File read failed (${response.status})`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          observe?.(path, bytes);
          return new Blob([bytes]);
        },
        connect: () => {
          const socket = new WebSocket(
            new URL(`/v1/realtime?opensteer_api_version=${teamApiVersion}`, via)
              .toString()
              .replace(/^http/u, "ws"),
            { headers },
          );
          socket.on("message", (raw) => observe?.("websocket", Buffer.from(raw.toString())));
          sockets.add(socket);
          webSockets.add(socket);
          socket.once("close", () => webSockets.delete(socket));
          socket.once("close", () => sockets.delete(socket));
          return socket as unknown as WebSocketClient;
        },
      });
      clients.push(client);
      return { client, rpc, headers, sockets };
    }
    return {
      host,
      database,
      origin,
      canonicalOrigin,
      setup,
      acceptInvite,
      session,
      directory,
      async close() {
        for (const client of clients) client.dispose();
        for (const socket of webSockets) socket.terminate();
        const stopped = host.close();
        for (const socket of host.app.websocketServer.clients) socket.terminate();
        host.app.server.closeAllConnections();
        await withTimeout(stopped, 5000, {
          timeoutError: () => new Error(`Team shutdown stalled at ${host.closingStep()}`),
        });
        await clone.drop();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await closeHost?.();
    await clone.drop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function teamCondition<T>(
  client: Pick<TeamSessionClient, "subscribe">,
  read: () => T | undefined,
  label: string,
  timeout = 15000,
): Promise<T> {
  const ready = Promise.withResolvers<T>();
  const check = () => {
    const result = read();
    if (result !== undefined) ready.resolve(result);
  };
  const stop = client.subscribe(check);
  try {
    check();
    return await withTimeout(ready.promise, timeout, { timeoutError: () => new Error(label) });
  } finally {
    stop();
  }
}

export async function openMachineSocket(origin: URL, secret: string, signal: AbortSignal) {
  const socket = new WebSocket(
    new URL("/internal/v1/team/link", origin).toString().replace(/^http/u, "ws"),
    {
      headers: {
        authorization: `Bearer ${secret}`,
        [teamApiVersionHeader]: String(teamApiVersion),
      },
    },
  );
  const stop = () => {
    socket.on("error", () => {});
    socket.terminate();
  };
  signal.addEventListener("abort", stop, { once: true });
  socket.once("close", () => signal.removeEventListener("abort", stop));
  await withTimeout(once(socket, "open"), 5000, {
    signal,
    timeoutError: () => new Error("Machine socket never opened"),
  });
  return socket;
}
