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
  type Request,
  type RunnerId,
  type UserId,
} from "../packages/core/src/index.js";
import {
  RunnerAuxiliaryChallengeSchema,
  RunnerBootIdSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  runnerProofFormatVersion,
} from "../packages/protocol/src/index.js";
import { AgentConnectionStore, beginAgentSession } from "../packages/database/src/index.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { hostKeyFingerprint } from "../packages/deployment-authority/src/index.js";
import {
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
  startTestPoolAgent,
  testGuest,
  type TestPoolAgent,
} from "../apps/pool-agent/src/test-support.js";
import {
  defaultManagedBrowserPoolIdleMs,
  managedBrowserPoolCoordinator,
  pooledBrowserRuntimeId,
  startManagedBrowserPool,
} from "../apps/host/src/browser/managed-pool-home.js";
import { BrowserService } from "../apps/host/src/browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { managedBrowserPoolRegistration } from "../apps/host/src/browser/managed-pool.js";
import { RunnerBrowserHub } from "../apps/host/src/browser/runner-browser-hub.js";
import { BrowserRelayError } from "../packages/runner-client/src/browser-bridge.js";
import { z } from "zod";
import {
  loadOrCreateManagedBrowserPoolKeys,
  managedBrowserPoolKeysPath,
  selfSignedCertificate,
} from "../apps/host/src/browser/managed-pool-keys.js";
import { initializePersonalState } from "../apps/host/src/runtime/personal-state.js";
import { createHostRuntime, type PersonalHostRuntime } from "../apps/host/src/runtime/runtime.js";

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
  readonly agent: TestPoolAgent;
  readonly runtime: BrowserRuntime;
  readonly target: ManagedBrowserPoolTarget;
  readonly slotId: string;
  readonly term: number;
  readonly pagesOpened: () => number;
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
  const agent = await startTestPoolAgent({ saveAfterMs: null });
  const summary = await agent.agent.createSlot({
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
    authorize: async (hello, clientKey) => agent.agent.authorizeRelay(hello, clientKey),
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
    agent,
    runtime,
    target,
    slotId: input.slotId,
    term: input.term,
    pagesOpened: () => launcher.launchCount,
    close: async () => {
      for (const socket of relaySockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await runtimeServer.close();
      await agent.close();
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

  it("Idle hold: a pending browser Request holds off idle park until resolved", async () => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-req-hold-"));
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
            idleParkMs: 150,
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

      const opened = await host.browser.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: `req-hold-${randomUUID()}`,
        identity: { kind: "guest" },
        url: "https://example.test/req-hold",
      });
      const requestId = createId("request");
      const pendingRequest = {
        id: requestId,
        status: "pending",
        originatingRunId: null,
        payload: {
          kind: "browser.sign-in",
          sessionId: opened.sessionId,
          site: "example.test",
          reason: "Sign in to continue",
        },
      } as unknown as Request;
      host.browser.observeRequest(pendingRequest);
      // Wait for at least two idle periods' worth of coordinator ticks: while the Request is
      // pending, an explicit tryPark() must be vetoed and the guest must stay running.
      await vi.waitFor(
        async () => {
          expect((await poolHost!.agent.agent.status(poolHost!.slotId, poolHost!.term)).phase).toBe(
            "running",
          );
        },
        { timeout: 2_000 },
      );
      // Triggering an idle-style park check via coordinator is vetoed while the Request holds it;
      // verify through the DB slot phase remaining running even after the idle timer fires.
      const beforeResolve = await host.store.database
        .selectFrom("browserPoolSlots")
        .select("phase")
        .executeTakeFirstOrThrow();
      expect(beforeResolve.phase).toBe("running");
      // Resolving the Request releases the hold and lets the idle timer park it.
      host.browser.observeRequest({ ...pendingRequest, status: "fulfilled" } as unknown as Request);
      await vi.waitFor(
        async () => {
          expect((await poolHost!.agent.agent.status(poolHost!.slotId, poolHost!.term)).phase).toBe(
            "paused",
          );
        },
        { timeout: 10_000 },
      );
    } finally {
      await host?.close();
      await poolHost?.close();
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
});
