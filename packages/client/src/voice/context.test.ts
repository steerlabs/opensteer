import { expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { placeList } from "../host/places.js";
import { VoiceContextLinks } from "./context.js";
import { voiceSavedTabs } from "./voice.test-support.js";

const placeOf = (host: MockHostClient) => (runId: string) => host.runPlace(runId)?.data ?? null;

it("finds every saved tab with continuation and puts Chat's old asleep tab ahead of the partial list", () => {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    const snapshot = voiceSavedTabs(host);
    const links = new VoiceContextLinks();
    const text = links.build(snapshot, undefined, { find: true, runPlace: placeOf(host) });
    const working = text.split("\n").find((line) => line.startsWith("Chat is working in:"))!;
    expect(working).toContain("Gmail");
    const link = working.match(/opensteer:\/\/place\/\d+/)![0];
    expect(links.resolve(link, snapshot)?.target).toMatchObject({
      destination: { tabId: "tab_gmail" },
    });
    expect(text).toContain("Places (partial");
    const gmail = links.find(snapshot, "gmail");
    expect(gmail.total).toBe(1);
    expect(gmail.text).toContain(link);
    const first = links.find(snapshot, "saved");
    expect(first.total).toBe(35);
    expect(first.nextOffset).toBeGreaterThan(0);
    const second = links.find(snapshot, "saved", first.nextOffset!);
    expect(second.text).not.toBe(first.text);
    const all: string[] = [];
    let offset = 0;
    do {
      const page = links.find(snapshot, "saved", offset);
      all.push(...page.text.match(/opensteer:\/\/place\/\d+/g)!);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (offset < 100);
    expect(new Set(all).size).toBe(35);
    expect(links.find(snapshot, "does not exist").text).toContain("No match on this device");
    expect(new VoiceContextLinks(() => false).find(snapshot, "gmail").total).toBe(0);
  } finally {
    host.dispose();
  }
});

it("uses the per-Run reader outside transcript windows and ranks equal titles by use instead of creation", () => {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    const snapshot = voiceSavedTabs(host);
    const home = snapshot.homeThreadId!;
    const entry = snapshot.transcripts[home]![0]!;
    if (entry.kind !== "place" || entry.place.kind !== "browser")
      throw new Error("Expected Gmail place");
    const links = new VoiceContextLinks();
    const runPlace = vi.fn(() => entry);
    expect(
      links.build({ ...snapshot, transcripts: {} }, undefined, { find: true, runPlace }),
    ).toContain('Chat is working in: "Gmail" | opensteer://place/');
    expect(runPlace).toHaveBeenCalledWith(snapshot.runQueue[0]!.id);
    const used = {
      ...snapshot,
      transcripts: {
        [home]: [
          entry,
          {
            ...entry,
            id: "other-run-place",
            runId: "other-run",
            title: "Saved tab",
            createdAt: "2026-11-01T12:00:00.000Z",
            place: { ...entry.place, surfaceId: snapshot.workspaceTabs![0]!.tabs![17]!.id },
          },
        ],
      },
    };
    const first = links.find(used, "saved tab");
    const offered = first.text.match(/opensteer:\/\/place\/\d+/)![0];
    expect(links.resolve(offered, used)?.target).toMatchObject({
      destination: { tabId: "tab_saved17" },
    });
    expect(links.build(used, undefined, { runPlace: placeOf(host) })).toContain(
      'Chat is working in: "Gmail"',
    );
    expect(
      links.build({ ...snapshot, runQueue: [] }, undefined, { runPlace: placeOf(host) }),
    ).not.toContain("Chat is working in:");
    const thread = snapshot.threads.find((t) => t.id !== home)!;
    const threadLinks = new VoiceContextLinks();
    expect(threadLinks.resolve(`opensteer://thread/${thread.id}`, snapshot)).toBeNull();
    const result = threadLinks.find(snapshot, thread.title);
    expect(result.text).toContain(`opensteer://thread/${thread.id}`);
    expect(threadLinks.resolve(`opensteer://thread/${thread.id}`, snapshot)?.target).toEqual({
      kind: "thread",
      threadId: thread.id,
    });
  } finally {
    host.dispose();
  }
});

it("keeps large escaped labels inside the answer budget without losing continuation", () => {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    const snapshot = voiceSavedTabs(host);
    snapshot.workspaceTabs = snapshot.workspaceTabs!.map((group) => ({
      ...group,
      tabs: group.tabs!.map((tab) => ({
        ...tab,
        title: "\u0001".repeat(180),
        site: "\u0001".repeat(180),
      })),
    }));
    const links = new VoiceContextLinks();
    const first = links.find(snapshot, "");
    expect(first.text.length).toBeLessThanOrEqual(4000);
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(first.text.match(/opensteer:\/\/place\/\d+/)?.length).toBeGreaterThan(0);
    expect(links.find(snapshot, "", 1000).text).toContain("No more matches on this device");
  } finally {
    host.dispose();
  }
});

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
    const text = links.build(snapshot, undefined, { runPlace: placeOf(host) });
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(links.build(snapshot, undefined, { runPlace: placeOf(host) })).toBe(text);
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
    const appLink = [
      ...links
        .build(snapshot, undefined, { runPlace: placeOf(host) })
        .matchAll(/opensteer:\/\/place\/\d+/g),
    ]
      .map((m) => m[0])
      .find((link) => {
        const target = links.resolve(link, snapshot)?.target;
        return target?.kind === "place" && target.destination.kind === "app";
      });
    expect(appLink, "the mock offers a Mac app place").toBeDefined();

    apps = false;
    const shown = links.build(snapshot, undefined, { runPlace: placeOf(host) });
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
