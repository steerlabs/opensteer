import { DeviceIdSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { BrowserProfileIdSchema, type TabTarget } from "@opensteer/core";
import { MockHostClient } from "./mock-host-client.js";
import { placeList } from "../host/places.js";

/** Opens a tab and returns the person's own view of it, for a window or phone. */
async function openView(client: MockHostClient, target: TabTarget) {
  const tab = await client.openTab(target);
  const viewer = await client.activateTab(tab.tabId);
  if (viewer.kind !== "window" && viewer.kind !== "phone") throw new Error("Expected a view");
  return { tab, view: viewer.view };
}

describe("start page mock journey", () => {
  it("opens a page in your own browser for that profile, replays one key once and refuses unknown profiles", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const snapshot = client.getSnapshot();
      expect(snapshot.browserProfiles.map((profile) => profile.name)).toEqual(
        expect.arrayContaining(["Personal", "Work"]),
      );
      const profileId = snapshot.browserProfiles[0]!.id;
      const open = (idempotencyKey: string, url = "https://start.example/path") =>
        client.dispatch({
          type: "tab.open",
          target: { kind: "page", url, profileId },
          idempotencyKey,
        });
      const [a, b] = await Promise.all([open("new-page"), open("new-page")]);
      expect(a).toEqual(b);
      if (a.type !== "tab.open") throw new Error("Unexpected command");
      expect(a.tab).toMatchObject({ kind: "page", profile: { profileId } });
      expect(client.getSnapshot().tabs.get(a.tab.tabId)?.url).toBe("https://start.example/path");
      const other = await open("another-page", "https://start.example/other");
      if (other.type !== "tab.open") throw new Error("Unexpected command");
      expect(other.tab.tabId).not.toBe(a.tab.tabId);
      await expect(
        client.openTab({
          kind: "page",
          url: "https://start.example/",
          profileId: BrowserProfileIdSchema.parse("bpr_99999999-9999-4999-8999-999999999999"),
        }),
      ).rejects.toMatchObject({ code: "conflict", reason: "browser-profile-unavailable" });
    } finally {
      client.dispose();
    }
  });

  it("opens, renews, closes and expires window and phone views without changing task holdings", async () => {
    let now = new Date("2026-10-19T12:00:00.000Z");
    const client = new MockHostClient({ latencyMs: 0, now: () => now });
    try {
      const approved = await client.listApprovedComputerApps();
      const app = approved.find((item) => item.target.kind === "app")!;
      if (app.target.kind !== "app") throw new Error("Expected an app");
      const before = client
        .getSnapshot()
        .machines.flatMap((machine) => machine.computerUse?.sessions ?? []);
      const { tab, view } = await openView(client, {
        kind: "window",
        computerId: DeviceIdSchema.parse(app.machineId),
        bundleId: app.target.app.bundleId,
      });
      const logical = placeList(client.getSnapshot()).find((place) => place.key === tab.tabId)!;
      expect(logical.kind).toBe("window");
      now = new Date(now.getTime() + 1000);
      const renewed = await client.renewComputerView(view.viewId, view.generation, {
        idempotencyKey: "renew-view",
      });
      expect(renewed.expiresAt > view.expiresAt).toBe(true);
      await client.closeComputerView(view.viewId, view.generation, {
        idempotencyKey: "close-view",
      });
      await client.closeComputerView(view.viewId, view.generation, {
        idempotencyKey: "close-view",
      });
      expect(
        client.getSnapshot().machines.flatMap((machine) => machine.computerUse?.sessions ?? []),
      ).toEqual(before);
      await expect(client.renewComputerView(view.viewId, view.generation)).rejects.toMatchObject({
        reason: "computer-view-ended",
      });
      // Selecting the tab again opens a newer view of it; the old generation stays refused.
      const reopened = await client.activateTab(tab.tabId);
      if (reopened.kind !== "window") throw new Error("Expected a window view");
      expect(reopened.view.generation).toBeGreaterThan(view.generation);
      await expect(client.renewComputerView(view.viewId, view.generation)).rejects.toMatchObject({
        reason: "computer-view-stale-generation",
      });
      now = new Date(now.getTime() + 10 * 60000);
      await expect(
        client.renewComputerView(reopened.view.viewId, reopened.view.generation),
      ).rejects.toMatchObject({ reason: "computer-view-ended" });
      const phone = approved.find((item) => item.target.kind === "phone")!;
      const { view: phoneView } = await openView(client, {
        kind: "phone",
        computerId: DeviceIdSchema.parse(phone.machineId),
      });
      now = new Date(now.getTime() + 3 * 60000);
      await expect(
        client.renewComputerView(phoneView.viewId, phoneView.generation),
      ).rejects.toMatchObject({ reason: "computer-view-ended" });
      await client.rpc["auth.signOut"]({});
      await expect(client.activateTab(tab.tabId)).rejects.toMatchObject({
        code: "unauthorized",
      });
    } finally {
      client.dispose();
    }
  });
});

it("renews owner authority only while a visible retain handle exists", async () => {
  vi.useFakeTimers();
  const client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
  try {
    const app = (await client.listApprovedComputerApps()).find((app) => app.target.kind === "app")!;
    if (app.target.kind !== "app") throw new Error("Expected an app");
    const { view } = await openView(client, {
      kind: "window",
      computerId: DeviceIdSchema.parse(app.machineId),
      bundleId: app.target.app.bundleId,
    });
    const ownerView = () =>
      client
        .getSnapshot()
        .machines.flatMap((machine) => machine.computerUse?.ownerViews ?? [])
        .find((held) => held.viewId === view.viewId);
    const handle = client.retainComputerView(view.viewId, view.generation, { visible: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ownerView()?.expiresAt).toBe(view.expiresAt);
    handle.setVisible(true);
    await vi.advanceTimersByTimeAsync(30_000);
    const renewed = ownerView()!;
    expect(renewed.expiresAt > view.expiresAt).toBe(true);
    handle.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ownerView()?.expiresAt).toBe(renewed.expiresAt);
  } finally {
    client.dispose();
    vi.useRealTimers();
  }
});
