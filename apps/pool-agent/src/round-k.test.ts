/**
 * The recheck of the pool wiring and enrolment (pool-wiring-enrolment-recheck-opus.md, Z6 and
 * Z2). Through the agent, the administration server and the provisioner's own client; only the
 * mount state is simulated. Written against 94c631128.
 */
import { generateKeyPairSync } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { callBrowserPoolAgentAdmin } from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { FakeHypervisorDriver } from "./fake-driver.test-support.js";
import { callFor, open } from "./review.test-support.js";
import { createAdminServer, listen } from "./server.js";
import { credentialFiles } from "./slot-credentials.js";
import { homeKeyPair, startTestPoolAgent, testGuest } from "./test-support.js";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** A mounted, pulling host behind its administration server, called as the provisioner calls it. */
async function host() {
  const driver = new FakeHypervisorDriver({ profilesMount: {}, pullsEgress: true });
  driver.profilesMounted = true;
  const agent = await startTestPoolAgent({
    saveAfterMs: null,
    driver,
    egressFetch: async () => ({
      upstreamUrl: "https://upstream.example:8443",
      username: "u-1",
      password: "a password",
    }),
  });
  open.push(agent);
  const provisioner = generateKeyPairSync("ed25519");
  const hostKeys = generateKeyPairSync("ed25519");
  const server = createAdminServer({
    agent: agent.agent,
    provisionerKey: provisioner.publicKey,
    hostId: "pool-host-k",
    hostKey: hostKeys.privateKey,
  });
  const address = (await listen(server, { host: "127.0.0.1", port: 0 })) as AddressInfo;
  closing.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const admin = (request: Parameters<typeof callBrowserPoolAgentAdmin>[1]) =>
    callBrowserPoolAgentAdmin(
      {
        url: `http://127.0.0.1:${address.port}`,
        provisionerKey: provisioner.privateKey,
        host: "pool-host-k",
        hostKey: hostKeys.publicKey,
      },
      request,
    );
  const create = (slotId: string, term = 1) =>
    admin({ op: "create", slotId, term, homeKey: homeKeyPair().spki, guest: testGuest } as never);
  const remove = (slotId: string, term: number) =>
    admin({ op: "delete", slotId, term, eraseProfile: true } as never);
  return { agent, driver, admin, create, remove };
}

describe("Z6: a missing profile disk has its own signed code", () => {
  it("answers create and delete with profile-disk-missing, and a term conflict with conflict", async () => {
    const h = await host();
    await h.create("kept", 2);
    // A conflict stays a conflict.
    await expect(h.remove("kept", 1)).rejects.toMatchObject({
      name: "BrowserPoolAgentUnavailable",
      refusal: "conflict",
    });
    h.driver.profilesMounted = false;
    await expect(h.create("new")).rejects.toMatchObject({
      name: "BrowserPoolAgentUnavailable",
      refusal: "profile-disk-missing",
      message: expect.stringMatching(/not mounted/u),
    });
    await expect(h.remove("kept", 2)).rejects.toMatchObject({
      name: "BrowserPoolAgentUnavailable",
      refusal: "profile-disk-missing",
    });
    expect(await present(h.driver.profilePath("new"))).toBe(false);
    expect(await present(h.driver.profilePath("kept"))).toBe(true);
  });
});

describe("Z2: the mount is checked again immediately before the erase", () => {
  it("keeps the profile when the mount goes mid-delete, and a repeated delete erases it once", async () => {
    const h = await host();
    await h.create("bps");
    expect(
      await h.agent.agent.apply(callFor(await h.agent.agent.status("bps", 1), "start")),
    ).toMatchObject({ applied: true });
    const credentials = credentialFiles(h.driver.credentialsRoot, "bps");
    expect(await present(credentials.password)).toBe(true);
    // The mount goes after the delete's first check, while the slot's network is removed.
    const removeSlot = h.driver.removeSlot.bind(h.driver);
    h.driver.removeSlot = async (slotId) => {
      await removeSlot(slotId);
      h.driver.profilesMounted = false;
    };
    await expect(h.remove("bps", 1)).rejects.toMatchObject({
      refusal: "profile-disk-missing",
    });
    expect(h.driver.erasing).toBe(0);
    expect(await present(h.driver.profilePath("bps"))).toBe(true);
    // Half done: guest and credentials gone, the slot tombstoned, the profile kept.
    expect(h.driver.writers("bps")).toBe(0);
    expect(await present(credentials.password)).toBe(false);
    expect(h.agent.agent.slotIds()).not.toContain("bps");
    // The disk comes back: the repeated delete answers all three, and erases exactly once.
    h.driver.profilesMounted = true;
    expect(await h.remove("bps", 1)).toEqual({
      op: "delete",
      slotId: "bps",
      erased: true,
      profileErased: true,
      credentialsErased: true,
    });
    expect(h.driver.erasing).toBe(1);
    expect(await present(h.driver.profilePath("bps"))).toBe(false);
  });
});
