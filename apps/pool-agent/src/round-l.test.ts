/**
 * "No upstream, no start" holds for the egress proxy process too. On a host that requires an
 * upstream (`pullsEgress`), `start` confirms the proxy is serving before boot. A wake
 * repairs failed units first and checks health alongside the restore.
 *
 * On a resume, host and proxy setup (and closing the guest network gate) are confirmed before
 * the right to resume is consumed (`consumed`). A refusal known before anything is loaded or
 * thawed (for example, a failed host/network/proxy prepare step) returns a stored,
 * signed refusal that leaves the slot `paused` with its saved state intact so a later resume
 * succeeds and keeps the guest's pages.
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import {
  callBrowserPoolAgent,
  type BrowserPoolAgentCall,
  type BrowserPoolAgentResult,
  type BrowserPoolAgentStatus,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCrashed } from "./agent.js";
import { FakeHypervisorDriver } from "./fake-driver.test-support.js";
import { callFor, open } from "./review.test-support.js";
import type { SlotEgressAnswer } from "./slot-egress-fetch.js";
import { homeKeyPair, startTestPoolAgent, testGuest } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

const answer: SlotEgressAnswer = {
  upstreamUrl: "https://upstream.example:8443",
  username: "u-1",
  password: "the password",
};

class CountingProxyDriver extends FakeHypervisorDriver {
  proxyChecks = 0;
  readonly proxyResets: string[] = [];
  hangProxy = false;
  proxyHealth: Promise<boolean> | undefined;

  override async resetProxy(slotId: string): Promise<void> {
    this.proxyResets.push(slotId);
    this.proxyUnhealthy.delete(slotId);
    await super.resetProxy(slotId);
  }

  override async verifyProxy(slotId: string, signal: AbortSignal): Promise<boolean> {
    this.proxyChecks += 1;
    if (!this.hangProxy && !this.proxyHealth) return super.verifyProxy(slotId, signal);
    return new Promise<boolean>((resolve) => {
      const abort = () => resolve(false);
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      void this.proxyHealth?.then((healthy) => {
        signal.removeEventListener("abort", abort);
        resolve(healthy);
      });
    });
  }
}

async function setup(options: {
  readonly pullsEgress: boolean;
  readonly saveAfterMs?: number | null;
  readonly proxyMs?: number;
  readonly hostCheckMs?: number;
  readonly checkpoint?: (point: string) => void;
}) {
  const driver = new CountingProxyDriver({ pullsEgress: options.pullsEgress });
  let running = await startTestPoolAgent({
    saveAfterMs: options.saveAfterMs ?? null,
    driver,
    ...(options.pullsEgress ? { egressFetch: async () => answer } : {}),
    ...(options.proxyMs !== undefined ? { deadlines: { proxy: options.proxyMs } } : {}),
    ...(options.hostCheckMs !== undefined ? { hostCheckMs: options.hostCheckMs } : {}),
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
  });
  open.push(running);
  const home = homeKeyPair();
  const agentKeys = new Map<string, KeyObject>();

  const create = async (slotId: string) => {
    const summary = await running.agent.createSlot({
      slotId,
      term: 1,
      homeKey: home.spki,
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
  });

  const signedStatus = async (slotId: string): Promise<BrowserPoolAgentStatus> => {
    const reply = await callBrowserPoolAgent(endpoint(slotId), slotId, 1, { op: "status" });
    if (reply.op !== "status") throw new Error(`unexpected ${reply.op}`);
    return reply.status;
  };

  const signedResult = async (
    slotId: string,
    id: string,
  ): Promise<BrowserPoolAgentResult | null> => {
    const reply = await callBrowserPoolAgent(endpoint(slotId), slotId, 1, { op: "result", id });
    if (reply.op !== "result") throw new Error(`unexpected ${reply.op}`);
    return reply.result;
  };

  const applyCall = async (
    slotId: string,
    call: BrowserPoolAgentCall,
  ): Promise<BrowserPoolAgentResult> => {
    const reply = await callBrowserPoolAgent(endpoint(slotId), slotId, 1, { op: "apply", call });
    if (reply.op !== "apply") throw new Error(`unexpected ${reply.op}`);
    return reply.result;
  };

  const apply = async (slotId: string, kind: "start" | "pause" | "resume" | "stop") => {
    const status = await signedStatus(slotId);
    const call = callFor(status, kind);
    return { call, result: await applyCall(slotId, call) };
  };

  const restart = async (checkpoint?: (point: string) => void) => {
    const idx = open.indexOf(running);
    running = await running.restart(checkpoint ? { checkpoint } : {});
    if (idx >= 0) open[idx] = running;
    else open.push(running);
    return running;
  };

  return {
    driver,
    get agent() {
      return running;
    },
    create,
    signedStatus,
    signedResult,
    applyCall,
    apply,
    restart,
  };
}

describe("slot proxy readiness when upstream is required", () => {
  it("refuses start with stored, signed egress-proxy-down and boots nothing when proxy is down", async () => {
    const h = await setup({ pullsEgress: true });
    await h.create("bps-e2-start");
    h.driver.proxyUnhealthy.add("bps-e2-start");

    const { call, result } = await h.apply("bps-e2-start", "start");
    expect(result).toMatchObject({
      applied: false,
      reason: "egress-proxy-down",
      status: { phase: "stopped" },
    });
    expect(await h.signedResult("bps-e2-start", call.id)).toMatchObject({
      applied: false,
      reason: "egress-proxy-down",
    });
    expect(h.driver.boots).toHaveLength(0);
    expect(h.driver.processes.size).toBe(0);

    // Once the proxy is serving again, a fresh start succeeds.
    h.driver.proxyUnhealthy.delete("bps-e2-start");
    const recovered = await h.apply("bps-e2-start", "start");
    expect(recovered.result).toMatchObject({
      applied: true,
      status: { phase: "running" },
    });
    expect(recovered.result.status.proxy).toBeUndefined();
    expect(h.driver.boots).toHaveLength(1);
  });

  it.each([
    { tier: "memory", service: "failed" },
    { tier: "disk", service: "activating" },
  ] as const)(
    "resets the $service proxy before consuming the wake from $tier",
    async ({ tier, service }) => {
      const slotId = `bps-e4-${tier}`;
      let serviceState: typeof service | "inactive" = "inactive";
      let stateAtConsumption: string | undefined;
      const h = await setup({
        pullsEgress: true,
        checkpoint: (point) => {
          if (point === "resume:consumed") stateAtConsumption = serviceState;
        },
      });
      await h.create(slotId);
      const started = (await h.apply(slotId, "start")).result;
      expect(started).toMatchObject({ applied: true, status: { phase: "running", epoch: 1 } });
      const paused = (await h.apply(slotId, "pause")).result;
      expect(paused).toMatchObject({ applied: true, status: { phase: "paused" } });
      const saved = paused.savedState!;
      const jails = [...h.driver.processes.keys()];
      expect(jails).toHaveLength(1);
      if (tier === "disk") {
        expect(await h.agent.agent.saveToDisk(slotId, saved.id)).toBe("saved");
        expect(h.driver.processes.size).toBe(0);
        expect(h.driver.images.has(saved.id)).toBe(true);
      }

      h.driver.proxyDown.add(slotId);
      h.driver.sockets.delete(slotId);
      serviceState = service;
      const prepareProxy = vi.spyOn(h.driver, "prepareProxy").mockImplementation(async () => {
        expect(h.driver.revived).toEqual([slotId]);
        expect(serviceState).toBe(service);
        serviceState = "inactive";
      });
      const { call, result } = await h.apply(slotId, "resume");
      expect(prepareProxy).toHaveBeenCalledExactlyOnceWith(slotId, expect.any(AbortSignal));
      expect(stateAtConsumption).toBe("inactive");
      expect(result).toMatchObject({
        applied: true,
        status: { phase: "running", instance: started.status.instance, epoch: 2, savedState: null },
      });
      expect(await h.signedResult(slotId, call.id)).toEqual(result);
      expect(await h.signedStatus(slotId)).toEqual(result.status);
      expect(h.driver.revived).toEqual([slotId]);
      expect(h.driver.sockets.has(slotId)).toBe(true);
      expect(h.driver.proxyResets).toEqual([]);
      expect(h.agent.agent.effects(slotId)).not.toContain("lost");
      expect(h.driver.operations.filter((op) => op.startsWith("boot:"))).toHaveLength(1);
      if (tier === "disk") {
        expect(h.driver.loaded.get(saved.id)).toBe(1);
      } else {
        expect([...h.driver.processes.keys()]).toEqual(jails);
        expect(h.driver.processes.get(jails[0]!)?.state).toBe("running");
      }
      expect(h.driver.processes.size).toBe(1);
      expect(h.driver.violations).toEqual([]);
    },
  );

  it("restores after the consumed write and answers while proxy health is still pending", async () => {
    const slotId = "bps-e4-wake-health";
    const checkpoints: string[] = [];
    const h = await setup({
      pullsEgress: true,
      proxyMs: 30_000,
      checkpoint: (point) => {
        if (point.startsWith("resume:")) checkpoints.push(point);
      },
    });
    await h.create(slotId);
    await h.apply(slotId, "start");
    const paused = (await h.apply(slotId, "pause")).result;
    const saved = paused.savedState!;
    expect(await h.agent.agent.saveToDisk(slotId, saved.id)).toBe("saved");
    const restore = h.driver.restore.bind(h.driver);
    h.driver.restore = async (...args) => {
      expect(checkpoints.at(-1)).toBe("resume:consumed");
      expect(h.driver.proxyChecks).toBe(2);
      await restore(...args);
    };
    // This probe answers only on cancellation. Its deadline is beyond the test's timeout.
    h.driver.hangProxy = true;
    expect((await h.apply(slotId, "resume")).result).toMatchObject({
      applied: true,
      status: { phase: "running" },
    });
    expect(h.driver.loaded.get(saved.id)).toBe(1);
  });

  it("reports a failed wake health check in signed status and repairs through pause and resume", async () => {
    const slotId = "bps-e4-wake-repair";
    const h = await setup({ pullsEgress: true, proxyMs: 250 });
    await h.create(slotId);
    await h.apply(slotId, "start");
    await h.apply(slotId, "pause");
    const health = Promise.withResolvers<boolean>();
    h.driver.proxyHealth = health.promise;
    try {
      expect((await h.apply(slotId, "resume")).result).toMatchObject({
        applied: true,
        status: { phase: "running" },
      });
    } finally {
      health.resolve(false);
    }
    await expect.poll(h.signedStatus.bind(null, slotId)).toMatchObject({
      phase: "running",
      proxy: "down",
    });
    expect(await h.driver.proxiesDown()).toEqual([]);
    h.driver.proxyUnhealthy.add(slotId);
    expect((await h.apply(slotId, "pause")).result.status.phase).toBe("paused");
    expect(h.driver.proxyResets).toEqual([slotId]);
    expect(h.driver.proxyUnhealthy.has(slotId)).toBe(false);
    h.driver.proxyHealth = undefined;
    expect((await h.apply(slotId, "resume")).result).toMatchObject({
      applied: true,
      status: { phase: "running" },
    });
    expect((await h.signedStatus(slotId)).proxy).toBeUndefined();
  });

  it("ignores a failed health answer caused by cancelling the probe at pause", async () => {
    const slotId = "bps-e4-wake-cancel";
    const h = await setup({ pullsEgress: true, proxyMs: 30_000 });
    await h.create(slotId);
    await h.apply(slotId, "start");
    await h.apply(slotId, "pause");
    h.driver.hangProxy = true;
    expect((await h.apply(slotId, "resume")).result.applied).toBe(true);
    expect(h.driver.proxyChecks).toBe(2);

    expect((await h.apply(slotId, "pause")).result.status.phase).toBe("paused");
    expect(h.driver.proxyResets).toEqual([]);
    expect((await h.signedStatus(slotId)).proxy).toBeUndefined();
  });

  it("clears a wake health timeout when a periodic probe finds the proxy serving", async () => {
    const slotId = "bps-e4-wake-slow";
    const h = await setup({ pullsEgress: true, proxyMs: 100, hostCheckMs: 20 });
    await h.create(slotId);
    await h.apply(slotId, "start");
    await h.apply(slotId, "pause");
    h.driver.hangProxy = true;
    const { result } = await h.apply(slotId, "resume");
    expect(result.applied).toBe(true);
    await expect
      .poll(() => h.signedStatus(slotId))
      .toMatchObject({ phase: "running", proxy: "down" });

    h.driver.hangProxy = false;
    await expect.poll(async () => (await h.signedStatus(slotId)).proxy).toBeUndefined();
    expect(await h.signedStatus(slotId)).toEqual(result.status);
    expect(h.driver.proxyResets).toEqual([]);
  });

  it("keeps savedState intact when host, network, proxy revive or gate close fails before resume is consumed", async () => {
    for (const fault of ["ensureHost", "prepareSlot", "reviveProxy", "closeNetwork"] as const) {
      const slotId = `bps-e4-${fault}`;
      const h = await setup({ pullsEgress: false });
      await h.create(slotId);
      const started = (await h.apply(slotId, "start")).result;
      const paused = (await h.apply(slotId, "pause")).result;
      const savedState = paused.savedState!;

      if (fault === "prepareSlot") {
        h.driver.prepareError = new Error("prepareSlot failed");
      } else if (fault === "reviveProxy") {
        h.driver.proxyDown.add(slotId);
        h.driver.fail("reviveProxy", new Error("reviveProxy failed"));
      } else {
        h.driver.fail(fault, new Error(`${fault} failed`));
      }

      const { call, result } = await h.apply(slotId, "resume");
      expect(result).toMatchObject({
        applied: false,
        reason: "resume-failed",
        status: {
          phase: "paused",
          instance: started.status.instance,
          epoch: 1,
          savedState,
        },
      });
      expect(await h.signedResult(slotId, call.id)).toEqual(result);
      expect(h.driver.processes.size).toBe(1);
      expect(h.agent.agent.effects(slotId)).not.toContain("lost");

      // Clear the fault: the slot resumes with its pages intact.
      h.driver.prepareError = undefined;
      h.driver.proxyDown.delete(slotId);
      const resumed = (await h.apply(slotId, "resume")).result;
      expect(resumed).toMatchObject({
        applied: true,
        status: {
          phase: "running",
          instance: started.status.instance,
          epoch: 2,
          savedState: null,
        },
      });
      expect(h.driver.violations).toEqual([]);
    }
  });

  for (const tier of ["memory", "disk"] as const) {
    it(`recovers paused and accepts retry after a crash between proxy check and consumed (${tier})`, async () => {
      let armed = false;
      const h = await setup({
        pullsEgress: true,
        checkpoint: (point) => {
          if (armed && point === "resume:prepared") throw new AgentCrashed(point);
        },
      });
      const slotId = `bps-e4-crash-prepared-${tier}`;
      await h.create(slotId);
      const started = (await h.apply(slotId, "start")).result;
      const paused = (await h.apply(slotId, "pause")).result;
      const savedState = paused.savedState!;
      if (tier === "disk")
        expect(await h.agent.agent.saveToDisk(slotId, savedState.id)).toBe("saved");

      const statusBefore = await h.signedStatus(slotId);
      const call = callFor(statusBefore, "resume");
      armed = true;
      await expect(h.agent.agent.apply(call)).rejects.toBeInstanceOf(AgentCrashed);
      armed = false;

      // Restart the agent on the same journal and driver.
      await h.restart();
      expect(await h.signedStatus(slotId)).toMatchObject({
        phase: "paused",
        instance: started.status.instance,
        epoch: 1,
        savedState,
      });
      // Nothing was committed for this call before the crash.
      expect(await h.signedResult(slotId, call.id)).toBeNull();
      if (tier === "disk") {
        expect(h.driver.images.has(savedState.id)).toBe(true);
        expect(h.driver.loaded.get(savedState.id)).toBeUndefined();
      } else {
        expect(h.driver.processes.size).toBe(1);
      }

      // Repeating the exact same call succeeds and resumes the guest with its pages intact.
      const resumed = await h.applyCall(slotId, call);
      expect(resumed).toMatchObject({
        applied: true,
        status: {
          phase: "running",
          instance: started.status.instance,
          epoch: 2,
          savedState: null,
        },
      });
      expect(h.driver.writers(slotId)).toBe(1);
      expect(h.driver.violations).toEqual([]);
    });

    it(`settles stopped with interrupted after a crash between consumed and first load (${tier})`, async () => {
      let armed = false;
      const h = await setup({
        pullsEgress: true,
        checkpoint: (point) => {
          if (armed && point === "resume:consumed") throw new AgentCrashed(point);
        },
      });
      const slotId = `bps-e4-crash-consumed-${tier}`;
      await h.create(slotId);
      await h.apply(slotId, "start");
      const paused = (await h.apply(slotId, "pause")).result;
      const savedState = paused.savedState!;
      if (tier === "disk")
        expect(await h.agent.agent.saveToDisk(slotId, savedState.id)).toBe("saved");

      const statusBefore = await h.signedStatus(slotId);
      const call = callFor(statusBefore, "resume");
      armed = true;
      await expect(h.agent.agent.apply(call)).rejects.toBeInstanceOf(AgentCrashed);
      armed = false;

      await h.restart();
      expect(await h.signedStatus(slotId)).toMatchObject({
        phase: "stopped",
        savedState: null,
      });
      const answerAfter = await h.signedResult(slotId, call.id);
      expect(answerAfter).toMatchObject({
        id: call.id,
        applied: false,
        reason: "interrupted",
        status: { phase: "stopped", savedState: null },
      });
      // Repeating the same call returns the same definite refusal; the Home can cold-start.
      expect(await h.applyCall(slotId, call)).toEqual(answerAfter);
      expect(h.driver.writers(slotId)).toBe(0);
      expect(h.driver.loaded.get(savedState.id)).toBeUndefined();
      expect((await h.apply(slotId, "start")).result).toMatchObject({
        applied: true,
        status: { phase: "running", epoch: 1 },
      });
      expect(h.driver.violations).toEqual([]);
    });
  }

  it("does not enforce proxy readiness on a host that does not require an upstream", async () => {
    const h = await setup({ pullsEgress: false });
    await h.create("bps-e2-plain");
    h.driver.proxyUnhealthy.add("bps-e2-plain");

    const { result } = await h.apply("bps-e2-plain", "start");
    expect(result).toMatchObject({ applied: true, status: { phase: "running" } });
    expect(h.driver.proxyChecks).toBe(0);
  });

  it("refuses start with egress-proxy-down when proxy verification hits the bound", async () => {
    const h = await setup({ pullsEgress: true, proxyMs: 50 });
    await h.create("bps-e2-timeout");
    h.driver.hangProxy = true;

    const { result } = await h.apply("bps-e2-timeout", "start");
    expect(result).toMatchObject({
      applied: false,
      reason: "egress-proxy-down",
      status: { phase: "stopped" },
    });
    expect(h.driver.boots).toHaveLength(0);
    expect(h.driver.processes.size).toBe(0);
  });
});
