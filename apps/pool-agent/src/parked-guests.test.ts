/**
 * Parked guests, deadlines and retention (pool-agent-review-state-sol.md, findings 3, 4, 6, 7, 10, 11).
 * Each test was written against 5f37312fb and failed there for the reason the review gives.
 */
import { afterEach, describe, expect, it } from "vitest";
import { agentConfigSchema } from "./config.js";
import { callFor, fixture, slotId, open } from "./review.test-support.js";
import { startTestPoolAgent } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

describe("finding 3: a save that times out cannot leave an image behind", () => {
  it("finishes or ends the writer before the slot is released, so no image appears afterwards", async () => {
    const f = await fixture({ deadlines: { snapshot: 50 } });
    await f.call("start");
    await f.call("pause");
    const paused = await f.status();
    let release!: () => void;
    f.driver.gate("snapshot", new Promise<void>((resolve) => (release = resolve)));
    const saving = f.agent.agent.saveToDisk(slotId, paused.savedState!.id);
    await expect.poll(() => f.events.some((event) => event.event === "save.failed")).toBe(true);
    release();
    await saving;
    await expect.poll(() => f.driver.snapshotsFinished).toBe(1);
    expect(f.driver.images.size).toBe(0);
    expect(f.driver.violations).toEqual([]);
  });
});

describe("finding 4: a process whose state cannot be confirmed is not accepted", () => {
  it("leaves a guest whose VMM never answers stopped, live and at agent start", async () => {
    const f = await fixture({ deadlines: { inspect: 200 } });
    await f.call("start");
    const jail = [...f.driver.processes.keys()][0]!;
    f.driver.answerUnknown(jail);
    expect(await f.status()).toMatchObject({ phase: "stopped" });
    expect(f.driver.writers(slotId)).toBe(0);
    await f.call("start");
    const second = [...f.driver.processes.keys()][0]!;
    f.driver.answerUnknown(second);
    await f.restart();
    expect(f.phase()).toBe("stopped");
    expect(f.driver.writers(slotId)).toBe(0);
  });

  it("keeps a guest whose VMM answers again within the wait", async () => {
    const f = await fixture({ deadlines: { inspect: 2_000 } });
    await f.call("start");
    f.driver.answerUnknown([...f.driver.processes.keys()][0]!, 2);
    expect(await f.status()).toMatchObject({ phase: "running" });
    expect(f.driver.writers(slotId)).toBe(1);
  });
});

describe("finding 6: an answered id never acts again", () => {
  it("keeps a recent answer through more newer calls than the list holds, refusing them rather than evict it", async () => {
    const f = await fixture({ maxResults: 16 });
    await f.call("start");
    const running = await f.status();
    const sign = callFor(running, "sign");
    const first = await f.agent.agent.apply(sign);
    expect(first.applied).toBe(true);
    for (let i = 0; i < 32; i += 1)
      await f.agent.agent.apply(callFor({ ...running, epoch: 99 }, "pause")).catch(() => undefined);
    expect(await f.agent.agent.apply(sign)).toEqual(first);
  });
});

describe("finding 7: every step is bounded and failed clean-up retries by itself", () => {
  it("does not hold a waiting wake behind a discard that never returns", async () => {
    const f = await fixture({ deadlines: { discard: 100 } });
    await f.call("start");
    await f.call("pause");
    const paused = await f.status();
    let release!: () => void;
    f.driver.gate("snapshot", new Promise<void>((resolve) => (release = resolve)));
    const saving = f.agent.agent.saveToDisk(slotId, paused.savedState!.id).catch(() => "failed");
    await expect.poll(() => f.driver.operations.includes(`snapshot:${slotId}`)).toBe(true);
    f.driver.fail("discard", "hang");
    let woke = false;
    const waking = f.agent.agent.apply(callFor(paused, "resume")).finally(() => (woke = true));
    release();
    await expect.poll(() => woke, { timeout: 2_000 }).toBe(true);
    await waking.catch(() => undefined);
    await saving;
  });

  it("finishes a stop whose clean-up failed without waiting for another call", async () => {
    const f = await fixture({ retryMs: 20 });
    await f.call("start");
    f.driver.fail("kill", new Error("cgroup busy"));
    await f.call("stop").catch(() => undefined);
    await expect.poll(() => f.phase(), { timeout: 2_000 }).toBe("stopped");
    expect(f.driver.writers(slotId)).toBe(0);
  });

  it("retries an expiry whose clean-up failed", async () => {
    const f = await fixture({ retentionMs: 300, retryMs: 20 });
    await f.call("start");
    await f.call("pause");
    f.driver.fail("kill", new Error("cgroup busy"));
    await expect.poll(() => f.phase(), { timeout: 2_000 }).toBe("stopped");
    expect(f.driver.writers(slotId)).toBe(0);
  });
});

describe("finding 10: the expiry stays armed until the park ends", () => {
  it("re-arms when the wall clock was put back before the timer fired", async () => {
    let offset = 0;
    const f = await fixture({ retentionMs: 300, now: () => Date.now() + offset });
    await f.call("start");
    await f.call("pause");
    offset = -250;
    await expect.poll(() => f.phase(), { timeout: 2_000 }).toBe("stopped");
  });
});

describe("finding 11: retention is at most 24 hours", () => {
  it("refuses a configuration and an agent that would keep a park longer", async () => {
    const config = {
      journal: "/var/lib/opensteer-pool/journal",
      listen: { host: "127.0.0.1", port: 7310 },
      admin: {
        listen: { host: "127.0.0.1", port: 7311 },
        provisionerKey: "a".repeat(60),
        hostId: "pool-host-a",
        hostKeyFile: "/etc/opensteer-pool/host-key.pem",
      },
      driver: {
        firecracker: "/opt/f",
        jailer: "/opt/j",
        images: "/srv/i",
        jailRoot: "/srv/j",
        savedRoot: "/srv/s",
        stateDirectory: "/var/d",
        arrayIdFile: "/run/a",
        profilesRoot: "/var/p",
        credentialsRoot: "/etc/c",
        slotUidBase: 200_000,
        egressUidBase: 300_000,
        egress: { node: "/opt/n", main: "/opt/m" },
        network: { resolvers: [] },
      },
    };
    expect(agentConfigSchema.parse({ ...config, retentionHours: 24 }).retentionHours).toBe(24);
    expect(() => agentConfigSchema.parse({ ...config, retentionHours: 48 })).toThrow();
    await expect(startTestPoolAgent({ retentionMs: 48 * 60 * 60_000 })).rejects.toThrow();
  });
});
