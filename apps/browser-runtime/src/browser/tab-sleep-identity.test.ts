/**
 * A tab has a name only while it sleeps (L2): the launcher's one lookup of that name, one
 * classifier for every page without provenance, and one lane per sleeping tab (L4). Chromium is
 * mocked; what Chromium itself does is tested in chromium-tab-identity.test.ts.
 */
import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { nativeProfileRequest } from "./native-profile.test-support.js";
import { PlaywrightChromiumLauncher } from "./playwright-launcher.js";
import { ChromiumTabLifecycleBridge, type ChromiumTabEntry } from "./tab-lifecycle-extension.js";

const row = (tabId: number, patch: Partial<ChromiumTabEntry> = {}): ChromiumTabEntry => ({
  tabId,
  windowId: 1,
  index: tabId,
  url: `https://tab-${tabId}.test/`,
  title: `Tab ${tabId}`,
  active: false,
  discarded: false,
  status: "complete",
  targetId: `target-${tabId}`,
  ...patch,
});

/** A Playwright page as the launcher sees one: its target in memory, its own close. */
function fakePage(targetId: string, url: string) {
  const events = new EventEmitter();
  let closed = false;
  const page = Object.assign(events, {
    url: () => url,
    isClosed: () => closed,
    markClosed: () => {
      closed = true;
      events.emit("close");
    },
    close: vi.fn(async () => {
      closed = true;
      events.emit("close");
    }),
    frames: () => [],
    mainFrame: () => ({}),
    bringToFront: vi.fn(async () => undefined),
    _opener: null,
    _connection: { toImpl: () => ({ delegate: { _targetId: targetId } }) },
  });
  return page as typeof page & Page;
}

const targetOf = (page: unknown) =>
  (page as { _connection: { toImpl(): { delegate: { _targetId: string } } } })._connection.toImpl()
    .delegate._targetId;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/**
 * A native launch against a mocked Chromium. `tabs` is what the helper reads; a discard gives the
 * tab a new id with the same target and closes its page, as on real Chromium; a name is written
 * to the row with that id.
 */
async function launchWith(initial: ChromiumTabEntry[] = []) {
  const state = { tabs: initial, readable: true };
  const directory = await mkdtemp(join(tmpdir(), "os-tab-sleep-identity-"));
  const helper = fakePage("target-helper", "about:blank");
  const pageHandlers: ((page: Page) => void)[] = [];
  const opened: Page[] = [];
  const nextPages: Page[] = [];
  let livePages: Page[] = [];
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 41_000 });
  const exit = () => {
    if (child.exitCode !== null) return;
    Object.defineProperty(child, "exitCode", { value: 0 });
    child.emit("exit", 0, null);
  };
  const browser = {
    newBrowserCDPSession: vi.fn(async () => ({
      send: vi.fn(async () => ({})),
      on: vi.fn(),
      off: vi.fn(),
      detach: vi.fn(async () => undefined),
    })),
    close: vi.fn(async () => exit()),
    isConnected: () => true,
  };
  const context = {
    process: () => child,
    browser: () => browser,
    // As Playwright does, a closed page leaves the context's list.
    pages: () => livePages.filter((page) => !page.isClosed()),
    serviceWorkers: () => [],
    newCDPSession: vi.fn(async (page: unknown) => ({
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo" ? { targetInfo: { targetId: targetOf(page) } } : {},
      ),
      on: vi.fn(),
      off: vi.fn(),
      detach: vi.fn(async () => undefined),
    })),
    newPage: vi.fn(async () => {
      if (opened.length === 0) {
        opened.push(helper);
        return helper;
      }
      const page = nextPages.shift() ?? fakePage(`target-fresh-${opened.length}`, "about:blank");
      opened.push(page);
      livePages = [...livePages, page];
      return page;
    }),
    addInitScript: vi.fn(async () => undefined),
    on: vi.fn((event: string, listener: (page: Page) => void) => {
      if (event === "page") pageHandlers.push(listener);
    }),
    close: vi.fn(async () => exit()),
  };
  vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(
    context as unknown as BrowserContext,
  );
  const read = vi
    .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
    .mockImplementation(async () => {
      if (!state.readable) throw new Error("The tab inventory did not agree with itself.");
      return [...state.tabs];
    });
  const discard = vi
    .spyOn(ChromiumTabLifecycleBridge.prototype, "discardByTabId")
    .mockImplementation(async (tabId) => {
      const before = state.tabs.find((t) => t.tabId === tabId);
      if (!before) return null;
      for (const page of livePages)
        if (targetOf(page) === before.targetId) (page as ReturnType<typeof fakePage>).markClosed();
      state.tabs = state.tabs.map((t) =>
        t.tabId === tabId ? { ...t, tabId: tabId + 1, discarded: true, status: "unloaded" } : t,
      );
      return tabId + 1;
    });
  const name = vi
    .spyOn(ChromiumTabLifecycleBridge.prototype, "nameTab")
    .mockImplementation(async (tabId, title) => {
      state.tabs = state.tabs.map((t) => (t.tabId === tabId ? { ...t, identity: title } : t));
      return true;
    });
  const unname = vi
    .spyOn(ChromiumTabLifecycleBridge.prototype, "unnameTab")
    .mockImplementation(async (tabId) => {
      state.tabs = state.tabs.map((t) => (t.tabId === tabId ? { ...t, identity: null } : t));
      return true;
    });
  const remove = vi
    .spyOn(ChromiumTabLifecycleBridge.prototype, "removeByTabId")
    .mockImplementation(async (tabId) => {
      const before = state.tabs.length;
      state.tabs = state.tabs.filter((t) => t.tabId !== tabId);
      return state.tabs.length < before;
    });
  const activate = vi.spyOn(ChromiumTabLifecycleBridge.prototype, "activateByTabId");
  const launcher = new PlaywrightChromiumLauncher({
    executablePath: process.execPath,
    headless: true,
    chromiumSandbox: true,
  });
  const launched = await launcher.launch(nativeProfileRequest(directory));
  cleanups.push(async () => {
    await launched.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  const handedOff: Page[] = [];
  launched.context.handOff((page) =>
    handedOff.push((page as unknown as { rawPage: Page }).rawPage),
  );
  /** Chromium announces a page: it joins the context's pages and its page event fires. */
  const arrive = (page: Page) => {
    livePages = [...livePages, page];
    for (const handler of pageHandlers) handler(page);
  };
  const visible = () =>
    launched.context.pages().map((page) => (page as unknown as { rawPage: Page }).rawPage);
  const internals = (launched as unknown as { contextHandle: ContextInternals }).contextHandle;
  /** Opens a page through the runtime, at `url`, and puts it to sleep; returns its token. */
  const sleepOne = async (tabId: number, url = `https://tab-${tabId}.test/`) => {
    const raw = fakePage(`target-${tabId}`, url);
    nextPages.push(raw);
    state.tabs = [...state.tabs, row(tabId, { url })];
    const page = await launched.context.createPage();
    const token = await page.captureRestore!();
    await page.close({ reason: "slept" });
    return { token, raw };
  };
  return {
    state,
    launched,
    arrive,
    handedOff,
    visible,
    internals,
    sleepOne,
    nextPages,
    spies: { read, discard, name, unname, remove, activate, newPage: context.newPage },
  };
}

interface ContextInternals {
  sleeping: Map<string, unknown>;
  sleepingTitles: Map<string, string>;
  removals: Map<string, unknown>;
  sleepAgain(tokenId: string): Promise<void>;
}

const tokenOf = (token: unknown) => (token as { tokenId: string }).tokenId;
const titleOf = (token: unknown) => `opensteer-sleep:${tokenOf(token)}`;

it("names a tab only after Chromium discarded it, wakes it by that name, and removes the name (L2)", async () => {
  const f = await launchWith();
  const { token } = await f.sleepOne(10);
  expect(f.state.tabs).toMatchObject([{ tabId: 11, discarded: true, identity: titleOf(token) }]);
  expect(f.spies.discard.mock.invocationCallOrder[0]).toBeLessThan(
    f.spies.name.mock.invocationCallOrder[0]!,
  );
  const woken = fakePage("target-10", "https://tab-10.test/");
  f.spies.activate.mockImplementation(async (tabId) => {
    f.state.tabs = f.state.tabs.map((t) => ({ ...t, discarded: false, status: "complete" }));
    queueMicrotask(() => f.arrive(woken));
    return { ok: true, tabId, discarded: false };
  });
  const page = await f.launched.context.createPage({ restore: token });
  expect((page as unknown as { rawPage: Page }).rawPage).toBe(woken);
  expect(f.state.tabs[0]!.identity).toBeNull();
  expect(f.internals.sleeping.size).toBe(0);
});

it("gives a wake up when a second tab carries its name as its page arrives, keeps both hidden, and opens the tab fresh (K2, test 2)", async () => {
  const f = await launchWith();
  const { token } = await f.sleepOne(20);
  const title = titleOf(token);
  const first = fakePage("target-20", "https://tab-20.test/");
  const second = fakePage("target-90", "https://tab-90.test/");
  f.spies.activate.mockImplementation(async (tabId) => {
    // While the wake is armed a second tab carries the same name, and both pages arrive.
    f.state.tabs = [
      row(21, { identity: title, targetId: "target-20" }),
      row(90, { identity: title, targetId: "target-90" }),
    ];
    queueMicrotask(() => {
      f.arrive(first);
      f.arrive(second);
    });
    return { ok: true, tabId, discarded: false };
  });
  const page = await f.launched.context.createPage({ restore: token });
  const raw = (page as unknown as { rawPage: Page }).rawPage;
  expect(raw).not.toBe(first);
  expect(raw).not.toBe(second);
  expect(f.handedOff).not.toContain(first);
  expect(f.handedOff).not.toContain(second);
  expect(f.visible()).toEqual([raw]);
});

it.each(["arrival", "candidate"] as const)(
  "takes a woken page only after a last check that its name is still on that one tab (L4, %s)",
  async (path) => {
    const f = await launchWith();
    const { token } = await f.sleepOne(30);
    const title = titleOf(token);
    const woken = fakePage("target-30", "https://tab-30.test/");
    if (path === "candidate") {
      // Chromium loaded the sleeping tab by itself: its page waits hidden, and the re-discard
      // that would follow finds nothing to do (the helper's discard declines here).
      f.spies.discard.mockResolvedValueOnce(null);
      f.state.tabs = f.state.tabs.map((t) => ({ ...t, discarded: false, status: "complete" }));
      f.arrive(woken);
      await vi.waitFor(() => expect(f.spies.read.mock.calls.length).toBeGreaterThan(4));
    }
    const readsBefore = f.spies.read.mock.calls.length;
    f.spies.read.mockImplementation(async () => {
      // Every read after the wake's first one sees a second tab with the same name.
      const reads = f.spies.read.mock.calls.length - readsBefore;
      return reads <= 1
        ? [...f.state.tabs]
        : [...f.state.tabs, row(99, { identity: title, targetId: "target-99" })];
    });
    f.spies.activate.mockImplementation(async (tabId) => {
      f.state.tabs = f.state.tabs.map((t) => ({ ...t, discarded: false, status: "complete" }));
      if (path === "arrival") queueMicrotask(() => f.arrive(woken));
      return { ok: true, tabId, discarded: false };
    });
    const page = await f.launched.context.createPage({ restore: token });
    expect((page as unknown as { rawPage: Page }).rawPage).not.toBe(woken);
    expect(f.handedOff).not.toContain(woken);
  },
);

it("runs a re-discard and a wake of one tab on its one lane, and a re-discard after the wake finds its token gone (L4)", async () => {
  const f = await launchWith();
  const { token } = await f.sleepOne(40);
  const woken = fakePage("target-40", "https://tab-40.test/");
  f.spies.activate.mockImplementation(async (tabId) => {
    f.state.tabs = f.state.tabs.map((t) => ({ ...t, discarded: false, status: "complete" }));
    queueMicrotask(() => f.arrive(woken));
    return { ok: true, tabId, discarded: false };
  });
  await f.launched.context.createPage({ restore: token });
  const discards = f.spies.discard.mock.calls.length;
  await f.internals.sleepAgain(tokenOf(token));
  expect(f.spies.discard.mock.calls.length).toBe(discards);
  expect(f.state.tabs[0]).toMatchObject({ discarded: false });
});

it("keeps a failed sleep's token and guard until there is removal evidence, and wakes it by address (L4)", async () => {
  const f = await launchWith();
  f.spies.name.mockResolvedValue(false);
  f.spies.remove.mockResolvedValue(false);
  const { token } = await f.sleepOne(50);
  expect(f.internals.sleeping.has(tokenOf(token))).toBe(true);
  expect(f.internals.removals.has(tokenOf(token))).toBe(true);
  await expect(f.launched.context.releaseRestore!(token)).resolves.toBe(false);
  expect(f.internals.sleeping.has(tokenOf(token))).toBe(true);
  // Its page is never handed off, and its wake opens the address instead of activating it.
  const late = fakePage("target-50", "https://tab-50.test/");
  f.state.tabs = f.state.tabs.map((t) => ({ ...t, discarded: false, status: "complete" }));
  f.arrive(late);
  await vi.waitFor(() => expect(late.close).toHaveBeenCalled(), { timeout: 3_000 });
  const page = await f.launched.context.createPage({ restore: token });
  expect(f.spies.activate).not.toHaveBeenCalled();
  expect((page as unknown as { rawPage: Page }).rawPage).not.toBe(late);
  expect(f.handedOff).not.toContain(late);
});

it("leaves the tab asleep under its name when its open is abandoned while the wake waits on its lane, and opens nothing fresh (L4)", async () => {
  const f = await launchWith();
  const { token } = await f.sleepOne(60);
  // Something else of this tab holds its lane while the open waits behind it.
  const held = Promise.withResolvers<void>();
  const internals = f.internals as unknown as {
    onLane(id: string, fn: () => Promise<void>): Promise<void>;
  };
  const holding = internals.onLane(tokenOf(token), () => held.promise);
  const abandon = new AbortController();
  const pagesBefore = f.spies.newPage.mock.calls.length;
  const opening = f.launched.context.createPage({ restore: token, signal: abandon.signal });
  await Promise.resolve();
  abandon.abort();
  held.resolve();
  await holding;
  await expect(opening).rejects.toThrow(/no longer wanted/);
  expect(f.spies.activate).not.toHaveBeenCalled();
  expect(f.spies.newPage.mock.calls.length).toBe(pagesBefore);
  expect(f.internals.sleeping.has(tokenOf(token))).toBe(true);
  expect(f.state.tabs[0]).toMatchObject({ discarded: true, identity: titleOf(token) });
});

it("reports no removal and keeps the guard when no read agrees with itself (K1, K6, test 4)", async () => {
  const f = await launchWith();
  const { token } = await f.sleepOne(70);
  f.state.readable = false;
  await expect(f.launched.context.releaseRestore!(token)).resolves.toBe(false);
  expect(f.spies.remove).not.toHaveBeenCalled();
  expect(f.internals.sleeping.has(tokenOf(token))).toBe(true);
  expect(f.internals.removals.has(tokenOf(token))).toBe(true);
});

it("never publishes a page without provenance: closed with evidence when no sleeping tab is its own (K3, test 3)", async () => {
  const f = await launchWith();
  const stranger = fakePage("target-301", "https://tab-301.test/");
  f.state.tabs = [row(301)];
  f.arrive(stranger);
  await vi.waitFor(() => expect(stranger.close).toHaveBeenCalled(), { timeout: 3_000 });
  expect(f.handedOff).toEqual([]);
  expect(f.visible()).toEqual([]);
});
