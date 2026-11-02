import { describe, expect, it } from "vitest";
import type { WorkspaceSurfaceDestination } from "@opensteer/client/host";
import { VoiceContextLinks } from "../../../../packages/client/src/voice/context.js";
import { MockHostClient } from "@opensteer/client/mock";
import { placeList } from "@opensteer/client/host";
import { paramsDestination, routeDestination, workspaceRoute } from "./surface-route.js";

const source = { kind: "owner-view", viewId: "view", generation: 2 } as const;
describe("native viewer routes", () => {
  it("round trips an owner window through typed and untyped params", () => {
    const destination = {
      kind: "app",
      machineId: "mac",
      appKey: "com.apple.notes",
      windowId: 42,
      source,
    } as const;
    const route = workspaceRoute("deployment", destination);
    expect(route.windowId).toBe(42);
    expect(routeDestination(route)).toEqual(destination);
    expect(paramsDestination(route)).toEqual(destination);
  });
  it.each<WorkspaceSurfaceDestination>([
    { kind: "app", machineId: "mac", appKey: "notes", source },
    { kind: "app", machineId: "mac", appKey: "notes", computerSessionId: "task" },
    { kind: "phone", machineId: "phone", source },
  ])("keeps legacy, task and phone routes without a window ($kind)", (destination) => {
    const route = workspaceRoute("deployment", destination);
    expect(route).not.toHaveProperty("windowId");
    expect(paramsDestination(route)).toEqual(destination);
    expect(paramsDestination({ ...route, windowId: "42" })).toEqual(destination);
  });
  it("lets mobile voice identify the visible owner window rather than the screen name", async () => {
    const host = new MockHostClient({ latencyMs: 0 });
    try {
      await host.load();
      const approved = (await host.listApprovedComputerApps()).find(
        (a) => a.target.kind === "app",
      )!;
      if (approved.target.kind !== "app") throw new Error("Mac fixture missing");
      const windows = await host.listComputerAppWindows(approved.machineId, approved.target.app);
      expect(windows.length).toBeGreaterThan(0);
      await host.openComputerView(approved.machineId, {
        ...approved.target,
        window: windows[0]!.id,
      });
      const snapshot = host.getSnapshot();
      const place = placeList(snapshot).find(
        (p) =>
          p.ownerView && p.destination.kind === "app" && p.destination.windowId === windows[0]!.id,
      )!;
      expect(place, "opened owner window missing from places").toBeDefined();
      const destination = paramsDestination(workspaceRoute("deployment", place.destination))!;
      expect(
        new VoiceContextLinks()
          .build(snapshot, { destination, title: "WorkspaceBrowser" })
          .split("\n")[0],
      ).toBe(`Visible now: ${JSON.stringify(place.title)}`);
    } finally {
      host.dispose();
    }
  });
});
