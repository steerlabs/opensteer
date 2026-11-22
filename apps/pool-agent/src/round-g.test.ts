/**
 * Round G: the agent makes and erases a slot's profile disk, because it is the only party on the
 * host (the provisioner reaches a pool host only through the administration interface). Through
 * the provisioner's own client, the signed administration wire, the agent and the profile
 * module the real driver uses; only `mkfs.ext4` is stood in for. Each test was written against
 * c2cc9d421 and failed there.
 */
import { generateKeyPairSync } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callBrowserPoolAgentAdmin } from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { callFor, open } from "./review.test-support.js";
import { profileFileName, profilePathFor, sweepUnfinishedProfiles } from "./profiles.js";
import { createAdminServer, listen } from "./server.js";
import { homeKeyPair, startTestPoolAgent } from "./test-support.js";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

const guest = { vcpus: 2, memoryMib: 2048, profileMib: 256 };

async function host() {
  const agent = await startTestPoolAgent({ saveAfterMs: null });
  open.push(agent);
  const provisioner = generateKeyPairSync("ed25519");
  const hostKeys = generateKeyPairSync("ed25519");
  const server = createAdminServer({
    agent: agent.agent,
    provisionerKey: provisioner.publicKey,
    hostId: "pool-host-g",
    hostKey: hostKeys.privateKey,
  });
  const address = (await listen(server, { host: "127.0.0.1", port: 0 })) as AddressInfo;
  closing.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const admin = (request: Parameters<typeof callBrowserPoolAgentAdmin>[1]) =>
    callBrowserPoolAgentAdmin(
      {
        url: `http://127.0.0.1:${address.port}`,
        provisionerKey: provisioner.privateKey,
        host: "pool-host-g",
        hostKey: hostKeys.publicKey,
      },
      request,
    );
  const create = (slotId: string, term = 1) =>
    admin({ op: "create", slotId, term, homeKey: homeKeyPair().spki, guest } as never);
  return { agent, admin, create, profile: (slotId: string) => agent.driver.profilePath(slotId) };
}

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

describe("the agent makes a slot's profile disk", () => {
  it("makes the profile at create, under its root, and the guest boots from it", async () => {
    const h = await host();
    await h.create("cc-person-1");
    const path = h.profile("cc-person-1");
    expect(await readFile(path, "utf8")).toMatch(/^fake-ext4/u);
    expect(dirname(path)).toBe(h.agent.driver.profilesRoot);
    await h.agent.agent.apply(callFor(await h.agent.agent.status("cc-person-1", 1), "start"));
    expect(h.agent.driver.boots.at(-1)!.profilePath).toBe(path);
  });

  it("keeps an existing profile exactly as it is: a create at a higher term reads the same file", async () => {
    const h = await host();
    await h.create("cc-person-2");
    const path = h.profile("cc-person-2");
    await appendFile(path, "the person's marker\n");
    await h.admin({ op: "delete", slotId: "cc-person-2", term: 1 });
    // The replaced instance's case: the slot made again at a higher term.
    await h.create("cc-person-2", 2);
    expect(await readFile(path, "utf8")).toContain("the person's marker");
    // Made once, at the first create; never formatted again.
    expect(h.agent.driver.formatted).toBe(1);
  });

  it("refuses a create whose filesystem cannot be made, leaving no slot and no file", async () => {
    const h = await host();
    h.agent.driver.formatError = new Error("mkfs.ext4: no space left on device");
    await expect(h.create("cc-person-3")).rejects.toThrow();
    expect(h.agent.agent.slotIds()).not.toContain("cc-person-3");
    expect(await readdir(h.agent.driver.profilesRoot)).toEqual([]);
  });
});

describe("the agent erases a slot's profile only when told, with evidence", () => {
  it("leaves the profile on a delete without eraseProfile", async () => {
    const h = await host();
    await h.create("cc-person-4");
    const reply = await h.admin({ op: "delete", slotId: "cc-person-4", term: 1 });
    expect(reply).toMatchObject({ op: "delete", erased: true });
    expect(reply).not.toHaveProperty("profileErased");
    expect(await exists(h.profile("cc-person-4"))).toBe(true);
  });

  it("answers profileErased only once the file is gone", async () => {
    const h = await host();
    await h.create("cc-person-5");
    let release!: () => void;
    h.agent.driver.eraseGate = new Promise<void>((resolve) => (release = resolve));
    let answered = false;
    const deleting = h
      .admin({ op: "delete", slotId: "cc-person-5", term: 1, eraseProfile: true } as never)
      .then((reply) => ((answered = true), reply));
    await expect.poll(() => h.agent.driver.erasing).toBe(1);
    expect(answered).toBe(false);
    expect(await exists(h.profile("cc-person-5"))).toBe(true);
    release();
    expect(await deleting).toMatchObject({ op: "delete", erased: true, profileErased: true });
    expect(await exists(h.profile("cc-person-5"))).toBe(false);
  });

  it("removes a leftover profile for a slot it does not know, with the same evidence", async () => {
    const h = await host();
    const leftover = profilePathFor(h.agent.driver.profilesRoot, "cc-person-6");
    await writeFile(leftover, "an earlier instance's profile\n");
    const reply = await h.admin({
      op: "delete",
      slotId: "cc-person-6",
      term: 7,
      eraseProfile: true,
    } as never);
    expect(reply).toMatchObject({ op: "delete", erased: true, profileErased: true });
    expect(await exists(leftover)).toBe(false);
  });
});

describe("a slot reaches only its own profile", () => {
  it("derives a path under the root from any slot id, and refuses a path the provisioner names", async () => {
    const h = await host();
    const root = h.agent.driver.profilesRoot;
    for (const slotId of [".", "..", "...", "a:b", "x.ext4", "-"])
      expect(dirname(profilePathFor(root, slotId))).toBe(root);
    await h.create("cc-person-7");
    // Another slot's profile, or anything else, named as a path: refused, nothing made.
    for (const profilePath of [h.profile("cc-person-7"), `${root}/../escape.ext4`, "/etc/passwd"])
      await expect(
        h.admin({
          op: "create",
          slotId: "cc-person-8",
          term: 1,
          homeKey: homeKeyPair().spki,
          guest: { vcpus: 2, memoryMib: 2048, profilePath },
        }),
      ).rejects.toThrow();
    expect(h.agent.agent.slotIds()).not.toContain("cc-person-8");
    expect(await exists(h.profile("cc-person-8"))).toBe(false);
  });
});

describe("a profile make that crashed", () => {
  it("leaves only a temporary name, which the driver sweeps and never takes for a profile", async () => {
    const h = await host();
    const root = h.agent.driver.profilesRoot;
    await writeFile(`${root}/.making-${profileFileName("cc-person-9")}-dead`, "half made\n");
    expect(await sweepUnfinishedProfiles(root)).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
    await h.create("cc-person-9");
    expect(await readFile(h.profile("cc-person-9"), "utf8")).toMatch(/^fake-ext4/u);
  });
});

describe("a deleted slot's upstream credentials (round G, B)", () => {
  const credentials = async (root: string, name: string) => {
    // Round I, U4: no fake makes the credentials root by itself; the operator would.
    await mkdir(root, { recursive: true });
    const files = {
      usernameFile: `${root}/${name}-username`,
      passwordFile: `${root}/${name}-password`,
      caFile: `${root}/${name}-ca.pem`,
    };
    for (const file of Object.values(files)) await writeFile(file, "secret\n", { mode: 0o600 });
    return { upstreamUrl: "https://upstream.example:8443", ...files };
  };

  it("removes them on delete and says so only once they are gone", async () => {
    const h = await host();
    const egress = await credentials(h.agent.driver.credentialsRoot, "cc-person-10");
    await h.admin({
      op: "create",
      slotId: "cc-person-10",
      term: 1,
      homeKey: homeKeyPair().spki,
      guest: { ...guest, egress },
    } as never);
    const reply = await h.admin({ op: "delete", slotId: "cc-person-10", term: 1 });
    expect(reply).toMatchObject({ op: "delete", erased: true, credentialsErased: true });
    for (const file of [egress.usernameFile, egress.passwordFile, egress.caFile])
      expect(await exists(file)).toBe(false);
  });

  it("keeps files another live slot also names, and does not claim them erased", async () => {
    const h = await host();
    const egress = await credentials(h.agent.driver.credentialsRoot, "shared");
    for (const slotId of ["cc-person-11", "cc-person-12"])
      await h.admin({
        op: "create",
        slotId,
        term: 1,
        homeKey: homeKeyPair().spki,
        guest: { ...guest, egress },
      } as never);
    const first = await h.admin({ op: "delete", slotId: "cc-person-11", term: 1 });
    expect(first).not.toHaveProperty("credentialsErased");
    expect(await exists(egress.passwordFile)).toBe(true);
    const second = await h.admin({ op: "delete", slotId: "cc-person-12", term: 1 });
    expect(second).toMatchObject({ credentialsErased: true });
    expect(await exists(egress.passwordFile)).toBe(false);
  });
});
