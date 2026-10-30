import { describe, expect, it } from "vitest";
import { BrowserTabCatalogSchema } from "@opensteer/protocol/browser";
import { BrowserCatalogRevisions } from "./browser-catalog-revisions.js";
import type { BrowserTabCatalog } from "@opensteer/protocol/browser";

const catalog = () =>
  BrowserTabCatalogSchema.parse({
    generation: 100,
    revision: 0,
    inventoryRevision: 1,
    tabs: [
      {
        id: "page",
        title: "Page",
        site: "https://example.com",
        iconRef: null,
        order: 0,
        openerId: null,
        availability: "ready",
        documentId: null,
        occupants: [
          {
            threadId: "thr_00000000-0000-4000-8000-000000000001",
            home: false,
            holding: true,
            acting: true,
            lastActiveAt: "2026-10-29T00:00:00.000Z",
          },
        ],
      },
    ],
  });

/** The stamped catalog alone, for cases that do not look at notices. */
class Stamps extends BrowserCatalogRevisions {
  stamp(viewer: string, input: BrowserTabCatalog): BrowserTabCatalog {
    return this.assign(viewer, input).catalog;
  }
}

describe("browser catalog revision history", () => {
  it.each(["timestamp", "audience", "expiry", "inventory"] as const)(
    "versions %s changes and keeps unchanged reads stable",
    (change) => {
      const history = new Stamps();
      const first = history.stamp("alice", catalog());
      const next = catalog();
      if (change === "timestamp")
        next.tabs[0]!.occupants[0]!.lastActiveAt = "2026-10-29T00:00:01.000Z";
      if (change === "audience") next.tabs[0]!.occupants = [];
      if (change === "expiry") next.tabs[0]!.occupants[0]!.acting = false;
      if (change === "inventory") next.inventoryRevision = 2;
      const changed = history.stamp("alice", next);
      expect(changed.revision).toBeGreaterThan(first.revision);
      expect(history.stamp("alice", next)).toEqual(changed);
      expect(first.tabs[0]!.occupants).toHaveLength(1);
    },
  );

  it("remembers the revision assigned to each interleaved viewer", () => {
    const history = new Stamps();
    const a = history.stamp("alice", catalog());
    const b = history.stamp("bob", catalog());
    const changed = catalog();
    changed.tabs[0]!.occupants = [];
    const a2 = history.stamp("alice", changed);
    const b2 = history.stamp("bob", changed);
    changed.tabs[0]!.title = "Changed";
    expect(history.stamp("alice", changed).revision).toBeGreaterThan(a2.revision);
    expect(b2.revision).toBeGreaterThan(b.revision);
    expect(a2.revision).toBeGreaterThan(a.revision);
  });

  it("does not commit invalid content and detaches returned values", () => {
    const history = new Stamps();
    const first = history.stamp("alice", catalog());
    const invalid = catalog();
    invalid.tabs[0]!.order = -1;
    expect(() => history.stamp("alice", invalid)).toThrow();
    expect(history.stamp("alice", catalog())).toEqual(first);
    first.tabs[0]!.title = "Mutated by caller";
    expect(history.stamp("alice", catalog()).tabs[0]!.title).toBe("Page");
  });

  it("orders terminal content after the latest global bump and resets on restart", () => {
    const history = new Stamps();
    history.stamp("alice", catalog());
    history.announce();
    const latest = history.stamp("bob", catalog());
    const terminal = history.stamp("alice", {
      ...catalog(),
      revision: latest.revision + 1,
      tabs: [],
    });
    expect(terminal.revision).toBeGreaterThan(latest.revision);
    const restarted = history.stamp("alice", { ...catalog(), generation: 101 });
    expect(restarted.generation).toBeGreaterThan(terminal.generation);
  });

  it("bounds retained digests without reusing an evicted viewer's revision", () => {
    const history = new Stamps();
    const first = history.stamp("alice", catalog());
    for (let index = 0; index < 300; index++) history.stamp(`viewer-${index}`, catalog());
    expect(history.size).toBeLessThanOrEqual(256);
    expect(history.has("alice")).toBe(false);
    expect(history.stamp("alice", catalog()).revision).toBeGreaterThan(first.revision);
    history.clear();
    expect(history.size).toBe(0);
  });

  it("keeps an interleaved viewer's unchanged read at its own revision", () => {
    const history = new Stamps();
    const alice = history.stamp("alice", catalog());
    history.stamp("bob", catalog());
    expect(history.stamp("alice", catalog()).revision).toBe(alice.revision);
  });

  it("reports a viewer's change that no announced mutation covered", () => {
    const history = new BrowserCatalogRevisions();
    expect(history.assign("alice", catalog()).unannounced).toBe(false);
    // Another viewer's first read raises the counter without announcing anything.
    history.assign("bob", catalog());
    const active = catalog();
    active.tabs[0]!.occupants[0]!.lastActiveAt = "2026-10-29T00:00:01.000Z";
    expect(history.assign("alice", active).unannounced).toBe(true);
    // A mutation that announced itself already told every connection.
    history.announce();
    const later = catalog();
    later.tabs[0]!.occupants[0]!.lastActiveAt = "2026-10-29T00:00:02.000Z";
    expect(history.assign("alice", later).unannounced).toBe(false);
    expect(history.assign("alice", later).unannounced).toBe(false);
  });
});
