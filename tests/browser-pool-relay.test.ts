/**
 * The relay end to end on one machine (pool-runtime-in-guest.md, decisions 2 to 6): the agent
 * on a fake hypervisor, the relay with mutual TLS and pinned keys, a pooled runtime behind it,
 * and the Runner's bridge and the Home's control channel reaching it only through tunnels.
 */
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  openPoolRelay,
  poolRelayTransport,
  PoolRelayRefused,
  type PoolRelayEndpoint,
} from "../packages/shared/src/poolRelay.js";
import { BrowserRuntime } from "../packages/browser-runtime-core/src/runtime.js";
import { BrowserRuntimeServer } from "../packages/browser-runtime-core/src/server.js";
import {
  FakeContext,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeTicketVerifier,
  testSessionFilesRoot,
  validClaims,
} from "../packages/browser-runtime-core/src/test-support/fakes.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import { RelayBrowserPoolRuntimeChannel } from "../apps/host/src/browser/managed-pool.js";
import { createRelayServer } from "../apps/pool-agent/src/relay.js";
import { callFor } from "../apps/pool-agent/src/review.test-support.js";
import {
  homeKeyPair,
  startTestPoolAgent,
  testGuest,
  type TestPoolAgent,
} from "../apps/pool-agent/src/test-support.js";

/** An Ed25519 key and a self-signed certificate for it, as setup and provisioning make them. */
function identity(directory: string, name: string) {
  const key = join(directory, `${name}.pem`);
  const cert = join(directory, `${name}.crt`);
  execFileSync("openssl", ["genpkey", "-algorithm", "ed25519", "-out", key]);
  execFileSync("openssl", [
    "req",
    "-x509",
    "-new",
    "-key",
    key,
    "-subj",
    "/CN=opensteer-pool",
    "-days",
    "2",
    "-out",
    cert,
  ]);
  const pem = readFileSync(key, "utf8");
  const publicKey = createPublicKey(createPrivateKey(pem));
  return {
    key: pem,
    certificate: readFileSync(cert, "utf8"),
    publicKey,
    spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function relayFixture() {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-pool-relay-"));
  // Two key pairs, as on a host (round D, D3): the relay's own TLS key, and the host's signing
  // key, which only the agent holds.
  const host = identity(directory, "relay");
  const signing = identity(directory, "host-signing");
  const home = identity(directory, "home-relay");
  const other = identity(directory, "other-relay");
  const agent: TestPoolAgent = await startTestPoolAgent({ saveAfterMs: null });
  cleanup.push(() => agent.close());
  const slotId = "slot-relay";
  const summary = await agent.agent.createSlot({
    slotId,
    term: 1,
    homeKey: homeKeyPair().spki,
    guest: testGuest,
    relayKey: home.spki,
  });
  const controlKey = createPublicKey({
    key: Buffer.from(summary.controlKey, "base64"),
    format: "der",
    type: "spki",
  });
  // The guest's runtime: pooled, its identity from its boot, its token from the agent.
  const verifier = new FakeTicketVerifier();
  const runtime = new BrowserRuntime({
    launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([new FakePage()]))),
    runtimeId: "browser-main",
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: verifier,
    pool: {
      controllerKey: controlKey,
      probePage: async () => [],
      boot: { slot: slotId, floor: { term: 1, sequence: 0 } },
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
  cleanup.push(() => runtimeServer.close());
  agent.driver.bridgeTargets.set(slotId, { host: "127.0.0.1", port: bridgeAddress.port });
  let asked = 0;
  const relay: Server = createRelayServer({
    key: host.key,
    certificate: host.certificate,
    authorize: async (hello, clientKey) => {
      asked += 1;
      return agent.agent.authorizeRelay(hello, clientKey);
    },
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => relay.close(() => resolve())));
  const endpoint = (overrides: Partial<PoolRelayEndpoint> = {}): PoolRelayEndpoint => ({
    host: "127.0.0.1",
    port: (relay.address() as AddressInfo).port,
    relayHostKey: host.publicKey,
    controlKey,
    relayKey: home.key,
    relayCertificate: home.certificate,
    slot: slotId,
    term: 1,
    ...overrides,
  });
  const call = async (kind: Parameters<typeof callFor>[1]) =>
    agent.agent.apply(callFor(await agent.agent.status(slotId, 1), kind));
  return {
    agent,
    runtime,
    verifier,
    endpoint,
    call,
    host,
    signing,
    directory,
    other,
    controlKey,
    asked: () => asked,
    delivered,
  };
}

const refusal = (promise: Promise<{ socket: { destroy(): void } }>) =>
  promise.then(
    (tunnel) => {
      tunnel.socket.destroy();
      return "opened";
    },
    (error: unknown) => (error instanceof PoolRelayRefused ? error.code : String(error)),
  );

describe("the relay", () => {
  it("lets the slot's own relay key reach its running guest, with the instance's token", async () => {
    const f = await relayFixture();
    await f.call("start");
    const tunnel = await openPoolRelay(f.endpoint());
    expect(tunnel.grant).toMatchObject({ slot: "slot-relay", term: 1, token: f.delivered() });
    tunnel.socket.destroy();
    // The Runner's bridge, behind its existing seam, reaches the runtime through tunnels.
    const bridge = new LocalBrowserRuntimeBridge({
      transport: poolRelayTransport(f.endpoint()),
      runtimeId: "browser-main",
    });
    expect(await bridge.capabilities()).toMatchObject({ wireVersion: expect.any(Number) });
    expect((await bridge.health()).state).not.toBe("unavailable");
  });

  it("carries the Home's signed controls to the runtime and reads the state it holds", async () => {
    const f = await relayFixture();
    const started = await f.call("start");
    const channel = new RelayBrowserPoolRuntimeChannel(poolRelayTransport(f.endpoint()));
    const state = await channel.controlPool(
      started.control!,
      Buffer.from(started.signature!, "base64"),
    );
    expect(state).toMatchObject({ phase: "running", fence: started.control!.fence });
    expect(await channel.poolState()).toEqual(state);
    // The same install again is a repeat; a forged signature is refused, and the state stays.
    const forged = Buffer.alloc(64);
    await expect(channel.controlPool(started.control!, forged)).rejects.toThrow();
    expect((await channel.poolState())?.fence).toEqual(started.control!.fence);
  });

  it("carries the Home's end request to the runtime, and the answer it gives after its teardown", async () => {
    const f = await relayFixture();
    const started = await f.call("start");
    const channel = new RelayBrowserPoolRuntimeChannel(poolRelayTransport(f.endpoint()));
    await channel.controlPool(started.control!, Buffer.from(started.signature!, "base64"));
    const claims = validClaims();
    f.verifier.setClaims("end", { ...claims, pool: { ...started.control!.fence, end: true } });
    // No such session is held or being torn down: ended, from the running runtime, under its fence.
    expect(await channel.endSession("end")).toMatchObject({
      outcome: "ended",
      state: { phase: "running", fence: started.control!.fence },
    });
    // An attach ticket is not an end request: refused, and nothing is answered as ended.
    f.verifier.setClaims("attach", {
      ...claims,
      pool: { ...started.control!.fence, attachment: 1 },
    });
    await expect(channel.endSession("attach")).rejects.toThrow("does not end a browser session");
  });

  // The Home side's channel interface (round 10): null means there is no runtime to ask, as a
  // value; a guest whose state cannot be read yet is a throw, never null.
  it("answers null for a stopped or paused guest, and its state for a running one", async () => {
    const f = await relayFixture();
    const guest = () => f.agent.agent.status("slot-relay", 1);
    const channel = new RelayBrowserPoolRuntimeChannel(poolRelayTransport(f.endpoint()), guest);
    expect(await channel.poolState()).toBeNull();
    await f.call("start");
    expect(await channel.poolState()).toMatchObject({ phase: "uninstalled" });
    await f.call("pause");
    expect(await channel.poolState()).toBeNull();
    // Without the agent's status a parked relay is not knowing, never "no runtime".
    const blind = new RelayBrowserPoolRuntimeChannel(poolRelayTransport(f.endpoint()));
    await expect(blind.poolState()).rejects.toThrow();
  });

  it("gives up waiting when the coordinator's step signal aborts", async () => {
    const f = await relayFixture();
    const channel = new RelayBrowserPoolRuntimeChannel(poolRelayTransport(f.endpoint()), () =>
      f.agent.agent.status("slot-relay", 1),
    );
    await f.call("start");
    const step = new AbortController();
    step.abort(new Error("the step ended"));
    await expect(channel.poolState(step.signal)).rejects.toThrow();
  });

  it("refuses a connection for a parked or stopped guest: the relay never wakes one", async () => {
    const f = await relayFixture();
    expect(await refusal(openPoolRelay(f.endpoint()))).toBe("parked");
    await f.call("start");
    await f.call("pause");
    expect(await refusal(openPoolRelay(f.endpoint()))).toBe("parked");
    expect((await f.agent.agent.status("slot-relay", 1)).phase).toBe("paused");
  });

  it("refuses another Home's key, another term and an unknown slot alike", async () => {
    const f = await relayFixture();
    await f.call("start");
    expect(
      await refusal(
        openPoolRelay(f.endpoint({ relayKey: f.other.key, relayCertificate: f.other.certificate })),
      ),
    ).toBe("refused");
    expect(await refusal(openPoolRelay(f.endpoint({ term: 2 })))).toBe("refused");
    expect(await refusal(openPoolRelay(f.endpoint({ slot: "slot-none" })))).toBe("refused");
  });

  it("sends nothing to a relay that does not hold the pinned relay key", async () => {
    const f = await relayFixture();
    await f.call("start");
    const impostor: KeyObject = f.other.publicKey;
    expect(await refusal(openPoolRelay(f.endpoint({ relayHostKey: impostor })))).toBe("relay-key");
    expect(f.asked()).toBe(0);
  });

  it("refuses a relay that presents the host's signing key instead of its own", async () => {
    const f = await relayFixture();
    await f.call("start");
    expect(f.signing.publicKey.equals(f.host.publicKey)).toBe(false);
    // A relay process that somehow held the host key, presenting it.
    const impostor = createRelayServer({
      key: f.signing.key,
      certificate: f.signing.certificate,
      authorize: async (hello, clientKey) => f.agent.agent.authorizeRelay(hello, clientKey),
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => impostor.close(() => resolve())));
    const port = (impostor.address() as AddressInfo).port;
    expect(await refusal(openPoolRelay(f.endpoint({ port })))).toBe("relay-key");
    // The same Home pinning the host key would have trusted it: the pins are distinct.
    expect(
      await refusal(openPoolRelay(f.endpoint({ port, relayHostKey: f.signing.publicKey }))),
    ).toBe("opened");
  });

  it("rejects a grant not signed by the slot's control key", async () => {
    const f = await relayFixture();
    await f.call("start");
    expect(await refusal(openPoolRelay(f.endpoint({ controlKey: f.host.publicKey })))).toBe(
      "grant",
    );
  });
});
