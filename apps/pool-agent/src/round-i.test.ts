/**
 * Round I (pool-agent-profiles-egress-review-gemini.md, the lead's decisions U1 to U8). Through
 * the agent, with the credential and profile modules the real driver uses on real files; only
 * the fetch, the hypervisor and `mkfs.ext4` are stood in for. Written against c351478fb.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentConfigSchema } from "./config.js";
import { FakeHypervisorDriver } from "./fake-driver.test-support.js";
import { eraseFilesUnder, eraseProfile, profilePathFor } from "./profiles.js";
import { callFor, open } from "./review.test-support.js";
import { credentialFiles, secureCredentialsRoot } from "./slot-credentials.js";
import type { SlotEgressAnswer } from "./slot-egress-fetch.js";
import { homeKeyPair, startTestPoolAgent, testGuest } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

const first: SlotEgressAnswer = {
  upstreamUrl: "https://upstream.example:8443",
  username: "u-1",
  password: "first password",
};
const rotated: SlotEgressAnswer = {
  upstreamUrl: "https://other-upstream.example:9443",
  username: "u-1",
  password: "rotated password",
};

/** An answer the fetch gives, or a failure: what the account service says this time. */
type Answer = SlotEgressAnswer | null | Error | "late";

async function pulling(answers: Answer[], options: { readonly saveAfterMs?: number | null } = {}) {
  const asked: string[] = [];
  let late: (() => void) | undefined;
  const agent = await startTestPoolAgent({
    saveAfterMs: options.saveAfterMs ?? null,
    driver: new FakeHypervisorDriver({ pullsEgress: true }),
    deadlines: { egress: 50 },
    egressFetch: async (slotId) => {
      asked.push(slotId);
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next instanceof Error) throw next;
      if (next === "late") return new Promise((resolve) => (late = () => resolve(first)));
      return next;
    },
  });
  open.push(agent);
  await agent.agent.createSlot({
    slotId: "bps",
    term: 1,
    homeKey: homeKeyPair().spki,
    guest: testGuest,
  });
  const apply = async (kind: Parameters<typeof callFor>[1], call = undefined as never) =>
    agent.agent.apply(call ?? callFor(await agent.agent.status("bps", 1), kind)).then(
      (result) => result,
      (error: unknown) => error as Error,
    );
  const files = () => credentialFiles(agent.driver.credentialsRoot, "bps");
  const password = () => readFile(files().password, "utf8").catch(() => null);
  return { agent, asked, apply, files, password, release: () => late?.() };
}

describe("U1: the account service is asked at every cold start", () => {
  it("asks with credentials present, and a changed answer replaces them", async () => {
    const h = await pulling([first, rotated]);
    expect(await h.apply("start")).toMatchObject({ applied: true });
    expect(await h.password()).toBe(first.password);
    await h.apply("stop");
    expect(await h.apply("start")).toMatchObject({ applied: true });
    expect(h.asked).toHaveLength(2);
    expect(await h.password()).toBe(rotated.password);
    expect(await readFile(h.files().url, "utf8")).toBe(rotated.upstreamUrl);
  });

  it("removes what is there and refuses egress-required when none is assigned any more", async () => {
    const h = await pulling([first, null]);
    await h.apply("start");
    await h.apply("stop");
    expect(await h.apply("start")).toMatchObject({ applied: false, reason: "egress-required" });
    expect(await h.password()).toBeNull();
  });

  it("uses what is there when the fetch cannot be completed", async () => {
    const h = await pulling([first, new Error("the account service answered 503")]);
    await h.apply("start");
    await h.apply("stop");
    expect(await h.apply("start")).toMatchObject({ applied: true });
    expect(await h.password()).toBe(first.password);
  });

  it("fetches at a wake from disk without credentials", async () => {
    const h = await pulling([first]);
    await h.apply("start");
    await h.apply("pause");
    const status = await h.agent.agent.status("bps", 1);
    expect(await h.agent.agent.saveToDisk("bps", status.savedState!.id)).toBe("saved");
    await rm(h.files().password);
    h.asked.length = 0;
    expect(await h.apply("resume")).toMatchObject({ applied: true });
    expect(h.asked).toEqual(["bps"]);
    expect(await h.password()).toBe(first.password);
  });

  it("answers a repeated call id from its stored egress-required, then starts once assigned", async () => {
    const h = await pulling([null, first]);
    const call = callFor(await h.agent.agent.status("bps", 1), "start");
    expect(await h.agent.agent.apply(call)).toMatchObject({ reason: "egress-required" });
    expect(await h.agent.agent.apply(call)).toMatchObject({ reason: "egress-required" });
    expect(h.asked).toHaveLength(1);
    expect(await h.apply("start")).toMatchObject({ applied: true });
    expect(h.asked).toHaveLength(2);
  });

  it("fetches once for two starts of one slot", async () => {
    const h = await pulling([first]);
    const status = await h.agent.agent.status("bps", 1);
    await Promise.all([
      h.agent.agent.apply(callFor(status, "start")).catch(() => undefined),
      h.agent.agent.apply(callFor(status, "start")).catch(() => undefined),
    ]);
    expect(h.asked).toHaveLength(1);
  });

  it("writes nothing from a fetch that answers after its deadline", async () => {
    const h = await pulling(["late"]);
    const outcome = await h.apply("start");
    expect((outcome as Error).name).toBe("AgentUnavailable");
    h.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await h.password()).toBeNull();
  });
});

describe("U2: nothing is written that the proxy would refuse to start with", () => {
  for (const [what, answer] of [
    ["port 0", { ...first, upstreamUrl: "https://upstream.example:0" }],
    ["a whitespace-only username", { ...first, username: "   " }],
    ["a whitespace-only password", { ...first, password: " \t " }],
    ["a newline", { ...first, password: "pass\nword" }],
    ["a NUL", { ...first, username: "u\u0000" }],
    ["an over-long address", { ...first, upstreamUrl: `https://${"a".repeat(2000)}.example:8443` }],
  ] as const)
    it(`for an answer with ${what}`, async () => {
      const h = await pulling([answer]);
      const outcome = await h.apply("start");
      expect(outcome).toBeInstanceOf(Error);
      expect(await h.password()).toBeNull();
    });
});

describe("U3: a guest running behind a proxy that does not require an upstream", () => {
  it("is ended at the agent's start on a pulling host", async () => {
    const h = await pulling([first]);
    await h.apply("start");
    expect(h.agent.driver.writers("bps")).toBe(1);
    // An earlier agent's (or configuration's) unit, found by a new agent.
    h.agent.driver.unrequiredProxies.add("bps");
    const restarted = await h.agent.restart();
    open.splice(open.indexOf(h.agent), 1, restarted);
    expect(restarted.driver.writers("bps")).toBe(0);
    expect((await restarted.agent.status("bps", 1)).phase).toBe("stopped");
  });
});

describe("U4: a delete with no credentials directory on disk", () => {
  it("is nothing to remove, for no files and for files under a root that does not exist", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "opensteer-pool-none-")), "credentials");
    await eraseFilesUnder(root, []);
    await eraseFilesUnder(root, [join(root, "slot-x.password")]);
  });
});

describe("U5: the free-space guard", () => {
  it("compares with what an unprivileged writer can use, beside a sparse profile and other files", async () => {
    const driver = new FakeHypervisorDriver();
    // A 200 MiB filesystem of which other files use 100 MiB: 100 MiB available.
    driver.filesystemBytes = 200 * 1024 * 1024;
    driver.availableBytes = 100 * 1024 * 1024;
    const agent = await startTestPoolAgent({ saveAfterMs: null, driver });
    open.push(agent);
    const create = (slotId: string) =>
      agent.agent.createSlot({
        slotId,
        term: 1,
        homeKey: homeKeyPair().spki,
        guest: { ...testGuest, profileMib: 64 },
      });
    await create("one");
    // The first is sparse: its 64 MiB may still fill in. 64 + 64 > 100.
    await expect(create("two")).rejects.toMatchObject({ name: "SlotConflict" });
  });
});

describe("U6: paths from configuration", () => {
  it("are normalised at load, without a trailing slash", () => {
    const parsed = agentConfigSchema.parse(configWith({ profilesRoot: "/var/lib/p/" }));
    expect(parsed.driver.profilesRoot).toBe("/var/lib/p");
  });

  it("erase a profile under a root named with a trailing slash", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-pool-slash-"));
    const path = profilePathFor(root, "s");
    await writeFile(path, "p");
    await eraseProfile(`${root}/`, path);
    expect(await readFile(path).catch(() => null)).toBeNull();
  });
});

describe("U8", () => {
  it("refuses a credentials root that is a symlink", async () => {
    const base = await mkdtemp(join(tmpdir(), "opensteer-pool-link-"));
    await mkdir(join(base, "real"));
    await symlink(join(base, "real"), join(base, "credentials"));
    await expect(secureCredentialsRoot(join(base, "credentials"))).rejects.toThrow();
  });

  it("refuses a delete of a tombstoned slot naming a lower term than its tombstone", async () => {
    const agent = await startTestPoolAgent({ saveAfterMs: null });
    open.push(agent);
    await agent.agent.createSlot({
      slotId: "t",
      term: 5,
      homeKey: homeKeyPair().spki,
      guest: testGuest,
    });
    await agent.agent.deleteSlot("t", 5);
    await expect(
      agent.agent.deleteSlotWithEvidence("t", 4, { eraseProfile: true }),
    ).rejects.toMatchObject({ name: "SlotConflict" });
    expect(await readFile(agent.driver.profilePath("t")).catch(() => null)).not.toBeNull();
    expect(await agent.agent.deleteSlotWithEvidence("t", 5, { eraseProfile: true })).toMatchObject({
      profileErased: true,
    });
  });
});

function configWith(driver: Record<string, unknown>) {
  return {
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
      egress: { node: "/n", main: "/m" },
      network: { resolvers: [] },
      ...driver,
    },
  };
}
