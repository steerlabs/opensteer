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
  // The helper's one sleep call, made of the two it is built from (mocked separately here):
  // named first, discarded second (Q2).
  vi.spyOn(ChromiumTabLifecycleBridge.prototype, "nameAndDiscard").mockImplementation(
    async function (this: ChromiumTabLifecycleBridge, tabId: number, title: string) {
      if (!(await this.nameTab(tabId, title))) return null;
      return this.discardByTabId(tabId);
    },
  );
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

it("names a tab first and discards it second, wakes it by that name, and removes the name (Q2)", async () => {
  const f = await launchWith();
  const { token } = await f.sleepOne(10);
  expect(f.state.tabs).toMatchObject([{ tabId: 11, discarded: true, identity: titleOf(token) }]);
  expect(f.spies.name.mock.invocationCallOrder[0]).toBeLessThan(
    f.spies.discard.mock.invocationCallOrder[0]!,
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

it("gives a wake up when a second tab carries its name as its page arrives: both pages are closed, never handed off, and nothing opens while the tab is not proven removed (K2, M2, test 2)", async () => {
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
  const pagesBefore = f.spies.newPage.mock.calls.length;
  await expect(f.launched.context.createPage({ restore: token })).rejects.toThrow(
    /not the one tab named/,
  );
  expect(f.spies.newPage.mock.calls.length).toBe(pagesBefore);
  expect(first.close).toHaveBeenCalled();
  expect(second.close).toHaveBeenCalled();
  expect(f.handedOff).not.toContain(first);
  expect(f.handedOff).not.toContain(second);
});

it.each(["arrival", "candidate"] as const)(
  "takes a woken page only after a last check that its name is still on that one tab (L4, %s)",
  async (path) => {
    const f = await launchWith();
    const { token } = await f.sleepOne(30);
    const title = titleOf(token);
    const woken = fakePage("target-30", "https://tab-30.test/");
    // The candidate shortcut: the tab's page is already there, loaded and hidden, when the wake
    // runs (it arrived while the wake waited behind other work on the tab's lane).
    const internals = f.internals as unknown as {
      onLane(id: string, fn: () => Promise<void>): Promise<void>;
    };
    const held = Promise.withResolvers<void>();
    const holding =
      path === "candidate" ? internals.onLane(tokenOf(token), () => held.promise) : null;
    let readsBefore = f.spies.read.mock.calls.length;
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
    const opening = f.launched.context.createPage({ restore: token });
    if (holding) {
      f.state.tabs = f.state.tabs.map((t) => ({ ...t, discarded: false, status: "complete" }));
      f.arrive(woken);
      await vi.waitFor(() => expect(f.spies.read.mock.calls.length).toBeGreaterThan(readsBefore));
      await vi.waitFor(() => expect(f.visible()).not.toContain(woken));
      // From the wake's own first read on: that one sees one carrier, the next a second.
      readsBefore = f.spies.read.mock.calls.length;
      held.resolve();
      await holding;
    }
    await expect(opening).rejects.toThrow(/not the one tab named/);
    expect(woken.close).toHaveBeenCalled();
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

it("keeps a failed sleep's token and guard until there is removal evidence, and opens it by address only once it is removed (L4, M2)", async () => {
  const f = await launchWith();
  f.spies.name.mockResolvedValue(false);
  f.spies.remove.mockResolvedValue(false);
  const { token } = await f.sleepOne(50);
  expect(f.internals.sleeping.has(tokenOf(token))).toBe(true);
  expect(f.internals.removals.has(tokenOf(token))).toBe(true);
  await expect(f.launched.context.releaseRestore!(token)).resolves.toBe(false);
  expect(f.internals.sleeping.has(tokenOf(token))).toBe(true);
  // Not proven removed: no fresh page, and no activation.
  const pagesBefore = f.spies.newPage.mock.calls.length;
  await expect(f.launched.context.createPage({ restore: token })).rejects.toThrow(
    /not proven removed/,
  );
  expect(f.spies.newPage.mock.calls.length).toBe(pagesBefore);
  // Once its removal is proven, it opens fresh at its address.
  f.spies.remove.mockRestore();
  vi.spyOn(ChromiumTabLifecycleBridge.prototype, "removeByTabId").mockImplementation(
    async (tabId) => {
      const before = f.state.tabs.length;
      f.state.tabs = f.state.tabs.filter((t) => t.tabId !== tabId);
      return f.state.tabs.length < before;
    },
  );
  const page = await f.launched.context.createPage({ restore: token });
  expect(f.spies.activate).not.toHaveBeenCalled();
  expect((page as unknown as { openedFresh: boolean }).openedFresh).toBe(true);
  expect(f.internals.sleeping.has(tokenOf(token))).toBe(false);
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

it.each(["none asleep", "one asleep"] as const)(
  "hands a page whose tab carries no sleep name off as the base does, opener or not (M1, %s)",
  async (state) => {
    const f = await launchWith();
    if (state === "one asleep") await f.sleepOne(300);
    const reads = f.spies.read.mock.calls.length;
    const ordinary = fakePage("target-301", "https://tab-301.test/");
    f.state.tabs = [...f.state.tabs, row(301)];
    f.arrive(ordinary);
    await vi.waitFor(() => expect(f.handedOff).toContain(ordinary), { timeout: 3_000 });
    expect(ordinary.close).not.toHaveBeenCalled();
    expect(f.visible()).toContain(ordinary);
    // With no tab asleep an arrival reads no inventory at all.
    if (state === "none asleep") expect(f.spies.read.mock.calls.length).toBe(reads);
  },
);

it("opens nothing fresh while the lane may still take a wake past its deadline, and leaves no awake page nobody owns (M2)", async () => {
  const f = await launchWith();
  const { token } = await f.sleepOne(80);
  const woken = fakePage("target-80", "https://tab-80.test/");
  // After the activation, the first read is the arriving page's, the second the wake's last one
  // before its take: that one never answers, so the lane runs to its deadline.
  let readsAtActivation = Number.POSITIVE_INFINITY;
  const read = f.spies.read.getMockImplementation()!;
  f.spies.read.mockImplementation(async () => {
    if (f.spies.read.mock.calls.length === readsAtActivation + 2)
      return new Promise<never>(() => {});
    return read();
  });
  f.spies.activate.mockImplementation(async (tabId) => {
    readsAtActivation = f.spies.read.mock.calls.length;
    f.state.tabs = f.state.tabs.map((t) => ({ ...t, discarded: false, status: "complete" }));
    queueMicrotask(() => f.arrive(woken));
    return { ok: true, tabId, discarded: false };
  });
  const order: string[] = [];
  f.spies.newPage.mockImplementationOnce(async () => {
    order.push("fresh");
    const page = fakePage("target-fresh-80", "about:blank");
    return page;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const opening = f.launched.context.createPage({ restore: token });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.spies.activate).toHaveBeenCalled();
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    const page = await opening;
    expect(order).toEqual(["fresh"]);
    expect((page as unknown as { openedFresh: boolean }).openedFresh).toBe(true);
    expect(woken.close).toHaveBeenCalled();
    expect(f.handedOff).not.toContain(woken);
  } finally {
    vi.useRealTimers();
  }
});

it("takes a woken page, its ownership and its publication before the name is removed, so an abandonment then leaves it with its owner (M2)", async () => {
  const f = await launchWith();
  const { token } = await f.sleepOne(85);
  const woken = fakePage("target-85", "https://tab-85.test/");
  f.spies.activate.mockImplementation(async (tabId) => {
    f.state.tabs = f.state.tabs.map((t) => ({ ...t, discarded: false, status: "complete" }));
    queueMicrotask(() => f.arrive(woken));
    return { ok: true, tabId, discarded: false };
  });
  const held = Promise.withResolvers<boolean>();
  let ownedBeforeUnname: boolean | null = null;
  const owned: unknown[] = [];
  f.spies.unname.mockImplementation(async () => {
    ownedBeforeUnname = owned.length === 1 && f.visible().includes(woken);
    return held.promise;
  });
  const abandon = new AbortController();
  const opening = f.launched.context.createPage({
    restore: token,
    signal: abandon.signal,
    own: (page) => owned.push(page),
  });
  await vi.waitFor(() => expect(f.spies.unname).toHaveBeenCalled());
  abandon.abort();
  held.resolve(false);
  const page = await opening;
  expect(ownedBeforeUnname).toBe(true);
  expect(owned).toEqual([page]);
  expect((page as unknown as { rawPage: Page }).rawPage).toBe(woken);
});

it("leaves a tab named and awake when the worker stops between name and discard, asks the discard again, and the tab sleeps and wakes normally, then sleeps normally next time (Q2)", async () => {
  const f = await launchWith();
  // The worker names the tab and stops before it discards.
  vi.spyOn(ChromiumTabLifecycleBridge.prototype, "nameAndDiscard").mockImplementationOnce(
    async function (this: ChromiumTabLifecycleBridge, tabId: number, title: string) {
      await this.nameTab(tabId, title);
      throw new Error("Opensteer tab lifecycle helper call timed out.");
    },
  );
  const { token } = await f.sleepOne(90);
  // Asleep under its name after the one more discard; nothing was removed.
  expect(f.state.tabs).toMatchObject([{ tabId: 91, discarded: true, identity: titleOf(token) }]);
  expect(f.spies.remove).not.toHaveBeenCalled();
  const woken = fakePage("target-90", "https://tab-90.test/");
  f.spies.activate.mockImplementation(async (tabId) => {
    f.state.tabs = f.state.tabs.map((t) => ({ ...t, discarded: false, status: "complete" }));
    queueMicrotask(() => f.arrive(woken));
    return { ok: true, tabId, discarded: false };
  });
  const page = await f.launched.context.createPage({ restore: token });
  expect((page as unknown as { rawPage: Page }).rawPage).toBe(woken);
  expect(f.state.tabs[0]!.identity).toBeNull();
  // Its next sleep is an ordinary one.
  const next = await page.captureRestore!();
  await page.close({ reason: "slept" });
  expect(f.state.tabs).toMatchObject([{ discarded: true, identity: titleOf(next) }]);
  expect(f.internals.sleeping.has(tokenOf(next))).toBe(true);
});

it("closing a sleeping tab while another tab is being put to sleep removes nothing but the closed tab (Q2)", async () => {
  const f = await launchWith();
  const { token: x } = await f.sleepOne(100);
  // Tab y is named; its discard waits while x is closed and removed.
  const held = Promise.withResolvers<void>();
  const helperStep = Promise.withResolvers<void>();
  vi.spyOn(ChromiumTabLifecycleBridge.prototype, "nameAndDiscard").mockImplementationOnce(
    async function (this: ChromiumTabLifecycleBridge, tabId: number, title: string) {
      await this.nameTab(tabId, title);
      helperStep.resolve();
      await held.promise;
      return this.discardByTabId(tabId);
    },
  );
  const sleepingY = f.sleepOne(200);
  await helperStep.promise;
  await expect(f.launched.context.releaseRestore!(x)).resolves.toBe(true);
  held.resolve();
  const { token: y } = await sleepingY;
  expect(f.spies.remove.mock.calls.map(([tabId]) => tabId)).toEqual([101]);
  expect(f.state.tabs).toMatchObject([{ tabId: 201, discarded: true, identity: titleOf(y) }]);
});

it("hands off a popup that arrives while an unrelated new tab is still opening, without waiting for it (Q3)", async () => {
  const f = await launchWith();
  await f.sleepOne(400);
  const opening = Promise.withResolvers<Page>();
  f.spies.newPage.mockImplementationOnce(() => opening.promise);
  const calls = f.spies.newPage.mock.calls.length;
  const unrelated = f.launched.context.createPage();
  void unrelated.catch(() => undefined);
  // The unrelated open is in flight, waiting on Chromium.
  await vi.waitFor(() => expect(f.spies.newPage.mock.calls.length).toBe(calls + 1));
  const popup = fakePage("target-401", "https://tab-401.test/");
  f.state.tabs = [...f.state.tabs, row(401)];
  f.arrive(popup);
  await vi.waitFor(() => expect(f.handedOff).toContain(popup), { timeout: 1_000, interval: 10 });
  opening.resolve(fakePage("target-402", "about:blank"));
  await unrelated;
});

it("hands off a popup that closes while its name is being read, so its end is delivered (Q3)", async () => {
  const f = await launchWith();
  await f.sleepOne(410);
  const held = Promise.withResolvers<void>();
  const read = f.spies.read.getMockImplementation()!;
  f.spies.read.mockImplementationOnce(async () => {
    await held.promise;
    return read();
  });
  const popup = fakePage("target-411", "https://tab-411.test/");
  f.state.tabs = [...f.state.tabs, row(411)];
  f.arrive(popup);
  await vi.waitFor(() => expect(f.spies.read).toHaveBeenCalled());
  popup.markClosed();
  held.resolve();
  await vi.waitFor(() => expect(f.handedOff).toContain(popup), { timeout: 3_000, interval: 10 });
});

it("keeps a closed opener's handle strongly held while it is among the last 64 closes, then only weakly, and keeps each target's opener record until it arrives or ends (Q1)", async () => {
  const f = await launchWith();
  const handles = f.internals as unknown as {
    recentlyClosed: unknown[];
    handleByTarget: Map<string, WeakRef<object>>;
    openerByTarget: Map<string, string>;
    noteOpener(targetId: string, openerId: string): void;
    forgetOpener(targetId: string): void;
  };
  // An opener the runtime opened, which closes; the test keeps no reference to its handle.
  f.nextPages.push(fakePage("target-opener", "https://opener.test/"));
  const raw = (await f.launched.context.createPage()) as unknown as {
    rawPage: ReturnType<typeof fakePage>;
  };
  raw.rawPage.markClosed();
  const held = () => handles.handleByTarget.get("target-opener")?.deref();
  expect(held()).toBeDefined();
  expect(handles.recentlyClosed).toContain(held());
  // 64 more closes push it out of the ring: it is then held only weakly, as before.
  for (let i = 0; i < 64; i++) {
    f.nextPages.push(fakePage(`target-later-${i}`, "about:blank"));
    const later = (await f.launched.context.createPage()) as unknown as {
      rawPage: ReturnType<typeof fakePage>;
    };
    later.rawPage.markClosed();
  }
  expect(handles.recentlyClosed).toHaveLength(64);
  expect(handles.recentlyClosed).not.toContain(held());
  // Opener records: removed when their target ends; past the cap only the oldest go.
  handles.noteOpener("target-child", "target-opener");
  handles.forgetOpener("target-child");
  expect(handles.openerByTarget.has("target-child")).toBe(false);
  for (let i = 0; i <= 4_096; i++) handles.noteOpener(`target-n-${i}`, "target-opener");
  expect(handles.openerByTarget.size).toBe(4_096);
  expect(handles.openerByTarget.has("target-n-0")).toBe(false);
  expect(handles.openerByTarget.has("target-n-1")).toBe(true);
  expect(handles.openerByTarget.has("target-n-4096")).toBe(true);
});
