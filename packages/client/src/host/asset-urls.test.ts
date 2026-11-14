import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type { AssetUrlsInput, HostApiClient } from "@opensteer/protocol";
import { AssetUrlStore, assetImageUrl } from "./asset-urls.js";
import { MockHostClient } from "../mock/mock-host-client.js";

const stores: AssetUrlStore[] = [];
afterEach(() => {
  stores.forEach((store) => store.dispose());
  stores.length = 0;
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const thread = createId("thread");
  const other = createId("thread");
  let origin = "https://first.example";
  let invalidate: () => void = () => {};
  let revision = 1;
  const read = vi.fn(async (input: AssetUrlsInput) => ({
    ok: true as const,
    data: {
      assets: input.assets.map(({ path, variant }) => ({
        status: "ok" as const,
        url: `/media/token-${revision}/${variant}-${encodeURIComponent(path)}`,
        expiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
        revision: String(revision),
        width: 100,
        height: 80,
        mediaType: "image/png" as const,
      })),
    },
  }));
  const store = new AssetUrlStore({ "asset.urls": read } as unknown as HostApiClient, {
    origin: async () => origin,
    subscribe: (listener) => {
      invalidate = listener;
      return () => {};
    },
  });
  stores.push(store);
  return {
    store,
    read,
    thread,
    other,
    overwrite: () => revision++,
    rebase: () => {
      origin = "https://second.example";
      invalidate();
    },
  };
}
it("batches at most 32 per task, separates tasks, and deduplicates in-flight and cached metadata", async () => {
  const { store, read, thread, other } = setup();
  const first = store.get("deployment", thread, "/0.png", "preview");
  expect(store.get("deployment", thread, "/0.png", "preview")).toBe(first);
  await Promise.all([
    first,
    ...Array.from({ length: 34 }, (_, i) =>
      store.get("deployment", thread, `/${i}.png`, "preview"),
    ),
    store.get("deployment", other, "/0.png", "preview"),
  ]);
  expect(read.mock.calls.map(([input]) => input.assets.length)).toEqual([32, 1, 2]);
  await store.get("deployment", thread, "/0.png", "preview");
  expect(read).toHaveBeenCalledTimes(3);
});
it("re-mints before use once an address is within five minutes of expiry", async () => {
  const { store, read, thread } = setup();
  await store.get("d", thread, "/a.png", "preview");
  await vi.advanceTimersByTimeAsync(8 * 60 * 60_000 - 4 * 60_000);
  const renewed = store.get("d", thread, "/a.png", "preview");
  expect(read).toHaveBeenCalledTimes(1);
  await renewed;
  expect(read).toHaveBeenCalledTimes(2);
});
it("re-confirms on a new mount so an overwritten, re-shown file updates", async () => {
  const { store, read, thread, overwrite } = setup();
  const changed = vi.fn();
  store.subscribe(changed);
  await store.get("d", thread, "/a.png", "preview");
  store.confirm("d", thread, "/a.png", "preview");
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  changed.mockClear();
  overwrite();
  await vi.advanceTimersByTimeAsync(5_000);
  store.confirm("d", thread, "/a.png", "preview");
  store.confirm("d", thread, "/a.png", "preview");
  await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 1_000 });
  expect(read).toHaveBeenCalledTimes(2);
  expect(await store.get("d", thread, "/a.png", "preview")).toMatchObject({ revision: "2" });
});
it("asks once while a background re-confirmation is in flight", async () => {
  const { store, read, thread } = setup();
  await store.get("d", thread, "/a.png", "preview");
  await vi.advanceTimersByTimeAsync(31_000);
  let release: () => void = () => {};
  read.mockImplementationOnce(
    (input) =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            data: {
              assets: input.assets.map(() => ({
                status: "ok" as const,
                url: "/media/token-1/a.png",
                expiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
                revision: "1",
                width: 100,
                height: 80,
                mediaType: "image/png" as const,
              })),
            },
          });
      }),
  );
  await store.get("d", thread, "/a.png", "preview");
  await vi.advanceTimersByTimeAsync(0);
  await store.get("d", thread, "/a.png", "preview");
  await vi.advanceTimersByTimeAsync(0);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
});
it("does not remember a failed call as an unavailable image", async () => {
  const { store, read, thread } = setup();
  read.mockRejectedValueOnce(new Error("offline"));
  expect(await store.get("d", thread, "/a.png", "preview")).toMatchObject({
    status: "unavailable",
  });
  expect(await store.get("d", thread, "/a.png", "preview")).toMatchObject({ status: "ok" });
  expect(read).toHaveBeenCalledTimes(2);
});
it("renders a cached address at once and re-confirms it in the background after 30 s", async () => {
  const { store, read, thread, overwrite } = setup();
  const changed = vi.fn();
  store.subscribe(changed);
  await store.get("d", thread, "/a.png", "preview");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await store.get("d", thread, "/a.png", "preview")).toMatchObject({ revision: "1" });
  expect(read).toHaveBeenCalledTimes(1);
  overwrite();
  await vi.advanceTimersByTimeAsync(11_000);
  expect(await store.get("d", thread, "/a.png", "preview")).toMatchObject({ revision: "1" });
  await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 1_000 });
  expect(await store.get("d", thread, "/a.png", "preview")).toMatchObject({ revision: "2" });
  expect(read).toHaveBeenCalledTimes(2);
});
it("invalidates and re-mints only once on load failure, allowing another attempt for new output", async () => {
  const { store, read, thread, overwrite } = setup();
  await store.get("d", thread, "/a.png", "preview");
  overwrite();
  expect(await store.loadFailed("d", thread, "/a.png", "preview")).toBe(true);
  expect(await store.get("d", thread, "/a.png", "preview")).toMatchObject({ revision: "2" });
  expect(await store.loadFailed("d", thread, "/a.png", "preview")).toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
  expect(await store.image("d", thread, "/a.png", "preview")).toBeNull();
  overwrite();
  await vi.advanceTimersByTimeAsync(31_000);
  await store.get("d", thread, "/a.png", "preview");
  await vi.waitFor(
    async () =>
      expect(await store.get("d", thread, "/a.png", "preview")).toMatchObject({ revision: "3" }),
    { timeout: 1_000 },
  );
  expect(await store.loadFailed("d", thread, "/a.png", "preview")).toBe(true);
});
it("rebases cached metadata after attachment invalidation without minting again", async () => {
  const { store, read, thread, rebase } = setup();
  const changed = vi.fn();
  store.subscribe(changed);
  expect((await store.image("d", thread, "/a.png", "preview"))?.source).toContain(
    "https://first.example/media/",
  );
  changed.mockClear();
  rebase();
  expect(changed).toHaveBeenCalledTimes(1);
  expect((await store.image("d", thread, "/a.png", "preview"))?.source).toContain(
    "https://second.example/media/",
  );
  expect(read).toHaveBeenCalledTimes(1);
});
it("binds desktop URLs to the minting Deployment", () => {
  expect(
    assetImageUrl("deployment-a", "/media/token/photo%20one.png", "https://ignored.example", true),
  ).toBe("app://opensteer/media/deployment-a/token/photo%20one.png");
});
it("implements ordered unavailable asset results in the mock", async () => {
  const mock = new MockHostClient({ latencyMs: 0 });
  try {
    expect(
      await mock.rpc["asset.urls"]({
        threadId: createId("thread"),
        assets: [
          { path: "/missing.png", variant: "preview" },
          { path: "/missing.png", variant: "original" },
        ],
      }),
    ).toEqual({
      ok: true,
      data: {
        assets: [
          { status: "unavailable", reason: "missing" },
          { status: "unavailable", reason: "missing" },
        ],
      },
    });
  } finally {
    mock.dispose();
  }
});

it("re-mints when time jumps past expiry and isolates Deployment metadata", async () => {
  const { store, read, thread } = setup();
  await store.get("first", thread, "/a.png", "preview");
  await store.get("second", thread, "/a.png", "preview");
  expect(read).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 9 * 60 * 60_000);
  await store.get("first", thread, "/a.png", "preview");
  expect(read).toHaveBeenCalledTimes(3);
});

it("settles every item when the RPC fails, and asks again on the next use", async () => {
  const { store, read, thread } = setup();
  read.mockRejectedValueOnce(new Error("offline"));
  expect(await store.image("d", thread, "/a.png", "preview")).toBeNull();
  expect(await store.image("d", thread, "/a.png", "preview")).toMatchObject({ revision: "1" });
});
