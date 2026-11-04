import { describe, expect, it } from "vitest";
import type { WorkspaceSurfaceDestination } from "@opensteer/client/host";
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
});
