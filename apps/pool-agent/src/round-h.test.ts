/**
 * Round H: "no upstream, no start" on a host that pulls each slot's upstream credentials, and
 * the free-space guard at create. Through the agent, with the credential and profile modules
 * the real driver uses on real files; only the fetch and `mkfs.ext4` are stood in for. Each
 * test was written before the change and failed there.
 */
import { lstat, mkdir, readdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { describe, expect, it, afterEach } from "vitest";
import { agentConfigSchema } from "./config.js";
import { FakeHypervisorDriver } from "./fake-driver.test-support.js";
import { callFor, open } from "./review.test-support.js";
import { credentialFiles } from "./slot-credentials.js";
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

async function pulling(
  fetch: (slotId: string, signal: AbortSignal) => Promise<SlotEgressAnswer | null>,
  options: { readonly egressMs?: number } = {},
) {
  const fetched: string[] = [];
  const agent = await startTestPoolAgent({
    saveAfterMs: null,
    driver: new FakeHypervisorDriver({ pullsEgress: true }),
    egressFetch: (slotId, signal) => {
      fetched.push(slotId);
      return fetch(slotId, signal);
    },
    ...(options.egressMs ? { deadlines: { egress: options.egressMs } } : {}),
  });
  open.push(agent);
  const create = (slotId: string, term = 1) =>
    agent.agent.createSlot({ slotId, term, homeKey: homeKeyPair().spki, guest: testGuest });
  const start = async (slotId: string) => {
    const call = callFor(await agent.agent.status(slotId, 1), "start");
    return {
      call,
      outcome: await agent.agent.apply(call).then(
        (result) => result,
        (error: unknown) => error as Error,
      ),
    };
  };
  const files = (slotId: string) => credentialFiles(agent.driver.credentialsRoot, slotId);
  return { agent, fetched, create, start, files };
}

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe("a slot with no credentials on a host that pulls them", () => {
  it("fetches them before anything boots, writes them root-only, and starts", async () => {
    const h = await pulling(async () => answer);
    await h.create("bps-1");
    expect(h.agent.driver.boots).toHaveLength(0);
    const { outcome } = await h.start("bps-1");
    expect(outcome).toMatchObject({ applied: true });
    expect(h.fetched).toEqual(["bps-1"]);
    const files = h.files("bps-1");
    expect(await readFile(files.url, "utf8")).toBe(answer.upstreamUrl);
    expect(await readFile(files.username, "utf8")).toBe(answer.username);
    expect(await readFile(files.password, "utf8")).toBe(answer.password);
    for (const file of [files.url, files.username, files.password]) {
      const info = await lstat(file);
      expect(info.mode & 0o777).toBe(0o600);
      expect(info.uid).toBe(process.getuid!());
    }
    expect((await lstat(h.agent.driver.credentialsRoot)).mode & 0o777).toBe(0o700);
    // The proxy was defined again with them before the guest booted.
    const ops = h.agent.driver.operations;
    expect(ops).toContain("defineProxy:bps-1:none");
    const defined = ops.indexOf(`defineProxy:bps-1:${answer.upstreamUrl}`);
    expect(defined).toBeGreaterThan(ops.indexOf("defineProxy:bps-1:none"));
    expect(defined).toBeLessThan(ops.indexOf("boot:bps-1"));
    // Round I, U1 (superseding "present credentials are used as they are"): the host's are a
    // copy, and the next cold start asks again.
    await h.agent.agent.apply(callFor(await h.agent.agent.status("bps-1", 1), "stop"));
    await h.start("bps-1");
    expect(h.fetched).toEqual(["bps-1", "bps-1"]);
  });

  it("answers egress-required, signed and stored, and boots nothing, when none is assigned", async () => {
    const h = await pulling(async () => null);
    await h.create("bps-2");
    const { call, outcome } = await h.start("bps-2");
    expect(outcome).toMatchObject({ applied: false, reason: "egress-required" });
    expect(await h.agent.agent.result("bps-2", 1, call.id)).toMatchObject({
      applied: false,
      reason: "egress-required",
    });
    expect(h.agent.driver.boots).toHaveLength(0);
    expect(await present(h.files("bps-2").password)).toBe(false);
  });

  it("says try again, writes nothing and boots nothing, when the fetch fails or never answers", async () => {
    for (const fetch of [
      async () => {
        throw new Error("the account service answered 503");
      },
      (_slotId: string, signal: AbortSignal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    ]) {
      const h = await pulling(fetch, { egressMs: 50 });
      await h.create("bps-3");
      const { call, outcome } = await h.start("bps-3");
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).name).toBe("AgentUnavailable");
      expect((outcome as Error).message).toMatch(/try again/u);
      expect(await h.agent.agent.result("bps-3", 1, call.id)).toBeNull();
      expect(h.agent.agent.effects("bps-3")).toEqual([]);
      expect(h.agent.driver.boots).toHaveLength(0);
      expect(await readdir(h.agent.driver.credentialsRoot).catch(() => [])).toEqual([]);
    }
  });

  it("never reads a half-written temporary file from a crash as a credential", async () => {
    const h = await pulling(async () => answer);
    await h.create("bps-4");
    const files = h.files("bps-4");
    await mkdir(h.agent.driver.credentialsRoot, { recursive: true });
    // A crash after two of the three were renamed into place, and a third half-written.
    await writeFile(files.url, answer.upstreamUrl, { mode: 0o600 });
    await writeFile(files.username, answer.username, { mode: 0o600 });
    await writeFile(`${h.agent.driver.credentialsRoot}/.making-x-password-dead`, "the pass");
    const restarted = await h.agent.restart();
    open.splice(open.indexOf(h.agent), 1, restarted);
    expect(await readdir(restarted.driver.credentialsRoot)).not.toContain(
      ".making-x-password-dead",
    );
    await restarted.agent.apply(callFor(await restarted.agent.status("bps-4", 1), "start"));
    // Not all three were there: they were fetched again, whole.
    expect(await readFile(files.password, "utf8")).toBe(answer.password);
  });

  it("removes a leftover slot's credentials on a delete for a slot it does not know", async () => {
    const h = await pulling(async () => answer);
    const files = h.files("bps-gone");
    await mkdir(h.agent.driver.credentialsRoot, { recursive: true });
    for (const file of [files.url, files.username, files.password])
      await writeFile(file, "left over\n", { mode: 0o600 });
    expect(await h.agent.agent.deleteSlotWithEvidence("bps-gone", 9)).toMatchObject({
      erased: true,
      credentialsErased: true,
    });
    for (const file of [files.url, files.username, files.password])
      expect(await present(file)).toBe(false);
  });

  it("refuses a create that names its own egress", async () => {
    const h = await pulling(async () => answer);
    await expect(
      h.agent.agent.createSlot({
        slotId: "bps-5",
        term: 1,
        homeKey: homeKeyPair().spki,
        guest: {
          ...testGuest,
          egress: {
            upstreamUrl: "https://elsewhere:1",
            usernameFile: "/x/u",
            passwordFile: "/x/p",
          },
        },
      }),
    ).rejects.toMatchObject({ name: "SlotConflict" });
  });
});

describe("the free-space guard at create", () => {
  it("refuses a profile that would make the profiles exceed their filesystem, making nothing", async () => {
    const driver = new FakeHypervisorDriver();
    // Round I, U5: what an unprivileged writer can still use.
    driver.availableBytes = 100 * 1024 * 1024;
    const agent = await startTestPoolAgent({ saveAfterMs: null, driver });
    open.push(agent);
    const create = (slotId: string, profileMib: number) =>
      agent.agent.createSlot({
        slotId,
        term: 1,
        homeKey: homeKeyPair().spki,
        guest: { ...testGuest, profileMib },
      });
    await create("fits", 64);
    await expect(create("too-much", 64)).rejects.toMatchObject({ name: "SlotConflict" });
    expect(agent.agent.slotIds()).not.toContain("too-much");
    expect(await readdir(driver.profilesRoot)).toHaveLength(1);
  });
});

describe("the account origin", () => {
  it("is refused at config load unless it is https", () => {
    const base = {
      journal: "/j",
      listen: { host: "127.0.0.1", port: 7310 },
      admin: {
        listen: { host: "127.0.0.1", port: 7311 },
        provisionerKey: "A".repeat(44),
        hostId: "ph_test",
        hostKeyFile: "/etc/k.pem",
      },
      driver: {
        firecracker: "/f",
        jailer: "/j",
        images: "/i",
        jailRoot: "/r",
        savedRoot: "/s",
        stateDirectory: "/d",
        arrayIdFile: "/a",
        profilesRoot: "/p",
        credentialsRoot: "/c",
        slotUidBase: 200_000,
        egressUidBase: 300_000,
        network: { resolvers: [] },
        requireEgressUpstream: true,
      },
    };
    const withOrigin = (accountOrigin?: string) => ({
      ...base,
      driver: {
        ...base.driver,
        egress: { node: "/n", main: "/m", ...(accountOrigin ? { accountOrigin } : {}) },
      },
    });
    expect(agentConfigSchema.safeParse(withOrigin("https://account.example")).success).toBe(true);
    for (const origin of ["http://account.example", "https://u:p@account.example", undefined])
      expect(agentConfigSchema.safeParse(withOrigin(origin)).success).toBe(false);
  });
});

describe("credentialsErased whenever the credentials are proven gone (W10)", () => {
  it("is reported for a slot that never had credentials, and for a repeated delete", async () => {
    const h = await pulling(async () => answer);
    await h.create("bps-never");
    expect(await h.agent.agent.deleteSlotWithEvidence("bps-never", 1)).toMatchObject({
      erased: true,
      credentialsErased: true,
    });
    expect(await h.agent.agent.deleteSlotWithEvidence("bps-never", 1)).toMatchObject({
      erased: true,
      credentialsErased: true,
    });
  });

  it("is reported on a host that does not pull, for a slot that named none", async () => {
    const agent = await startTestPoolAgent({ saveAfterMs: null });
    open.push(agent);
    await agent.agent.createSlot({
      slotId: "plain",
      term: 1,
      homeKey: homeKeyPair().spki,
      guest: testGuest,
    });
    expect(await agent.agent.deleteSlotWithEvidence("plain", 1)).toMatchObject({
      erased: true,
      credentialsErased: true,
    });
  });

  it("refuses the delete when a file is there and cannot be removed, and it can be sent again", async () => {
    const h = await pulling(async () => answer);
    await h.create("bps-stuck");
    const files = h.files("bps-stuck");
    // Not a plain file: the agent will not remove it.
    await mkdir(files.password, { recursive: true });
    await expect(h.agent.agent.deleteSlotWithEvidence("bps-stuck", 1)).rejects.toThrow();
    expect(h.agent.agent.slotIds()).toContain("bps-stuck");
    await rmdir(files.password);
    expect(await h.agent.agent.deleteSlotWithEvidence("bps-stuck", 1)).toMatchObject({
      erased: true,
      credentialsErased: true,
    });
  });
});
