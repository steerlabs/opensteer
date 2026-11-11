import { describe, expect, it } from "vitest";
import type { SurfaceDestination } from "@opensteer/client/host";
import {
  pageSite,
  paramsDestination,
  routeDestination,
  sameDestination,
  surfaceRoute,
  viewedPage,
  tabsRoute,
} from "./surface-route.js";

const source = { kind: "owner-view", viewId: "view", generation: 2 } as const;
describe("pageSite", () => {
  it("names a site as a person says it, without its www", () => {
    expect(pageSite("https://www.google.com/search?q=a")).toBe("google.com");
    expect(pageSite("https://mail.example.com/inbox")).toBe("mail.example.com");
    expect(pageSite("about:blank")).toBeNull();
  });
});

describe("viewedPage", () => {
  const session = { id: "bsn_00000000-0000-4000-8000-000000000001" };
  const tab = { active: true, id: "page-1", title: "Example", url: "https://example.com/" };

  it("includes a page the person can see, and not one that failed to load", () => {
    expect(viewedPage(session, tab as never)).toMatchObject({ url: "https://example.com/" });
    expect(viewedPage(session, { ...tab, navigationFailed: true } as never)).toBeNull();
  });
});

describe("app tab routes", () => {
  const appId = "app_11111111-1111-4111-8111-111111111111";
  const destination = { appId, kind: "opensteer-app" } as const;

  it("round trips through typed and untyped params from Tabs and from a conversation", () => {
    for (const route of [
      tabsRoute("deployment", destination),
      surfaceRoute("deployment", "thread", destination),
    ]) {
      expect(route.appId).toBe(appId);
      expect(routeDestination(route)).toEqual(destination);
      expect(paramsDestination(JSON.parse(JSON.stringify(route)))).toEqual(destination);
    }
  });

  it("tells one app from another and from every other place", () => {
    const other = {
      appId: appId.replace("1111-4111", "2222-4222"),
      kind: "opensteer-app",
    } as const;
    expect(sameDestination(destination, { ...destination })).toBe(true);
    expect(sameDestination(destination, other)).toBe(false);
    expect(sameDestination(destination, { kind: "browser", sessionId: "s", tabId: appId })).toBe(
      false,
    );
  });

  // A link can carry any value, and a malformed one must not reach a Host read
  // or fall through to the browser the same route also names.
  it.each(["", "app_1", "../../v1/rpc/bootstrap.get", `${appId}/dark/token`, "https://host.test"])(
    "names nothing for the malformed id %j",
    (malformed) => {
      expect(routeDestination({ appId: malformed })).toBeNull();
      expect(paramsDestination({ appId: malformed, sessionId: "s", tabId: "t" })).toBeNull();
    },
  );
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
    const route = tabsRoute("deployment", destination);
    expect(route.windowId).toBe(42);
    expect(routeDestination(route)).toEqual(destination);
    expect(paramsDestination(route)).toEqual(destination);
  });
  it.each<SurfaceDestination>([
    { kind: "app", machineId: "mac", appKey: "notes", source },
    { kind: "app", machineId: "mac", appKey: "notes", computerSessionId: "task" },
    { kind: "phone", machineId: "phone" },
  ])("keeps legacy, task and phone routes without a window ($kind)", (destination) => {
    const route = tabsRoute("deployment", destination);
    expect(route).not.toHaveProperty("windowId");
    expect(paramsDestination(route)).toEqual(destination);
    expect(paramsDestination({ ...route, windowId: "42" })).toEqual(destination);
  });
});
