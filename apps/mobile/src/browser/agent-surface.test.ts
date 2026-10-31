import { describe, expect, it } from "vitest";
import { type SurfaceItem, type ThreadPlace, surfaceDestination } from "@opensteer/client/host";
import { agentSurface, surfaceGlyph } from "./agent-surface.js";

/** A page whose browser names `actingThread` as the one acting in the tab, or no one. */
const page = (key: string, actingThread: string | null): SurfaceItem =>
  ({
    kind: "browser",
    key,
    // The browser's own flag says only that someone acts there.
    acting: actingThread !== null,
    session: {
      id: `browser-${key}`,
      state: "ready",
      tabCatalog: {
        tabs: [
          {
            id: key,
            occupants: actingThread === null ? [] : [{ acting: true, threadId: actingThread }],
          },
        ],
      },
    },
    tabId: key,
  }) as unknown as SurfaceItem;
const browser = page("page", null);
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
const own = new Set(["conversation", "worker"]);
const latest = (item: SurfaceItem): ThreadPlace => ({
  destination: surfaceDestination(item),
  placeKey: item.key,
  runId: null,
  title: "Latest",
  site: null,
});

describe("the surface the conversation's agent is using", () => {
  it("prefers a surface its own agents act in over the Host's latest place and newest item", () => {
    const acting = page("acting", "worker");
    expect(agentSurface([acting, { ...app, acting: true }, phone], own, latest(phone))).toBe(
      acting,
    );
  });
  it("does not follow another conversation acting in a shared browser", () => {
    const elsewhere = page("shared", "someone-else");
    expect(agentSurface([elsewhere, app, phone], own, latest(app))).toBe(app);
  });
  it("uses the Host's exact latest destination when idle", () => {
    expect(agentSurface([browser, app, phone], own, latest(app))).toBe(app);
    expect(agentSurface([browser, app, phone], own, latest(browser))).toBe(browser);
  });
  it("falls back to the newest item for a missing or unrelated latest place, and null for none", () => {
    expect(agentSurface([browser, app], own, null)).toBe(app);
    expect(agentSurface([browser, app], own, latest(phone))).toBe(app);
    expect(agentSurface([], own, latest(phone))).toBeNull();
  });
  it.each([
    [browser, "globe"],
    [app, "laptopcomputer"],
    [phone, "smartphone"],
  ] as const)("maps the surface kind to its glyph", (item, glyph) => {
    expect(surfaceGlyph(item)).toBe(glyph);
  });
});
