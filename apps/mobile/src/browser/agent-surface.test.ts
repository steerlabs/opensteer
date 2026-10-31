import { describe, expect, it } from "vitest";
import { type SurfaceItem, type ThreadPlace, surfaceDestination } from "@opensteer/client/host";
import { agentSurface, surfaceGlyph } from "./agent-surface.js";

const browser = {
  kind: "browser",
  key: "page",
  acting: false,
  session: { id: "browser" },
  tabId: "page",
} as unknown as SurfaceItem;
const app = {
  kind: "app",
  key: "app",
  acting: false,
  machine: { id: "mac" },
  computerSessionId: "session",
  appKey: "notes",
} as unknown as SurfaceItem;
const phone = {
  kind: "phone",
  key: "phone",
  acting: false,
  machine: { id: "phone" },
  computerSessionId: "phone-session",
} as unknown as SurfaceItem;
const latest = (item: SurfaceItem): ThreadPlace => ({
  destination: surfaceDestination(item),
  placeKey: item.key,
  runId: null,
  title: "Latest",
  site: null,
});

describe("the surface the conversation's agent is using", () => {
  it("prefers the first acting surface over the Host's latest place and newest item", () => {
    const acting = { ...browser, acting: true };
    expect(agentSurface([acting, { ...app, acting: true }, phone], latest(phone))).toBe(acting);
  });
  it("uses the Host's exact latest destination when idle", () => {
    expect(agentSurface([browser, app, phone], latest(app))).toBe(app);
    expect(agentSurface([browser, app, phone], latest(browser))).toBe(browser);
  });
  it("falls back to the newest item for a missing or unrelated latest place, and null for none", () => {
    expect(agentSurface([browser, app], null)).toBe(app);
    expect(agentSurface([browser, app], latest(phone))).toBe(app);
    expect(agentSurface([], latest(phone))).toBeNull();
  });
  it.each([
    [browser, "globe"],
    [app, "laptopcomputer"],
    [phone, "smartphone"],
  ] as const)("maps the surface kind to its glyph", (item, glyph) => {
    expect(surfaceGlyph(item)).toBe(glyph);
  });
});
