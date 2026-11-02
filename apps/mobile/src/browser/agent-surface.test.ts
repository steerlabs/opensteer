import { describe, expect, it } from "vitest";
import { type SurfaceItem } from "@opensteer/client/host";
import { actingFor, surfaceGlyph } from "./agent-surface.js";

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
describe("the surface the conversation's agent is using", () => {
  it("counts only this conversation's agents acting in ready shared tabs", () => {
    expect(actingFor(page("own", "conversation"), own)).toBe(true);
    expect(actingFor(page("delegated", "worker"), own)).toBe(true);
    expect(actingFor(page("shared", "someone-else"), own)).toBe(false);
    expect(actingFor(browser, own)).toBe(false);
    const closed = page("closed", "conversation");
    if (closed.kind !== "browser") throw new Error("Expected a browser tab");
    expect(actingFor({ ...closed, session: { ...closed.session, state: "closed" } }, own)).toBe(
      false,
    );
    for (const item of [app, phone]) {
      expect(actingFor(item, own)).toBe(false);
      expect(actingFor({ ...item, acting: true }, own)).toBe(true);
    }
  });
  it.each([
    [browser, "globe"],
    [app, "laptopcomputer"],
    [phone, "smartphone"],
  ] as const)("maps the surface kind to its glyph", (item, glyph) => {
    expect(surfaceGlyph(item)).toBe(glyph);
  });
});
