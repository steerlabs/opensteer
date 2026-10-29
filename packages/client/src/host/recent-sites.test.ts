import { describe, expect, it } from "vitest";
import { RecentSitesStore } from "./recent-sites.js";
const day = 86400000;
describe("local recent sites", () => {
  it("persists full history and derives recent origins, isolates every scope, bounds and expires, and omits Guest history", () => {
    let now = 100 * day;
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
    const store = new RecentSitesStore({ storage, now: () => now });
    const work = { kind: "profile", profileId: "bpr_work" } as const;
    store.setScope({ deploymentId: "one", userId: "one" });
    const epoch = store.epoch;
    store.record(work, "https://example.com/private?secret=yes#private", epoch);
    store.record(work, "https://example.com/other", store.epoch);
    expect(store.list(work)).toEqual([{ origin: "https://example.com", lastUsed: now }]);
    expect(store.history(work).map((entry) => entry.url)).toEqual([
      "https://example.com/other",
      "https://example.com/private?secret=yes#private",
    ]);
    store.record({ kind: "guest" }, "https://guest.example", store.epoch);
    expect(store.list({ kind: "guest" })).toEqual([]);
    expect(JSON.stringify([...data.values()])).not.toContain("guest.example");
    store.record(work, "https://me:secret@example.com", store.epoch);
    store.record(work, "file:///private", store.epoch);
    for (let i = 0; i < 20; i++) {
      now++;
      store.record(work, `https://site${i}.example`, store.epoch);
    }
    expect(store.list(work)).toHaveLength(12);
    store.setScope({ deploymentId: "two", userId: "one" });
    expect(store.list(work)).toEqual([]);
    store.setScope({ deploymentId: "one", userId: "two" });
    expect(store.list(work)).toEqual([]);
    store.setScope({ deploymentId: "one", userId: "one" });
    expect(store.list(work)).toHaveLength(12);
    now += 90 * day;
    expect(store.list(work)).toEqual([]);
    store.record(work, "https://clear.example", store.epoch);
    store.clear(work);
    expect(store.list(work)).toEqual([]);
    store.record(work, "https://logout.example", store.epoch);
    store.setScope(null);
    store.record(work, "https://late.example", epoch);
    store.setScope({ deploymentId: "one", userId: "one" });
    expect(store.list(work)).toEqual([]);
    store.record(work, "https://late.example", epoch);
    expect(store.list(work)).toEqual([]);
  });
  it("returns empty for corrupt data or failed storage", () => {
    const store = new RecentSitesStore({
      storage: {
        getItem: () => "invalid",
        setItem: () => {
          throw Error("full");
        },
        removeItem: () => undefined,
      },
    });
    store.setScope({ deploymentId: "one", userId: "one" });
    expect(store.list({ kind: "profile", profileId: "bpr_work" })).toEqual([]);
    store.record({ kind: "profile", profileId: "bpr_work" }, "https://example.com", store.epoch);
    expect(store.list({ kind: "profile", profileId: "bpr_work" })).toEqual([]);
  });
});
