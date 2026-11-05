import { describe, expect, it } from "vitest";
import type { WorkspaceSurfaceDestination } from "@opensteer/client/host";
import {
  paramsDestination,
  routeDestination,
  viewedPage,
  workspaceRoute,
} from "./surface-route.js";

const source = { kind: "owner-view", viewId: "view", generation: 2 } as const;
describe("viewedPage", () => {
  const session = { id: "bsn_00000000-0000-4000-8000-000000000001" };
  const tab = { active: true, id: "page-1", title: "Example", url: "https://example.com/" };

  it("includes a page the person can see, and not one that failed to load", () => {
    expect(viewedPage(session, tab as never)).toMatchObject({ url: "https://example.com/" });
    expect(viewedPage(session, { ...tab, navigationFailed: true } as never)).toBeNull();
  });
});

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
