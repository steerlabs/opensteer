/**
 * E2: "no upstream, no start" holds for the egress proxy process too. On a host that requires an
 * upstream (`pullsEgress`), `start` and wake (`resume` from memory or from disk) confirm the
 * slot's proxy is serving within a bounded wait before answering applied. If it is not, no guest
 * is left running and the agent answers with a stored, signed refusal (`egress-proxy-down`).
 */
import { afterEach, describe, expect, it } from "vitest";
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
  hangProxy = false;

  override async verifyProxy(slotId: string, signal: AbortSignal): Promise<boolean> {
    this.proxyChecks += 1;
    if (this.hangProxy) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return false;
    }
    return super.verifyProxy(slotId, signal);
  }
}

async function setup(options: {
  readonly pullsEgress: boolean;
  readonly saveAfterMs?: number | null;
  readonly proxyMs?: number;
}) {
  const driver = new CountingProxyDriver({ pullsEgress: options.pullsEgress });
  const agent = await startTestPoolAgent({
    saveAfterMs: options.saveAfterMs ?? null,
    driver,
    ...(options.pullsEgress ? { egressFetch: async () => answer } : {}),
    ...(options.proxyMs !== undefined ? { deadlines: { proxy: options.proxyMs } } : {}),
  });
  open.push(agent);
  const create = (slotId: string) =>
    agent.agent.createSlot({ slotId, term: 1, homeKey: homeKeyPair().spki, guest: testGuest });
  const apply = async (slotId: string, kind: "start" | "pause" | "resume" | "stop") => {
    const status = await agent.agent.status(slotId, 1);
    const call = callFor(status, kind);
    return { call, result: await agent.agent.apply(call) };
  };
  return { driver, agent, create, apply };
}

describe("E2: start and wake confirm the slot proxy is serving when upstream is required", () => {
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
    expect(await h.agent.agent.result("bps-e2-start", 1, call.id)).toMatchObject({
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

  it("refuses wake from memory with egress-proxy-down and leaves no guest running when proxy is down", async () => {
    const h = await setup({ pullsEgress: true });
    await h.create("bps-e2-mem");
    expect((await h.apply("bps-e2-mem", "start")).result).toMatchObject({ applied: true });
    expect((await h.apply("bps-e2-mem", "pause")).result).toMatchObject({
      applied: true,
      status: { phase: "paused" },
    });
    expect(h.driver.processes.size).toBe(1);

    h.driver.proxyUnhealthy.add("bps-e2-mem");
    const { call, result } = await h.apply("bps-e2-mem", "resume");
    expect(result).toMatchObject({
      applied: false,
      reason: "egress-proxy-down",
      status: { phase: "stopped" },
    });
    expect(await h.agent.agent.result("bps-e2-mem", 1, call.id)).toMatchObject({
      applied: false,
      reason: "egress-proxy-down",
    });
    expect(h.driver.processes.size).toBe(0);
  });

  it("refuses wake from disk with egress-proxy-down and leaves no guest running when proxy is down", async () => {
    const h = await setup({ pullsEgress: true });
    await h.create("bps-e2-disk");
    expect((await h.apply("bps-e2-disk", "start")).result).toMatchObject({ applied: true });
    const paused = (await h.apply("bps-e2-disk", "pause")).result;
    expect(paused).toMatchObject({ applied: true, status: { phase: "paused" } });
    await h.agent.agent.saveToDisk("bps-e2-disk", paused.savedState!.id);
    expect(h.driver.processes.size).toBe(0);

    h.driver.proxyUnhealthy.add("bps-e2-disk");
    const { call, result } = await h.apply("bps-e2-disk", "resume");
    expect(result).toMatchObject({
      applied: false,
      reason: "egress-proxy-down",
      status: { phase: "stopped" },
    });
    expect(await h.agent.agent.result("bps-e2-disk", 1, call.id)).toMatchObject({
      applied: false,
      reason: "egress-proxy-down",
    });
    expect(h.driver.processes.size).toBe(0);
  });

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
