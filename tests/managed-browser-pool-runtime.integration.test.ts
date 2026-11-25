import type { RuntimeBrowserAttachTicketClaims } from "../packages/protocol/src/browser.js";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:tls";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { parseHostConfig, type HostConfig } from "../packages/config/src/index.js";
import {
  BrowserPoolSlotIdSchema,
  ManagedBrowserPoolRegistrationRequestSchema,
  managedBrowserPoolRegistrationPath,
  managedBrowserPoolRegistrationSigningBytes,
  managedBrowserPoolTargetPath,
  managedHomeClaimPath,
  type ManagedBrowserPoolTarget,
  type ManagedBrowserPoolTargetResponse,
} from "../packages/control-plane-protocol/src/index.js";
import {
  createId,
  OpensteerError,
  type AuthSessionId,
  type RunnerId,
  type UserId,
} from "../packages/core/src/index.js";
import {
  BrowserSessionIdSchema,
  RunnerAuxiliaryChallengeSchema,
  RunnerBootIdSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  runnerProofFormatVersion,
} from "../packages/protocol/src/index.js";
import { AgentConnectionStore, beginAgentSession } from "../packages/database/src/index.js";
import {
  BrowserPoolAdmissionClosed,
  listBrowserPoolUnconfirmedClosings,
  recordBrowserPoolTargetAnswer,
  stopBrowserPoolSession,
} from "../packages/database/src/browser-pool-store.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { hostKeyFingerprint } from "../packages/deployment-authority/src/index.js";
import {
  createRunnerAuthenticationSignature,
  createRunnerAuxiliarySignature,
  createRunnerEnrollmentSignature,
  hashRunnerEnrollmentToken,
} from "../packages/runner-auth/src/index.js";
import { freePort } from "../packages/shared/src/loopbackPort.test-support.js";
import { BrowserRuntime } from "../packages/browser-runtime-core/src/runtime.js";
import { BrowserRuntimeServer } from "../packages/browser-runtime-core/src/server.js";
import { Ed25519AttachTicketVerifier } from "../packages/browser-runtime-core/src/security/attach-ticket.js";
import {
  FakeIsolatingLauncher,
  testSessionFilesRoot,
} from "../packages/browser-runtime-core/src/test-support/fakes.js";
import { createRelayServer } from "../apps/pool-agent/src/relay.js";
import {
  createHomeServer,
  listen,
  PoolAgent,
  SlotJournal,
  startTestPoolAgent,
  testGuest,
  type TestPoolAgent,
} from "../apps/pool-agent/src/test-support.js";
import {
  BrowserPoolCoordinator,
  type BrowserPoolWakeTrace,
} from "../apps/host/src/browser/browser-pool-coordinator.js";
import {
  createManagedPooledRelay,
  defaultManagedBrowserPoolIdleMs,
  managedBrowserPoolCoordinator,
  pooledBrowserRuntimeId,
  startManagedBrowserPool,
} from "../apps/host/src/browser/managed-pool-home.js";
import { BrowserService } from "../apps/host/src/browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import {
  managedBrowserPool,
  managedBrowserPoolRegistration,
} from "../apps/host/src/browser/managed-pool.js";
import { RunnerBrowserHub } from "../apps/host/src/browser/runner-browser-hub.js";
import {
  BrowserRelayError,
  LocalBrowserRuntimeBridge,
} from "../packages/runner-client/src/browser-bridge.js";
import { z } from "zod";
import {
  loadOrCreateManagedBrowserPoolKeys,
  managedBrowserPoolKeysPath,
  selfSignedCertificate,
} from "../apps/host/src/browser/managed-pool-keys.js";
import { initializePersonalState } from "../apps/host/src/runtime/personal-state.js";
import { createHostRuntime, type PersonalHostRuntime } from "../apps/host/src/runtime/runtime.js";
import { createPersonalRunFixturePort } from "../packages/database/src/personal-run-fixture.test-support.js";

const homeOrigin = "https://cc-pool-home.example.test";
const accountOrigin = "https://accounts.example.test";
const cloudComputerId = "cc_0192f4a1-4444-4000-8000-000000000001";
const generation = 1;
const setupCode = randomBytes(32).toString("base64url");
const mainRunnerToken = randomBytes(32).toString("base64url");
const hostCredential = `osc_${randomBytes(32).toString("base64url")}`;
const linkGeneration = randomBytes(32).toString("base64url");
const accountKeys = generateKeyPairSync("ed25519");

function spkiBase64(publicKey: ReturnType<typeof createPublicKey>): string {
  return publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

function spkiPemFromBase64(spki: string): string {
  return createPublicKey({
    key: Buffer.from(spki, "base64"),
    format: "der",
    type: "spki",
  })
    .export({ format: "pem", type: "spki" })
    .toString();
}

function managedConfig(
  databaseUrl: string,
  directory: string,
  port: number,
  options: { readonly browserPool?: boolean } = {},
): HostConfig {
  return parseHostConfig({
    OPENSTEER_MODE: "development",
    OPENSTEER_DEPLOYMENT_KIND: "personal",
    OPENSTEER_DATABASE_URL: databaseUrl,
    OPENSTEER_AUTH_SECRET: "managed-pool-runtime-secret".padEnd(48, "s"),
    OPENSTEER_HOST_DATA_DIR: join(directory, "host"),
    OPENSTEER_PORT: String(port),
    OPENSTEER_BIND_ADDRESS: "127.0.0.1",
    OPENSTEER_CANONICAL_ORIGIN: homeOrigin,
    OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
    OPENSTEER_AGENT_HOME: join(directory, "agent-home"),
    OPENSTEER_NATIVE_FS_HELPER: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
    OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: setupCode,
    OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN: mainRunnerToken,
    OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
    OPENSTEER_SIGNUP_POLICY: "closed",
    OPENSTEER_MANAGED_HOME_ID: cloudComputerId,
    OPENSTEER_MANAGED_HOME_GENERATION: String(generation),
    OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN: accountOrigin,
    OPENSTEER_MANAGED_HOME_OIDC_CLIENT_ID: "occ_0192f4a1-4444-4000-8000-000000000001",
    OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET: `ocs_${randomBytes(32).toString("base64url")}`,
    ...(options.browserPool ? { OPENSTEER_MANAGED_HOME_BROWSER_POOL: "true" } : {}),
  });
}

async function claimHome(host: PersonalHostRuntime): Promise<{
  readonly ownerId: UserId;
  readonly hostSpki: string;
}> {
  const descriptor = await host.app.inject({ method: "GET", url: "/.well-known/opensteer" });
  const discovery = descriptor.json<{
    authority: {
      document: { deploymentId: string; hostInstanceId: string };
      publicKey: { spki: string };
    };
  }>();
  const issuedAt = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "account-key" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      tokenUse: "opensteer-managed-home-claim",
      authority: {
        canonicalOrigin: homeOrigin,
        deploymentId: discovery.authority.document.deploymentId,
        hostInstanceId: discovery.authority.document.hostInstanceId,
        hostKeyFingerprint: hostKeyFingerprint(discovery.authority.publicKey.spki),
      },
      claim: { cloudComputerId, generation },
      owner: { displayName: "Pool Owner", email: "pool-owner@example.test", emailVerified: true },
      link: {
        generation: linkGeneration,
        hostCredentialSha256: createHash("sha256").update(hostCredential).digest("base64url"),
      },
      iss: accountOrigin,
      aud: homeOrigin,
      sub: "acct_0192f4a1-4444-4000-8000-000000000002",
      iat: issuedAt,
      exp: issuedAt + 120,
      jti: `mhc_${randomUUID()}`,
    }),
  ).toString("base64url");
  const assertion = `${header}.${payload}.${sign(
    null,
    Buffer.from(`${header}.${payload}`, "ascii"),
    accountKeys.privateKey,
  ).toString("base64url")}`;
  const claimed = await host.app.inject({
    method: "POST",
    url: managedHomeClaimPath,
    headers: { host: "cc-pool-home.example.test", "x-forwarded-proto": "https" },
    payload: { schemaVersion: 1, setupCode, assertion, hostCredential },
  });
  expect(claimed.statusCode).toBe(200);
  const owner = await host.store.database
    .selectFrom("users")
    .select("id")
    .where("email", "=", "pool-owner@example.test")
    .executeTakeFirstOrThrow();
  return { ownerId: owner.id as UserId, hostSpki: discovery.authority.publicKey.spki };
}

async function enrollMainRunner(host: PersonalHostRuntime, config: HostConfig): Promise<RunnerId> {
  const runnerId = createId("runner");
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  await host.store.enrollRunnerConnection({
    descriptor: {
      bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
      capabilities: [],
      modules: {},
      name: "Cloud Computer",
      runnerId,
      runnerKind: "main",
      runtimeVersion: "test",
    },
    enrollmentTokenHash: hashRunnerEnrollmentToken(mainRunnerToken),
    publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyPem).digest("hex")}`,
    publicKeyPem,
  });
  await initializePersonalState(host.store.database, {
    agentHome: config.personal!.agentHome,
    environmentId: config.personal!.environmentId,
  });
  return runnerId;
}

interface LoopbackPoolHost {
  /** Every ticket the guest's runtime verified, as it read it (M2). */
  readonly verifiedClaims: readonly RuntimeBrowserAttachTicketClaims[];
  readonly agent: TestPoolAgent;
  readonly currentAgent: () => PoolAgent;
  readonly runtime: BrowserRuntime;
  readonly target: ManagedBrowserPoolTarget;
  readonly slotId: string;
  readonly term: number;
  readonly pagesOpened: () => number;
  stopAgent(): Promise<void>;
  restartAgent(): Promise<void>;
  close(): Promise<void>;
}

async function startLoopbackPoolHost(input: {
  readonly directory: string;
  readonly slotId: string;
  readonly term: number;
  readonly registered: {
    readonly homeKey: string;
    readonly relayKey: string;
    readonly ticketKey: { readonly keyId: string; readonly spki: string };
  };
}): Promise<LoopbackPoolHost> {
  const relayKeys = generateKeyPairSync("ed25519");
  const relayKeyPem = relayKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const relayCertificate = selfSignedCertificate(relayKeys.privateKey);
  const hostKeys = generateKeyPairSync("ed25519");
  const agent = await startTestPoolAgent({ saveAfterMs: null, hostKeys });
  let liveAgent: PoolAgent = agent.agent;
  let restartedServer: import("node:http").Server | undefined;
  let agentRunning = true;
  let closeAgent: () => Promise<void> = async () => {
    if (!agentRunning) return;
    agentRunning = false;
    await agent.close();
  };
  const agentPort = Number(new URL(agent.url).port);
  const summary = await liveAgent.createSlot({
    slotId: input.slotId,
    term: input.term,
    homeKey: input.registered.homeKey,
    guest: testGuest,
    relayKey: input.registered.relayKey,
  });
  const controlKey = createPublicKey({
    key: Buffer.from(summary.controlKey, "base64"),
    format: "der",
    type: "spki",
  });
  const ticketPublicKeyPem = spkiPemFromBase64(input.registered.ticketKey.spki);
  const verifier = await Ed25519AttachTicketVerifier.create({
    pooled: true,
    replayLedgerPath: join(
      input.directory,
      `pool-${input.slotId}-${input.term}`,
      "replay-ledger.json",
    ),
    resolvePublicKey: async (keyId) =>
      keyId === input.registered.ticketKey.keyId ? ticketPublicKeyPem : null,
  });
  // What every pooled ticket carries, as the guest's runtime verifies it (M2).
  const verifiedClaims: Awaited<ReturnType<typeof verifier.verify>>[] = [];
  const verify = verifier.verify.bind(verifier);
  verifier.verify = async (...args) => {
    const claims = await verify(...args);
    verifiedClaims.push(claims);
    return claims;
  };
  const launcher = Object.assign(new FakeIsolatingLauncher(), {
    localProfiles: {
      engine: "chromium" as const,
      createFiles: async () => {},
      release: async () => "released" as const,
    },
  });
  const runtime = new BrowserRuntime({
    launcher,
    runtimeId: "browser-main",
    sessionFilesRoot: testSessionFilesRoot(),
    localProfiles: { root: join(input.directory, `profiles-${input.slotId}-${input.term}`) },
    ticketVerifier: verifier,
    pool: {
      controllerKey: controlKey,
      probePage: async () => [],
      boot: { slot: input.slotId, floor: { term: input.term, sequence: 0 } },
    },
  });
  const delivered = () => [...agent.driver.tokens.values()].at(-1)?.at(-1) ?? "no-token-yet";
  const runtimeServer = new BrowserRuntimeServer({
    runtime,
    host: "127.0.0.1",
    port: 0,
    relayBridge: {
      get token() {
        return delivered();
      },
      updateAttachKeys: () => {},
    },
  });
  const bridgeAddress = await runtimeServer.start();
  agent.driver.bridgeTargets.set(input.slotId, { host: "127.0.0.1", port: bridgeAddress.port });
  const relay: Server = createRelayServer({
    key: relayKeyPem,
    certificate: relayCertificate,
    authorize: async (hello, clientKey) => liveAgent.authorizeRelay(hello, clientKey),
  });
  const relaySockets = new Set<Socket>();
  relay.on("connection", (socket) => {
    relaySockets.add(socket);
    socket.once("close", () => relaySockets.delete(socket));
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const target: ManagedBrowserPoolTarget = {
    kind: "managed-pool",
    slotId: BrowserPoolSlotIdSchema.parse(input.slotId),
    term: input.term,
    agentUrl: agent.url,
    agentKey: summary.controlKey,
    hostKey: spkiBase64(agent.hostPublicKey),
    relay: {
      host: "127.0.0.1",
      port: (relay.address() as AddressInfo).port,
      relayHostKey: spkiBase64(relayKeys.publicKey),
    },
  };
  return {
    verifiedClaims,
    agent,
    currentAgent: () => liveAgent,
    runtime,
    target,
    slotId: input.slotId,
    term: input.term,
    pagesOpened: () => launcher.launchCount,
    stopAgent: async () => {
      for (const socket of relaySockets) socket.destroy();
      await closeAgent();
    },
    restartAgent: async () => {
      for (const socket of relaySockets) socket.destroy();
      await closeAgent();
      const nextJournal = new SlotJournal(join(agent.directory, "journal"));
      const nextAgent = new PoolAgent({
        saveAfterMs: null,
        journal: nextJournal,
        driver: agent.driver,
      });
      await nextAgent.start();
      const nextServer = createHomeServer({
        agent: nextAgent,
        hostKey: hostKeys.privateKey,
      });
      await listen(nextServer, { host: "127.0.0.1", port: agentPort });
      liveAgent = nextAgent;
      restartedServer = nextServer;
      agentRunning = true;
      closeAgent = async () => {
        if (!agentRunning) return;
        agentRunning = false;
        nextAgent.close();
        nextServer.closeAllConnections();
        await new Promise<void>((resolve) => nextServer.close(() => resolve()));
      };
    },
    close: async () => {
      for (const socket of relaySockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await runtimeServer.close();
      await closeAgent();
      void restartedServer;
    },
  };
}

function jwksFetch(): typeof globalThis.fetch {
  return async (input) => {
    if (String(input) !== `${accountOrigin}/api/auth/jwks`)
      throw new Error(`Unexpected JWKS fetch ${input}`);
    return Response.json({
      keys: [
        { ...accountKeys.publicKey.export({ format: "jwk" }), alg: "EdDSA", kid: "account-key" },
      ],
    });
  };
}

describe("Managed browser pool wired into createHostRuntime", () => {
  it("registers keys, adopts a ready target, opens a tab, parks on idle, wakes on next use, stops with runtime evidence, and replaces targets", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-runtime-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: true });
    let accountReachable = false;
    let hostSpkiForVerify: string | undefined;
    let registeredKeys:
      | {
          readonly homeKey: string;
          readonly relayKey: string;
          readonly ticketKey: { readonly keyId: string; readonly spki: string };
        }
      | undefined;
    let targetResponse: ManagedBrowserPoolTargetResponse = { status: "preparing" };
    const accountCalls: string[] = [];
    const poolHosts: LoopbackPoolHost[] = [];

    const accountControlFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      accountCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (!accountReachable) throw new Error("Account temporarily unreachable");
      if (
        init?.headers &&
        new Headers(init.headers).get("authorization") !== `Bearer ${hostCredential}`
      )
        return new Response("unauthorized", { status: 401 });
      if (url.pathname === managedBrowserPoolRegistrationPath && init?.method === "PUT") {
        const parsed = ManagedBrowserPoolRegistrationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        expect(parsed.document.cloudComputerId).toBe(cloudComputerId);
        if (hostSpkiForVerify) {
          expect(
            verify(
              null,
              managedBrowserPoolRegistrationSigningBytes(parsed.document),
              createPublicKey({
                key: Buffer.from(hostSpkiForVerify, "base64url"),
                format: "der",
                type: "spki",
              }),
              Buffer.from(parsed.signature, "base64url"),
            ),
          ).toBe(true);
        }
        registeredKeys = parsed.document.keys;
        return Response.json(targetResponse);
      }
      if (url.pathname === managedBrowserPoolTargetPath && (init?.method ?? "GET") === "GET") {
        return Response.json(registeredKeys ? targetResponse : { status: "unregistered" });
      }
      return new Response("not found", { status: 404 });
    };

    let hostToClose: PersonalHostRuntime | undefined;
    try {
      expect(defaultManagedBrowserPoolIdleMs).toBe(5 * 60_000);
      // Unreachable account must never block Home startup.
      const { host } = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: {
            firstDelayMs: 50,
            maxDelayMs: 150,
            idleParkMs: 250,
            statusEveryMs: 150,
          },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      hostToClose = host;

      const { ownerId, hostSpki } = await claimHome(host);
      hostSpkiForVerify = hostSpki;
      await enrollMainRunner(host, config);

      // Account becomes reachable and answers "preparing" while the pool host provisions the slot.
      accountReachable = true;
      await vi.waitFor(() => expect(registeredKeys).toBeDefined(), { timeout: 2_000 });
      // Operator visibility reflects preparing, then ready on loopback /ready while /healthz stays plain.
      expect((await host.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
        ok: true,
      });
      await vi.waitFor(
        async () => {
          expect((await host.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "preparing",
          });
        },
        { timeout: 5_000 },
      );

      // Spin up loopback pool target 1 with the keys this Home registered.
      const target1 = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      poolHosts.push(target1);
      targetResponse = { status: "ready", target: target1.target };

      // Home adopts target 1 and reports ready on /ready.
      await vi.waitFor(
        async () => {
          expect((await host.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
          expect(host.browser.usesPoolAdmission).toBe(true);
        },
        { timeout: 10_000 },
      );

      // Open a person's tab in the pooled browser (signed with poolKeys.ticketKey!).
      const opened1 = await host.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `open-1-${randomUUID()}`,
        identity: { kind: "guest" },
        url: "https://example.test/one",
      });
      expect(target1.pagesOpened()).toBeGreaterThanOrEqual(1);
      // G1 on a Cloud Computer (M2): every pooled ticket brings this Home's addresses, so the
      // guest's browser refuses the Home before its first page loads.
      expect(target1.verifiedClaims.length).toBeGreaterThan(0);
      for (const claims of target1.verifiedClaims)
        expect(claims.homeAddresses?.origins).toContain(homeOrigin);
      expect((await target1.agent.agent.status(target1.slotId, target1.term)).phase).toBe(
        "running",
      );

      // Idle rule: with nobody holding the browser past idleParkMs, it parks automatically.
      await vi.waitFor(
        async () => {
          const status = await target1.agent.agent.status(target1.slotId, target1.term);
          expect(status.phase).toBe("paused");
        },
        { timeout: 10_000 },
      );

      // Next use wakes the parked browser and opens a second tab.
      const opened2 = await host.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `open-2-${randomUUID()}`,
        identity: { kind: "guest" },
        url: "https://example.test/two",
      });
      expect((await target1.agent.agent.status(target1.slotId, target1.term)).phase).toBe(
        "running",
      );

      // Stop ends the pooled session with the runtime's own answer.
      await host.browser.stop(ownerId, opened1.sessionId);
      await vi.waitFor(
        async () => {
          const row = await host.store.getBrowserSessionForOwner(opened1.sessionId, ownerId);
          expect(row?.state).toBe("closed");
        },
        { timeout: 10_000 },
      );
      if (opened2.sessionId !== opened1.sessionId) {
        await host.browser.stop(ownerId, opened2.sessionId);
        await vi.waitFor(
          async () => {
            const row = await host.store.getBrowserSessionForOwner(opened2.sessionId, ownerId);
            expect(row?.state).toBe("closed");
          },
          { timeout: 10_000 },
        );
      }

      // Target replacement: Account places a new target and old slot is gone -> old coordinator
      // retires and new target is adopted.
      const target2 = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      poolHosts.push(target2);
      targetResponse = { status: "ready", target: target2.target };
      await target1.agent.agent.deleteSlot(target1.slotId);

      // Opening a tab on the replaced browser lands on target 2.
      await vi.waitFor(
        async () => {
          const status = await target2.agent.agent.status(target2.slotId, target2.term);
          expect(status.phase).toBe("running");
        },
        { timeout: 10_000 },
      );
      const openedOnTarget2 = await host.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `open-target2-${randomUUID()}`,
        identity: { kind: "guest" },
        url: "https://example.test/three",
      });
      expect(openedOnTarget2.sessionId).toBeTruthy();
      expect(target2.pagesOpened()).toBeGreaterThanOrEqual(1);
    } finally {
      await hostToClose?.close();
      for (const poolHost of poolHosts) await poolHost.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts no pool object at all when browserPool is not set", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-no-pool-runtime-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    const poolCalls: string[] = [];
    const accountControlFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("browser-pool")) poolCalls.push(url.pathname);
      return new Response("not found", { status: 404 });
    };
    try {
      const { host } = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      expect((await host.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
        ok: true,
      });
      expect(host.browser.usesPoolAdmission).toBe(false);
      await expect(access(managedBrowserPoolKeysPath(join(directory, "host")))).rejects.toThrow();
      expect(poolCalls).toEqual([]);
    } finally {
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses browser opens with no local fallback when browserPool is set and no target is ready", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-no-target-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: true });
    const accountControlFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (
        url.pathname === managedBrowserPoolRegistrationPath ||
        url.pathname === managedBrowserPoolTargetPath
      ) {
        return Response.json({ status: "preparing" } satisfies ManagedBrowserPoolTargetResponse);
      }
      return new Response("not found", { status: 404 });
    };
    try {
      const { host } = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: {
            firstDelayMs: 50,
            maxDelayMs: 150,
            idleParkMs: 250,
            statusEveryMs: 150,
          },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      // Before the account answers, /healthz stays plain and /ready reports no-target.
      expect((await host.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
        ok: true,
      });
      expect((await host.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
        ok: true,
        browserPool: "no-target",
      });
      const { ownerId } = await claimHome(host);
      await enrollMainRunner(host, config);
      await vi.waitFor(
        async () => {
          expect((await host.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "preparing",
          });
        },
        { timeout: 5_000 },
      );
      await expect(
        host.browser.openTab(ownerId, {
          type: "browser.tab.open",
          idempotencyKey: `open-refused-${randomUUID()}`,
          identity: { kind: "guest" },
          url: "https://example.test/refused",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        reason: "browser-placement-unavailable",
      });
      expect(
        await host.store.database.selectFrom("browserSessions").select("id").execute(),
      ).toEqual([]);
      expect(host.browser.usesPoolAdmission).toBe(false);
    } finally {
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a local main Runner browser auxiliary stream on a pooled Home", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-refuse-local-relay-"));
    const port = await freePort();
    const config = managedConfig(database.url, directory, port, { browserPool: true });
    const accountControlFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (
        url.pathname === managedBrowserPoolRegistrationPath ||
        url.pathname === managedBrowserPoolTargetPath
      ) {
        return Response.json({ status: "preparing" } satisfies ManagedBrowserPoolTargetResponse);
      }
      return new Response("not found", { status: 404 });
    };
    let primary: WebSocket | undefined;
    let auxiliary: WebSocket | undefined;
    let host: PersonalHostRuntime | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: { firstDelayMs: 50, maxDelayMs: 150 },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        await runtime.listen();
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      await claimHome(host);

      const nextJson = (socket: WebSocket) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const onMessage = (raw: WebSocket.RawData) => {
            socket.off("error", onError);
            resolve(JSON.parse(String(raw)) as Record<string, unknown>);
          };
          const onError = (error: Error) => {
            socket.off("message", onMessage);
            reject(error);
          };
          socket.once("message", onMessage);
          socket.once("error", onError);
        });

      primary = new WebSocket(`ws://127.0.0.1:${port}/internal/v1/runners`);
      const challengeFrame = await nextJson(primary);
      expect(challengeFrame.type).toBe("host.challenge");
      const challenge = RunnerChallengeSchema.parse(challengeFrame);
      const runnerId = createId("runner");
      const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
      const runnerKeys = generateKeyPairSync("ed25519");
      const publicKeyPem = runnerKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
      const descriptor = RunnerDescriptorSchema.parse({
        bootId,
        capabilities: [],
        modules: { browser: { wireVersion: 2, runtimeId: "browser-main" } },
        name: "Cloud Computer",
        runnerId,
        runnerKind: "main",
        runtimeVersion: "test",
      });
      const credential = {
        enrollmentToken: mainRunnerToken,
        kind: "host-enrollment-token" as const,
      };
      const welcomePromise = nextJson(primary);
      primary.send(
        JSON.stringify({
          challengeId: challenge.challengeId,
          credential,
          descriptor,
          proofFormatVersion: runnerProofFormatVersion,
          publicKeyPem,
          signature: createRunnerEnrollmentSignature(runnerKeys.privateKey, {
            challenge,
            credential,
            descriptor,
            publicKeyPem,
          }),
          type: "runner.enroll",
        }),
      );
      const welcome = await welcomePromise;
      expect(welcome.type).toBe("host.welcome");

      const ticketPromise = nextJson(primary);
      primary.send(
        JSON.stringify({
          bootId,
          connectionGeneration: welcome.connectionGeneration,
          connectionId: welcome.connectionId,
          connectionLeaseId: welcome.connectionLeaseId,
          module: "browser",
          requestId: "browser-stream-refused",
          runnerId,
          type: "runner.auxiliary.ticket-request",
        }),
      );
      const ticketFrame = await ticketPromise;
      expect(ticketFrame.type).toBe("host.auxiliary.ticket");
      const ticket = String(ticketFrame.ticket);

      auxiliary = new WebSocket(`ws://127.0.0.1:${port}/internal/v1/runners/auxiliary/browser`);
      const auxChallengeFrame = await nextJson(auxiliary);
      expect(auxChallengeFrame.type).toBe("host.auxiliary.challenge");
      const auxChallenge = RunnerAuxiliaryChallengeSchema.parse(auxChallengeFrame);

      const rejectedPromise = nextJson(auxiliary);
      const closedPromise = new Promise<{ code: number; reason: string }>((resolve) => {
        auxiliary!.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      auxiliary.send(
        JSON.stringify({
          bootId,
          challengeId: auxChallenge.challengeId,
          module: "browser",
          runnerId,
          signature: createRunnerAuxiliarySignature(runnerKeys.privateKey, {
            bootId,
            challenge: auxChallenge,
            module: "browser",
            runnerId,
            ticket,
          }),
          ticket,
          type: "runner.auxiliary.authenticate",
        }),
      );
      expect(await rejectedPromise).toMatchObject({
        type: "host.auxiliary.rejected",
      });
      expect(await closedPromise).toEqual({
        code: 4003,
        reason: "Managed browser pool refuses local browser relay",
      });
    } finally {
      auxiliary?.terminate();
      primary?.terminate();
      await host?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("holds off idle park while a viewer watches and retries after a vetoed park", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-idle-veto-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      const coordinator = managedBrowserPoolCoordinator({
        database: host.store.database,
        runnerId,
        target: poolHost.target,
        keys,
        idleParkMs: 120,
        onSuspect: () => {},
      });
      try {
        await coordinator.recover();
        // Start the guest by taking and releasing a reservation.
        const initial = await coordinator.gate.reserve(new AbortController().signal);
        initial.release();
        expect((await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)).phase).toBe(
          "running",
        );

        // While a viewer is watching, park is vetoed and the guest stays running.
        const releaseViewer = coordinator.gate.viewing();
        expect(coordinator.gate.viewers).toBe(1);
        expect(await coordinator.tryPark()).toBe("vetoed");
        expect((await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)).phase).toBe(
          "running",
        );

        // While a holder holds the gate, an explicit tryPark() is vetoed; once released, the
        // idle timer re-arms and parks automatically at the next idle period.
        const holder = await coordinator.gate.reserve(new AbortController().signal);
        releaseViewer();
        expect(coordinator.gate.viewers).toBe(0);
        expect(coordinator.gate.held).toBe(1);
        expect(await coordinator.tryPark()).toBe("vetoed");
        expect((await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)).phase).toBe(
          "running",
        );
        holder.release();

        await vi.waitFor(
          async () => {
            expect(
              (await poolHost!.agent.agent.status(poolHost!.slotId, poolHost!.term)).phase,
            ).toBe("paused");
          },
          { timeout: 10_000 },
        );
      } finally {
        coordinator.close();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function createConnectedAgentSession(
  host: PersonalHostRuntime,
  ownerId: UserId,
  config: HostConfig,
) {
  await initializePersonalState(host.store.database, {
    agentHome: config.personal!.agentHome,
    environmentId: config.personal!.environmentId,
  });
  const settings = await host.store.database
    .selectFrom("personalSettings")
    .select("agentHomeComputerId")
    .executeTakeFirstOrThrow();
  await host.store.database
    .insertInto("executionEnvironments")
    .values({
      capabilities: [],
      id: config.personal!.environmentId,
      kind: "main",
      name: "Cloud Computer",
      runnerId: settings.agentHomeComputerId,
    })
    .onConflict((conflict) => conflict.column("id").doNothing())
    .execute();
  const connections = new AgentConnectionStore(host.store.database);
  const connection = await connections.create({
    userId: ownerId,
    label: "Pooled test agent",
    clientName: "Pooled test agent",
    accessMode: "full-access",
    grant: { scope: "everything" },
    resource: `${homeOrigin}/mcp`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(await connections.activate(connection.id, randomUUID())).toBe(true);
  const { session } = await beginAgentSession(host.store.database, {
    userId: ownerId,
    agentConnectionId: connection.id,
  });
  return {
    agentBindingId: `session:${session.id}`,
    ownerId,
    threadId: session.threadId,
  };
}

describe("Managed browser pool review fixes (W1-W4, S2, S4-S7, idle holds)", () => {
  it("W1: keeps person viewer and agent CDP live while a real main Runner opens and retries its browser stream", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-w1-"));
    const port = await freePort();
    const config = managedConfig(database.url, directory, port, { browserPool: true });
    let registeredKeys:
      | {
          readonly homeKey: string;
          readonly relayKey: string;
          readonly ticketKey: { readonly keyId: string; readonly spki: string };
        }
      | undefined;
    let targetResponse: ManagedBrowserPoolTargetResponse = { status: "preparing" };
    const accountControlFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === managedBrowserPoolRegistrationPath && init?.method === "PUT") {
        const parsed = ManagedBrowserPoolRegistrationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        registeredKeys = parsed.document.keys;
        return Response.json(targetResponse);
      }
      if (url.pathname === managedBrowserPoolTargetPath) {
        return Response.json(registeredKeys ? targetResponse : { status: "unregistered" });
      }
      return new Response("not found", { status: 404 });
    };
    let primary: WebSocket | undefined;
    const auxiliaries: WebSocket[] = [];
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: {
            firstDelayMs: 50,
            maxDelayMs: 150,
            idleParkMs: 60_000,
            statusEveryMs: 250,
          },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        await runtime.listen();
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      const { ownerId } = await claimHome(host);

      const nextJson = (socket: WebSocket) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const onMessage = (raw: WebSocket.RawData) => {
            socket.off("error", onError);
            resolve(JSON.parse(String(raw)) as Record<string, unknown>);
          };
          const onError = (error: Error) => {
            socket.off("message", onMessage);
            reject(error);
          };
          socket.once("message", onMessage);
          socket.once("error", onError);
        });

      primary = new WebSocket(`ws://127.0.0.1:${port}/internal/v1/runners`);
      const challenge = RunnerChallengeSchema.parse(await nextJson(primary));
      const runnerId = createId("runner");
      const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
      const runnerKeys = generateKeyPairSync("ed25519");
      const publicKeyPem = runnerKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
      const descriptor = RunnerDescriptorSchema.parse({
        bootId,
        capabilities: [],
        modules: { browser: { wireVersion: 2, runtimeId: "browser-main" } },
        name: "Cloud Computer",
        runnerId,
        runnerKind: "main",
        runtimeVersion: "test",
      });
      const credential = {
        enrollmentToken: mainRunnerToken,
        kind: "host-enrollment-token" as const,
      };
      const welcomePromise = nextJson(primary);
      primary.send(
        JSON.stringify({
          challengeId: challenge.challengeId,
          credential,
          descriptor,
          proofFormatVersion: runnerProofFormatVersion,
          publicKeyPem,
          signature: createRunnerEnrollmentSignature(runnerKeys.privateKey, {
            challenge,
            credential,
            descriptor,
            publicKeyPem,
          }),
          type: "runner.enroll",
        }),
      );
      const welcome = await welcomePromise;
      expect(welcome.type).toBe("host.welcome");

      await vi.waitFor(() => expect(registeredKeys).toBeDefined(), { timeout: 5_000 });
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      targetResponse = { status: "ready", target: poolHost.target };

      await vi.waitFor(() => expect(host!.browser.usesPoolAdmission).toBe(true), {
        timeout: 10_000,
      });

      const profile = await host.browser.createProfile({
        ownerId,
        name: "W1 Work",
        idempotencyKey: `w1-profile-${randomUUID()}`,
      });
      const opened = await host.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `w1-open-${randomUUID()}`,
        identity: { kind: "profile", profileId: profile.id },
        url: "https://example.test/w1",
      });

      // Attach a real person viewer.
      let viewerClosed = false;
      const viewerPeer = {
        id: `viewer-${randomUUID()}`,
        isOpen: () => !viewerClosed,
        close: () => {
          viewerClosed = true;
        },
        send: async () => {},
      };
      const viewer = await host.browser.attach(ownerId, opened.sessionId, viewerPeer, {
        authSessionId: `aus_${randomUUID()}` as AuthSessionId,
        mode: "control",
        signedIn: async () => true,
      });

      // Attach a real connected-agent CDP connection on the same pooled session.
      const agent = await createConnectedAgentSession(host, ownerId, config);
      await host.browser.openAgentSession({
        agentBindingId: agent.agentBindingId,
        ownerId,
        sessionId: opened.sessionId,
      });
      let agentClosed = false;
      const agentCdp = await host.browser.attachCdpForAgent(
        { agentBindingId: agent.agentBindingId, ownerId, sessionId: opened.sessionId },
        () => {},
        () => {
          agentClosed = true;
        },
      );

      // Now simulate the real main Runner opening and retrying its local browser stream twice!
      for (let attempt = 1; attempt <= 2; attempt++) {
        const ticketPromise = nextJson(primary);
        primary.send(
          JSON.stringify({
            bootId,
            connectionGeneration: welcome.connectionGeneration,
            connectionId: welcome.connectionId,
            connectionLeaseId: welcome.connectionLeaseId,
            module: "browser",
            requestId: `w1-browser-retry-${attempt}`,
            runnerId,
            type: "runner.auxiliary.ticket-request",
          }),
        );
        const ticketFrame = await ticketPromise;
        expect(ticketFrame.type).toBe("host.auxiliary.ticket");
        const aux = new WebSocket(`ws://127.0.0.1:${port}/internal/v1/runners/auxiliary/browser`);
        auxiliaries.push(aux);
        const auxChallenge = RunnerAuxiliaryChallengeSchema.parse(await nextJson(aux));
        const rejectedPromise = nextJson(aux);
        const closedPromise = new Promise<{ code: number; reason: string }>((resolve) => {
          aux.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        });
        aux.send(
          JSON.stringify({
            bootId,
            challengeId: auxChallenge.challengeId,
            module: "browser",
            runnerId,
            signature: createRunnerAuxiliarySignature(runnerKeys.privateKey, {
              bootId,
              challenge: auxChallenge,
              module: "browser",
              runnerId,
              ticket: String(ticketFrame.ticket),
            }),
            ticket: String(ticketFrame.ticket),
            type: "runner.auxiliary.authenticate",
          }),
        );
        expect(await rejectedPromise).toMatchObject({ type: "host.auxiliary.rejected" });
        expect((await closedPromise).code).toBe(4003);
      }

      // Primary Runner connection, person viewer, agent CDP, and further opens must ALL stay alive!
      expect(primary.readyState).toBe(WebSocket.OPEN);
      expect(viewerClosed).toBe(false);
      expect(agentClosed).toBe(false);
      await expect(agentCdp.request({ method: "Browser.getVersion" })).resolves.toBeDefined();
      const secondTab = await host.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `w1-open-2-${randomUUID()}`,
        identity: { kind: "guest" },
        url: "https://example.test/w1-after-retry",
      });
      expect(secondTab.sessionId).toBeTruthy();

      agentCdp.close();
      viewer.close();
    } finally {
      for (const aux of auxiliaries) aux.terminate();
      primary?.terminate();
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("W2: re-attaches the pool relay while the guest is running after a detach", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-w2-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      const hub = new RunnerBrowserHub();
      const hostKey = generateKeyPairSync("ed25519").privateKey;
      const pool = await startManagedBrowserPool({
        database: host.store.database,
        dataDirectory: join(directory, "host"),
        cloudComputerId,
        runnerId,
        hostKey,
        browser: host.browser,
        browserRelay: hub,
        idleParkMs: 60_000,
        statusEveryMs: 250,
        account: {
          register: async () => ({ status: "ready", target: poolHost!.target }),
          target: async () => ({ status: "ready", target: poolHost!.target }),
        },
      });
      try {
        await vi.waitFor(
          () => {
            expect(hub.stream(runnerId)).not.toBeNull();
            expect(pool.status()).toBe("ready");
          },
          { timeout: 10_000 },
        );

        // Detach the relay while the guest stays running.
        hub.detachRunner(runnerId, "transport-disconnected");
        expect(hub.stream(runnerId)).toBeNull();
        // Truthful status must leave "ready" while detached.
        expect(pool.status()).not.toBe("ready");

        // Coordinator must re-attach automatically while the guest stays running (without parking).
        await vi.waitFor(
          () => {
            expect(hub.stream(runnerId)).not.toBeNull();
            expect(pool.status()).toBe("ready");
          },
          { timeout: 10_000 },
        );
        expect((await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)).phase).toBe(
          "running",
        );
      } finally {
        await pool.close();
        hub.close();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("W3: never discards the person's live guest on Home-side relay attach failures (all 4 causes)", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-w3-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      const causes: readonly (() => Error)[] = [
        () =>
          new BrowserRelayError(
            "Update the Browser Runtime on this computer. The current native browser contract is required.",
          ),
        () => new BrowserRelayError("Browser runtime identity does not match configuration."),
        () => {
          const parsed = z.object({ wireVersion: z.literal(2) }).safeParse({ wireVersion: "bad" });
          return parsed.success ? new Error("unexpected") : parsed.error;
        },
        () =>
          new OpensteerError({
            code: "conflict",
            message: "The browser inventory contains a conflicting profile binding.",
          }),
      ];
      let attempts = 0;
      const discards: string[] = [];
      let allowAttach = false;
      const coordinator = managedBrowserPoolCoordinator({
        database: host.store.database,
        runnerId,
        target: poolHost.target,
        keys,
        idleParkMs: null,
        retryMs: 20,
        unansweredRetryMaxMs: 50,
        onDiscard: (reason) => discards.push(reason),
        onSuspect: () => {},
        onRunning: async () => {
          if (allowAttach) return;
          const cause = causes[attempts % causes.length]!;
          attempts += 1;
          throw cause();
        },
        onError: () => {},
      });
      try {
        // Override retry cadence indirectly? No — let's check with real coordinator recover() + fast check:
        // Actually use BrowserPoolCoordinator options via managedBrowserPoolCoordinator or wait for 8 attempts!
        // Wait: retryMs defaults to 100ms, 8 attempts with backoff 200+400+800+1600+3200+5000+5000 = ~16s (or with W3 fix, never discards!).
        const originalSlot = await poolHost.agent.agent.status(poolHost.slotId, poolHost.term);
        void originalSlot;
        void coordinator.recover().catch(() => undefined);
        await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(8), { timeout: 25_000 });
        const statusWhileFailing = await poolHost.agent.agent.status(
          poolHost.slotId,
          poolHost.term,
        );
        expect(statusWhileFailing.phase).toBe("running");
        const instanceBefore = statusWhileFailing.instance;
        allowAttach = true;
        await coordinator.recover();
        const statusAfter = await poolHost.agent.agent.status(poolHost.slotId, poolHost.term);
        expect(statusAfter.phase).toBe("running");
        expect(statusAfter.instance).toBe(instanceBefore);
        expect(discards).toEqual([]);
      } finally {
        coordinator.close();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it("W4: recovers and adopts a later target after an earlier choose() rejection", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-w4-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      const errors: unknown[] = [];
      let failAdoptOnce = true;
      let adoptedCount = 0;
      const hostKey = generateKeyPairSync("ed25519").privateKey;
      const pool = await startManagedBrowserPool({
        database: host.store.database,
        dataDirectory: join(directory, "host"),
        cloudComputerId,
        runnerId,
        hostKey,
        browser: {
          adoptPool: async (id, coordinator) => {
            if (failAdoptOnce) {
              failAdoptOnce = false;
              throw new Error("Simulated first choose() failure");
            }
            adoptedCount += 1;
            await host!.browser.adoptPool(id, coordinator);
          },
          retirePool: (id, reason) => host!.browser.retirePool(id, reason),
          drainPool: (id, coordinator) => host!.browser.drainPool(id, coordinator),
        },
        firstDelayMs: 30,
        maxDelayMs: 60,
        account: {
          register: async () => ({ status: "ready", target: poolHost!.target }),
          target: async () => ({ status: "ready", target: poolHost!.target }),
        },
        onError: (error) => errors.push(error),
      });
      try {
        await vi.waitFor(() => expect(adoptedCount).toBe(1), { timeout: 10_000 });
        expect(
          errors.some(
            (error) => error instanceof Error && error.message.includes("Simulated first choose()"),
          ),
        ).toBe(true);
      } finally {
        await pool.close();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("S2: refuses an unauthorized agent open without waking a parked pooled browser", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-s2-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: true });
    let registeredKeys:
      | {
          readonly homeKey: string;
          readonly relayKey: string;
          readonly ticketKey: { readonly keyId: string; readonly spki: string };
        }
      | undefined;
    let targetResponse: ManagedBrowserPoolTargetResponse = { status: "preparing" };
    const accountControlFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === managedBrowserPoolRegistrationPath && init?.method === "PUT") {
        const parsed = ManagedBrowserPoolRegistrationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        registeredKeys = parsed.document.keys;
        return Response.json(targetResponse);
      }
      if (url.pathname === managedBrowserPoolTargetPath) {
        return Response.json(registeredKeys ? targetResponse : { status: "unregistered" });
      }
      return new Response("not found", { status: 404 });
    };
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: {
            firstDelayMs: 50,
            maxDelayMs: 150,
            idleParkMs: 200,
            statusEveryMs: 150,
          },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      const { ownerId } = await claimHome(host);
      await enrollMainRunner(host, config);
      await vi.waitFor(() => expect(registeredKeys).toBeDefined(), { timeout: 5_000 });
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      targetResponse = { status: "ready", target: poolHost.target };
      await vi.waitFor(
        async () => {
          expect(host!.browser.usesPoolAdmission).toBe(true);
          expect((await host!.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );

      // Open a saved profile as person, then let it park automatically on idle.
      const profile = await host.browser.createProfile({
        ownerId,
        name: "S2 Work",
        idempotencyKey: `s2-profile-${randomUUID()}`,
      });
      await host.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `s2-person-${randomUUID()}`,
        identity: { kind: "profile", profileId: profile.id },
        url: "https://example.test/s2",
      });
      await vi.waitFor(
        async () => {
          expect((await poolHost!.agent.agent.status(poolHost!.slotId, poolHost!.term)).phase).toBe(
            "paused",
          );
        },
        { timeout: 10_000 },
      );

      // Restart the Home while the guest is parked so its in-process relay is not yet attached
      // (`!#resolveTarget(intended)` is true in `#resolveIdentityOpen`!).
      await host.close();
      host = undefined;
      const restarted = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: {
            firstDelayMs: 50,
            maxDelayMs: 150,
            idleParkMs: 200,
            statusEveryMs: 150,
          },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = restarted.host;
      await vi.waitFor(() => expect(host!.browser.usesPoolAdmission).toBe(true), {
        timeout: 10_000,
      });
      expect((await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)).phase).toBe(
        "paused",
      );

      // The main Runner is not connected (offline), so an admitted connected agent open must be
      // refused BEFORE waking the parked browser!
      const agent = await createConnectedAgentSession(host, ownerId, config);
      await expect(
        host.browser.openAgentTab(agent, {
          operationKey: `s2-agent-${randomUUID()}`,
          identity: { kind: "profile", profile: profile.id },
          url: "https://example.test/s2-agent",
        }),
      ).rejects.toThrow();

      // Browser must still be paused — a refused agent caller wakes nothing.
      expect((await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)).phase).toBe(
        "paused",
      );
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("S4 & S5: keeps /healthz plain, serves truthful browserPool on loopback /ready, and gives the person a readable refusal reason", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-s4s5-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: true });
    const accountControlFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (
        url.pathname === managedBrowserPoolRegistrationPath ||
        url.pathname === managedBrowserPoolTargetPath
      ) {
        return Response.json({ status: "preparing" } satisfies ManagedBrowserPoolTargetResponse);
      }
      return new Response("not found", { status: 404 });
    };
    let host: PersonalHostRuntime | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: { firstDelayMs: 50, maxDelayMs: 150 },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      // /healthz is public and must stay plain { ok: true }.
      expect((await host.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
        ok: true,
      });
      // Public forwarded /ready is refused (404).
      const forwardedReady = await host.app.inject({
        method: "GET",
        url: "/ready",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      expect(forwardedReady.statusCode).toBe(404);
      // Loopback /ready carries browserPool status.
      expect((await host.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
        ok: true,
        browserPool: "no-target",
      });

      const { ownerId } = await claimHome(host);
      await enrollMainRunner(host, config);
      await vi.waitFor(
        async () => {
          expect((await host!.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "preparing",
          });
        },
        { timeout: 5_000 },
      );

      await expect(
        host.browser.openTab(ownerId, {
          type: "browser.tab.open",
          idempotencyKey: `s5-preparing-${randomUUID()}`,
          identity: { kind: "guest" },
          url: "https://example.test/s5",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        reason: "browser-placement-unavailable",
        message: expect.stringContaining("Setting up your browser"),
      });
    } finally {
      await host?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("S7: retires and re-adopts the pool when a re-enrolled main Runner connects with a new Runner id", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-s7-"));
    const port = await freePort();
    const config = managedConfig(database.url, directory, port, { browserPool: true });
    let registeredKeys:
      | {
          readonly homeKey: string;
          readonly relayKey: string;
          readonly ticketKey: { readonly keyId: string; readonly spki: string };
        }
      | undefined;
    let targetResponse: ManagedBrowserPoolTargetResponse = { status: "preparing" };
    const accountControlFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === managedBrowserPoolRegistrationPath && init?.method === "PUT") {
        const parsed = ManagedBrowserPoolRegistrationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        registeredKeys = parsed.document.keys;
        return Response.json(targetResponse);
      }
      if (url.pathname === managedBrowserPoolTargetPath) {
        return Response.json(registeredKeys ? targetResponse : { status: "unregistered" });
      }
      return new Response("not found", { status: 404 });
    };
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: { firstDelayMs: 50, maxDelayMs: 150, idleParkMs: 60_000 },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        await runtime.listen();
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      const { ownerId } = await claimHome(host);
      const runner1 = await enrollMainRunner(host, config);
      await vi.waitFor(() => expect(registeredKeys).toBeDefined(), { timeout: 5_000 });
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      targetResponse = { status: "ready", target: poolHost.target };
      await vi.waitFor(
        async () => {
          expect(host!.browser.usesPoolAdmission).toBe(true);
          expect((await host!.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );

      // Revoke runner1 and enroll a replacement main Runner (runner2) via real WS registration.
      await host.store.database
        .updateTable("runners")
        .set({ revokedAt: new Date() })
        .where("id", "=", runner1)
        .execute();
      const runner2Token = randomBytes(32).toString("base64url");
      await host.store.createRunnerEnrollment({
        allowedModules: ["agents", "browser"],
        createdBy: ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: `s7-reenroll-${randomUUID()}`,
        issuanceModules: ["agents", "browser"],
        mainEnrollmentPurpose: "replacement",
        name: "Cloud Computer re-enrolled",
        requestFingerprint: `s7-${randomUUID()}`,
        runnerKind: "main",
        tokenHash: hashRunnerEnrollmentToken(runner2Token),
      });
      const nextJson = (socket: WebSocket) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const onMessage = (raw: WebSocket.RawData) => {
            socket.off("error", onError);
            resolve(JSON.parse(String(raw)) as Record<string, unknown>);
          };
          const onError = (error: Error) => {
            socket.off("message", onMessage);
            reject(error);
          };
          socket.once("message", onMessage);
          socket.once("error", onError);
        });
      const primary2 = new WebSocket(`ws://127.0.0.1:${port}/internal/v1/runners`);
      try {
        const challenge = RunnerChallengeSchema.parse(await nextJson(primary2));
        const runner2 = createId("runner");
        const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
        const runnerKeys = generateKeyPairSync("ed25519");
        const publicKeyPem = runnerKeys.publicKey
          .export({ format: "pem", type: "spki" })
          .toString();
        const descriptor = RunnerDescriptorSchema.parse({
          bootId,
          capabilities: [],
          modules: { browser: { wireVersion: 2, runtimeId: "browser-main" } },
          name: "Cloud Computer",
          runnerId: runner2,
          runnerKind: "main",
          runtimeVersion: "test",
        });
        const credential = {
          enrollmentToken: runner2Token,
          kind: "host-enrollment-token" as const,
        };
        const welcomePromise = nextJson(primary2);
        primary2.send(
          JSON.stringify({
            challengeId: challenge.challengeId,
            credential,
            descriptor,
            proofFormatVersion: runnerProofFormatVersion,
            publicKeyPem,
            signature: createRunnerEnrollmentSignature(runnerKeys.privateKey, {
              challenge,
              credential,
              descriptor,
              publicKeyPem,
            }),
            type: "runner.enroll",
          }),
        );
        expect((await welcomePromise).type).toBe("host.welcome");

        await vi.waitFor(
          async () => {
            expect((await host!.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
              ok: true,
              browserPool: "ready",
            });
          },
          { timeout: 10_000 },
        );
        // Opening a tab must succeed on runner2 (never stuck "between states" on runner1).
        await vi.waitFor(
          async () => {
            const opened = await host!.browser.openTab(ownerId, {
              type: "browser.tab.open",
              idempotencyKey: `s7-open-${randomUUID()}`,
              identity: { kind: "guest" },
              url: "https://example.test/s7",
            });
            expect(opened.sessionId).toBeTruthy();
          },
          { timeout: 10_000 },
        );
      } finally {
        primary2.terminate();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("S3: derives pooled modules.browser capabilities from the guest contract without falsely advertising passkeys", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-s3-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      const hub = new RunnerBrowserHub();
      const hostKey = generateKeyPairSync("ed25519").privateKey;
      const pool = await startManagedBrowserPool({
        database: host.store.database,
        dataDirectory: join(directory, "host"),
        cloudComputerId,
        runnerId,
        hostKey,
        browser: host.browser,
        browserRelay: hub,
        passkeys: false,
        idleParkMs: 60_000,
        account: {
          register: async () => ({ status: "ready", target: poolHost!.target }),
          target: async () => ({ status: "ready", target: poolHost!.target }),
        },
      });
      try {
        await vi.waitFor(() => expect(hub.stream(runnerId)).not.toBeNull(), { timeout: 10_000 });
        const advertised = hub.stream(runnerId)!.identity.modules.browser!;
        const guestHealth = poolHost.runtime.health();
        expect(advertised.wireVersion).toBe(guestHealth.wireVersion);
        expect(advertised.standardCdp).toBe(guestHealth.standardCdp);
        expect(advertised.standardCdpLineage).toBe(guestHealth.standardCdpLineage);
        expect(advertised.connectionCommands).toBe(guestHealth.connectionCommands);
        expect(advertised.standardCdpLeaseRecovery).toBe(guestHealth.standardCdpLeaseRecovery);
        expect(advertised.standardCdpAttemptRecovery).toBe(guestHealth.standardCdpAttemptRecovery);
        expect(advertised.wholeContextCdp).toBe(guestHealth.wholeContextCdp);
        expect(advertised.passkeys).toBeUndefined();
      } finally {
        await pool.close();
        hub.close();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("S6: refuses to fall back to the Home key when a pooledOnly Home has no pool signer", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-s6-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: true });
    const accountControlFetch: typeof globalThis.fetch = async () =>
      Response.json({ status: "preparing" } satisfies ManagedBrowserPoolTargetResponse);
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: { firstDelayMs: 50, maxDelayMs: 150 },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      const { ownerId } = await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      // Build a second BrowserService with pooledOnly: true and NO setPoolSigner() call:
      // opening a pooled tab must throw rather than silently minting a ticket with the Home key.
      let connectCalled = false;
      const pooledOnlyWithoutSigner = new BrowserService({
        deploymentId: host.deployment.id,
        hostOrigin: new URL(homeOrigin),
        onSessionsChanged: () => {},
        pooledOnly: true,
        pooledRunner: runnerId,
        repository: host.store,
        signer: new BrowserAttachTicketSigner({
          keyId: "home-key-must-never-be-used",
          privateKey: generateKeyPairSync("ed25519").privateKey,
        }),
        targetResolver: {
          resolve: () => ({
            placementKey: `runner:${runnerId}`,
            runnerId,
            runnerName: "Cloud Computer",
            runtimeId: pooledBrowserRuntimeId,
            wireVersion: 2,
            connect: () => {
              connectCalled = true;
              throw new Error("should not reach connect without pool signer");
            },
          }),
          placements: () => [
            {
              kind: "runner",
              label: "Cloud Computer",
              environmentIds: [],
              runnerId,
              runtimeId: pooledBrowserRuntimeId,
              available: true,
            },
          ],
        },
      });
      const coordinator = managedBrowserPoolCoordinator({
        database: host.store.database,
        runnerId,
        target: poolHost.target,
        keys,
        idleParkMs: null,
        onSuspect: () => {},
      });
      try {
        await pooledOnlyWithoutSigner.adoptPool(runnerId, coordinator);
        await coordinator.recover();
        await expect(
          pooledOnlyWithoutSigner.start({
            ownerId,
            placement: { kind: "runner", runnerId },
            fresh: true,
          }),
        ).rejects.toThrow(/pooled browser attach key is not configured/iu);
        expect(connectCalled).toBe(false);
      } finally {
        coordinator.close();
        await pooledOnlyWithoutSigner.close();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("M1: relay outage never blocks Stop, reports unreachable, consults account, and reattaches same guest", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-m1-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      const { ownerId } = await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      const parts = managedBrowserPool(poolHost.target, keys);
      let relayAttached = false;
      let relayDown = true;
      let suspectCalls = 0;
      const coordinator = new BrowserPoolCoordinator({
        database: host.store.database,
        runnerId,
        runtimeId: pooledBrowserRuntimeId,
        slotId: poolHost.slotId,
        term: poolHost.term,
        runtime: parts.runtime,
        controller: parts.controller,
        idleParkMs: null,
        retryMs: 25,
        unansweredRetryMaxMs: 50,
        unreachableAfterMs: 120,
        unansweredMs: 120,
        statusEveryMs: 100,
        relay: {
          attached: () => relayAttached,
          attach: async () => {
            if (relayDown) throw new Error("Simulated permanent relay outage");
            relayAttached = true;
          },
        },
        onSuspect: () => {
          suspectCalls += 1;
        },
        onError: () => {},
      });
      try {
        host.browser.setPoolSigner(
          new BrowserAttachTicketSigner({
            keyId: keys.ticketKey.keyId,
            privateKey: keys.ticketKey.key,
          }),
        );
        await host.browser.adoptPool(runnerId, coordinator);
        await vi.waitFor(
          async () => {
            const st = await poolHost!.agent.agent.status(poolHost!.slotId, poolHost!.term);
            expect(st.phase).toBe("running");
          },
          { timeout: 10_000 },
        );
        const instanceBefore = (await poolHost.agent.agent.status(poolHost.slotId, poolHost.term))
          .instance;
        const readPlacementRevision = async () => {
          const row = await host!.store.database
            .selectFrom("clientSyncState")
            .select("resourceRevisions")
            .executeTakeFirst();
          return Number(
            (row?.resourceRevisions as Record<string, string> | undefined)?.["browser-placement"] ??
              0,
          );
        };
        const versionBefore = await readPlacementRevision();

        // Create a ready session belonging to this slot/term, then ask Stop while relay is down.
        const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
        await host.store.database
          .insertInto("browserSessions")
          .values({
            id: sessionId,
            tabGroupId: sessionId,
            origin: "person",
            profileId: null,
            placementKey: `runner:${runnerId}`,
            runnerId,
            runtimeId: pooledBrowserRuntimeId,
            state: "ready",
            opener: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
          })
          .execute();
        await host.store.database
          .insertInto("browserPoolSessions")
          .values({
            sessionId,
            runnerId,
            slotId: poolHost.slotId,
            term: poolHost.term,
          })
          .execute();
        await host.store.database
          .insertInto("browserSessionAttachments")
          .values({
            sessionId,
            ownerId,
            agentBindingId: `person:${ownerId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .execute();
        await stopBrowserPoolSession(host.store.database, { runnerId, sessionId });
        coordinator.stopped();

        // 1. Stop must reach "closed" through the control API even while relay is down.
        await vi.waitFor(
          async () => {
            const row = await host!.store.database
              .selectFrom("browserSessions")
              .select("state")
              .where("id", "=", sessionId)
              .executeTakeFirstOrThrow();
            expect(row.state).toBe("closed");
          },
          { timeout: 5_000 },
        );

        // 2. Clients receive the unreachable announcement and report() shows unreachable.
        await vi.waitFor(
          async () => {
            expect(coordinator.report()?.unreachable).toBe(true);
            expect(await readPlacementRevision()).toBeGreaterThan(versionBefore);
          },
          { timeout: 5_000 },
        );

        // 3. Account is consulted via onSuspect.
        await vi.waitFor(() => expect(suspectCalls).toBeGreaterThanOrEqual(1), { timeout: 5_000 });

        // 4. When relay returns, it attaches with the same guest instance and clears unreachable.
        relayDown = false;
        await vi.waitFor(
          () => {
            expect(relayAttached).toBe(true);
            expect(coordinator.report()?.unreachable).toBeUndefined();
          },
          { timeout: 5_000 },
        );
        const instanceAfter = (await poolHost.agent.agent.status(poolHost.slotId, poolHost.term))
          .instance;
        expect(instanceAfter).toBe(instanceBefore);
      } finally {
        coordinator.close();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("M2: a retired target's hanging capabilities read cannot overwrite the replacement target's peer", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-m2-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost1: LoopbackPoolHost | undefined;
    let poolHost2: LoopbackPoolHost | undefined;
    const origCapabilities = LocalBrowserRuntimeBridge.prototype.capabilities;
    let hangNextCap = false;
    const hangingCapGate = Promise.withResolvers<void>();
    const hangingCapEntered = Promise.withResolvers<void>();
    const hangingCapFinished = Promise.withResolvers<void>();
    const capSpy = vi
      .spyOn(LocalBrowserRuntimeBridge.prototype, "capabilities")
      .mockImplementation(async function (this: LocalBrowserRuntimeBridge, ...args: unknown[]) {
        if (hangNextCap) {
          hangNextCap = false;
          hangingCapEntered.resolve();
          await hangingCapGate.promise;
          try {
            return await (
              origCapabilities as (
                ...a: unknown[]
              ) => Promise<Awaited<ReturnType<LocalBrowserRuntimeBridge["capabilities"]>>>
            ).apply(this, args);
          } finally {
            hangingCapFinished.resolve();
          }
        }
        return (
          origCapabilities as (
            ...a: unknown[]
          ) => Promise<Awaited<ReturnType<LocalBrowserRuntimeBridge["capabilities"]>>>
        ).apply(this, args);
      });
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost1 = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      poolHost2 = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      const hub = new RunnerBrowserHub();
      let currentTarget = poolHost1.target;
      const hostKey = generateKeyPairSync("ed25519").privateKey;
      const pool = await startManagedBrowserPool({
        database: host.store.database,
        dataDirectory: join(directory, "host"),
        cloudComputerId,
        runnerId,
        hostKey,
        browser: host.browser,
        browserRelay: hub,
        idleParkMs: null,
        firstDelayMs: 30,
        maxDelayMs: 60,
        account: {
          register: async () => ({ status: "ready", target: currentTarget }),
          target: async () => ({ status: "ready", target: currentTarget }),
        },
        onError: () => {},
      });
      try {
        // Wait until target 1 is running and attached.
        await vi.waitFor(() => expect(hub.stream(runnerId)).not.toBeNull(), { timeout: 10_000 });
        // Detach target 1's relay and hang its reattach's capabilities() read.
        hangNextCap = true;
        hub.detachRunner(runnerId, "transport-disconnected");
        await hangingCapEntered.promise;
        // Switch the account to target 2 while target 1's health read hangs.
        currentTarget = poolHost2.target;
        pool.targets.suspect();
        // Wait until target 2 attaches its peer to the hub.
        await vi.waitFor(() => expect(hub.stream(runnerId)).not.toBeNull(), { timeout: 10_000 });
        const target2StreamId = hub.stream(runnerId)!.auxiliaryStreamId;
        // Now let target 1's hanging capabilities read complete late.
        hangingCapGate.resolve();
        await hangingCapFinished.promise;
        // Let the post-await continuation in target 1's attach settle.
        await Promise.resolve();
        await Promise.resolve();
        // The hub MUST still hold target 2's peer, never overwritten by target 1.
        expect(hub.stream(runnerId)?.auxiliaryStreamId).toBe(target2StreamId);
      } finally {
        hangingCapGate.resolve();
        await pool.close();
        hub.close();
      }
    } finally {
      capSpy.mockRestore();
      await host?.close();
      await poolHost1?.close();
      await poolHost2?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("M3: discard and restart settle on physical install and never reboot the fresh guest on relay failures", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-m3-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      const { ownerId } = await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      host.browser.setPoolSigner(
        new BrowserAttachTicketSigner({
          keyId: keys.ticketKey.keyId,
          privateKey: keys.ticketKey.key,
        }),
      );
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      const parts = managedBrowserPool(poolHost.target, keys);
      let relayAttached = false;
      let failRelayCount = 0;
      let relayFailuresSeen = 0;
      let injectEndUnconfirmedOnce = false;
      const wrappedRuntime = {
        poolState: (signal?: AbortSignal) => parts.runtime.poolState(signal),
        controlPool: async (
          control: Parameters<typeof parts.runtime.controlPool>[0],
          sig: Uint8Array,
        ) => {
          if (injectEndUnconfirmedOnce && control.kind === "install") {
            injectEndUnconfirmedOnce = false;
            throw Object.assign(new Error("Simulated end-unconfirmed"), {
              reason: "end-unconfirmed",
            });
          }
          return parts.runtime.controlPool(control, sig);
        },
        endSession: (ticket: string, signal?: AbortSignal) =>
          parts.runtime.endSession(ticket, signal),
      };
      const coordinator = new BrowserPoolCoordinator({
        database: host.store.database,
        runnerId,
        runtimeId: pooledBrowserRuntimeId,
        slotId: poolHost.slotId,
        term: poolHost.term,
        runtime: wrappedRuntime,
        controller: parts.controller,
        idleParkMs: null,
        retryMs: 20,
        unansweredRetryMaxMs: 40,
        relay: {
          attached: () => relayAttached,
          attach: async () => {
            if (failRelayCount > 0) {
              failRelayCount -= 1;
              relayFailuresSeen += 1;
              throw new Error("Simulated post-install relay failure");
            }
            relayAttached = true;
          },
        },
        onSuspect: () => {},
        onError: () => {},
      });
      try {
        await host.browser.adoptPool(runnerId, coordinator);
        await coordinator.recover();
        await vi.waitFor(() => expect(relayAttached).toBe(true), { timeout: 5_000 });
        const instance1 = (await poolHost.agent.agent.status(poolHost.slotId, poolHost.term))
          .instance;

        // Trigger a restart while relay fails 3 times: restart() must resolve on physical install,
        // and the 3 relay failures must never boot another guest.
        relayAttached = false;
        failRelayCount = 3;
        await Promise.race([
          coordinator.restart({ key: "m3-restart" }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("restart() did not settle on physical install")),
              4_000,
            ),
          ),
        ]);
        const instance2 = (await poolHost.agent.agent.status(poolHost.slotId, poolHost.term))
          .instance;
        expect(instance2).not.toBe(instance1);
        await vi.waitFor(
          () => {
            expect(relayFailuresSeen).toBe(3);
            expect(relayAttached).toBe(true);
          },
          { timeout: 5_000 },
        );
        expect((await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)).instance).toBe(
          instance2,
        );

        // Also trigger an independent discard (`end-unconfirmed`) while relay fails 3 times:
        // discard installs instance3 once, clears discard intent, and retries only relay attach.
        relayAttached = false;
        relayFailuresSeen = 0;
        failRelayCount = 3;
        injectEndUnconfirmedOnce = false;
        // Cause a discard via end-unconfirmed on endSession by injecting a closing session
        // whose runtime end fails with end-unconfirmed once.
        const origEnd = wrappedRuntime.endSession;
        let throwEndUnconfirmed = true;
        wrappedRuntime.endSession = async (ticket, signal) => {
          if (throwEndUnconfirmed) {
            throwEndUnconfirmed = false;
            throw Object.assign(new Error("Simulated end-unconfirmed"), {
              reason: "end-unconfirmed",
            });
          }
          return origEnd(ticket, signal);
        };
        const sid = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
        await host.store.database
          .insertInto("browserSessions")
          .values({
            id: sid,
            tabGroupId: sid,
            origin: "person",
            profileId: null,
            placementKey: `runner:${runnerId}`,
            runnerId,
            runtimeId: pooledBrowserRuntimeId,
            state: "closing",
            opener: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
          })
          .execute();
        await host.store.database
          .insertInto("browserPoolSessions")
          .values({
            sessionId: sid,
            runnerId,
            slotId: poolHost.slotId,
            term: poolHost.term,
          })
          .execute();
        await host.store.database
          .insertInto("browserSessionAttachments")
          .values({
            sessionId: sid,
            ownerId,
            agentBindingId: `person:${ownerId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .execute();
        coordinator.stopped();
        await vi.waitFor(
          async () => {
            const st = await poolHost!.agent.agent.status(poolHost!.slotId, poolHost!.term);
            expect(st.instance).not.toBe(instance2);
          },
          { timeout: 5_000 },
        );
        const instance3 = (await poolHost.agent.agent.status(poolHost.slotId, poolHost.term))
          .instance;
        await vi.waitFor(
          () => {
            expect(relayFailuresSeen).toBe(3);
            expect(relayAttached).toBe(true);
          },
          { timeout: 5_000 },
        );
        expect((await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)).instance).toBe(
          instance3,
        );
      } finally {
        coordinator.close();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("M4: level-triggered reconciliation survives startup rejection, failed retirement + new slot, failed rebind, and stale target ordering", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-m4-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost1: LoopbackPoolHost | undefined;
    let poolHost2: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      const { ownerId } = await claimHome(host);
      const runner1 = await enrollMainRunner(host, config);
      const enrollReplacementRunner = async (name: string): Promise<RunnerId> => {
        const token = randomBytes(32).toString("base64url");
        await host!.store.createRunnerEnrollment({
          allowedModules: ["agents", "browser"],
          createdBy: ownerId,
          expiresAt: new Date(Date.now() + 60_000),
          id: `ren_${randomUUID()}`,
          idempotencyKey: `m4-reenroll-${randomUUID()}`,
          issuanceModules: ["agents", "browser"],
          mainEnrollmentPurpose: "replacement",
          name,
          requestFingerprint: `m4-${randomUUID()}`,
          runnerKind: "main",
          tokenHash: hashRunnerEnrollmentToken(token),
        });
        const replacementKeys = generateKeyPairSync("ed25519");
        const replacementId = createId("runner");
        const publicKeyPem = replacementKeys.publicKey
          .export({ format: "pem", type: "spki" })
          .toString();
        await host!.store.enrollRunnerConnection({
          descriptor: {
            bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
            capabilities: [],
            modules: {},
            name,
            runnerId: replacementId,
            runnerKind: "main",
            runtimeVersion: "test",
          },
          enrollmentTokenHash: hashRunnerEnrollmentToken(token),
          publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyPem).digest("hex")}`,
          publicKeyPem,
        });
        return replacementId;
      };
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost1 = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      poolHost2 = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      // Pre-store poolHost1 as ready in DB to exercise startup with stored ready target.
      await recordBrowserPoolTargetAnswer(host.store.database, {
        cloudComputerId,
        status: "ready",
        target: poolHost1.target as unknown as Readonly<Record<string, unknown>>,
      });

      const hostKey = generateKeyPairSync("ed25519").privateKey;
      let accountTarget = poolHost1.target;
      let accountPolls = 0;
      let failFirstAdopt = true;
      let failNextRetire = false;
      let failNextRebindAdopt = false;
      let adoptedSlots: string[] = [];
      let blockRetireGate: PromiseWithResolvers<void> | undefined;
      let retireEnteredGate: PromiseWithResolvers<void> | undefined;
      const pool = await startManagedBrowserPool({
        database: host.store.database,
        dataDirectory: join(directory, "host"),
        cloudComputerId,
        runnerId: runner1,
        hostKey,
        firstDelayMs: 30,
        maxDelayMs: 60,
        idleParkMs: null,
        browser: {
          adoptPool: async (id, coordinator) => {
            if (failFirstAdopt) {
              failFirstAdopt = false;
              throw new Error("Simulated startup adopt failure");
            }
            if (failNextRebindAdopt) {
              failNextRebindAdopt = false;
              throw new Error("Simulated rebind adopt failure");
            }
            await host!.browser.adoptPool(id, coordinator);
            adoptedSlots.push(`${id}:${coordinator.ownSessions.slotId}`);
          },
          retirePool: async (id, reason) => {
            if (blockRetireGate) {
              retireEnteredGate?.resolve();
              await blockRetireGate.promise;
            }
            if (failNextRetire) {
              failNextRetire = false;
              throw new Error("Simulated retirement failure");
            }
            await host!.browser.retirePool(id, reason);
          },
          drainPool: (id, coordinator) => host!.browser.drainPool(id, coordinator),
        },
        account: {
          register: async () => {
            accountPolls += 1;
            return { status: "ready", target: accountTarget };
          },
          target: async () => {
            accountPolls += 1;
            return { status: "ready", target: accountTarget };
          },
        },
        onError: () => {},
      });
      try {
        // Case 1: Startup rejection did NOT throw out of startManagedBrowserPool, targets.start() ran,
        // and reconcile adopted poolHost1 on the next pass.
        await vi.waitFor(
          () => {
            expect(accountPolls).toBeGreaterThanOrEqual(1);
            expect(adoptedSlots).toContain(`${runner1}:${poolHost1!.slotId}`);
          },
          { timeout: 10_000 },
        );
        // Wait for slot row of poolHost1 to exist in DB.
        await vi.waitFor(
          async () => {
            const row = await host!.store.database
              .selectFrom("browserPoolSlots")
              .select(["runnerId", "slotId"])
              .where("runnerId", "=", runner1)
              .executeTakeFirst();
            expect(row?.slotId).toBe(poolHost1!.slotId);
          },
          { timeout: 10_000 },
        );

        // Case 2: Retirement fails once while switching to a different slot (poolHost2);
        // old slot row must still be retired and poolHost2 adopted cleanly.
        failNextRetire = true;
        accountTarget = poolHost2.target;
        pool.targets.suspect();
        await vi.waitFor(
          async () => {
            const row = await host!.store.database
              .selectFrom("browserPoolSlots")
              .select(["runnerId", "slotId"])
              .where("runnerId", "=", runner1)
              .executeTakeFirst();
            expect(row?.slotId).toBe(poolHost2!.slotId);
          },
          { timeout: 10_000 },
        );

        // Case 3: Rebind to a new runner fails once, then retries automatically without another call.
        await host.store.database
          .updateTable("runners")
          .set({ revokedAt: new Date() })
          .where("id", "=", runner1)
          .execute();
        const runner2 = await enrollReplacementRunner("Replaced Main Runner");
        failNextRebindAdopt = true;
        pool.bindRunner(runner2);
        await vi.waitFor(() => expect(adoptedSlots).toContain(`${runner2}:${poolHost2!.slotId}`), {
          timeout: 10_000,
        });

        // Case 4: Target A (poolHost1) cannot revert Target B (poolHost2) when bindRunner races
        // while a target switch from A -> B is in flight.
        // Switch back to poolHost1 first, then hold retirement while switching to poolHost2 AND rebinding.
        accountTarget = poolHost1.target;
        pool.targets.suspect();
        await vi.waitFor(
          () => expect(adoptedSlots.at(-1)).toBe(`${runner2}:${poolHost1!.slotId}`),
          { timeout: 10_000 },
        );
        blockRetireGate = Promise.withResolvers<void>();
        retireEnteredGate = Promise.withResolvers<void>();
        accountTarget = poolHost2.target;
        pool.targets.suspect();
        // Wait for reconcile to enter retirePool for poolHost1 -> poolHost2, then rebind runner3.
        await retireEnteredGate.promise;
        await host.store.database
          .updateTable("runners")
          .set({ revokedAt: new Date() })
          .where("id", "=", runner2)
          .execute();
        const runner3 = await enrollReplacementRunner("Third Main Runner");
        pool.bindRunner(runner3);
        blockRetireGate.resolve();
        blockRetireGate = undefined;
        await vi.waitFor(
          () => expect(adoptedSlots.at(-1)).toBe(`${runner3}:${poolHost2!.slotId}`),
          { timeout: 10_000 },
        );
        // Close awaits the reconciliation loop to full quiescence; verify it stayed on poolHost2.
        await pool.close();
        expect(adoptedSlots.at(-1)).toBe(`${runner3}:${poolHost2!.slotId}`);
      } finally {
        blockRetireGate?.resolve();
        await pool.close();
      }
    } finally {
      await host?.close();
      await poolHost1?.close();
      await poolHost2?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("A (Sol 1): relay attach failures during wake never discard a healthy guest", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-a-sol1-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });
      const parts = managedBrowserPool(poolHost.target, keys);
      let relayAttached = false;
      let failRelayDuringWake = false;
      let wakeRelayFailures = 0;
      const coordinator = managedBrowserPoolCoordinator({
        database: host.store.database,
        runnerId,
        target: poolHost.target,
        keys,
        parts,
        idleParkMs: null,
        retryMs: 25,
        unansweredRetryMaxMs: 50,
        relay: {
          attached: () => relayAttached,
          attach: async () => {
            if (failRelayDuringWake) {
              wakeRelayFailures += 1;
              if (wakeRelayFailures % 3 === 1) {
                throw new BrowserPoolAdmissionClosed("The pooled browser is not running.");
              }
              if (wakeRelayFailures % 3 === 2) {
                throw Object.assign(new Error("Simulated relay error carrying end-unconfirmed"), {
                  reason: "end-unconfirmed",
                });
              }
              throw new Error("Simulated non-network relay attach refusal during wake");
            }
            relayAttached = true;
          },
        },
        onSuspect: () => {},
        onError: () => {},
      });
      try {
        await host.browser.adoptPool(runnerId, coordinator);
        await vi.waitFor(
          async () => {
            const st = await poolHost!.agent.agent.status(poolHost!.slotId, poolHost!.term);
            expect(st.phase).toBe("running");
            expect(relayAttached).toBe(true);
          },
          { timeout: 10_000 },
        );
        const instanceBeforePark = (
          await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)
        ).instance;

        // Park the running guest cleanly.
        expect(await coordinator.tryPark()).toBe("parked");
        relayAttached = false;

        // Fail relay attach > 6 times (discardAfterAttempts = 6) during wake.
        failRelayDuringWake = true;
        const wakeAbort = new AbortController();
        const wakeHold = coordinator.gate.reserve(wakeAbort.signal);
        wakeHold.catch(() => undefined);
        await vi.waitFor(() => expect(wakeRelayFailures).toBeGreaterThanOrEqual(8), {
          timeout: 10_000,
        });

        // The healthy guest must NOT have been discarded/replaced!
        const statusWhileFailing = await poolHost.agent.agent.status(
          poolHost.slotId,
          poolHost.term,
        );
        expect(statusWhileFailing.instance).toBe(instanceBeforePark);

        // Once the relay recovers, wake completes on the SAME guest instance.
        failRelayDuringWake = false;
        const lease = await wakeHold;
        lease.release();
        expect((await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)).instance).toBe(
          instanceBeforePark,
        );
      } finally {
        coordinator.close();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("V1 (Sol 1): recovering a preparing-row park across a real Home restart attaches the relay for the exact guest and keeps retained tabs", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-v1-preparing-"));
    let host1: PersonalHostRuntime | undefined;
    let host2: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    let registeredKeys:
      | {
          readonly homeKey: string;
          readonly relayKey: string;
          readonly ticketKey: { readonly keyId: string; readonly spki: string };
        }
      | undefined;
    let targetResponse: ManagedBrowserPoolTargetResponse = { status: "preparing" };
    const accountControlFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === managedBrowserPoolRegistrationPath && init?.method === "PUT") {
        const parsed = ManagedBrowserPoolRegistrationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        registeredKeys = parsed.document.keys;
        return Response.json(targetResponse);
      }
      if (url.pathname === managedBrowserPoolTargetPath) {
        return Response.json(registeredKeys ? targetResponse : { status: "unregistered" });
      }
      return new Response("not found", { status: 404 });
    };
    try {
      const config1 = managedConfig(database.url, directory, await freePort(), {
        browserPool: true,
      });
      const started1 = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config1, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: { firstDelayMs: 50, maxDelayMs: 150, idleParkMs: 250 },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        await runtime.listen();
        return { host: runtime, close: () => runtime.close() };
      });
      host1 = started1.host;
      const { ownerId } = await claimHome(host1);
      const runnerId = await enrollMainRunner(host1, config1);
      await vi.waitFor(() => expect(registeredKeys).toBeDefined(), { timeout: 5_000 });
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      targetResponse = { status: "ready", target: poolHost.target };
      await vi.waitFor(
        async () => {
          expect((await host1!.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );

      // Hold the first `seal` control so Home 1 stops while the runtime has retired its sessions
      // and the Home's durable slot row is in `phase = "preparing"`.
      const sealReached = Promise.withResolvers<void>();
      const releaseSeal = Promise.withResolvers<void>();
      const originalControlPool = poolHost.runtime.controlPool.bind(poolHost.runtime);
      const controlSpy = vi
        .spyOn(poolHost.runtime, "controlPool")
        .mockImplementation(async (control, signature) => {
          if (control.kind === "seal") {
            sealReached.resolve();
            await releaseSeal.promise;
            throw new Error("Home 1 restarted before seal completed");
          }
          return originalControlPool(control, signature);
        });

      const opened = await host1.browser.openTab(ownerId, {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        placement: { kind: "runner", runnerId },
        idempotencyKey: `v1-preparing-${randomUUID()}`,
      });
      const instanceBeforeRestart = (
        await poolHost.agent.agent.status(poolHost.slotId, poolHost.term)
      ).instance;

      // Idle park runs retire -> reaches seal with the slot row in "preparing".
      await sealReached.promise;
      const slotBeforeRestart = await host1.store.database
        .selectFrom("browserPoolSlots")
        .select(["phase", "instanceId", "epoch"])
        .where("runnerId", "=", runnerId)
        .executeTakeFirst();
      expect(slotBeforeRestart?.phase).toBe("preparing");
      expect(poolHost.runtime.poolState()?.phase).toBe("retired");

      // Restart Home 1 before seal completes.
      releaseSeal.resolve();
      await host1.close();
      host1 = undefined;
      controlSpy.mockRestore();

      // Start Home 2 against the same database & pool host. Its recovery releases the preparing
      // park, attaches the real managed relay for the exact guest, and readopts the retained tab
      // on the SAME guest instance without replacing it.
      const config2 = managedConfig(database.url, directory, await freePort(), {
        browserPool: true,
      });
      const started2 = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config2, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: { firstDelayMs: 50, maxDelayMs: 150, idleParkMs: 60_000 },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        await runtime.listen();
        return { host: runtime, close: () => runtime.close() };
      });
      host2 = started2.host;

      await vi.waitFor(
        async () => {
          const ready = (await host2!.app.inject({ method: "GET", url: "/ready" })).json();
          const slot = await host2!.store.database
            .selectFrom("browserPoolSlots")
            .select(["phase", "instanceId"])
            .where("runnerId", "=", runnerId)
            .executeTakeFirst();
          expect(ready).toEqual({ ok: true, browserPool: "ready" });
          expect(slot?.phase).toBe("running");
        },
        { timeout: 15_000 },
      );

      const statusAfterRestart = await poolHost.agent.agent.status(poolHost.slotId, poolHost.term);
      expect(statusAfterRestart.instance).toBe(instanceBeforeRestart);
      const sessionAfterRestart = await host2.store.database
        .selectFrom("browserSessions")
        .select("state")
        .where("id", "=", opened.sessionId)
        .executeTakeFirst();
      expect(sessionAfterRestart?.state).toBe("ready");
      const losses = await host2.store.database
        .selectFrom("browserPoolDocumentLosses")
        .select("surfaceId")
        .where("sessionId", "=", opened.sessionId)
        .execute();
      expect(losses).toHaveLength(0);
    } finally {
      await host1?.close();
      await host2?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("I (Sol 4): Home restart between durable target B write and A retirement cleans stale slot A ready sessions and surfaces unconfirmed Stops", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-i-sol4-"));
    let host1: PersonalHostRuntime | undefined;
    let host2: PersonalHostRuntime | undefined;
    let poolHostA: LoopbackPoolHost | undefined;
    let poolHostB: LoopbackPoolHost | undefined;
    try {
      let registeredKeys:
        | {
            readonly homeKey: string;
            readonly relayKey: string;
            readonly ticketKey: { readonly keyId: string; readonly spki: string };
          }
        | undefined;
      let targetResponse: ManagedBrowserPoolTargetResponse = { status: "preparing" };
      const accountControlFetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === managedBrowserPoolRegistrationPath && init?.method === "PUT") {
          const parsed = ManagedBrowserPoolRegistrationRequestSchema.parse(
            JSON.parse(String(init.body)),
          );
          registeredKeys = parsed.document.keys;
          return Response.json(targetResponse);
        }
        if (url.pathname === managedBrowserPoolTargetPath) {
          return Response.json(registeredKeys ? targetResponse : { status: "unregistered" });
        }
        return new Response("not found", { status: 404 });
      };

      const config1 = managedConfig(database.url, directory, await freePort(), {
        browserPool: true,
      });
      const started1 = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config1, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: { firstDelayMs: 30, maxDelayMs: 60, idleParkMs: 60_000 },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        await runtime.listen();
        return { host: runtime, close: () => runtime.close() };
      });
      host1 = started1.host;
      const { ownerId } = await claimHome(host1);
      const runnerId = await enrollMainRunner(host1, config1);
      await vi.waitFor(() => expect(registeredKeys).toBeDefined(), { timeout: 5_000 });
      poolHostA = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      poolHostB = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      targetResponse = { status: "ready", target: poolHostA.target };
      // Wait for Home #1 to adopt slot A and open its pool relay.
      await vi.waitFor(
        async () => {
          const row = await host1!.store.database
            .selectFrom("browserPoolSlots")
            .select(["slotId", "phase"])
            .where("runnerId", "=", runnerId)
            .executeTakeFirst();
          expect(row).toEqual({ slotId: poolHostA!.slotId, phase: "running" });
          expect(host1!.browser.usesPoolAdmission).toBe(true);
        },
        { timeout: 10_000 },
      );

      const profileA = await host1.browser.createProfile({
        ownerId,
        name: "Sol 4 Ready Profile",
        idempotencyKey: `sol4-profile-${randomUUID()}`,
      });
      const readyTab = await host1.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `sol4-ready-${randomUUID()}`,
        identity: { kind: "profile", profileId: profileA.id },
        url: "https://example.test/ready-on-a",
      });
      const stoppingTab = await host1.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `sol4-stopping-${randomUUID()}`,
        identity: { kind: "guest" },
        url: "https://example.test/stopping-on-a",
      });
      expect(readyTab.sessionId).not.toBe(stoppingTab.sessionId);
      // Leave stoppingTab in `closing` on slot A (as a Stop whose runtime confirmation has not arrived).
      await host1.store.database
        .updateTable("browserSessions")
        .set({ state: "closing", updatedAt: new Date() })
        .where("id", "=", stoppingTab.sessionId)
        .execute();

      // Simulate Home crash right after recording target B in browser_pool_targets, BEFORE retiring slot A.
      targetResponse = { status: "ready", target: poolHostB.target };
      await recordBrowserPoolTargetAnswer(host1.store.database, {
        cloudComputerId,
        status: "ready",
        target: poolHostB.target as unknown as Readonly<Record<string, unknown>>,
      });
      await host1.close();
      host1 = undefined;

      // Start Home #2 against the same DB: browser_pool_slots still holds A while browser_pool_targets holds B.
      const config2 = managedConfig(database.url, directory, await freePort(), {
        browserPool: true,
      });
      const started2 = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config2, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: { firstDelayMs: 30, maxDelayMs: 60, idleParkMs: 60_000 },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        await runtime.listen();
        return { host: runtime, close: () => runtime.close() };
      });
      host2 = started2.host;
      await vi.waitFor(
        async () => {
          const row = await host2!.store.database
            .selectFrom("browserPoolSlots")
            .select(["slotId", "phase"])
            .where("runnerId", "=", runnerId)
            .executeTakeFirst();
          expect(row).toEqual({ slotId: poolHostB!.slotId, phase: "running" });
        },
        { timeout: 10_000 },
      );

      const readySession = await host2.store.database
        .selectFrom("browserSessions")
        .select(["id", "state", "closedAt"])
        .where("id", "=", readyTab.sessionId)
        .executeTakeFirst();
      const stoppingSession = await host2.store.database
        .selectFrom("browserSessions")
        .select(["id", "state", "closedAt"])
        .where("id", "=", stoppingTab.sessionId)
        .executeTakeFirst();
      const losses = await host2.store.database
        .selectFrom("browserPoolDocumentLosses")
        .select(["sessionId", "reason", "surfaceId"])
        .where("sessionId", "=", readyTab.sessionId)
        .execute();
      const unconfirmed = await listBrowserPoolUnconfirmedClosings(host2.store.database, runnerId);

      // Ready session on A must have ended with a loss note (NOT stranded as ready forever).
      expect(readySession?.state).toBe("failed");
      expect(losses.length).toBeGreaterThanOrEqual(1);
      // Unconfirmed Stop on A stays closing (no evidence from A) and surfaces as an unconfirmed closing.
      expect(stoppingSession?.state).toBe("closing");
      expect(unconfirmed.map((u) => u.sessionId)).toContain(stoppingTab.sessionId);
    } finally {
      await host1?.close();
      await host2?.close();
      await poolHostA?.close();
      await poolHostB?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("D & F (Sol 2 & diagnostic containment): drops stale-guest attach results on epoch change and keeps retrying when diagnostic callbacks throw", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-df-"));
    const config = managedConfig(database.url, directory, await freePort(), { browserPool: false });
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, { personalAccountGrantFetch: jwksFetch() });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      await claimHome(host);
      const runnerId = await enrollMainRunner(host, config);
      const keys = await loadOrCreateManagedBrowserPoolKeys(join(directory, "host"));
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: managedBrowserPoolRegistration(keys),
      });

      // F: throwing onError and onStatusChanged during a transient adopt failure must not kill retry.
      let failOnce = true;
      let adopted = false;
      let errorThrows = 0;
      let statusThrows = 0;
      const pool = await startManagedBrowserPool({
        database: host.store.database,
        dataDirectory: join(directory, "host"),
        cloudComputerId,
        runnerId,
        hostKey: generateKeyPairSync("ed25519").privateKey,
        firstDelayMs: 30,
        maxDelayMs: 60,
        idleParkMs: null,
        browser: {
          adoptPool: async (id, coordinator) => {
            if (failOnce) {
              failOnce = false;
              throw new Error("Transient adopt failure");
            }
            await host!.browser.adoptPool(id, coordinator);
            adopted = true;
          },
          retirePool: (id, reason) => host!.browser.retirePool(id, reason),
          drainPool: (id, coordinator) => host!.browser.drainPool(id, coordinator),
        },
        account: {
          register: async () => ({ status: "ready", target: poolHost!.target }),
          target: async () => ({ status: "ready", target: poolHost!.target }),
        },
        onError: () => {
          errorThrows += 1;
          throw new Error("Simulated throwing onError diagnostic callback");
        },
        onStatusChanged: () => {
          statusThrows += 1;
          throw new Error("Simulated throwing onStatusChanged diagnostic callback");
        },
      });
      try {
        await vi.waitFor(() => expect(adopted && pool.status() === "ready").toBe(true), {
          timeout: 10_000,
        });
        expect(errorThrows).toBeGreaterThanOrEqual(1);
        expect(statusThrows).toBeGreaterThanOrEqual(1);

        // D (Sol 2): if the slot's active guest `(instanceId, epoch)` changes while the relay
        // attach is in flight (either during capabilities or during relay.attach), the attach is
        // rejected with BrowserPoolAdmissionClosed and no stale peer is published on RunnerBrowserHub.
        const baseTransport = managedBrowserPool(poolHost.target, keys).transport;
        const hub = new RunnerBrowserHub();
        try {
          let activeGuest: { readonly instanceId: string; readonly epoch: number } | null = {
            instanceId: "guest-a",
            epoch: 1,
          };
          const capabilitiesEntered = Promise.withResolvers<void>();
          const releaseCapabilities = Promise.withResolvers<void>();
          let pauseFirstCapabilities = true;
          const gatedTransport: typeof baseTransport = {
            open: async () => {
              if (pauseFirstCapabilities) {
                pauseFirstCapabilities = false;
                capabilitiesEntered.resolve();
                await releaseCapabilities.promise;
              }
              return baseTransport.open();
            },
          };
          const relay1 = createManagedPooledRelay({
            browserRelay: hub,
            runnerId,
            runnerName: "Cloud Computer",
            environmentIds: [],
            transport: gatedTransport,
            ticketKey: keys.ticketKey,
            passkeys: false,
            currentGuest: () => activeGuest,
          });
          const attach1 = relay1.ensureAttached();
          await capabilitiesEntered.promise;
          // Guest epoch advances while /health is still in flight.
          activeGuest = { instanceId: "guest-a", epoch: 2 };
          releaseCapabilities.resolve();
          await expect(attach1).rejects.toBeInstanceOf(BrowserPoolAdmissionClosed);
          expect(relay1.isAttached()).toBe(false);
          expect(hub.stream(runnerId)).toBeNull();
          relay1.retire();

          // Second fence: guest instance changes right after hub.attach(), while relay.attach() runs.
          const relay2 = createManagedPooledRelay({
            browserRelay: hub,
            runnerId,
            runnerName: "Cloud Computer",
            environmentIds: [],
            transport: baseTransport,
            ticketKey: keys.ticketKey,
            passkeys: false,
            currentGuest: () => activeGuest,
          });
          const unsub = hub.subscribe({
            onAttached: () => {
              activeGuest = { instanceId: "guest-b", epoch: 1 };
            },
          });
          try {
            await expect(relay2.ensureAttached()).rejects.toBeInstanceOf(
              BrowserPoolAdmissionClosed,
            );
            expect(relay2.isAttached()).toBe(false);
            expect(hub.stream(runnerId)).toBeNull();
          } finally {
            unsub();
            relay2.retire();
          }
        } finally {
          hub.close();
        }
      } finally {
        await pool.close();
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("a ready pool is always offered across Home restarts while parked (0 sessions or with sessions, memory or disk) and after a pool-agent restart, wakes on person and connected-agent opens, and reports pool reasons on outage/refusal", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-offered-"));
    const port = await freePort();
    const config = managedConfig(database.url, directory, port, { browserPool: true });
    let registeredKeys:
      | {
          readonly homeKey: string;
          readonly relayKey: string;
          readonly ticketKey: { readonly keyId: string; readonly spki: string };
        }
      | undefined;
    let targetResponse: ManagedBrowserPoolTargetResponse = { status: "preparing" };
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    let primary: WebSocket | undefined;

    const accountControlFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === managedBrowserPoolRegistrationPath && init?.method === "PUT") {
        const parsed = ManagedBrowserPoolRegistrationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        registeredKeys = parsed.document.keys;
        return Response.json(targetResponse);
      }
      if (url.pathname === managedBrowserPoolTargetPath && (init?.method ?? "GET") === "GET") {
        return Response.json(registeredKeys ? targetResponse : { status: "unregistered" });
      }
      return new Response("not found", { status: 404 });
    };

    const nextJson = (socket: WebSocket) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const onMessage = (raw: WebSocket.RawData) => {
          socket.off("error", onError);
          resolve(JSON.parse(String(raw)) as Record<string, unknown>);
        };
        const onError = (error: Error) => {
          socket.off("message", onMessage);
          reject(error);
        };
        socket.once("message", onMessage);
        socket.once("error", onError);
      });

    const runnerId = createId("runner");
    const runnerKeys = generateKeyPairSync("ed25519");
    const runnerPublicKeyPem = runnerKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();

    const connectMainRunner = async (enroll: boolean) => {
      primary?.terminate();
      primary = new WebSocket(`ws://127.0.0.1:${port}/internal/v1/runners`);
      const challenge = RunnerChallengeSchema.parse(await nextJson(primary));
      const descriptor = RunnerDescriptorSchema.parse({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        capabilities: [],
        modules: { browser: { wireVersion: 2, runtimeId: "browser-main" } },
        name: "Cloud Computer",
        runnerId,
        runnerKind: "main",
        runtimeVersion: "test",
      });
      const welcomePromise = nextJson(primary);
      if (enroll) {
        const credential = {
          enrollmentToken: mainRunnerToken,
          kind: "host-enrollment-token" as const,
        };
        primary.send(
          JSON.stringify({
            challengeId: challenge.challengeId,
            credential,
            descriptor,
            proofFormatVersion: runnerProofFormatVersion,
            publicKeyPem: runnerPublicKeyPem,
            signature: createRunnerEnrollmentSignature(runnerKeys.privateKey, {
              challenge,
              credential,
              descriptor,
              publicKeyPem: runnerPublicKeyPem,
            }),
            type: "runner.enroll",
          }),
        );
      } else {
        primary.send(
          JSON.stringify({
            challengeId: challenge.challengeId,
            descriptor,
            proofFormatVersion: runnerProofFormatVersion,
            signature: createRunnerAuthenticationSignature(runnerKeys.privateKey, {
              challenge,
              descriptor,
            }),
            type: "runner.authenticate",
          }),
        );
      }
      expect((await welcomePromise).type).toBe("host.welcome");
    };

    const startHome = async (idleParkMs: number | null) => {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: {
            firstDelayMs: 40,
            maxDelayMs: 120,
            idleParkMs,
            statusEveryMs: 120,
          },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        await runtime.listen();
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      return started.host;
    };

    try {
      const home1 = await startHome(120);
      const { ownerId } = await claimHome(home1);
      await connectMainRunner(true);
      await initializePersonalState(home1.store.database, {
        agentHome: config.personal!.agentHome,
        environmentId: config.personal!.environmentId,
      });

      // Before a ready slot exists, no browser placement is reported.
      expect(home1.browser.resourcePlacements()).toEqual([]);
      expect((await home1.browser.workspaceBootstrap(ownerId)).available).toBe(false);

      await vi.waitFor(() => expect(registeredKeys).toBeDefined(), { timeout: 5_000 });
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      targetResponse = { status: "ready", target: poolHost.target };

      await vi.waitFor(
        async () => {
          expect((await home1.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );

      // Create a browser profile for person and agent opens.
      const profile = await home1.browser.createProfile({
        ownerId,
        name: "Ready Pool Profile",
        idempotencyKey: `profile-ready-pool-${randomUUID()}`,
      });
      // Enable device browser access for agent/Run opens.
      await home1.store.database
        .updateTable("devices")
        .set({
          accessPolicy: {
            reach: "owner",
            commands: true,
            browser: true,
            apps: true,
            forwarding: true,
            shares: [],
          },
        })
        .where("id", "=", runnerId as unknown as import("../packages/core/src/index.js").DeviceId)
        .execute();

      const waitForMemoryPark = async (label = "") => {
        let savedId = "";
        await vi.waitFor(
          async () => {
            const status = await poolHost!.currentAgent().status(poolHost!.slotId, poolHost!.term);
            expect(status.phase, `waitForMemoryPark(${label})`).toBe("paused");
            expect(status.savedState?.id).toBeTruthy();
            savedId = status.savedState!.id;
          },
          { timeout: 10_000 },
        );
        return savedId;
      };
      const waitForDiskPark = async (label = "") => {
        const savedId = await waitForMemoryPark(label);
        expect(await poolHost!.currentAgent().saveToDisk(poolHost!.slotId, savedId)).toBe("saved");
        const status = await poolHost!.currentAgent().status(poolHost!.slotId, poolHost!.term);
        expect(status.phase).toBe("paused");
        expect(status.savedState?.id).toBe(savedId);
      };

      // 1) ZERO-SESSION case: guest idles and parks to DISK before any tab was ever opened,
      // then the Home restarts with 0 sessions and 0 relays attached.
      await waitForDiskPark("step1-home1");
      expect(await home1.store.listBrowserSessions(ownerId)).toEqual([]);
      primary?.terminate();
      await home1.close();
      host = undefined;
      const home2 = await startHome(120);
      await vi.waitFor(
        async () => {
          expect((await home2.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );
      const parkedPlacements = home2.browser.resourcePlacements();
      expect(parkedPlacements).toMatchObject([{ runnerId, available: true }]);
      expect(home2.browser.resourcePlacements([runnerId])).toEqual(parkedPlacements);
      const bootstrapEmptyDisk = await home2.browser.workspaceBootstrap(ownerId);
      expect(bootstrapEmptyDisk.available).toBe(true);
      expect(bootstrapEmptyDisk.placements).toEqual(parkedPlacements);

      // Person's very first open (unbound profile) creates demand, wakes from disk, and opens.
      const firstOpen = await home2.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `person-first-open-${randomUUID()}`,
        identity: { kind: "profile", profileId: profile.id },
        url: "https://example.test/first-ever",
      });
      expect(firstOpen.tabId).toBeTruthy();
      expect((await poolHost.currentAgent().status(poolHost.slotId, poolHost.term)).phase).toBe(
        "running",
      );
      // Synthesized placement while parked matches the live attached stream placement identically.
      expect(home2.browser.resourcePlacements()).toEqual(parkedPlacements);

      // 2) WITH SESSIONS: park to MEMORY tier, restart the Home, verify placement & tabs.open wake.
      await waitForMemoryPark("step2-home2");
      await home2.close();
      host = undefined;
      const home3 = await startHome(120);
      await vi.waitFor(
        async () => {
          expect((await home3.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );
      expect(home3.browser.resourcePlacements()).toMatchObject([{ runnerId, available: true }]);
      expect((await home3.browser.workspaceBootstrap(ownerId)).available).toBe(true);

      const memPersonOpen = await home3.tabs.open(
        { kind: "person", ownerId },
        { kind: "page", profileId: profile.id, url: "https://example.test/from-memory-person" },
        `person-mem-open-${randomUUID()}`,
      );
      expect(memPersonOpen.tab.tabId).toBeTruthy();
      expect((await poolHost.currentAgent().status(poolHost.slotId, poolHost.term)).phase).toBe(
        "running",
      );

      // 3) Park to DISK tier, restart the POOL AGENT (dropping relays), restart the Home,
      // and wake on a connected agent's open.
      const agentBinding = await createConnectedAgentSession(home3, ownerId, config);
      await waitForDiskPark("step3-home3");
      await poolHost.restartAgent();
      const postRestartStatus = await poolHost
        .currentAgent()
        .status(poolHost.slotId, poolHost.term);
      expect(postRestartStatus.phase).toBe("paused");
      expect(postRestartStatus.savedState?.id).toBeTruthy();

      await home3.close();
      host = undefined;
      const home4 = await startHome(120);
      await connectMainRunner(false);
      await vi.waitFor(
        async () => {
          expect((await home4.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );
      expect(home4.browser.resourcePlacements()).toMatchObject([{ runnerId, available: true }]);

      const diskAgentOpen = await home4.browser.openTab(
        ownerId,
        {
          type: "browser.tab.open",
          idempotencyKey: `agent-disk-open-${randomUUID()}`,
          identity: { kind: "profile", profileId: profile.id },
          url: "https://example.test/from-disk-agent",
        },
        agentBinding,
      );
      expect(diskAgentOpen.tabId).toBeTruthy();
      expect((await poolHost.currentAgent().status(poolHost.slotId, poolHost.term)).phase).toBe(
        "running",
      );
      await home4.browser.detachAgentSessionsForBinding(agentBinding.agentBindingId);

      // 4a) Park to DISK tier, restart the Home, make the controller refuse the next resume:
      // an ordinary person open (18s budget, no confirmedSignal) ends at once with the pool's
      // start-refusal words while keeping the placement offered, and the next open wakes and
      // clears the refusal.
      await waitForDiskPark("step4a-home4");
      primary?.terminate();
      await home4.close();
      host = undefined;
      const home5 = await startHome(120);
      await vi.waitFor(
        async () => {
          expect((await home5.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );
      poolHost.agent.driver.fail("ensureHost", new Error("resume refused"), 1);
      const refusedAt = Date.now();
      await expect(
        home5.browser.openTab(ownerId, {
          type: "browser.tab.open",
          idempotencyKey: `controller-refused-${randomUUID()}`,
          identity: { kind: "profile", profileId: profile.id },
          url: "https://example.test/refused-wake",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        reason: "browser-pool-refused",
        message:
          "Your Cloud Computer’s browser can’t start right now. Your tabs and sign-ins are kept.",
      });
      // Ended at once on the controller refusal, not at the 18s deadline.
      expect(Date.now() - refusedAt).toBeLessThan(5_000);
      // Placement stays offered so asking is the retry.
      expect(home5.browser.resourcePlacements()).toMatchObject([{ runnerId, available: true }]);
      // Next open tries again immediately, succeeds, and clears the refusal.
      const recoveredFromRefusal = await home5.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `retry-after-refusal-${randomUUID()}`,
        identity: { kind: "profile", profileId: profile.id },
        url: "https://example.test/recovered-refusal",
      });
      expect(recoveredFromRefusal.tabId).toBeTruthy();
      expect((await poolHost.currentAgent().status(poolHost.slotId, poolHost.term)).phase).toBe(
        "running",
      );
      await vi.waitFor(
        async () => {
          expect((await home5.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );

      // 4b) Park to DISK tier, stop the pool agent so nothing answers, restart the Home with no
      // live stream attached: openTab rejects at its deadline with the pool's unreachable reason
      // (not the generic timeout), placement stays offered, and once the pool agent is back a
      // later open succeeds.
      await waitForDiskPark("step4b-home5");
      await home5.close();
      host = undefined;
      await poolHost.stopAgent();
      const home6 = await startHome(120);
      await vi.waitFor(
        () =>
          expect(home6.browser.resourcePlacements()).toMatchObject([{ runnerId, available: true }]),
        { timeout: 10_000 },
      );
      await expect(
        home6.browser.openTab(
          ownerId,
          {
            type: "browser.tab.open",
            idempotencyKey: `unready-bounded-${randomUUID()}`,
            identity: { kind: "profile", profileId: profile.id },
            url: "https://example.test/never-wakes",
          },
          undefined,
          AbortSignal.timeout(150),
        ),
      ).rejects.toMatchObject({
        code: "conflict",
        reason: "browser-pool-unreachable",
        message: "Your Cloud Computer’s browser couldn’t be reached. Try again in a moment.",
      });
      expect(home6.browser.resourcePlacements()).toMatchObject([{ runnerId, available: true }]);
      await poolHost.restartAgent();
      const recoveredFromOutage = await home6.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `retry-after-outage-${randomUUID()}`,
        identity: { kind: "profile", profileId: profile.id },
        url: "https://example.test/recovered-outage",
      });
      expect(recoveredFromOutage.tabId).toBeTruthy();
      expect((await poolHost.currentAgent().status(poolHost.slotId, poolHost.term)).phase).toBe(
        "running",
      );

      // 5) Park to disk, restart with no live stream attached, then retire the slot: placement
      // disappears once the slot is gone (negative boundary).
      await waitForDiskPark("step5-home6");
      await home6.close();
      host = undefined;
      const home7 = await startHome(120);
      await vi.waitFor(
        () =>
          expect(home7.browser.resourcePlacements()).toMatchObject([{ runnerId, available: true }]),
        { timeout: 10_000 },
      );
      await home7.browser.retirePool(runnerId, "slot-gone");
      expect(home7.browser.resourcePlacements()).toEqual([]);
      expect((await home7.browser.workspaceBootstrap(ownerId)).available).toBe(false);
    } finally {
      primary?.terminate();
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it("a ready pool is always offered (Run): wakes a disk-parked pooled slot after a Home restart on a Run's first open", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-offered-run-"));
    const port = await freePort();
    const config = managedConfig(database.url, directory, port, { browserPool: true });
    let registeredKeys:
      | {
          readonly homeKey: string;
          readonly relayKey: string;
          readonly ticketKey: { readonly keyId: string; readonly spki: string };
        }
      | undefined;
    let targetResponse: ManagedBrowserPoolTargetResponse = { status: "preparing" };
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    let primary: WebSocket | undefined;

    const accountControlFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === managedBrowserPoolRegistrationPath && init?.method === "PUT") {
        const parsed = ManagedBrowserPoolRegistrationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        registeredKeys = parsed.document.keys;
        return Response.json(targetResponse);
      }
      if (url.pathname === managedBrowserPoolTargetPath && (init?.method ?? "GET") === "GET") {
        return Response.json(registeredKeys ? targetResponse : { status: "unregistered" });
      }
      return new Response("not found", { status: 404 });
    };

    const nextJson = (socket: WebSocket) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const onMessage = (raw: WebSocket.RawData) => {
          socket.off("error", onError);
          resolve(JSON.parse(String(raw)) as Record<string, unknown>);
        };
        const onError = (error: Error) => {
          socket.off("message", onMessage);
          reject(error);
        };
        socket.once("message", onMessage);
        socket.once("error", onError);
      });

    const runnerId = createId("runner");
    const runnerKeys = generateKeyPairSync("ed25519");
    const runnerPublicKeyPem = runnerKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();

    const connectMainRunner = async (enroll: boolean) => {
      primary?.terminate();
      primary = new WebSocket(`ws://127.0.0.1:${port}/internal/v1/runners`);
      const challenge = RunnerChallengeSchema.parse(await nextJson(primary));
      const descriptor = RunnerDescriptorSchema.parse({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        capabilities: [],
        modules: { browser: { wireVersion: 2, runtimeId: "browser-main" } },
        name: "Cloud Computer",
        runnerId,
        runnerKind: "main",
        runtimeVersion: "test",
      });
      const welcomePromise = nextJson(primary);
      if (enroll) {
        const credential = {
          enrollmentToken: mainRunnerToken,
          kind: "host-enrollment-token" as const,
        };
        primary.send(
          JSON.stringify({
            challengeId: challenge.challengeId,
            credential,
            descriptor,
            proofFormatVersion: runnerProofFormatVersion,
            publicKeyPem: runnerPublicKeyPem,
            signature: createRunnerEnrollmentSignature(runnerKeys.privateKey, {
              challenge,
              credential,
              descriptor,
              publicKeyPem: runnerPublicKeyPem,
            }),
            type: "runner.enroll",
          }),
        );
      } else {
        primary.send(
          JSON.stringify({
            challengeId: challenge.challengeId,
            descriptor,
            proofFormatVersion: runnerProofFormatVersion,
            signature: createRunnerAuthenticationSignature(runnerKeys.privateKey, {
              challenge,
              descriptor,
            }),
            type: "runner.authenticate",
          }),
        );
      }
      expect((await welcomePromise).type).toBe("host.welcome");
    };

    const startHome = async (idleParkMs: number | null) => {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: {
            firstDelayMs: 40,
            maxDelayMs: 120,
            idleParkMs,
            statusEveryMs: 120,
          },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        await runtime.listen();
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      return started.host;
    };

    try {
      const home1 = await startHome(120);
      const { ownerId } = await claimHome(home1);
      await connectMainRunner(true);
      await initializePersonalState(home1.store.database, {
        agentHome: config.personal!.agentHome,
        environmentId: config.personal!.environmentId,
      });

      await vi.waitFor(() => expect(registeredKeys).toBeDefined(), { timeout: 5_000 });
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      targetResponse = { status: "ready", target: poolHost.target };

      await vi.waitFor(
        async () => {
          expect((await home1.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );

      const profile = await home1.browser.createProfile({
        ownerId,
        name: "Ready Pool Run Profile",
        idempotencyKey: `profile-ready-pool-run-${randomUUID()}`,
      });
      await home1.store.database
        .updateTable("devices")
        .set({
          accessPolicy: {
            reach: "owner",
            commands: true,
            browser: true,
            apps: true,
            forwarding: true,
            shares: [],
          },
        })
        .where("id", "=", runnerId as unknown as import("../packages/core/src/index.js").DeviceId)
        .execute();

      // Park the slot to DISK with 0 sessions, then restart the Home.
      let savedId = "";
      await vi.waitFor(
        async () => {
          const status = await poolHost!.currentAgent().status(poolHost!.slotId, poolHost!.term);
          expect(status.phase).toBe("paused");
          expect(status.savedState?.id).toBeTruthy();
          savedId = status.savedState!.id;
        },
        { timeout: 10_000 },
      );
      expect(await poolHost.currentAgent().saveToDisk(poolHost.slotId, savedId)).toBe("saved");
      expect(await home1.store.listBrowserSessions(ownerId)).toEqual([]);

      primary?.terminate();
      await home1.close();
      host = undefined;

      const home2 = await startHome(120);
      await connectMainRunner(false);
      await vi.waitFor(
        async () => {
          expect((await home2.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );
      expect(home2.browser.resourcePlacements()).toMatchObject([{ runnerId, available: true }]);

      // Create a real personal task and live Run through the product store fixture port.
      const settings = await home2.store.database
        .selectFrom("personalSettings")
        .select("agentHomeComputerId")
        .executeTakeFirstOrThrow();
      await home2.store.database
        .insertInto("executionEnvironments")
        .values({
          capabilities: [],
          id: config.personal!.environmentId,
          kind: "main",
          name: "Cloud Computer",
          runnerId: settings.agentHomeComputerId,
        })
        .onConflict((conflict) => conflict.column("id").doNothing())
        .execute();
      const personalRuns = createPersonalRunFixturePort(home2.store);
      const task = await personalRuns.createTask({ ownerId, suffix: "ready-pool-run" });
      await home2.store.updateThreadAccessMode({
        threadId: task.threadId,
        requestedBy: ownerId,
        accessMode: "full-access",
      });
      const started = await personalRuns.startTask(
        task.threadId,
        "Open the pooled browser from disk.",
      );

      // The Run's first open wakes the disk-parked slot on demand and opens the page.
      const diskRunOpen = await home2.browser.openTab(
        ownerId,
        {
          type: "browser.tab.open",
          idempotencyKey: `run-disk-open-${randomUUID()}`,
          identity: { kind: "profile", profileId: profile.id },
          url: "https://example.test/from-disk-run",
        },
        {
          ownerId,
          agentBindingId: `run:${started.runId}`,
          threadId: task.threadId,
        },
      );
      expect(diskRunOpen.tabId).toBeTruthy();
      expect((await poolHost.currentAgent().status(poolHost.slotId, poolHost.term)).phase).toBe(
        "running",
      );

      // Releasing the Run's binding drops its idle hold so the slot can park again.
      await home2.browser.detachAgentSessionsForBinding(`run:${started.runId}`);
      await vi.waitFor(
        async () => {
          const status = await poolHost!.currentAgent().status(poolHost!.slotId, poolHost!.term);
          expect(status.phase).toBe("paused");
        },
        { timeout: 10_000 },
      );
    } finally {
      primary?.terminate();
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips duplicate health checks, emits wake timings, and reattaches 1, 4, and 8 retained sessions in bounded parallel", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-wake-speed-"));
    const port = await freePort();
    const config = managedConfig(database.url, directory, port, { browserPool: true });
    let registeredKeys:
      | {
          readonly homeKey: string;
          readonly relayKey: string;
          readonly ticketKey: { readonly keyId: string; readonly spki: string };
        }
      | undefined;
    let targetResponse: ManagedBrowserPoolTargetResponse = { status: "preparing" };
    const accountControlFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === managedBrowserPoolRegistrationPath && init?.method === "PUT") {
        const parsed = ManagedBrowserPoolRegistrationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        registeredKeys = parsed.document.keys;
        return Response.json(targetResponse);
      }
      if (url.pathname === managedBrowserPoolTargetPath) {
        return Response.json(registeredKeys ? targetResponse : { status: "unregistered" });
      }
      return new Response("not found", { status: 404 });
    };
    const wakes: BrowserPoolWakeTrace[] = [];
    let host: PersonalHostRuntime | undefined;
    let poolHost: LoopbackPoolHost | undefined;
    try {
      const started = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config, {
          personalAccountGrantFetch: jwksFetch(),
          accountControlFetch,
          managedBrowserPoolTiming: {
            firstDelayMs: 30,
            maxDelayMs: 80,
            idleParkMs: 200,
            onWake: (trace) => wakes.push(trace),
          },
        });
        if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
        return { host: runtime, close: () => runtime.close() };
      });
      host = started.host;
      const { ownerId } = await claimHome(host);
      await enrollMainRunner(host, config);
      await vi.waitFor(() => expect(registeredKeys).toBeDefined(), { timeout: 5_000 });
      poolHost = await startLoopbackPoolHost({
        directory,
        slotId: `bps_${randomUUID()}`,
        term: 1,
        registered: registeredKeys!,
      });
      targetResponse = { status: "ready", target: poolHost.target };
      await vi.waitFor(
        async () => {
          expect((await host!.app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
            ok: true,
            browserPool: "ready",
          });
        },
        { timeout: 10_000 },
      );

      const profiles: {
        readonly id: import("../packages/core/src/index.js").BrowserProfileId;
        readonly sessionId: import("../packages/protocol/src/browser.js").BrowserSessionId;
      }[] = [];
      for (const sessionCount of [1, 4, 8]) {
        // Hold a viewer on the first session while creating additional profiles/tabs so the
        // 200 ms idle-park timer cannot park between profile creations.
        let setupViewer: { close(): void } | undefined;
        if (profiles.length > 0) {
          let closed = false;
          setupViewer = await host.browser.attach(
            ownerId,
            profiles[0]!.sessionId,
            {
              id: `setup-viewer-${sessionCount}`,
              isOpen: () => !closed,
              close: () => {
                closed = true;
              },
              send: async () => {},
            },
            {
              authSessionId: `aus_${randomUUID()}` as AuthSessionId,
              mode: "control",
              signedIn: async () => true,
            },
          );
        }
        try {
          const needed = sessionCount - profiles.length;
          const startIndex = profiles.length;
          const created = await Promise.all(
            Array.from({ length: needed }, async (_, offset) => {
              const index = startIndex + offset + 1;
              const profile = await host!.browser.createProfile({
                ownerId,
                name: `Speed Profile ${index}`,
                idempotencyKey: `wake-speed-profile-${index}-${randomUUID()}`,
              });
              const opened = await host!.browser.openTab(ownerId, {
                type: "browser.tab.open",
                idempotencyKey: `wake-speed-open-${index}-${randomUUID()}`,
                identity: { kind: "profile", profileId: profile.id },
                url: `https://example.test/session-${index}`,
              });
              return { id: profile.id, sessionId: opened.sessionId };
            }),
          );
          profiles.push(...created);
        } finally {
          setupViewer?.close();
        }

        // Wait for idle park with `sessionCount` retained sessions.
        await vi.waitFor(
          async () => {
            const status = await poolHost!.currentAgent().status(poolHost!.slotId, poolHost!.term);
            expect(status.phase).toBe("paused");
          },
          { timeout: 10_000 },
        );

        wakes.length = 0;
        await host.browser.openTab(ownerId, {
          type: "browser.tab.open",
          idempotencyKey: `wake-speed-trigger-${sessionCount}-${randomUUID()}`,
          identity: { kind: "profile", profileId: profiles[0]!.id },
          url: `https://example.test/wake-${sessionCount}`,
        });

        await vi.waitFor(() => expect(wakes).toHaveLength(1), { timeout: 5_000 });
        const trace = wakes[0]!;
        expect(trace.retainedSessions).toBe(sessionCount);
        expect(trace.adoptedSessions).toBe(sessionCount);
        expect(trace.lostSessions).toBe(0);
        expect(trace.steps.reattach).toBeGreaterThanOrEqual(0);
        expect(trace.steps.relay).toBeGreaterThanOrEqual(0);
        // 3 control tunnels (poolState + adopt + complete) + N session websockets.
        expect(trace.relayHandshakes.length).toBe(3 + sessionCount);
      }
    } finally {
      await host?.close();
      await poolHost?.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
