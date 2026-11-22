/**
 * A running guest whose Home has sent no authenticated call for `homeSilenceMs` (default 15 min)
 * is stopped by the agent itself through the slot's lane and journal, freeing host memory while
 * keeping the durable profile disk intact. Parked guests are left alone.
 */
import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import * as runtimeCore from "@opensteer/browser-runtime-core";
import { pooledRuntimeSessionDeadlineMs } from "@opensteer/browser-runtime-core/browser-pool";
import {
  callBrowserPoolAgent,
  type BrowserPoolAgentStatus,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentCrashed,
  PoolAgent,
  defaultHomeSilenceMs,
  homeSilenceMarginMs,
  minimumHomeSilenceMs,
} from "./agent.js";
import { agentConfigSchema } from "./config.js";
import { FakeHypervisorDriver } from "./fake-driver.test-support.js";
import { SlotJournal } from "./journal.js";
import { callFor, open } from "./review.test-support.js";
import { homeKeyPair, startTestPoolAgent, testGuest } from "./test-support.js";

afterEach(async () => {
  vi.useRealTimers();
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

const baseConfig = {
  journal: "/var/lib/opensteer-pool/journal",
  listen: { host: "10.0.0.2", port: 7310 },
  admin: {
    listen: { host: "10.0.0.2", port: 7311 },
    provisionerKey: "A".repeat(60),
    hostId: "host-1",
    hostKeyFile: "/etc/opensteer-pool/host.key",
  },
  driver: {
    firecracker: "/usr/bin/firecracker",
    jailer: "/usr/bin/jailer",
    images: "/var/lib/opensteer-pool/images",
    jailRoot: "/srv/jailer",
    savedRoot: "/srv/opensteer-pool/saved",
    stateDirectory: "/var/lib/opensteer-pool/driver",
    arrayIdFile: "/srv/opensteer-pool/array-id",
    profilesRoot: "/var/lib/opensteer-pool/profiles",
    credentialsRoot: "/etc/opensteer-pool/credentials",
    slotUidBase: 20_000,
    egressUidBase: 100_000,
    egress: {
      node: "/usr/bin/node",
      main: "/opt/opensteer/egress-main.js",
    },
    network: {
      resolvers: ["1.1.1.1"],
    },
  },
};

function runtimeDeadlineMs(): number {
  const exports = runtimeCore as Readonly<Record<string, unknown>>;
  const value = exports.pooledSessionWithoutChannelMs ?? exports.pooledChannelDeadlineMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error("Expected a positive runtime session-without-channel deadline constant.");
  return value;
}

/** Yields to real libuv I/O (not faked by fake `setTimeout`) until `predicate` holds. */
async function waitUntil(predicate: () => boolean, deadlineMs = 5_000): Promise<void> {
  const until = performance.now() + deadlineMs;
  while (!predicate()) {
    if (performance.now() >= until)
      throw new Error("Timed out waiting for silent-Home stop I/O to finish.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function setup(
  options: {
    readonly homeSilenceMs?: number;
    readonly startNow?: number;
    readonly checkpoint?: (point: string) => void;
  } = {},
) {
  let clock = options.startNow ?? Date.parse("2026-11-22T12:00:00Z");
  const events: Readonly<Record<string, unknown>>[] = [];
  const driver = new FakeHypervisorDriver();
  let running = await startTestPoolAgent({
    driver,
    saveAfterMs: null,
    now: () => clock,
    log: (event) => events.push(event),
    ...(options.homeSilenceMs !== undefined ? { homeSilenceMs: options.homeSilenceMs } : {}),
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
  });
  open.push(running);
  const home = homeKeyPair();
  const relay = homeKeyPair();
  const agentKeys = new Map<string, KeyObject>();

  const create = async (slotId: string) => {
    const summary = await running.agent.createSlot({
      slotId,
      term: 1,
      homeKey: home.spki,
      relayKey: relay.spki,
      guest: testGuest,
    });
    agentKeys.set(
      slotId,
      createPublicKey({
        key: Buffer.from(summary.controlKey, "base64"),
        format: "der",
        type: "spki",
      }),
    );
    return summary;
  };

  const endpoint = (slotId: string) => ({
    url: running.url,
    homeKey: home.privateKey,
    agentKey: agentKeys.get(slotId)!,
    hostKey: running.hostPublicKey,
    now: () => clock,
  });

  const signedStatus = async (slotId: string): Promise<BrowserPoolAgentStatus> => {
    const reply = await callBrowserPoolAgent(endpoint(slotId), slotId, 1, { op: "status" });
    if (reply.op !== "status") throw new Error(`unexpected ${reply.op}`);
    return reply.status;
  };

  const signedResult = async (slotId: string, id: string) => {
    const reply = await callBrowserPoolAgent(endpoint(slotId), slotId, 1, { op: "result", id });
    if (reply.op !== "result") throw new Error(`unexpected ${reply.op}`);
    return reply.result;
  };

  const apply = async (slotId: string, kind: "start" | "pause" | "resume" | "stop" | "sign") => {
    const status = await signedStatus(slotId);
    const call =
      kind === "sign"
        ? {
            ...callFor(status, "sign"),
            control: {
              kind: "retire" as const,
              fence: {
                slot: status.slotId,
                term: status.term,
                instance: status.instance!,
                epoch: status.epoch!,
              },
              intent: { id: "intent-1", sequence: 1 },
            },
          }
        : callFor(status, kind);
    const reply = await callBrowserPoolAgent(endpoint(slotId), slotId, 1, { op: "apply", call });
    if (reply.op !== "apply") throw new Error(`unexpected ${reply.op}`);
    return { call, result: reply.result };
  };

  const advance = async (ms: number) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  const restart = async (checkpoint?: (point: string) => void) => {
    const idx = open.indexOf(running);
    running = await running.restart({
      now: () => clock,
      log: (event) => events.push(event),
      ...(options.homeSilenceMs !== undefined ? { homeSilenceMs: options.homeSilenceMs } : {}),
      ...(checkpoint ? { checkpoint } : {}),
    });
    if (idx >= 0) open[idx] = running;
    else open.push(running);
    return running;
  };

  return {
    driver,
    events,
    home,
    relay,
    get agent() {
      return running;
    },
    get now() {
      return clock;
    },
    create,
    signedStatus,
    signedResult,
    apply,
    advance,
    restart,
  };
}

describe("stopping a running guest whose Home has gone silent", () => {
  it("keeps default and minimum silent-Home bounds strictly above the guest runtime deadline", () => {
    const runtimeMs = runtimeDeadlineMs();
    expect(pooledRuntimeSessionDeadlineMs).toBeGreaterThanOrEqual(runtimeMs);
    expect(minimumHomeSilenceMs).toBe(pooledRuntimeSessionDeadlineMs + homeSilenceMarginMs);
    expect(minimumHomeSilenceMs).toBeGreaterThan(runtimeMs);
    expect(defaultHomeSilenceMs).toBeGreaterThan(minimumHomeSilenceMs);
    expect(defaultHomeSilenceMs).toBeGreaterThan(runtimeMs);
    expect(agentConfigSchema.parse(baseConfig).homeSilenceSeconds).toBe(
      defaultHomeSilenceMs / 1000,
    );
  });

  it("refuses configuration and PoolAgent options below the minimum silent-Home bound", () => {
    expect(() =>
      agentConfigSchema.parse({
        ...baseConfig,
        homeSilenceSeconds: minimumHomeSilenceMs / 1000 - 1,
      }),
    ).toThrow();
    expect(() =>
      agentConfigSchema.parse({
        ...baseConfig,
        homeSilenceSeconds: 0,
      }),
    ).toThrow();
    expect(
      agentConfigSchema.parse({
        ...baseConfig,
        homeSilenceSeconds: minimumHomeSilenceMs / 1000,
      }).homeSilenceSeconds,
    ).toBe(minimumHomeSilenceMs / 1000);

    const driver = new FakeHypervisorDriver();
    const journal = new SlotJournal("/tmp/opensteer-unused-journal");
    expect(
      () => new PoolAgent({ journal, driver, homeSilenceMs: minimumHomeSilenceMs - 1 }),
    ).toThrow(RangeError);
    expect(() => new PoolAgent({ journal, driver, homeSilenceMs: Number.NaN })).toThrow(RangeError);
    expect(
      new PoolAgent({ journal, driver, homeSilenceMs: minimumHomeSilenceMs }).homeSilenceMs,
    ).toBe(minimumHomeSilenceMs);
  });

  it("stops a running guest silent for N minutes, reports home-silent to Home and operator, keeps profile, and allows cold start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await setup();
    await h.create("bps-silent-1");
    const profilePath = h.driver.profilePath("bps-silent-1");
    expect(existsSync(profilePath)).toBe(true);

    const started = (await h.apply("bps-silent-1", "start")).result;
    expect(started).toMatchObject({ applied: true, status: { phase: "running", epoch: 1 } });
    expect(h.driver.writers("bps-silent-1")).toBe(1);

    // Still running just before the deadline.
    await h.advance(defaultHomeSilenceMs - 1);
    expect(h.driver.writers("bps-silent-1")).toBe(1);
    expect(
      h.agent.agent.summaries().find((entry) => entry.slotId === "bps-silent-1")?.status,
    ).toMatchObject({ phase: "running" });

    // Past the silence timeout: stopped by the agent without touching the profile disk.
    await h.advance(1);
    await waitUntil(
      () =>
        h.agent.agent.summaries().find((entry) => entry.slotId === "bps-silent-1")?.status.phase ===
        "stopped",
    );
    expect(h.driver.writers("bps-silent-1")).toBe(0);
    expect(h.driver.networks.get("bps-silent-1")).toBe("closed");
    expect(existsSync(profilePath)).toBe(true);

    // Operator sees stopReason in list summaries and in the agent log.
    expect(
      h.agent.agent.summaries().find((entry) => entry.slotId === "bps-silent-1")?.status,
    ).toEqual({
      slotId: "bps-silent-1",
      term: 1,
      instance: started.status.instance,
      epoch: null,
      phase: "stopped",
      savedState: null,
      stopReason: "home-silent",
    });
    expect(h.events).toContainEqual(
      expect.objectContaining({
        event: "guest.stopped",
        slotId: "bps-silent-1",
        reason: "home-silent",
      }),
    );

    // Returning Home reads stopReason on signed status, then cold-starts cleanly (clearing it).
    expect(await h.signedStatus("bps-silent-1")).toEqual({
      slotId: "bps-silent-1",
      term: 1,
      instance: started.status.instance,
      epoch: null,
      phase: "stopped",
      savedState: null,
      stopReason: "home-silent",
    });
    const restarted = (await h.apply("bps-silent-1", "start")).result;
    expect(restarted).toMatchObject({
      applied: true,
      status: { phase: "running", epoch: 1, savedState: null },
    });
    expect(restarted.status.stopReason).toBeUndefined();
    expect(restarted.status.instance).not.toBe(started.status.instance);
    expect(h.driver.violations).toEqual([]);
  });

  it("resets the silence clock on any authenticated Home call or authorized relay open, and ignores unauthenticated or admin reads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await setup({ homeSilenceMs: minimumHomeSilenceMs });
    await h.create("bps-silent-reset");
    const started = await h.apply("bps-silent-reset", "start");
    expect(started.result.applied).toBe(true);

    // 1. Authenticated `status` resets the clock.
    await h.advance(minimumHomeSilenceMs - 60_000);
    expect((await h.signedStatus("bps-silent-reset")).phase).toBe("running");

    // 2. Authenticated `result` resets the clock.
    await h.advance(minimumHomeSilenceMs - 60_000);
    expect(await h.signedResult("bps-silent-reset", started.call.id)).toMatchObject({
      id: started.call.id,
      applied: true,
    });

    // 3. Authenticated `apply` (`sign`) resets the clock.
    await h.advance(minimumHomeSilenceMs - 60_000);
    expect((await h.apply("bps-silent-reset", "sign")).result.applied).toBe(true);

    // 4. Authorized relay open (`ok: true`) resets the clock.
    await h.advance(minimumHomeSilenceMs - 60_000);
    const grant = h.agent.agent.authorizeRelay(
      { v: 1, slot: "bps-silent-reset", term: 1, nonce: "a".repeat(22) },
      h.relay.spki,
    );
    expect(grant.ok).toBe(true);
    expect(h.driver.writers("bps-silent-reset")).toBe(1);

    // 5. Unauthenticated requests, refused relay hellos, and admin `summaries()` do NOT reset it.
    await h.advance(minimumHomeSilenceMs - 60_000);
    const stranger = generateKeyPairSync("ed25519");
    await expect(
      callBrowserPoolAgent(
        {
          url: h.agent.url,
          homeKey: stranger.privateKey,
          agentKey: createPublicKey(h.agent.agent.controlKey("bps-silent-reset")!),
          hostKey: h.agent.hostPublicKey,
          now: () => h.now,
        },
        "bps-silent-reset",
        1,
        { op: "status" },
      ),
    ).rejects.toThrow();
    expect(
      h.agent.agent.authorizeRelay(
        { v: 1, slot: "bps-silent-reset", term: 1, nonce: "b".repeat(22) },
        "not-the-relay-key",
      ),
    ).toEqual({ ok: false, code: "refused" });
    expect(h.agent.agent.summaries()).toHaveLength(1);

    // One minute later, the original deadline from step 4 fires and stops the guest.
    await h.advance(60_000);
    await waitUntil(
      () =>
        h.agent.agent.summaries().find((entry) => entry.slotId === "bps-silent-reset")?.status
          .phase === "stopped",
    );
    expect(h.driver.writers("bps-silent-reset")).toBe(0);
    expect(await h.signedStatus("bps-silent-reset")).toMatchObject({
      phase: "stopped",
      stopReason: "home-silent",
    });
  });

  it("restarts the silence clock from agent start time after an agent restart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await setup({ homeSilenceMs: minimumHomeSilenceMs });
    await h.create("bps-silent-restart");
    expect((await h.apply("bps-silent-restart", "start")).result.applied).toBe(true);

    // Almost silent for the whole window, then the agent restarts (guest keeps running).
    await h.advance(minimumHomeSilenceMs - 60_000);
    await h.restart();
    expect(h.driver.writers("bps-silent-restart")).toBe(1);

    // Another (N - 1 min) passes after restart (2N - 2 min since start): still running.
    await h.advance(minimumHomeSilenceMs - 60_000);
    expect(h.driver.writers("bps-silent-restart")).toBe(1);
    expect(
      h.agent.agent.summaries().find((entry) => entry.slotId === "bps-silent-restart")?.status
        .phase,
    ).toBe("running");

    // The remaining minute passes: now stopped.
    await h.advance(60_000);
    await waitUntil(
      () =>
        h.agent.agent.summaries().find((entry) => entry.slotId === "bps-silent-restart")?.status
          .phase === "stopped",
    );
    expect(h.driver.writers("bps-silent-restart")).toBe(0);
    expect(await h.signedStatus("bps-silent-restart")).toMatchObject({
      phase: "stopped",
      stopReason: "home-silent",
    });
  });

  it("leaves parked guests alone (in memory and on disk); their own discard time governs them", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await setup({ homeSilenceMs: minimumHomeSilenceMs });
    for (const tier of ["memory", "disk"] as const) {
      const slotId = `bps-silent-parked-${tier}`;
      await h.create(slotId);
      expect((await h.apply(slotId, "start")).result.applied).toBe(true);
      const paused = (await h.apply(slotId, "pause")).result;
      const savedState = paused.savedState!;
      if (tier === "disk")
        expect(await h.agent.agent.saveToDisk(slotId, savedState.id)).toBe("saved");

      // Advance well past the silent-Home window (2 hours), still within 24h discardAt.
      await h.advance(2 * 60 * 60_000);
      expect(
        h.agent.agent.summaries().find((entry) => entry.slotId === slotId)?.status,
      ).toMatchObject({
        phase: "paused",
        savedState,
      });
      if (tier === "memory") expect(h.driver.writers(slotId)).toBe(1);
      else expect(h.driver.images.has(savedState.id)).toBe(true);
    }
  });

  for (const point of ["silent-stop:journaled", "silent-stop:killed"] as const) {
    it(`recovers cleanly from a crash at ${point} like any other stop`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let armed = true;
      let crashed = false;
      const h = await setup({
        homeSilenceMs: minimumHomeSilenceMs,
        checkpoint: (reached) => {
          if (armed && reached === point) {
            crashed = true;
            throw new AgentCrashed(reached);
          }
        },
      });
      const slotId = `bps-silent-crash-${point.replace(":", "-")}`;
      await h.create(slotId);
      const started = (await h.apply(slotId, "start")).result;
      expect(started.applied).toBe(true);

      await h.advance(minimumHomeSilenceMs);
      await waitUntil(() => crashed);
      expect(crashed).toBe(true);
      armed = false;

      // Restart without the crash checkpoint: recovery finishes the autonomous stop.
      await h.restart();
      expect(h.driver.writers(slotId)).toBe(0);
      expect(h.driver.networks.get(slotId)).toBe("closed");
      expect(await h.signedStatus(slotId)).toEqual({
        slotId,
        term: 1,
        instance: started.status.instance,
        epoch: null,
        phase: "stopped",
        savedState: null,
        stopReason: "home-silent",
      });

      // Returning Home can cold-start immediately.
      const fresh = (await h.apply(slotId, "start")).result;
      expect(fresh).toMatchObject({ applied: true, status: { phase: "running", epoch: 1 } });
      expect(fresh.status.stopReason).toBeUndefined();
      expect(h.driver.writers(slotId)).toBe(1);
      expect(h.driver.violations).toEqual([]);
    });
  }
});
