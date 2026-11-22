/**
 * The profile disk must be the mount the agent was told to expect (driver.profilesMount). If it
 * is not (never mounted, unmounted later, attached late), the agent must not make a fresh empty
 * profile on the boot disk, boot a guest from it, or answer profileErased about it. Through the
 * agent and the mount module the real driver uses; only the mount state is simulated where a
 * test needs a mount to come and go. Written against c9fc964f4.
 */
import { lstat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHypervisorDriver } from "./fake-driver.test-support.js";
import { checkProfilesMount } from "./profiles-mount.js";
import { callFor, open } from "./review.test-support.js";
import { homeKeyPair, startTestPoolAgent, testGuest } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe("a host told to expect its profile disk mounted", () => {
  it("refuses to start when the profiles root is a plain directory on the same device", async () => {
    const driver = new FakeHypervisorDriver({ profilesMount: {} });
    await expect(startTestPoolAgent({ saveAfterMs: null, driver })).rejects.toThrow(
      /profile disk is not mounted/u,
    );
  });

  it("refuses create, start and an erasing delete once the mount is gone, making and erasing nothing", async () => {
    const driver = new FakeHypervisorDriver({ profilesMount: {} });
    driver.profilesMounted = true;
    const agent = await startTestPoolAgent({ saveAfterMs: null, driver });
    open.push(agent);
    await agent.agent.createSlot({
      slotId: "kept",
      term: 1,
      homeKey: homeKeyPair().spki,
      guest: testGuest,
    });
    driver.profilesMounted = false;
    // create: a definite refusal, no slot, no file.
    await expect(
      agent.agent.createSlot({
        slotId: "new",
        term: 1,
        homeKey: homeKeyPair().spki,
        guest: testGuest,
      }),
    ).rejects.toMatchObject({
      name: "ProfilesNotMounted",
      message: expect.stringMatching(/not mounted/u),
    });
    expect(agent.agent.slotIds()).not.toContain("new");
    expect(await present(driver.profilePath("new"))).toBe(false);
    // start: a stored, signed applied:false with its own reason; nothing booted.
    const start = callFor(await agent.agent.status("kept", 1), "start");
    expect(await agent.agent.apply(start)).toMatchObject({
      applied: false,
      reason: "profile-disk-missing",
    });
    expect(await agent.agent.result("kept", 1, start.id)).toMatchObject({
      reason: "profile-disk-missing",
    });
    expect(driver.boots).toHaveLength(0);
    // delete with eraseProfile: refused, the profile untouched, never profileErased.
    await expect(
      agent.agent.deleteSlotWithEvidence("kept", 1, { eraseProfile: true }),
    ).rejects.toMatchObject({ name: "ProfilesNotMounted" });
    expect(await present(driver.profilePath("kept"))).toBe(true);
    expect(agent.agent.slotIds()).toContain("kept");
    // The mount comes back: everything works again.
    driver.profilesMounted = true;
    expect(
      await agent.agent.apply(callFor(await agent.agent.status("kept", 1), "start")),
    ).toMatchObject({ applied: true });
  });

  it("is unchanged without the setting", async () => {
    const agent = await startTestPoolAgent({
      saveAfterMs: null,
      driver: new FakeHypervisorDriver(),
    });
    open.push(agent);
    await agent.agent.createSlot({
      slotId: "plain",
      term: 1,
      homeKey: homeKeyPair().spki,
      guest: testGuest,
    });
    expect(
      await agent.agent.apply(callFor(await agent.agent.status("plain", 1), "start")),
    ).toMatchObject({ applied: true });
  });
});

describe("the mount check", () => {
  const io = (state: { root: number; parent: number; label?: number; writable?: boolean }) => ({
    stat: async (path: string) => ({
      dev: path === "/srv/profiles" ? state.root : state.parent,
      rdev: path.startsWith("/dev/disk/by-label/") ? (state.label ?? -1) : 0,
      isDirectory: () => !path.startsWith("/dev/"),
    }),
    access: async () => {
      if (state.writable === false) throw new Error("EROFS");
    },
  });

  it("names what is wrong: not a mount point, another filesystem, not writable", async () => {
    expect(await checkProfilesMount("/srv/profiles", {}, io({ root: 7, parent: 7 }))).toMatch(
      /not a mount point/u,
    );
    expect(
      await checkProfilesMount(
        "/srv/profiles",
        { label: "osp-0123456789ab" },
        io({ root: 8, parent: 7, label: 9 }),
      ),
    ).toMatch(/not the filesystem labelled osp-0123456789ab/u);
    expect(
      await checkProfilesMount("/srv/profiles", {}, io({ root: 8, parent: 7, writable: false })),
    ).toMatch(/not writable/u);
    expect(
      await checkProfilesMount(
        "/srv/profiles",
        { label: "osp-0123456789ab" },
        io({ root: 8, parent: 7, label: 8 }),
      ),
    ).toBeUndefined();
  });
});
