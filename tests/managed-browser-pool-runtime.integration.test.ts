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
import { createId, type RunnerId, type UserId } from "../packages/core/src/index.js";
import {
  RunnerAuxiliaryChallengeSchema,
  RunnerBootIdSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  runnerProofFormatVersion,
} from "../packages/protocol/src/index.js";
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
} from "../apps/host/src/browser/managed-pool-home.js";
import { managedBrowserPoolRegistration } from "../apps/host/src/browser/managed-pool.js";
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
  const launcher = new FakeIsolatingLauncher();
  const runtime = new BrowserRuntime({
    launcher,
    runtimeId: "browser-main",
    sessionFilesRoot: testSessionFilesRoot(),
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
      // Operator visibility reflects preparing, then ready once the target is adopted.
      await vi.waitFor(
        async () => {
          expect((await host.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
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

      // Home adopts target 1 and reports ready.
      await vi.waitFor(
        async () => {
          expect((await host.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
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
      // Before the account answers, /healthz reports no-target.
      expect((await host.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
        ok: true,
        browserPool: "no-target",
      });
      const { ownerId } = await claimHome(host);
      await enrollMainRunner(host, config);
      await vi.waitFor(
        async () => {
          expect((await host.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
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
