import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserHistory, BrowserHistoryIcons } from "@opensteer/protocol";
import { BrowserHistoryClient } from "./browser-history.js";
import { BrowserPreferences } from "./browser-preferences.js";

const scope = { deploymentId: "deployment", userId: "person" };
const entry = (url = "https://example.com/path") => ({
  url,
  title: "Example",
  typedCount: 1,
  visitCount: 1,
  lastVisitAt: "2026-10-30T12:00:00.000Z",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup(value: BrowserHistory = { entries: [entry()], icons: [] }) {
  const ports = {
    get: vi.fn(async (_profileId: string) => value),
    icons: vi.fn(async (_profileId: string, iconRefs: string[]): Promise<BrowserHistoryIcons> => ({
      icons: iconRefs.map((iconRef) => ({ iconRef, favicon: `data:image/png;base64,${iconRef}` })),
    })),
    remove: vi.fn(async (_profileId: string, _url: string): Promise<void> => undefined),
    clear: vi.fn(async (_profileId: string): Promise<void> => undefined),
  };
  const history = new BrowserHistoryClient(ports);
  history.setScope(scope);
  return { history, ports };
}
afterEach(() => vi.useRealTimers());
describe("Host browsing history cache", () => {
  it("distinguishes pending, retained, absent and failed icons, retrying after a new load", async () => {
    const iconRef = "a".repeat(64);
    const { history, ports } = setup({
      entries: [entry()],
      icons: [{ origin: "https://example.com", iconRef }],
    });
    await history.load("profile");
    expect(history.icon("profile", null)).toBeNull();
    expect(history.icon("profile", "unretained")).toBeNull();
    expect(ports.icons).not.toHaveBeenCalled();
    const raster = deferred<BrowserHistoryIcons>();
    ports.icons.mockReturnValueOnce(raster.promise);
    expect(history.icon("profile", iconRef)).toBeNull();
    await Promise.resolve();
    expect(history.icon("profile", iconRef)).toBeNull();
    raster.resolve({ icons: [{ iconRef, favicon: "data:ready" }] });
    await vi.waitFor(() => expect(history.icon("profile", iconRef)).toBe("data:ready"));
    for (const failed of [false, true]) {
      history.setScope({ ...scope, userId: String(failed) });
      await history.load("profile");
      if (failed) ports.icons.mockRejectedValueOnce(new Error("offline"));
      else ports.icons.mockResolvedValueOnce({ icons: [] });
      expect(history.icon("profile", iconRef)).toBeNull();
      await vi.waitFor(() => expect(history.icon("profile", iconRef)).toBeNull());
      const calls = ports.icons.mock.calls.length;
      expect(history.icon("profile", iconRef)).toBeNull();
      await Promise.resolve();
      expect(ports.icons).toHaveBeenCalledTimes(calls);
      await history.load("profile");
      expect(history.icon("profile", iconRef)).toBeNull();
      await vi.waitFor(() =>
        expect(history.icon("profile", iconRef)).toBe(`data:image/png;base64,${iconRef}`),
      );
    }
    history.dispose();
  });
  it("reloads authoritative history after concurrent removals both fail", async () => {
    const entries = [entry("https://a.example/"), entry("https://b.example/")];
    const { history, ports } = setup({ entries, icons: [] });
    await history.load("profile");
    const first = deferred<void>();
    const second = deferred<void>();
    ports.remove.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = history.remove("profile", entries[0]!.url);
    const b = history.remove("profile", entries[1]!.url);
    const rejectedA = expect(a).rejects.toThrow("offline A");
    const rejectedB = expect(b).rejects.toThrow("offline B");
    expect(history.entries("profile")).toEqual([]);
    first.reject(new Error("offline A"));
    await rejectedA;
    expect(ports.get).toHaveBeenCalledOnce();
    second.reject(new Error("offline B"));
    await rejectedB;
    await vi.waitFor(() => expect(history.entries("profile")).toEqual(entries));
    expect(ports.get).toHaveBeenCalledTimes(2);
    expect(history.entries("profile")).toEqual(entries);
    history.dispose();
  });
  it("dedupes in-flight reads, revalidates each open and notifies subscribers", async () => {
    const { history, ports } = setup();
    const changed = vi.fn();
    const unsubscribe = history.subscribe(changed);
    const gate = deferred<BrowserHistory>();
    ports.get.mockReturnValueOnce(gate.promise);
    const first = history.load("profile");
    expect(history.load("profile")).toBe(first);
    await Promise.resolve();
    expect(ports.get).toHaveBeenCalledExactlyOnceWith("profile");
    gate.resolve({ entries: [entry()], icons: [] });
    await first;
    expect(history.entries("profile")).toEqual([entry()]);
    expect(changed).toHaveBeenCalledOnce();
    ports.get.mockResolvedValueOnce({ entries: [entry("https://new.example/")], icons: [] });
    await history.load("profile");
    expect(ports.get).toHaveBeenCalledTimes(2);
    expect(history.entries("profile")[0]?.url).toBe("https://new.example/");
    unsubscribe();
    history.dispose();
  });
  it("reloads a cached subscribed profile on change and ignores unknown profiles", async () => {
    const { history, ports } = setup();
    const unsubscribe = history.subscribe(vi.fn());
    await history.load("profile");
    ports.get.mockResolvedValueOnce({ entries: [], icons: [] });
    history.changed("other");
    history.changed("profile");
    await vi.waitFor(() => expect(history.entries("profile")).toEqual([]));
    expect(ports.get.mock.calls).toEqual([["profile"], ["profile"]]);
    unsubscribe();
    history.dispose();
  });
  it("keeps what it showed when a read fails, says so, and clears it on the next success", async () => {
    const { history, ports } = setup();
    await history.load("profile");
    const changed = vi.fn();
    history.subscribe(changed);
    ports.get.mockRejectedValueOnce(new Error("Host unreachable"));
    await history.load("profile");
    expect(history.failed("profile")).toBe(true);
    expect(history.entries("profile")).toEqual([entry()]);
    expect(changed).toHaveBeenCalledOnce();
    await history.load("profile");
    expect(history.failed("profile")).toBe(false);
    expect(history.failed(null)).toBe(false);
    history.dispose();
  });

  it("coalesces changes during an in-flight read into exactly one follow-up", async () => {
    const { history, ports } = setup();
    const unsubscribe = history.subscribe(vi.fn());
    const gate = deferred<BrowserHistory>();
    ports.get.mockReturnValueOnce(gate.promise);
    const read = history.load("profile");
    await Promise.resolve();
    history.changed("profile");
    history.changed("profile");
    history.changed("profile");
    expect(ports.get).toHaveBeenCalledOnce();
    ports.get.mockResolvedValueOnce({ entries: [], icons: [] });
    gate.resolve({ entries: [entry()], icons: [] });
    await read;
    await vi.waitFor(() => expect(history.entries("profile")).toEqual([]));
    expect(ports.get).toHaveBeenCalledTimes(2);
    unsubscribe();
    history.dispose();
  });
  it("leaves an unsubscribed profile stale until the next load", async () => {
    const { history, ports } = setup();
    await history.load("profile");
    history.changed("profile");
    await Promise.resolve();
    expect(ports.get).toHaveBeenCalledOnce();
    ports.get.mockResolvedValueOnce({ entries: [], icons: [] });
    await history.load("profile");
    expect(ports.get).toHaveBeenCalledTimes(2);
    expect(history.entries("profile")).toEqual([]);
    history.dispose();
  });
  it("revalidates loaded profiles after reconnect, without fetching Guest", async () => {
    const { history, ports } = setup();
    history.setConnected(true);
    await history.load("one");
    await history.load("two");
    history.setConnected(false);
    history.setConnected(true);
    await Promise.all([history.load("one"), history.load("two"), history.load(null)]);
    expect(ports.get.mock.calls.map(([profileId]) => profileId)).toEqual([
      "one",
      "two",
      "one",
      "two",
    ]);
    expect(history.entries(null)).toEqual([]);
    expect(history.icon(null, "ref")).toBeNull();
    await history.clear(null);
    await history.remove(null, entry().url);
    expect(ports.clear).not.toHaveBeenCalled();
    expect(ports.remove).not.toHaveBeenCalled();
    history.dispose();
  });
  it("fetches only requested icons in parallel microtask batches of at most 24 and caches immutable refs across profiles", async () => {
    const icons = Array.from({ length: 50 }, (_, i) => ({
      origin: `https://site${i}.example`,
      iconRef: String(i).padStart(64, "0"),
    }));
    const { history, ports } = setup({ entries: [], icons });
    const gate = deferred<void>();
    ports.icons.mockImplementation(async (_profileId, refs) => {
      await gate.promise;
      return { icons: refs.map((iconRef) => ({ iconRef, favicon: `data:${iconRef}` })) };
    });
    await history.load("one");
    expect(ports.icons).not.toHaveBeenCalled();
    for (const { iconRef } of icons) {
      history.icon("one", iconRef);
      history.icon("one", iconRef);
    }
    await Promise.resolve();
    expect(ports.icons.mock.calls.map(([, refs]) => refs.length)).toEqual([24, 24, 2]);
    gate.resolve();
    await vi.waitFor(() =>
      expect(history.icon("one", icons[0]!.iconRef)).toContain(icons[0]!.iconRef),
    );
    await history.load("two");
    expect(history.icon("two", icons[0]!.iconRef)).toContain(icons[0]!.iconRef);
    await Promise.resolve();
    expect(ports.icons).toHaveBeenCalledTimes(3);
    history.dispose();
  });
  it("dedupes in-flight refs across profiles while new batches start independently", async () => {
    const icons = ["a", "b"].map((letter) => ({
      origin: `https://${letter}.example`,
      iconRef: letter.repeat(64),
    }));
    const { history, ports } = setup({ entries: [], icons });
    await Promise.all([history.load("one"), history.load("two")]);
    const gate = deferred<BrowserHistoryIcons>();
    ports.icons.mockReturnValueOnce(gate.promise);
    history.icon("one", icons[0]!.iconRef);
    await Promise.resolve();
    history.icon("two", icons[0]!.iconRef);
    history.icon("one", icons[1]!.iconRef);
    await Promise.resolve();
    expect(ports.icons.mock.calls).toEqual([
      ["one", [icons[0]!.iconRef]],
      ["one", [icons[1]!.iconRef]],
    ]);
    await vi.waitFor(() =>
      expect(history.icon("one", icons[1]!.iconRef)).toContain(icons[1]!.iconRef),
    );
    gate.resolve({ icons: [{ iconRef: icons[0]!.iconRef, favicon: "data:first" }] });
    await gate.promise;
    expect(history.icon("two", icons[0]!.iconRef)).toBe("data:first");
    history.dispose();
  });
  it("dedupes icon refs while a read revalidates, and does not loop on missing or failed icons", async () => {
    vi.useFakeTimers();
    const iconRef = "a".repeat(64);
    const { history, ports } = setup({
      entries: [entry()],
      icons: [{ origin: "https://example.com", iconRef }],
    });
    await history.load("one");
    const gate = deferred<BrowserHistoryIcons>();
    ports.icons.mockReturnValueOnce(gate.promise);
    history.icon("one", iconRef);
    await vi.advanceTimersByTimeAsync(0);
    await history.load("one");
    history.icon("one", iconRef);
    gate.resolve({ icons: [] });
    await vi.runAllTimersAsync();
    history.icon("one", iconRef);
    await vi.runAllTimersAsync();
    expect(ports.icons).toHaveBeenCalledOnce();
    await history.load("one");
    ports.icons.mockRejectedValueOnce(new Error("offline"));
    history.icon("one", iconRef);
    await vi.runAllTimersAsync();
    history.icon("one", iconRef);
    await vi.runAllTimersAsync();
    expect(ports.icons).toHaveBeenCalledTimes(2);
    history.dispose();
  });
  it("updates remove and clear immediately and fences stale reads and reads during mutations", async () => {
    const { history, ports } = setup();
    await history.load("profile");
    const stale = deferred<BrowserHistory>();
    ports.get.mockReturnValueOnce(stale.promise);
    const read = history.load("profile");
    await Promise.resolve();
    const mutation = deferred<void>();
    ports.remove.mockReturnValueOnce(mutation.promise);
    const removed = history.remove("profile", entry().url);
    expect(history.entries("profile")).toEqual([]);
    ports.get.mockResolvedValueOnce({ entries: [], icons: [] });
    const duringMutation = history.load("profile");
    expect(history.load("profile")).toBe(duringMutation);
    expect(ports.get).toHaveBeenCalledTimes(2);
    stale.resolve({ entries: [entry()], icons: [] });
    await read;
    expect(history.entries("profile")).toEqual([]);
    mutation.resolve();
    await removed;
    await duringMutation;
    expect(history.entries("profile")).toEqual([]);
    await history.load("profile");
    const clear = history.clear("profile");
    expect(history.entries("profile")).toEqual([]);
    await clear;
    expect(ports.clear).toHaveBeenCalledExactlyOnceWith("profile");
    history.dispose();
  });
  it.each(["remove", "clear"] as const)(
    "reloads Host data if %s fails and keeps cached data when a read fails",
    async (operation) => {
      const iconRef = "a".repeat(64);
      const { history, ports } = setup({
        entries: [entry()],
        icons: [{ origin: "https://example.com", iconRef }],
      });
      await history.load("profile");
      ports.get.mockRejectedValueOnce(new Error("offline"));
      await history.load("profile");
      expect(history.entries("profile")).toEqual([entry()]);
      const authoritative = entry("https://example.com/new");
      ports.get.mockResolvedValueOnce({
        entries: [authoritative],
        icons: [{ origin: "https://example.com", iconRef }],
      });
      ports[operation].mockRejectedValueOnce(new Error("offline"));
      const mutation =
        operation === "remove" ? history.remove("profile", entry().url) : history.clear("profile");
      expect(history.entries("profile")).toEqual([]);
      expect(history.iconRef("profile", entry().url)).toBeNull();
      await expect(mutation).rejects.toThrow("offline");
      await vi.waitFor(() => expect(history.entries("profile")).toEqual([authoritative]));
      expect(ports.get).toHaveBeenCalledTimes(3);
      expect(history.iconRef("profile", entry().url)).toBe(iconRef);
      history.dispose();
    },
  );
  it("reloads a newer successful clear after an older remove fails", async () => {
    const { history, ports } = setup();
    await history.load("profile");
    const gate = deferred<void>();
    ports.remove.mockReturnValueOnce(gate.promise);
    const removed = history.remove("profile", entry().url);
    const rejected = expect(removed).rejects.toThrow("offline");
    await history.clear("profile");
    ports.get.mockResolvedValue({ entries: [], icons: [] });
    gate.reject(new Error("offline"));
    await rejected;
    await history.load("profile");
    expect(history.entries("profile")).toEqual([]);
    history.dispose();
  });
  it("waits for every pending mutation before reloading the Host after failure", async () => {
    const other = entry("https://other.example/");
    const { history, ports } = setup({ entries: [entry(), other], icons: [] });
    await history.load("profile");
    const removeGate = deferred<void>();
    const clearGate = deferred<void>();
    ports.remove.mockReturnValueOnce(removeGate.promise);
    ports.clear.mockReturnValueOnce(clearGate.promise);
    const removed = history.remove("profile", entry().url);
    expect(history.entries("profile")).toEqual([other]);
    const superseded = history.load("profile");
    const cleared = history.clear("profile");
    const rejected = expect(cleared).rejects.toThrow("offline");
    const read = history.load("profile");
    expect(history.entries("profile")).toEqual([]);
    removeGate.resolve();
    await removed;
    await superseded;
    expect(ports.get).toHaveBeenCalledOnce();
    expect(history.entries("profile")).toEqual([]);
    ports.get.mockResolvedValueOnce({ entries: [other], icons: [] });
    clearGate.reject(new Error("offline"));
    await rejected;
    await read;
    expect(ports.get).toHaveBeenCalledTimes(2);
    expect(history.entries("profile")).toEqual([other]);
    history.dispose();
  });
  it.each([null, { ...scope, userId: "other" }, { ...scope, deploymentId: "other" }])(
    "resets history, icons and pending work on scope change to %j",
    async (next) => {
      vi.useFakeTimers();
      const iconRef = "b".repeat(64);
      const { history, ports } = setup({
        entries: [entry()],
        icons: [{ origin: "https://example.com", iconRef }],
      });
      await history.load("profile");
      history.icon("profile", iconRef);
      await vi.runAllTimersAsync();
      const gate = deferred<BrowserHistory>();
      ports.get.mockReturnValueOnce(gate.promise);
      const read = history.load("profile");
      await Promise.resolve();
      history.setScope(next);
      gate.resolve({ entries: [entry()], icons: [] });
      await read;
      expect(history.entries("profile")).toEqual([]);
      expect(history.icon("profile", iconRef)).toBeNull();
      if (next) {
        await history.load("profile");
        expect(history.icon("profile", iconRef)).toBeNull();
        await vi.runAllTimersAsync();
        expect(ports.icons).toHaveBeenCalledTimes(2);
      } else {
        await history.load("profile");
        await history.remove("profile", entry().url);
        await history.clear("profile");
        expect(ports.get).toHaveBeenCalledTimes(2);
        expect(ports.remove).not.toHaveBeenCalled();
        expect(ports.clear).not.toHaveBeenCalled();
      }
      history.dispose();
    },
  );
  it("drops a deleted profile without allowing its late response to restore it", async () => {
    const { history, ports } = setup();
    const gate = deferred<BrowserHistory>();
    ports.get.mockReturnValueOnce(gate.promise);
    const read = history.load("profile");
    await Promise.resolve();
    history.drop("profile");
    gate.resolve({ entries: [entry()], icons: [] });
    await read;
    expect(history.entries("profile")).toEqual([]);
    history.dispose();
  });
  it("cancels queued icons and ignores old icon replies even after returning to the same scope", async () => {
    const icons = ["a", "b"].map((letter) => ({
      origin: `https://${letter}.example`,
      iconRef: letter.repeat(64),
    }));
    const { history, ports } = setup({ entries: [], icons });
    await history.load("profile");
    const gate = deferred<BrowserHistoryIcons>();
    ports.icons.mockReturnValueOnce(gate.promise);
    history.icon("profile", icons[0]!.iconRef);
    await Promise.resolve();
    history.icon("profile", icons[1]!.iconRef);
    history.setScope(null);
    history.setScope(scope);
    await history.load("profile");
    expect(ports.icons).toHaveBeenCalledOnce();
    expect(history.icon("profile", icons[0]!.iconRef)).toBeNull();
    await vi.waitFor(() =>
      expect(history.icon("profile", icons[0]!.iconRef)).toBe(
        `data:image/png;base64,${icons[0]!.iconRef}`,
      ),
    );
    gate.resolve({ icons: [{ iconRef: icons[0]!.iconRef, favicon: "data:stale" }] });
    await gate.promise;
    expect(history.icon("profile", icons[0]!.iconRef)).toBe(
      `data:image/png;base64,${icons[0]!.iconRef}`,
    );
    expect(ports.icons).toHaveBeenCalledTimes(2);
    history.dispose();
  });
});
it("deletes all old device history keys without importing them and preserves search preferences", () => {
  const data = new Map(
    [
      "opensteer.browsing-history.v2:a",
      "opensteer.browsing-history.v1:b",
      "opensteer.recent-sites.v1:c",
      `opensteer.search-suggestions.v1:${JSON.stringify([scope.deploymentId, scope.userId])}`,
    ].map((key) => [key, "false"]),
  );
  const preferences = new BrowserPreferences({
    keys: () => [...data.keys()],
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  });
  preferences.setScope(scope);
  expect(data.size).toBe(1);
  expect(preferences.showSearchSuggestions).toBe(false);
});

it("keeps a queued icon while another URL from its origin is removed", async () => {
  vi.useFakeTimers();
  const iconRef = "f".repeat(64);
  const { history, ports } = setup({
    entries: [entry(), entry("https://example.com/other")],
    icons: [{ origin: "https://example.com", iconRef }],
  });
  await history.load("profile");
  history.icon("profile", iconRef);
  await history.remove("profile", entry().url);
  await vi.runAllTimersAsync();
  expect(ports.icons).toHaveBeenCalledExactlyOnceWith("profile", [iconRef]);
  expect(history.icon("profile", iconRef)).toBe(`data:image/png;base64,${iconRef}`);
  history.dispose();
});

it.each(["raster", "missing", "failed"])(
  "bounds settled %s icons and refetches an evicted ref",
  async (kind) => {
    vi.useFakeTimers();
    const icons = (offset: number) =>
      Array.from({ length: 300 }, (_, i) => ({
        origin: `https://site${i + offset}.example`,
        iconRef: String(i + offset).padStart(64, "0"),
      }));
    const firstIcons = icons(0);
    const { history, ports } = setup({ entries: [], icons: firstIcons });
    if (kind === "missing") ports.icons.mockResolvedValue({ icons: [] });
    if (kind === "failed") ports.icons.mockRejectedValue(new Error("offline"));
    await history.load("first");
    for (const { iconRef } of firstIcons) history.icon("first", iconRef);
    await vi.runAllTimersAsync();
    ports.get.mockResolvedValueOnce({ entries: [], icons: icons(300) });
    await history.load("second");
    for (const { iconRef } of icons(300)) history.icon("second", iconRef);
    await vi.runAllTimersAsync();
    const before = ports.icons.mock.calls.length;
    expect(history.icon("first", firstIcons[0]!.iconRef)).toBeNull();
    await vi.runAllTimersAsync();
    expect(ports.icons).toHaveBeenCalledTimes(before + 1);
    history.dispose();
  },
);

it("starts a fresh read on reconnect even when the previous connection's read is pending", async () => {
  const { history, ports } = setup({ entries: [entry("https://new.example/")], icons: [] });
  history.setConnected(true);
  const gate = deferred<BrowserHistory>();
  ports.get.mockReturnValueOnce(gate.promise);
  const stale = history.load("profile");
  await Promise.resolve();
  history.setConnected(false);
  history.setConnected(true);
  await history.load("profile");
  gate.resolve({ entries: [entry("https://old.example/")], icons: [] });
  await stale;
  expect(ports.get).toHaveBeenCalledTimes(2);
  expect(history.entries("profile")[0]?.url).toBe("https://new.example/");
  history.dispose();
});
