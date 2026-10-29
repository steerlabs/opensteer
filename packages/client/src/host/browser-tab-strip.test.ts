/* Failure modes: interleaved members move unrelated tabs; layout order overrides tab order;
 * unknown members inflate visible membership or create empty headers; native places get grouped; collapsed members remain
 * keyboard targets; unchanged rows lose identity when a different group is edited. */
import { describe, expect, it } from "vitest";
import { BrowserTabGroupIdSchema, BrowserSurfaceIdSchema } from "@opensteer/core";
import { WorkspaceTabLineageSchema, type BrowserTabLayout } from "@opensteer/protocol";
import { MockHostClient } from "../mock/mock-host-client.js";
import { placeList } from "./places.js";
import { browserTabStrip } from "./browser-tab-strip.js";

describe("browser tab strip", () => {
  it("projects interleaved groups once in tab order, preserving unaffected rows", () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const places = placeList(client.getSnapshot());
      const web = places.filter((place) => place.kind === "browser");
      expect(web.length).toBeGreaterThan(3);
      const ids = web.map((place) =>
        place.destination.kind === "browser"
          ? BrowserSurfaceIdSchema.parse(place.destination.tabId)
          : never(),
      );
      const layout: BrowserTabLayout = {
        revision: 1,
        groups: [
          {
            id: BrowserTabGroupIdSchema.parse("btg_00000000-0000-4000-8000-000000000001"),
            title: "Research",
            color: "blue",
            collapsed: false,
            tabIds: [ids[2]!, ids[0]!, BrowserSurfaceIdSchema.parse("surface_outside-bootstrap")],
          },
        ],
      };
      const strip = browserTabStrip(places, layout);
      expect(strip.web[0]).toMatchObject({ kind: "group", places: [web[0], web[2]] });
      expect(layout.groups[0]!.tabIds).toHaveLength(3);
      if (strip.web[0]?.kind !== "group") throw new Error("Expected tab group");
      expect(strip.web[0].places).toHaveLength(2);
      expect(strip.visible.slice(0, 4)).toEqual([web[0], web[2], web[1], web[3]]);
      expect(browserTabStrip(places, layout)).toBe(strip);
      const collapsed = browserTabStrip(places, {
        ...layout,
        revision: 2,
        groups: layout.groups.map((group) => ({ ...group, collapsed: true })),
      });
      expect(collapsed.visible).not.toContain(web[0]);
      expect(collapsed.visible).not.toContain(web[2]);
      expect(collapsed.web[1]).toBe(strip.web[1]);
      expect(collapsed.native).toEqual(places.filter((place) => place.kind !== "browser"));
      const unknown = browserTabStrip(places, {
        revision: 3,
        groups: [
          {
            ...layout.groups[0]!,
            tabIds: [BrowserSurfaceIdSchema.parse("bsurf_00000000-0000-4000-8000-000000000099")],
          },
        ],
      });
      expect(unknown.web.every((row) => row.kind === "place")).toBe(true);
      expect(browserTabStrip(places).visible).toEqual([...web, ...strip.native]);
    } finally {
      client.dispose();
    }
  });
});
function never(): never {
  throw new Error("Expected web tab");
}

// Failure modes: resolving a previously resolved layout reverses the opener placement
// when a lineage read wins the layout race; live-only tabs become durable anchors;
// an older Host changes order; moving one row replaces unrelated row objects.
describe("saved tab order projection", () => {
  it("resolves the saved order after a lineage read, including the grouped opener counterexample", () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const snapshot = client.getSnapshot();
      const session = snapshot.browserSessions[0]!;
      const ids = ["a", "b", "c", "d"].map((id) =>
        BrowserSurfaceIdSchema.parse(`surface_race_${id}`),
      );
      const lineage = WorkspaceTabLineageSchema.parse({
        id: session.id,
        revision: 1,
        createdAt: "2026-10-25T00:00:00.000Z",
        session: {
          ...session,
          createdAt: "2026-10-25T00:00:00.000Z",
          updatedAt: "2026-10-25T00:00:00.000Z",
        },
        tabs: ids.map((id, order) => ({
          kind: "browser" as const,
          id,
          sessionId: session.id,
          title: id,
          site: "",
          order,
          openerId: order === 2 ? ids[1]! : order === 3 ? ids[2]! : null,
          state: "suspended" as const,
          createdAt: `2026-10-25T00:00:0${order}.000Z`,
        })),
      });
      const layout: BrowserTabLayout = {
        revision: 1,
        order: [],
        groups: [
          {
            id: BrowserTabGroupIdSchema.parse("btg_00000000-0000-4000-8000-000000000002"),
            title: "G",
            color: "blue",
            collapsed: false,
            tabIds: [ids[0]!, ids[2]!],
          },
        ],
      };
      const source = {
        ...snapshot,
        workspaceTabRestoreVersion: 1 as const,
        workspaceTabs: [{ ...lineage, tabs: lineage.tabs!.slice(0, 3) }],
        browserSessions: [],
      };
      const first = browserTabStrip(placeList({ ...source, browserTabGroups: layout }), layout);
      expect(
        first.ordered
          .map((p) => (p.destination.kind === "browser" ? p.destination.tabId : null))
          .filter(Boolean),
      ).toEqual([ids[0], ids[2], ids[1]]);
      const places = placeList({ ...source, workspaceTabs: [lineage], browserTabGroups: layout });
      const earlyRead = browserTabStrip(places, layout);
      expect(
        earlyRead.ordered
          .filter((p) => p.kind === "browser")
          .map((p) => (p.destination.kind === "browser" ? p.destination.tabId : null)),
      ).toEqual([ids[0], ids[2], ids[3], ids[1]]);
      expect(browserTabStrip(places, layout)).toBe(earlyRead);
      const newer = { ...layout, revision: 2 };
      const refreshed = browserTabStrip(
        placeList({ ...source, workspaceTabs: [lineage], browserTabGroups: newer }),
        newer,
      );
      expect(refreshed.ordered.map((p) => p.key)).toEqual(earlyRead.ordered.map((p) => p.key));
      expect(browserTabStrip(places, newer).web[0]).toBe(earlyRead.web[0]);
    } finally {
      client.dispose();
    }
  });

  it("puts live-only tabs after durable tabs and leaves older Hosts in today's derived order", () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const snapshot = client.getSnapshot();
      const saved = snapshot.workspaceTabs![0]!;
      // One saved lineage; every other browser is live only, as on a runtime that saves no tabs.
      const source = {
        ...snapshot,
        workspaceTabRestoreVersion: 1 as const,
        workspaceTabs: [saved],
        browserSessions: snapshot.browserSessions.map((session) =>
          session.id === saved.session.id
            ? session
            : { ...session, workspaceTabRestoreVersion: undefined },
        ),
      };
      const ordered = placeList({
        ...source,
        browserTabGroups: { revision: 1, groups: [], order: [] },
      }).filter((p) => p.kind === "browser");
      const durable = ordered.filter((p) => p.workspaceTab);
      expect(durable.length).toBeGreaterThan(0);
      expect(ordered.length).toBeGreaterThan(durable.length);
      expect(ordered.slice(0, durable.length)).toEqual(durable);
      const older = placeList({ ...source, browserTabGroups: { revision: 1, groups: [] } });
      expect(older).toEqual(placeList({ ...source, browserTabGroups: undefined }));
      expect(browserTabStrip(older, { revision: 1, groups: [] }).ordered).toEqual(older);
    } finally {
      client.dispose();
    }
  });
});
