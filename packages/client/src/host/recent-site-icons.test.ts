import { expect, it, vi } from "vitest";
import type { BrowserSessionSummary } from "./client.js";
import { RecentSitesStore, type RecentSitesStorage } from "./recent-sites.js";

const profile = { kind: "profile", profileId: "profile-one" } as const;
const scope = { deploymentId: "deployment", userId: "person" };
const blue = "data:image/png;base64,Ymx1ZQ==";
const green = "data:image/png;base64,Z3JlZW4=";
const page = { sessionId: "session", tabId: "tab" };
const address = "https://example.com/path";
function sessions(ref: string | null, documentId = "document", site = "https://example.com") {
  return [
    {
      id: page.sessionId,
      profileId: profile.profileId,
      tabCatalog: {
        generation: 1,
        revision: 1,
        tabs: [{ id: page.tabId, site, iconRef: ref, documentId }],
      },
    },
  ] as unknown as BrowserSessionSummary[];
}
function storage() {
  const data = new Map<string, string>();
  const port: RecentSitesStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return { data, port };
}
const settle = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

it("retains a late icon once per origin across tab closure and reload without adding visits", async () => {
  const saved = storage();
  const readIcon = vi.fn(async () => blue);
  const store = new RecentSitesStore({ storage: saved.port, readIcon });
  store.setScope(scope);
  store.observeTabs(sessions(null), true);
  store.record(profile, address, store.epoch, { tab: page });
  expect(readIcon).not.toHaveBeenCalled();
  const changed = vi.fn();
  store.subscribe(changed);
  store.observeTabs(sessions("icon"), true);
  await settle();
  expect(store.list(profile)[0]?.favicon).toBe(blue);
  expect(store.history(profile)[0]).toMatchObject({ visitCount: 1, typedCount: 1, favicon: blue });
  expect(changed).toHaveBeenCalledOnce();
  store.observeTabs([], true);
  store.record(profile, "https://example.com/another", store.epoch);
  expect(store.list(profile)[0]?.favicon).toBe(blue);
  expect(JSON.stringify([...saved.data.values()]).split(blue)).toHaveLength(2);
  const reloaded = new RecentSitesStore({ storage: saved.port, readIcon });
  reloaded.setScope(scope);
  expect(reloaded.history(profile).map((entry) => entry.favicon)).toEqual([blue, blue]);
  expect(readIcon).toHaveBeenCalledOnce();
  expect(reloaded.list({ kind: "profile", profileId: "other" })).toEqual([]);
});

it("takes the opened document's icon after an HTTP redirect to another origin", async () => {
  const store = new RecentSitesStore({ readIcon: async () => blue });
  store.setScope(scope);
  store.observeTabs(sessions(null, "blank", "about:blank"), true);
  store.record(profile, address, store.epoch, { tab: page });
  store.observeTabs(sessions("icon", "redirected-document", "https://redirected.example"), true);
  await settle();
  expect(store.list(profile)[0]).toMatchObject({ origin: "https://example.com", favicon: blue });
  expect(store.history(profile)[0]?.visitCount).toBe(1);
});

it.each(["document", "site", "reference", "clear", "remove", "scope", "dispose"])(
  "rejects an icon completing after its %s changed",
  async (change) => {
    let finish!: (icon: string) => void;
    const store = new RecentSitesStore({
      readIcon: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    store.setScope(scope);
    store.observeTabs(sessions("icon"), true);
    store.record(profile, address, store.epoch, { tab: page });
    if (change === "document") store.observeTabs(sessions("new-icon", "next-document"), true);
    if (change === "site")
      store.observeTabs(sessions("new-icon", "document", "https://other.com"), true);
    if (change === "reference") store.observeTabs(sessions(null), true);
    if (change === "clear") store.clear(profile);
    if (change === "remove") store.remove(profile, address);
    if (change === "scope") store.setScope({ ...scope, userId: "another-person" });
    if (change === "dispose") store.dispose();
    if (["clear", "remove", "scope"].includes(change)) store.record(profile, address, store.epoch);
    finish(blue);
    await settle();
    expect(store.list(profile).some((entry) => entry.favicon)).toBe(false);
  },
);

it("retries on later metadata and reconnect, accepts newer references, and never records agent or Guest visits", async () => {
  const readIcon = vi
    .fn()
    .mockRejectedValueOnce(Error("Disconnected"))
    .mockResolvedValueOnce(blue)
    .mockResolvedValueOnce(blue)
    .mockResolvedValue(green);
  const store = new RecentSitesStore({ readIcon });
  store.setScope(scope);
  store.observeTabs(sessions("icon"), true);
  expect(readIcon).not.toHaveBeenCalled();
  store.record({ kind: "guest" }, address, store.epoch, { tab: page });
  expect(readIcon).not.toHaveBeenCalled();
  store.record(profile, address, store.epoch, { tab: page });
  await settle();
  store.observeTabs(sessions("icon"), true);
  await settle();
  expect(store.list(profile)[0]?.favicon).toBe(blue);
  store.observeTabs(sessions("icon"), false);
  store.observeTabs(sessions("icon"), true);
  await settle();
  expect(store.list(profile)[0]?.favicon).toBe(blue);
  store.observeTabs(sessions("new-icon"), true);
  await settle();
  expect(store.list(profile)[0]?.favicon).toBe(green);
  expect(store.history(profile)).toHaveLength(1);
  store.clear(profile);
  expect(store.list(profile)).toEqual([]);
});

it("migrates existing history and removes expired icons with their visits", async () => {
  const saved = storage();
  const key = `opensteer.browsing-history.v1:${JSON.stringify([scope.deploymentId, scope.userId])}`;
  let now = 100 * 86400000;
  saved.port.setItem(
    key,
    JSON.stringify({
      [profile.profileId]: [
        { url: address, title: "A page", typedCount: 2, visitCount: 3, lastVisit: now },
      ],
    }),
  );
  const store = new RecentSitesStore({
    storage: saved.port,
    now: () => now,
    readIcon: async () => blue,
  });
  store.setScope(scope);
  expect(store.history(profile)[0]).toMatchObject({
    title: "A page",
    typedCount: 2,
    visitCount: 3,
  });
  store.observeTabs(sessions("icon"), true);
  store.record(profile, address, store.epoch, { tab: page });
  await settle();
  now += 90 * 86400000;
  expect(store.history(profile)).toEqual([]);
  expect(JSON.stringify([...saved.data.values()])).not.toContain(blue);
  expect(saved.data.has(key)).toBe(false);
});

it("discards an older reference and invalid images while accepting the document's latest icon", async () => {
  let finish!: (icon: string) => void;
  const readIcon = vi
    .fn<(sessionId: string, ref: string) => Promise<string | null>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce("data:image/svg+xml;base64,PHN2Zy8+")
    .mockResolvedValue(green);
  const store = new RecentSitesStore({ readIcon });
  store.setScope(scope);
  store.observeTabs(sessions("old"), true);
  store.record(profile, address, store.epoch, { tab: page });
  store.observeTabs(sessions("invalid"), true);
  await settle();
  expect(store.list(profile)[0]?.favicon).toBeUndefined();
  store.observeTabs(sessions("latest"), true);
  await settle();
  finish(blue);
  await settle();
  expect(store.list(profile)[0]?.favicon).toBe(green);
  expect(store.history(profile)[0]?.visitCount).toBe(1);
});

it("bounds visits and deduplicated rasters together by serialized UTF-8 bytes", async () => {
  const saved = storage();
  let now = 100 * 86400000;
  const icon = `data:image/png;base64,${"A".repeat(21_844)}`;
  const store = new RecentSitesStore({
    storage: saved.port,
    now: () => now,
    readIcon: async () => icon,
  });
  store.setScope(scope);
  const identity = { kind: "profile", profileId: 'profile-"-🦊' } as const;
  for (let index = 0; index < 60; index++) {
    now++;
    const origin = `https://site${index}.example`;
    store.observeTabs(
      sessions("icon", "document", origin).map((session) => ({
        ...session,
        profileId: identity.profileId,
      })),
      true,
    );
    store.record(identity, `${origin}/path?q=🦊`, store.epoch, {
      tab: page,
      title: '🦊"\n'.repeat(60),
    });
    await settle();
  }
  const raw = [...saved.data.values()][0]!;
  expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(1024 * 1024);
  const retained = store.history(identity);
  expect(retained.length).toBeLessThan(60);
  expect(retained[0]?.url).toContain("site59.example");
  const payload = JSON.parse(raw) as { icons: Record<string, Record<string, string>> };
  expect(Object.keys(payload.icons[identity.profileId]!).sort()).toEqual(
    [...new Set(retained.map((entry) => new URL(entry.url).origin))].sort(),
  );
});
