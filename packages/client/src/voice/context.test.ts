import { expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { placeList } from "../host/places.js";
import { VoiceContextLinks } from "./context.js";

it("keeps exact browser tabs distinct and rejects stale places and unknown threads", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    await host.load();
    const app = (await host.listApprovedComputerApps()).find(
      (candidate) => candidate.target.kind === "app",
    )!;
    await host.openComputerView(app.machineId, app.target);
    const snapshot = host.getSnapshot();
    const links = new VoiceContextLinks();
    const text = links.build(snapshot);
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(links.build(snapshot)).toBe(text);
    const offered = [...text.matchAll(/opensteer:\/\/place\/\d+/g)].map((m) => m[0]);
    expect(offered.length).toBeGreaterThan(1);
    const destinations = offered.map((link) => links.resolve(link, snapshot)!.target);
    expect(new Set(destinations.map((d) => JSON.stringify(d))).size).toBe(destinations.length);
    expect(links.resolve("opensteer://thread/unknown", snapshot)).toBeNull();
    expect(links.resolve("opensteer://place/%broken", snapshot)).toBeNull();
    for (const link of offered)
      expect(
        links.resolve(link, { ...snapshot, browserSessions: [], workspaceTabs: [], machines: [] }),
      ).toBeNull();
    const owner = placeList(snapshot).find((p) => p.ownerView);
    expect(owner).toBeDefined();
    if (!owner) throw new Error("Owner view missing");
    {
      const link = offered.find(
        (link) =>
          JSON.stringify(links.resolve(link, snapshot)?.target) ===
          JSON.stringify({ kind: "place", destination: owner.destination }),
      )!;
      expect(link).toBeDefined();
      const changed = {
        ...snapshot,
        machines: snapshot.machines.map((m) => ({
          ...m,
          ...(m.computerUse
            ? {
                computerUse: {
                  ...m.computerUse,
                  ownerViews: m.computerUse.ownerViews?.map((v) => ({
                    ...v,
                    generation: v.generation + 1,
                  })),
                },
              }
            : {}),
        })),
      };
      expect(links.resolve(link, changed)).toBeNull();
    }
  } finally {
    host.dispose();
  }
});

it("never offers or resolves a place this device can't show", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    await host.load();
    const app = (await host.listApprovedComputerApps()).find(
      (candidate) => candidate.target.kind === "app",
    )!;
    await host.openComputerView(app.machineId, app.target);
    const snapshot = host.getSnapshot();
    let apps = true;
    const links = new VoiceContextLinks((destination) => apps || destination.kind !== "app");
    const appLink = [...links.build(snapshot).matchAll(/opensteer:\/\/place\/\d+/g)]
      .map((m) => m[0])
      .find((link) => {
        const target = links.resolve(link, snapshot)?.target;
        return target?.kind === "place" && target.destination.kind === "app";
      });
    expect(appLink, "the mock offers a Mac app place").toBeDefined();

    apps = false;
    const shown = links.build(snapshot);
    expect(shown.split("\n").filter((line) => line.includes("| app"))).toEqual([]);
    expect(links.resolve(appLink!, snapshot)).toBeNull();
    for (const link of shown.matchAll(/opensteer:\/\/place\/\d+/g))
      expect(links.resolve(link[0], snapshot)?.target).not.toMatchObject({
        destination: { kind: "app" },
      });
  } finally {
    host.dispose();
  }
});
