/**
 * K1-K4 at the launcher: one lookup of a name, one classifier for every page, and no restored
 * session without a read that agrees with itself. Chromium is mocked; what Chromium itself does
 * is tested in chromium-tab-identity.test.ts.
 */
import type { BrowserSurfaceId } from "@opensteer/protocol/browser";
import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { nativeProfileRequest } from "./native-profile.test-support.js";
import { PlaywrightChromiumLauncher } from "./playwright-launcher.js";
import { ChromiumTabLifecycleBridge, type ChromiumTabEntry } from "./tab-lifecycle-extension.js";

const surfX = "srf_00000000-0000-4000-8000-0000000k0201" as BrowserSurfaceId;
const surfLate = "srf_00000000-0000-4000-8000-0000000k0301" as BrowserSurfaceId;

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
    close: vi.fn(async () => {
      closed = true;
      events.emit("close");
    }),
    frames: () => [],
    mainFrame: () => ({}),
    addInitScript: vi.fn(async () => undefined),
    bringToFront: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    _opener: null,
    _connection: { toImpl: () => ({ delegate: { _targetId: targetId } }) },
  });
  return page as typeof page & Page;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/** A native launch against a mocked Chromium whose helper answers `read()`. */
async function launchWith(read: () => Promise<ChromiumTabEntry[]>) {
  const directory = await mkdtemp(join(tmpdir(), "os-tab-restore-identity-"));
  const helper = fakePage("target-helper", "about:blank");
  const pageHandlers: ((page: Page) => void)[] = [];
  const contexts: { args: readonly string[] }[] = [];
  let livePages: Page[] = [];
  const makeContext = (args: readonly string[]) => {
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 40_000 + contexts.length });
    const exit = () => {
      if (child.exitCode !== null) return;
      Object.defineProperty(child, "exitCode", { value: 0 });
      child.emit("exit", 0, null);
    };
    contexts.push({ args });
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
    return {
      process: () => child,
      browser: () => browser,
      pages: () => livePages,
      serviceWorkers: () => [],
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => ({})),
        detach: vi.fn(async () => undefined),
      })),
      newPage: vi.fn(async () => helper),
      addInitScript: vi.fn(async () => undefined),
      on: vi.fn((event: string, listener: (page: Page) => void) => {
        if (event === "page") pageHandlers.push(listener);
      }),
      close: vi.fn(async () => exit()),
    };
  };
  vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.spyOn(chromium, "launchPersistentContext").mockImplementation(
    async (_dir, options) => makeContext(options?.args ?? []) as unknown as BrowserContext,
  );
  vi.spyOn(ChromiumTabLifecycleBridge.prototype, "inventory").mockImplementation(read);
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
  return { launched, directory, arrive, handedOff, visible, contexts };
}

it("gives a wake up when a second tab carries its name as its page arrives, and keeps both hidden (K2, test 2)", async () => {
  let tabs = [row(55, { identity: surfX, discarded: true, status: "unloaded", targetId: null })];
  const { launched, arrive, handedOff, visible } = await launchWith(async () => [...tabs]);
  const first = fakePage("target-55", "https://tab-55.test/");
  const second = fakePage("target-56", "https://tab-56.test/");
  vi.spyOn(ChromiumTabLifecycleBridge.prototype, "activateByTabId").mockImplementation(
    async (tabId) => {
      // While the wake is armed a second tab carries the same name, and both pages arrive.
      tabs = [
        row(55, { identity: surfX, targetId: "target-55" }),
        row(56, { identity: surfX, targetId: "target-56" }),
      ];
      queueMicrotask(() => {
        arrive(first);
        arrive(second);
      });
      return { ok: true, tabId, discarded: false };
    },
  );
  const claimed = await launched.context.sessionRestore!.claim(surfX, undefined, undefined);
  expect(claimed).toBeNull();
  expect(handedOff).toEqual([]);
  expect(visible()).toEqual([]);
  await expect(launched.context.sessionRestore!.claim(surfX)).resolves.toBeNull();
});

it("never publishes a restored page missing from the first read: closed with evidence when it has no name, claimable when it has a kept Home name (K3, test 3)", async () => {
  let tabs: ChromiumTabEntry[] = [];
  const { launched, arrive, handedOff, visible } = await launchWith(async () => [...tabs]);
  // (a) No name: never published, closed.
  const unnamed = fakePage("target-301", "https://tab-301.test/");
  tabs = [row(301)];
  arrive(unnamed);
  await vi.waitFor(() => expect(unnamed.close).toHaveBeenCalled(), { timeout: 3_000 });
  expect(unnamed.isClosed()).toBe(true);
  // (b) A kept Home name, alone on its tab: hidden, and the claim of that name takes it.
  const named = fakePage("target-302", "https://tab-302.test/");
  tabs = [row(302, { identity: surfLate })];
  arrive(named);
  await vi.waitFor(
    () =>
      expect(
        (
          launched as unknown as { contextHandle: { restored: Map<string, unknown> } }
        ).contextHandle.restored.has(surfLate),
      ).toBe(true),
    { timeout: 3_000 },
  );
  expect(handedOff).toEqual([]);
  expect(visible()).toEqual([]);
  const claimed = await launched.context.sessionRestore!.claim(surfLate);
  expect((claimed as unknown as { rawPage: Page } | null)?.rawPage).toBe(named);
  expect(named.close).not.toHaveBeenCalled();
});

it("reports no removal and keeps the name guarded when no read agrees with itself (K1, K6, test 4)", async () => {
  let readable = true;
  const tabs = [row(401, { identity: surfX, discarded: true, status: "unloaded", targetId: null })];
  const { launched, arrive, handedOff } = await launchWith(async () => {
    if (!readable) throw new Error("The tab inventory did not agree with itself.");
    return [...tabs];
  });
  const removed = vi.spyOn(ChromiumTabLifecycleBridge.prototype, "removeByTabId");
  readable = false;
  await launched.context.sessionRestore!.reconcile(new Set());
  const handle = (
    launched as unknown as {
      contextHandle: { removals: Map<string, unknown>; restored: Map<string, unknown> };
    }
  ).contextHandle;
  // Not known is not "gone": the name is still guarded, nothing was asked of Chromium.
  expect(handle.restored.has(surfX)).toBe(false);
  expect(handle.removals.has(surfX)).toBe(true);
  expect(removed).not.toHaveBeenCalled();
  const late = fakePage("target-401", "https://tab-401.test/");
  readable = true;
  tabs[0] = row(401, { identity: surfX, targetId: "target-401" });
  arrive(late);
  await vi.waitFor(() => expect(late.close).toHaveBeenCalled(), { timeout: 3_000 });
  expect(handedOff).toEqual([]);
});

it("launches once more without the last session when launch has no read that agrees with itself, and takes no root from pages() (K4, test 5)", async () => {
  let reads = 0;
  const writes: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const { launched, directory, contexts } = await launchWith(async () => {
    // The first browser's helper never agrees with itself; the second's does.
    if (reads++ === 0) throw new Error("The tab inventory did not agree with itself.");
    return [];
  }).finally(() => stderr.mockRestore());
  expect(contexts.map((context) => context.args.includes("--restore-last-session"))).toEqual([
    true,
    false,
  ]);
  const preferences = JSON.parse(await readFile(join(directory, "Default", "Preferences"), "utf8"));
  expect(preferences.session.restore_on_startup).toBe(5);
  expect(
    writes.filter((line) => line.includes('"browser-runtime.tab-restore-skipped"')),
  ).toHaveLength(1);
  expect(launched.context.sessionRestore).toBeDefined();
  expect(launched.context.nativeProfile).toBe(true);
});
